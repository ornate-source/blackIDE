import * as yaml from 'js-yaml';

// Rules v2 — Phase 2 (M9/M11) of docs/notes/enhancement.md.
//
// Pure, vscode-free, fs-free: parsing, validation, glob matching and selection only.
// The loader (rules-loader.ts) does the I/O. Keeping this half pure is what lets the
// activation semantics — the part that decides what the model is told — be tested
// exhaustively without a workspace.
//
// Before this, a project had exactly one lever: `.blackide/AGENTS.md`, injected whole
// on every single turn. That is fine for three lines of house style and useless for
// anything real — a Python convention was shouted at the model while it edited CSS,
// and the only way to add a targeted rule was to make the always-on blob larger.

/** How a rule decides to participate in a turn. */
export type RuleActivation =
    /** Always injected. The `AGENTS.md` behaviour, and the default. */
    | 'always'
    /** Injected only when a file matching `globs` is in play. */
    | 'glob'
    /** Advertised to the model by name+description; injected only if it asks. */
    | 'agent-requested'
    /** Never automatic; only when the user turns it on for the session. */
    | 'manual';

export const RULE_ACTIVATIONS: RuleActivation[] = ['always', 'glob', 'agent-requested', 'manual'];

/** Where a rule came from. Decides precedence and whether the user may disable it. */
export type RuleScope = 'team' | 'project' | 'user';

export interface Rule {
    name: string;
    description: string;
    /** The rule text injected into the prompt. */
    body: string;
    activation: RuleActivation;
    /** Glob patterns, relative to the workspace root. Only meaningful for `glob`. */
    globs: string[];
    /** Higher wins when the budget forces truncation. Default 0. */
    priority: number;
    scope: RuleScope;
    /** Absolute path, for diagnostics and for the session panel to link to. */
    file: string;
}

export interface RuleProblem {
    file: string;
    message: string;
    severity: 'error' | 'warning';
}

/**
 * Why each selected rule fired. The session panel (M10) renders this, and the gate
 * for Phase 2 is that what it shows matches what was actually assembled — so the
 * reason is produced by the selector itself rather than reconstructed afterwards.
 */
export interface RuleActivationReason {
    rule: Rule;
    reason: 'always' | 'glob-match' | 'manual-enabled' | 'agent-requested';
    /** For `glob-match`, the path that matched and the pattern it matched. */
    matchedPath?: string;
    matchedGlob?: string;
}

const MAX_RULE_NAME = 60;

/**
 * Translate one glob to a RegExp.
 *
 * Deliberately a small subset — `**`, `*`, `?`, `{a,b}`, character classes — rather
 * than a dependency. Two behaviours matter and are easy to get wrong:
 *   - `*` must not cross a path separator; `**` must.
 *   - a bare pattern with no separator (`*.ts`) should match at any depth, which is
 *     what users expect from editor globs and what `.gitignore` does.
 */
