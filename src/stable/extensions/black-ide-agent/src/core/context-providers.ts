import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ─── Context providers (Phase 3, M19) ───────────────────────────────────────
//
// `@`-mentions used to resolve one thing: files. Every `@` query went through a
// single `searchFiles` message, so `@problems`, `@git`, `@terminal` and the rest
// were not merely missing — there was nowhere to put them.
//
// A provider answers two questions: what can I offer for this query (`suggest`),
// and what text should go into the prompt for the thing the user picked
// (`resolve`). Splitting those matters: the dropdown needs to be fast enough to run
// on every keystroke, while resolution happens once per turn and may read files or
// shell out.
//
// ── Budgets are per-provider and enforced here ──────────────────────────────
// Any provider can produce arbitrarily much text — `@folder` on `src/`, `@git` on a
// large diff. Each declares a character budget and is truncated to it *with a
// visible marker*, never silently dropped: an agent that receives half a diff and is
// not told so will reason confidently about code it cannot see.
//
// ── Trust ───────────────────────────────────────────────────────────────────
// Everything a provider returns is untrusted *data*. File contents, commit messages,
// terminal output and web pages are quoted into the prompt, and the system prompt's
// untrusted-content posture (Phase 9, M56) covers them. Providers must never widen a
// tool allowlist or auto-approve anything, and none of them can.

export interface ContextItem {
    /** Stable id, unique within a provider. Round-trips through the webview. */
    id: string;
    /** Shown in the dropdown. */
    label: string;
    /** Second line in the dropdown: a path, a branch, a count. */
    detail?: string;
}

export interface ResolvedContext {
    /** `@file:src/a.ts` — how the mention appears in the composed message. */
    mention: string;
    /** The text injected into the prompt. */
    text: string;
    /** True when `text` was cut to fit the provider's budget. */
    truncated: boolean;
}

export interface ContextProvider {
    /** Mention keyword, without the `@`. */
    readonly id: string;
    readonly title: string;
    readonly description: string;
    /** Maximum characters this provider may contribute to one turn. */
    readonly budget: number;
    /** Candidates for the dropdown. Must be cheap — this runs per keystroke. */
    suggest(query: string): Promise<ContextItem[]>;
    /** Full text for a chosen item. May be expensive. */
    resolve(itemId: string): Promise<string>;
}

