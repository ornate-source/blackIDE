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
