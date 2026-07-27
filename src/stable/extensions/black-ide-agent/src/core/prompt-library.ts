import * as yaml from 'js-yaml';

// Prompt & workflow library — Phase 2 (M12) of docs/notes/enhancement.md.
//
// Pure: parsing, validation and argument expansion only. The loader half lives in
// prompt-library-loader.ts.
//
// The eleven built-in slash commands are hard-coded in the webview message handler,
// so a team's own repeated prompt ("review this against our API checklist") had
// nowhere to live but a scratch file the user pasted from. These are the same thing
// as a built-in command, authored as a file.

/** A reusable prompt, surfaced as a slash command. */
export interface UserPrompt {
    /** Invoked as `/<name>`. Lower-case, no spaces. */
    name: string;
    description: string;
    /** The prompt body, with `$ARGS` / `$1`… placeholders already declared. */
    template: string;
    /** Mode to switch to when this prompt runs. Undefined = keep the current mode. */
    mode?: string;
    /** Ordered follow-up prompt names, for multi-step workflows. */
    steps: string[];
    file: string;
}

export interface PromptProblem {
    file: string;
    message: string;
    severity: 'error' | 'warning';
}

/** Built-ins may not be shadowed: a user `/plan` would silently break planning. */
export const RESERVED_PROMPT_NAMES = [
    'plan', 'orchestrate', 'single', 'explain', 'fix', 'refactor', 'test',
    'docs', 'd', 'search', 's', 'commit', 'c', 'compact',
];

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Parse one prompt file.
 *
 * `name` defaults to the filename, so the minimum viable prompt is a `.md` file with
 * no frontmatter at all — the same low-ceremony authoring the rules loader allows.
 */
export function parsePromptFile(
    file: string,
    content: string,
    fallbackName: string,
): { prompt?: UserPrompt; problems: PromptProblem[] } {
    const problems: PromptProblem[] = [];
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

    const rawName = String(fm.name || fallbackName).trim().toLowerCase();
    if (!NAME_RE.test(rawName)) {
        problems.push({
            file,
            message: `"${rawName}" is not a usable command name. Use lower-case letters, digits and dashes, starting with a letter (max 32 chars).`,
            severity: 'error',
        });
        return { problems };
    }
    if (RESERVED_PROMPT_NAMES.includes(rawName)) {
        problems.push({
            file,
            message: `"/${rawName}" is a built-in slash command and cannot be redefined. Choose another name.`,
            severity: 'error',
        });
        return { problems };
    }

    const steps = Array.isArray(fm.steps) ? fm.steps.map((s: any) => String(s).trim().toLowerCase()).filter(Boolean) : [];

    if (!body.trim() && !steps.length) {
        problems.push({
            file,
            message: 'Prompt file has neither a body nor "steps", so invoking it would do nothing.',
            severity: 'error',
        });
        return { problems };
    }
    if (!String(fm.description || '').trim()) {
        problems.push({ file, message: 'Missing "description" — it is what the command picker shows.', severity: 'warning' });
    }

    return {
        prompt: {
            name: rawName,
            description: String(fm.description || '').trim(),
            template: body.trim(),
            mode: typeof fm.mode === 'string' && fm.mode.trim() ? fm.mode.trim() : undefined,
            steps,
            file,
        },
        problems,
    };
}

/**
 * Substitute arguments into a template.
 *
 * `$ARGS` takes everything the user typed after the command; `$1`…`$9` take
 * whitespace-separated words. A template with no placeholder gets the arguments
 * appended, because silently dropping what the user typed is the one behaviour
 * nobody expects.
 */
export function expandPrompt(template: string, args: string): string {
    const trimmed = args.trim();
    const words = trimmed ? trimmed.split(/\s+/) : [];
    const hasArgsToken = /\$ARGS\b/.test(template);
    const hasPositional = /\$[1-9]\b/.test(template);

    let out = template.replace(/\$ARGS\b/g, trimmed);
    out = out.replace(/\$([1-9])\b/g, (_m, d) => words[Number(d) - 1] ?? '');

    if (!hasArgsToken && !hasPositional && trimmed) {
        out = `${out}\n\n${trimmed}`;
    }
    return out.trim();
}

/** Parse `/name rest of the line` into its parts, or undefined if not a slash command. */
export function parseSlashInvocation(input: string): { name: string; args: string } | undefined {
    const m = /^\/([a-z][a-z0-9-]*)\s*([\s\S]*)$/i.exec(input.trim());
    if (!m) return undefined;
    return { name: m[1].toLowerCase(), args: m[2] || '' };
}

/**
 * Resolve a workflow to its ordered prompts.
 *
 * Cycle-safe: a workflow that references itself (directly or through a chain) would
 * otherwise recurse until the stack blew. The cycle is reported rather than silently
 * truncated, because a silently shortened workflow looks like it worked.
 */
export function resolveWorkflow(
    entry: UserPrompt,
    byName: Map<string, UserPrompt>,
): { steps: UserPrompt[]; cycle?: string[] } {
    const steps: UserPrompt[] = [];
    const seen = new Set<string>();
    const trail: string[] = [];

    const visit = (prompt: UserPrompt): string[] | undefined => {
        if (seen.has(prompt.name)) return [...trail, prompt.name];
        seen.add(prompt.name);
        trail.push(prompt.name);

        if (prompt.template.trim()) steps.push(prompt);

        for (const stepName of prompt.steps) {
            const next = byName.get(stepName);
            if (!next) continue; // reported at load time as a problem
            const cycle = visit(next);
            if (cycle) return cycle;
        }
        trail.pop();
        return undefined;
    };

    const cycle = visit(entry);
    return cycle ? { steps, cycle } : { steps };
}