/** Truncates to `budget`, appending a marker that says so. Never silently drops. */
export function applyBudget(text: string, budget: number, what: string): ResolvedContext {
    if (text.length <= budget) return { mention: what, text, truncated: false };
    const marker = `\n\n… [${what} truncated: ${text.length - budget} of ${text.length} characters omitted]`;
    return { mention: what, text: text.slice(0, Math.max(0, budget - marker.length)) + marker, truncated: true };
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function rel(p: string): string {
    const root = workspaceRoot();
    return root && p.startsWith(root) ? path.relative(root, p).split(path.sep).join('/') : p;
}

// ─── @file ──────────────────────────────────────────────────────────────────

export class FileProvider implements ContextProvider {
    readonly id = 'file';
    readonly title = 'Files';
    readonly description = 'A file in the workspace';
    readonly budget = 24_000;

    async suggest(query: string): Promise<ContextItem[]> {
        const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,dist,out,build,.git}/**', 2000);
        const needle = query.toLowerCase();
        return uris
            .map(u => rel(u.fsPath))
            .filter(p => !needle || p.toLowerCase().includes(needle))
            .sort((a, b) => scorePath(a, needle) - scorePath(b, needle) || a.length - b.length)
            .slice(0, 20)
            .map(p => ({ id: p, label: path.basename(p), detail: p }));
    }

    async resolve(itemId: string): Promise<string> {
        const root = workspaceRoot();
        if (!root) return '';
        try {
            const content = await fs.promises.readFile(path.join(root, itemId), 'utf8');
            return `--- ${itemId} ---\n${content}`;
        } catch {
            return `--- ${itemId} ---\n[could not be read]`;
        }
    }
}

/** Lower is better: prefer a basename match over a match buried in a directory. */
function scorePath(p: string, needle: string): number {
    if (!needle) return 0;
    const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    if (base === needle) return 0;
    if (base.startsWith(needle)) return 1;
    if (base.includes(needle)) return 2;
    return 3;
}

// ─── @folder ────────────────────────────────────────────────────────────────

export class FolderProvider implements ContextProvider {
    readonly id = 'folder';
    readonly title = 'Folders';
    readonly description = 'Every file in a directory, as a tree plus contents';
    readonly budget = 32_000;

    async suggest(query: string): Promise<ContextItem[]> {
        const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,dist,out,build,.git}/**', 2000);
        const dirs = new Map<string, number>();
        for (const uri of uris) {
            const dir = rel(uri.fsPath).split('/').slice(0, -1).join('/');
            if (!dir) continue;
            dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
        }
        const needle = query.toLowerCase();
        return Array.from(dirs.entries())
            .filter(([dir]) => !needle || dir.toLowerCase().includes(needle))
            .sort((a, b) => a[0].length - b[0].length)
            .slice(0, 20)
            .map(([dir, count]) => ({ id: dir, label: dir, detail: `${count} file${count === 1 ? '' : 's'}` }));
    }

    async resolve(itemId: string): Promise<string> {
        const root = workspaceRoot();
        if (!root) return '';
        const uris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(path.join(root, itemId), '**/*'),
            '**/{node_modules,dist,out,build,.git}/**',
            200,
        );
        const parts = [`--- folder ${itemId} (${uris.length} files) ---`];
        for (const uri of uris) {
            try {
                parts.push(`\n--- ${rel(uri.fsPath)} ---\n${await fs.promises.readFile(uri.fsPath, 'utf8')}`);
            } catch { /* unreadable file listed but not included */ }
        }
        return parts.join('\n');
    }
}

// ─── @problems ──────────────────────────────────────────────────────────────

export class ProblemsProvider implements ContextProvider {
    readonly id = 'problems';
    readonly title = 'Problems';
    readonly description = 'Current compiler and linter diagnostics';
    readonly budget = 8_000;

    async suggest(query: string): Promise<ContextItem[]> {
        const entries = vscode.languages.getDiagnostics() as Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
        const withProblems = entries.filter(([, d]) => d && d.length > 0);
        const total = withProblems.reduce((sum, [, d]) => sum + d.length, 0);

        const items: ContextItem[] = [{
            id: '*',
            label: 'All problems',
            detail: `${total} in ${withProblems.length} file${withProblems.length === 1 ? '' : 's'}`,
        }];
        const needle = query.toLowerCase();
        for (const [uri, diags] of withProblems) {
            const p = rel(uri.fsPath);
            if (needle && !p.toLowerCase().includes(needle)) continue;
            items.push({ id: p, label: path.basename(p), detail: `${diags.length} problem(s) — ${p}` });
        }
        return items.slice(0, 20);
    }

    async resolve(itemId: string): Promise<string> {
        const entries = vscode.languages.getDiagnostics() as Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
        const lines: string[] = [];
        for (const [uri, diags] of entries) {
            const p = rel(uri.fsPath);
            if (itemId !== '*' && p !== itemId) continue;
            if (!diags?.length) continue;
            lines.push(`${p}:`);
            for (const d of diags) {
                const severity = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
                lines.push(`  ${severity} line ${d.range.start.line + 1}: ${d.message}`);
            }
        }
        return lines.length ? `--- problems ---\n${lines.join('\n')}` : '--- problems ---\nNone reported.';
    }
}

// ─── @git ───────────────────────────────────────────────────────────────────

export type GitRunner = (args: string[]) => Promise<string>;

export class GitProvider implements ContextProvider {
    readonly id = 'git';
    readonly title = 'Git';
    readonly description = 'Working diff, staged diff, branch, or recent commits';
    readonly budget = 20_000;