export function globToRegExp(glob: string): RegExp {
    const g = glob.trim().replace(/^\.\//, '');
    // A pattern with no `/` is depth-agnostic: `*.ts` means "any .ts anywhere".
    const anchored = g.includes('/') ? g : `**/${g}`;

    let out = '';
    for (let i = 0; i < anchored.length; i++) {
        const c = anchored[i];
        if (c === '*') {
            if (anchored[i + 1] === '*') {
                // `**/` consumes zero or more directories; bare `**` matches the rest.
                if (anchored[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
                else { out += '.*'; i += 1; }
            } else {
                out += '[^/]*';
            }
        } else if (c === '?') {
            out += '[^/]';
        } else if (c === '{') {
            const close = anchored.indexOf('}', i);
            if (close === -1) { out += '\\{'; continue; }
            const alts = anchored.slice(i + 1, close).split(',').map(a => a.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
            out += `(?:${alts.join('|')})`;
            i = close;
        } else if (c === '[') {
            const close = anchored.indexOf(']', i);
            if (close === -1) { out += '\\['; continue; }
            out += anchored.slice(i, close + 1);
            i = close;
        } else if ('.+^$()|\\'.includes(c)) {
            out += '\\' + c;
        } else {
            out += c;
        }
    }
    return new RegExp(`^${out}$`, 'i');
}

/** Does `filePath` (workspace-relative, forward slashes) match any of `globs`? */
export function matchGlobs(filePath: string, globs: string[]): string | undefined {
    const p = filePath.replace(/\\/g, '/').replace(/^\.?\//, '');
    for (const glob of globs) {
        if (!glob) continue;
        if (globToRegExp(glob).test(p)) return glob;
    }
    return undefined;
}

/**
 * Parse one rule file. Frontmatter is optional: a plain `.md` with no frontmatter is
 * a valid always-on rule, which is what keeps a hand-written `AGENTS.md` working
 * unchanged when it is dropped into `rules/`.
 */
export function parseRuleFile(
    file: string,
    content: string,
    scope: RuleScope,
    fallbackName: string,
): { rule?: Rule; problems: RuleProblem[] } {
    const problems: RuleProblem[] = [];
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);

    let fm: Record<string, any> = {};
    let body = content;
    if (fmMatch) {
        try {
            const parsed = yaml.load(fmMatch[1]);
            if (parsed && typeof parsed === 'object') fm = parsed as Record<string, any>;
            else problems.push({ file, message: 'Frontmatter must be a YAML mapping.', severity: 'error' });
        } catch (e: any) {
            problems.push({ file, message: `Invalid YAML frontmatter: ${e?.message || e}`, severity: 'error' });
            return { problems };
        }
        body = content.slice(fmMatch[0].length);
    }

    const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : fallbackName;
    if (name.length > MAX_RULE_NAME) {
        problems.push({ file, message: `"name" exceeds ${MAX_RULE_NAME} characters.`, severity: 'warning' });
    }

    const globs = toStringArray(fm.globs);
    let activation: RuleActivation = 'always';
    if (fm.activation !== undefined) {
        if (typeof fm.activation === 'string' && (RULE_ACTIVATIONS as string[]).includes(fm.activation)) {
            activation = fm.activation as RuleActivation;
        } else {
            problems.push({
                file,
                message: `Unknown activation "${fm.activation}". Valid values: ${RULE_ACTIVATIONS.join(', ')}.`,
                severity: 'warning',
            });
        }
    } else if (globs.length) {
        // Declaring globs without an activation obviously means "when these match".
        // Defaulting to `always` here would silently ignore the globs, which is the
        // most confusing possible reading of the file.
        activation = 'glob';
    }

    if (activation === 'glob' && !globs.length) {
        problems.push({
            file,
            message: 'activation is "glob" but no "globs" are declared, so this rule can never fire.',
            severity: 'warning',
        });
    }
    if (activation === 'agent-requested' && !String(fm.description || '').trim()) {
        problems.push({
            file,
            message: 'activation is "agent-requested" but there is no "description" — the model is offered the rule by its description, so it will never know to ask for this one.',
            severity: 'warning',
        });
    }
    if (!body.trim()) {
        problems.push({ file, message: 'Rule file has no body below the frontmatter, so it injects nothing.', severity: 'warning' });
    }

    const priority = Number.isFinite(Number(fm.priority)) ? Number(fm.priority) : 0;

    return {
        rule: {
            name,
            description: String(fm.description || '').trim(),
            body: body.trim(),
            activation,
            globs,
            priority,
            scope,
            file,
        },
        problems,
    };
}

function toStringArray(v: unknown): string[] {
    if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
    return [];
}

export interface SelectRulesOpts {
    rules: Rule[];
    /** Workspace-relative paths in play this turn (open editor, referenced files). */
    activePaths?: string[];
    /** Rule names the user enabled for this session (drives `manual`). */
    enabled?: string[];
    /** Rule names the user disabled for this session. Team rules ignore this. */
    disabled?: string[];
    /** Names the model explicitly asked for (drives `agent-requested`). */
    requested?: string[];
}

/**
 * Decide which rules apply this turn, in injection order.
 *
 * Order is team → project → user, then by descending priority, then by name for
 * determinism. Team first is deliberate: when the budget truncates, the rules an
 * organisation mandates are the ones that survive.
 */
export function selectRules(opts: SelectRulesOpts): RuleActivationReason[] {
    const { rules, activePaths = [], enabled = [], disabled = [], requested = [] } = opts;
    const lower = (xs: string[]) => new Set(xs.map(x => x.toLowerCase()));
    const enabledSet = lower(enabled);
    const disabledSet = lower(disabled);
    const requestedSet = lower(requested);

    const picked: RuleActivationReason[] = [];

    for (const rule of rules) {
        // A team rule is not the user's to switch off — that is the whole point of
        // the scope. Project and user rules are.
        if (rule.scope !== 'team' && disabledSet.has(rule.name.toLowerCase())) continue;

        switch (rule.activation) {
            case 'always':
                picked.push({ rule, reason: 'always' });
                break;
            case 'glob': {
                let hit: { path: string; glob: string } | undefined;
                for (const p of activePaths) {
                    const glob = matchGlobs(p, rule.globs);
                    if (glob) { hit = { path: p, glob }; break; }
                }
                if (hit) picked.push({ rule, reason: 'glob-match', matchedPath: hit.path, matchedGlob: hit.glob });
                break;
            }
            case 'agent-requested':
                if (requestedSet.has(rule.name.toLowerCase())) picked.push({ rule, reason: 'agent-requested' });
                break;
            case 'manual':
                if (enabledSet.has(rule.name.toLowerCase())) picked.push({ rule, reason: 'manual-enabled' });
                break;
        }
    }

    const scopeRank: Record<RuleScope, number> = { team: 0, project: 1, user: 2 };
    return picked.sort((a, b) =>
        scopeRank[a.rule.scope] - scopeRank[b.rule.scope] ||
        b.rule.priority - a.rule.priority ||
        a.rule.name.localeCompare(b.rule.name));
}

/**
 * Render selected rules into the prompt's `project_rules` section.
 *
 * The scope is stated inline because it changes how the model should treat a
 * conflict: a team rule outranks a project preference.
 */
export function renderRules(selected: RuleActivationReason[]): string {
    if (!selected.length) return '';
    const blocks = selected.map(({ rule }) => {
        const label = rule.scope === 'team' ? `${rule.name} (team rule — takes precedence)` : rule.name;
        return `### ${label}\n${rule.body}`;
    });
    return `Project rules — follow these unless the user overrides them in this conversation:\n\n${blocks.join('\n\n')}`;
}

/**
 * Catalogue of `agent-requested` rules, offered to the model so it can ask for one.
 * Only names and descriptions: the bodies are what we are trying not to spend budget
 * on until they are wanted.
 */
export function renderRequestableRules(rules: Rule[]): string {
    const requestable = rules.filter(r => r.activation === 'agent-requested' && r.description);
    if (!requestable.length) return '';
    const lines = requestable.map(r => `- ${r.name}: ${r.description}`);
    return `Additional rule sets are available on request. If one is relevant, say so and it will be provided next turn:\n${lines.join('\n')}`;
}