    constructor(private readonly git: GitRunner) {}

    async suggest(query: string): Promise<ContextItem[]> {
        const all: ContextItem[] = [
            { id: 'diff', label: 'Working diff', detail: 'Uncommitted changes' },
            { id: 'staged', label: 'Staged diff', detail: 'What would be committed' },
            { id: 'branch', label: 'Branch & status', detail: 'Current branch and file states' },
            { id: 'log', label: 'Recent commits', detail: 'Last 20 commit subjects' },
        ];
        const needle = query.toLowerCase();
        return needle ? all.filter(i => i.id.includes(needle) || i.label.toLowerCase().includes(needle)) : all;
    }

    async resolve(itemId: string): Promise<string> {
        try {
            switch (itemId) {
                case 'diff': return `--- git diff ---\n${await this.git(['diff'])}`;
                case 'staged': return `--- git diff --staged ---\n${await this.git(['diff', '--staged'])}`;
                case 'log': return `--- git log ---\n${await this.git(['log', '-20', '--pretty=format:%h %ad %an: %s', '--date=short'])}`;
                case 'branch':
                default:
                    return `--- git status ---\n${await this.git(['status', '--short', '--branch'])}`;
            }
        } catch (e: any) {
            // Not a git repo, or git is absent. Say which, rather than returning
            // an empty block the model will read as "there are no changes".
            return `--- git ---\n[unavailable: ${e?.message || e}]`;
        }
    }
}

// ─── @terminal ──────────────────────────────────────────────────────────────

/** Ring buffer of recent command output, filled by the tool runner. */
export class TerminalHistory {
    private readonly entries: { command: string; output: string; at: number }[] = [];

    constructor(private readonly max = 10) {}

    record(command: string, output: string): void {
        this.entries.push({ command, output, at: Date.now() });
        while (this.entries.length > this.max) this.entries.shift();
    }

    list(): { command: string; output: string; at: number }[] {
        return [...this.entries].reverse();   // newest first
    }
}

export class TerminalProvider implements ContextProvider {
    readonly id = 'terminal';
    readonly title = 'Terminal';
    readonly description = 'Recent commands run by the agent and their output';
    readonly budget = 12_000;

    constructor(private readonly history: TerminalHistory) {}

    async suggest(query: string): Promise<ContextItem[]> {
        const entries = this.history.list();
        const needle = query.toLowerCase();
        const items: ContextItem[] = entries.length
            ? [{ id: '*', label: 'All recent output', detail: `${entries.length} command(s)` }]
            : [];
        entries.forEach((entry, i) => {
            if (needle && !entry.command.toLowerCase().includes(needle)) return;
            items.push({ id: String(i), label: entry.command.slice(0, 60), detail: new Date(entry.at).toLocaleTimeString() });
        });
        return items.slice(0, 20);
    }

    async resolve(itemId: string): Promise<string> {
        const entries = this.history.list();
        const chosen = itemId === '*' ? entries : [entries[Number(itemId)]].filter(Boolean);
        if (!chosen.length) return '--- terminal ---\nNo commands have been run in this session.';
        return `--- terminal ---\n${chosen.map(e => `$ ${e.command}\n${e.output}`).join('\n\n')}`;
    }
}

// ─── @symbol ────────────────────────────────────────────────────────────────

/**
 * A function, class or method by name, resolved from the M15 code graph.
 *
 * This is the provider M19 shipped without, and it is small *because* M15 landed
 * first: the graph already knows every symbol's file and line span, so this is a
 * lookup and a ranged read rather than a parse.
 *
 * What it contributes over `@file` is the reason to have it: the definition's own
 * lines instead of a whole file the budget would truncate, plus **who references it**.
 * "Change this function" and "change this function and its callers" are different
 * tasks, and only the second one is answerable without a follow-up turn.
 */
export class SymbolProvider implements ContextProvider {
    readonly id = 'symbol';
    readonly title = 'Symbols';
    readonly description = 'A function, class or method, with its callers';
    readonly budget = 16_000;

    constructor(private readonly graph: () => SymbolGraph | undefined) {}

    async suggest(query: string): Promise<ContextItem[]> {
        const graph = this.graph();
        if (!graph || graph.fileCount === 0) return [];
        return graph.searchSymbols(query, 20).map(s => ({
            // The id carries the file and line so `resolve` never has to re-search and
            // cannot land on a different same-named symbol than the one that was picked.
            id: `${s.name}|${s.file}|${s.startLine}`,
            label: s.name,
            detail: `${s.kind}${s.parent ? ` in ${s.parent}` : ''} — ${s.file}:${s.startLine}`,
        }));
    }

    async resolve(itemId: string): Promise<string> {
        const graph = this.graph();
        const [name, file, startLine] = itemId.split('|');

        // "The index is not built" and "that symbol does not exist" look identical to a
        // model and have completely different fixes — the same distinction M16's
        // impact_analysis output draws.
        if (!graph || graph.fileCount === 0) {
            return `--- symbol ${name || itemId} ---\n[the code index is not built yet, so no symbol could be resolved. It builds on the first agent turn in a workspace.]`;
        }
        if (!name || !file) return `--- symbol ${itemId} ---\n[unrecognised symbol reference]`;

        const definitions = graph.definitionsOf(name);
        const chosen = definitions.find(d => d.file === file && String(d.startLine) === startLine)
            ?? definitions.find(d => d.file === file)
            ?? definitions[0];
        if (!chosen) return `--- symbol ${name} ---\n[no definition of "${name}" is in the index]`;

        const root = workspaceRoot();
        let body = '[definition could not be read from disk]';
        if (root) {
            try {
                const content = await fs.promises.readFile(path.join(root, chosen.file), 'utf8');
                const lines = content.split(/\r?\n/);
                // Line numbers from the graph are 1-based and inclusive.
                body = lines.slice(Math.max(0, chosen.startLine - 1), chosen.endLine).join('\n');
            } catch { /* keep the placeholder — say it, do not fake it */ }
        }

        const parts = [
            `--- symbol ${name} (${chosen.kind}) — ${chosen.file}:${chosen.startLine}-${chosen.endLine} ---`,
            body,
        ];

        const referencing = graph.referencesOf(name).filter(f => f !== chosen.file);
        if (referencing.length) {
            // Bounded, and the bound is stated. A symbol referenced in 200 files would
            // otherwise spend the whole budget on a file list.
            const shown = referencing.slice(0, 30);
            parts.push(
                `\n--- referenced in ${referencing.length} other file(s)${referencing.length > shown.length ? `, first ${shown.length} shown` : ''} ---`,
                shown.join('\n'),
                // The graph is name-keyed, not binding-keyed (M15's design position), so
                // say what the list is before a model treats it as resolved truth.
                '\n[Name-matched from the code graph, not binding-resolved. Use find_references for an authoritative list.]',
            );
        }

        if (definitions.length > 1) {
            parts.push(`\n[Warning: "${name}" is defined in ${definitions.length} places; this is the one at ${chosen.file}:${chosen.startLine}.]`);
        }

        return parts.join('\n');
    }
}

/**
 * The slice of `CodeGraph` this provider needs.
 *
 * Structural rather than a direct import so `context-providers.ts` does not depend on
 * the index: the provider is about presentation, and a test can hand it three symbols
 * without building a corpus.
 */
export interface SymbolGraph {
    readonly fileCount: number;
    searchSymbols(query: string, limit?: number): { name: string; file: string; startLine: number; endLine: number; kind: string; parent?: string }[];
    definitionsOf(name: string): { name: string; file: string; startLine: number; endLine: number; kind: string; parent?: string }[];
    referencesOf(name: string): string[];
}

// ─── @rules / @skills / @past-chats ─────────────────────────────────────────

export class StaticListProvider implements ContextProvider {
    readonly budget: number;

    constructor(
        readonly id: string,
        readonly title: string,
        readonly description: string,
        private readonly load: () => Promise<{ id: string; label: string; detail?: string; body: string }[]>,
        budget = 12_000,
    ) {
        this.budget = budget;
    }

    async suggest(query: string): Promise<ContextItem[]> {
        const needle = query.toLowerCase();
        const items = await this.load();
        return items
            .filter(i => !needle || i.label.toLowerCase().includes(needle))
            .slice(0, 20)
            .map(({ id, label, detail }) => ({ id, label, ...(detail ? { detail } : {}) }));
    }

    async resolve(itemId: string): Promise<string> {
        const found = (await this.load()).find(i => i.id === itemId);
        return found ? `--- ${this.id}: ${found.label} ---\n${found.body}` : '';
    }
}

// ─── @docs (Phase 3, M20) ───────────────────────────────────────────────────

/**
 * A crawled documentation set, searched locally.
 *
 * The mention carries a query rather than an id: `@docs:django/how do querysets cache`.
 * A doc set is 60 pages, so selecting the *set* and injecting all of it would spend the
 * whole budget on one framework's front matter — the useful unit is the passage that
 * answers the question, which means the query has to reach the provider.
 */
export class DocsProvider implements ContextProvider {
    readonly id = 'docs';
    readonly title = 'Docs';
    readonly description = 'An indexed documentation set — `@docs:<set>/<question>`';
    readonly budget = 14_000;

    constructor(
        private readonly listSets: () => Promise<{ name: string; rootUrl: string; pages: number }[]>,
        private readonly search: (set: string, query: string) => Promise<{ url: string; title: string; excerpt: string }[]>,
    ) {}

    async suggest(query: string): Promise<ContextItem[]> {
        const sets = await this.listSets();
        const [setPart] = splitDocsQuery(query);
        const needle = setPart.toLowerCase();
        if (!sets.length) {
            // A menu entry that explains the empty state, because "no matches" and "you
            // have not indexed any docs yet" call for completely different actions.
            return [{ id: '', label: 'No doc sets indexed', detail: 'Run "Black IDE: Add Docs" to crawl one' }];
        }
        return sets
            .filter(s => !needle || s.name.toLowerCase().includes(needle))
            .slice(0, 20)
            .map(s => ({ id: `${s.name}/`, label: s.name, detail: `${s.pages} pages — ${s.rootUrl}` }));
    }

    async resolve(itemId: string): Promise<string> {
        const [set, query] = splitDocsQuery(itemId);
        if (!set) return '--- docs ---\n[no doc set named. Use @docs:<set>/<question>.]';

        const sets = await this.listSets();
        if (!sets.some(s => s.name.toLowerCase() === set.toLowerCase())) {
            const names = sets.map(s => s.name).join(', ') || 'none indexed';
            return `--- docs: ${set} ---\n[no such doc set. Available: ${names}.]`;
        }
        if (!query.trim()) {
            // Deliberately not "here is the whole set": it would blow the budget and bury
            // whatever the user actually wanted.
            return `--- docs: ${set} ---\n[add a question after the set name, e.g. @docs:${set}/how do I paginate.]`;
        }

        const hits = await this.search(set, query);
        if (!hits.length) return `--- docs: ${set} — "${query}" ---\nNo passage matched. The set may not cover this topic.`;

        return [`--- docs: ${set} — "${query}" ---`]
            .concat(hits.map(h => `[${h.title}] ${h.url}\n${h.excerpt}`))
            .join('\n\n');
    }
}

/** `django/how do querysets cache` → `['django', 'how do querysets cache']`. */
export function splitDocsQuery(raw: string): [string, string] {
    const cut = raw.indexOf('/');
    if (cut === -1) return [raw.trim(), ''];
    return [raw.slice(0, cut).trim(), raw.slice(cut + 1)];
}

// ─── @web (Phase 3, M21) ────────────────────────────────────────────────────

/**
 * A live web search, resolved at turn time.
 *
 * `suggest` cannot offer results — it runs per keystroke and a search per keystroke is
 * both slow and rude to the provider — so it offers the *query itself* as the item. The
 * search happens once, in `resolve`, when the message is actually sent.
 */
export class WebProvider implements ContextProvider {
    readonly id = 'web';
    readonly title = 'Web';
    readonly description = 'A live web search — `@web:<query>`';
    readonly budget = 10_000;

    constructor(private readonly search: (query: string) => Promise<string>) {}

    async suggest(query: string): Promise<ContextItem[]> {
        const trimmed = query.trim();
        if (!trimmed) return [{ id: '', label: 'Type a search query', detail: 'e.g. @web:django 5 async orm' }];
        return [{ id: trimmed, label: `Search the web for "${trimmed}"`, detail: 'Runs when you send the message' }];
    }

    async resolve(itemId: string): Promise<string> {
        const query = itemId.trim();
        if (!query) return '--- web ---\n[no query given]';
        try {
            return `--- web search: "${query}" ---\n${await this.search(query)}`;
        } catch (e: any) {
            // Naming the failure rather than returning nothing: an empty block reads as
            // "the web had nothing to say about this", which is a different claim.
            return `--- web search: "${query}" ---\n[search failed: ${e?.message || e}]`;
        }
    }
}

// ─── Registry ───────────────────────────────────────────────────────────────

export class ContextProviderRegistry {
    private readonly providers = new Map<string, ContextProvider>();

    register(provider: ContextProvider): void {
        this.providers.set(provider.id, provider);
    }

    get(id: string): ContextProvider | undefined {
        return this.providers.get(id);
    }

    list(): ContextProvider[] {
        return Array.from(this.providers.values());
    }

    /**
     * Answers one dropdown query.
     *
     * `@foo` with no colon offers matching *providers* as well as files, so the set
     * stays discoverable — a user who does not know `@problems` exists will never
     * type it. `@problems:x` narrows within one provider. `@file` remains the
     * default so the old muscle memory (`@somefile.ts`) keeps working unchanged.
     */
    async suggest(raw: string): Promise<{ provider: string; items: ContextItem[] }[]> {
        const colon = raw.indexOf(':');
        if (colon !== -1) {
            const provider = this.providers.get(raw.slice(0, colon));
            if (!provider) return [];
            return [{ provider: provider.id, items: await safeSuggest(provider, raw.slice(colon + 1)) }];
        }

        const needle = raw.toLowerCase();
        const out: { provider: string; items: ContextItem[] }[] = [];

        const matchingProviders = this.list().filter(p => p.id !== 'file' && p.id.startsWith(needle));
        if (matchingProviders.length > 0) {
            out.push({
                provider: 'providers',
                items: matchingProviders.map(p => ({ id: `${p.id}:`, label: `@${p.id}`, detail: p.description })),
            });
        }

        const files = this.providers.get('file');
        if (files) out.push({ provider: 'file', items: await safeSuggest(files, raw) });

        return out;
    }

    /** Resolves `provider:itemId`, applying that provider's budget. */
    async resolve(mention: string): Promise<ResolvedContext | undefined> {
        const colon = mention.indexOf(':');
        const providerId = colon === -1 ? 'file' : mention.slice(0, colon);
        const itemId = colon === -1 ? mention : mention.slice(colon + 1);

        const provider = this.providers.get(providerId);
        if (!provider) return undefined;

        try {
            const text = await provider.resolve(itemId);
            return applyBudget(text, provider.budget, `@${providerId}:${itemId}`);
        } catch (e: any) {
            // One broken provider must not take the whole turn down with it.
            return { mention: `@${providerId}:${itemId}`, text: `[${providerId} failed: ${e?.message || e}]`, truncated: false };
        }
    }
}

/** A provider that throws mid-keystroke must not empty the dropdown. */
async function safeSuggest(provider: ContextProvider, query: string): Promise<ContextItem[]> {
    try {
        return await provider.suggest(query);
    } catch {
        return [];
    }
}
