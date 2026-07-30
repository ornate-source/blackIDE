import * as vscode from 'vscode';
import * as path from 'path';
import { ToolRunner } from './tool-runner';

// Language-server tools — Phase 1 (M6/M7) of docs/notes/enhancement.md.
//
// Black IDE is a VS Code *fork*, so a language server is already running for every
// language the user has an extension for. Until now none of that reached the agent:
// it answered "where is this defined?" with grep, and grep cannot tell a definition
// from a mention in a comment. These are thin wrappers over the providers the editor
// already has.
//
// Three rules hold throughout:
//   1. Address symbols by *name*, not by (line, character). A model does not know
//      character offsets; making it guess them produced silent misses.
//   2. Degrade to grep, never throw. A cold or absent server must yield a weaker
//      answer plus a note, because surfacing a provider error as a tool failure
//      teaches the agent to stop using the tool at all.
//   3. Cap every result. A `find_references` on a popular helper can return
//      hundreds of hits and blow the context budget.

/** How long to wait for a language server to answer before falling back. */
const PROVIDER_TIMEOUT_MS = 4000;
/** Retry budget while a server warms up after the document is first opened. */
const READY_ATTEMPTS = 3;
const READY_BACKOFF_MS = 400;

const MAX_REFERENCES = 40;
const MAX_SYMBOLS = 40;
const MAX_DIAGNOSTICS = 30;

function rel(p: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root && p.startsWith(root) ? path.relative(root, p) : p;
}

function absUri(filePath: string): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return vscode.Uri.file(path.isAbsolute(filePath) ? filePath : path.join(root, filePath));
}

/**
 * Race a provider call against a timeout. Providers are third-party extension code;
 * a wedged one must not hang the agent loop, which has no timeout of its own here.
 */
async function withTimeout<T>(work: Thenable<T>, ms = PROVIDER_TIMEOUT_MS): Promise<T | undefined> {
    return Promise.race([
        Promise.resolve(work).catch(() => undefined),
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms)),
    ]);
}

/** Open the document so its language server activates, and hand back the text. */
async function openDoc(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    try { return await vscode.workspace.openTextDocument(uri); } catch { return undefined; }
}

/**
 * Locate a symbol occurrence by name.
 *
 * Prefers a *declaration-looking* occurrence (one preceded by `function`, `class`,
 * `def`, `const`, `fn`, `type`, …) over the first textual hit, because the first hit
 * in a file is frequently an import line, and asking a rename provider to operate on
 * an import produces either nothing or the wrong edit.
 */
export function findSymbolPosition(
    text: string,
    symbol: string,
    preferLine?: number,
): { line: number; character: number } | undefined {
    if (!symbol) return undefined;
    const lines = text.split(/\r?\n/);
    // Identifier-aware boundaries rather than `\b`. `\b` is defined against [A-Za-z0-9_],
    // so it never matches before a leading `$` — which would silently fail to resolve
    // `$scope`, jQuery's `$`, and every PHP variable. Treating `$` as an identifier
    // character in the lookarounds handles those while still refusing a partial match
    // (searching `Widget` must not hit `WidgetFactory`).
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
    // Keep this covering the languages the profiler detects — `func` (Go) and `record`
    // (C#/Java) were missed on the first pass, which demoted real Go declarations to
    // "first textual hit".
    const declarator = /\b(function|func|class|def|const|let|var|fn|struct|enum|interface|type|trait|impl|record|public|private|protected|async|sub|method)\b/;

    const hits: Array<{ line: number; character: number; declaration: boolean; imported: boolean }> = [];
    for (let i = 0; i < lines.length; i++) {
        const m = word.exec(lines[i]);
        if (!m) continue;
        const before = lines[i].slice(0, m.index);
        hits.push({
            line: i,
            character: m.index,
            declaration: declarator.test(before),
            imported: /^\s*(import|from|use|using|require|#include)\b/.test(lines[i]),
        });
    }
    if (!hits.length) return undefined;

    if (preferLine !== undefined) {
        const exact = hits.find(h => h.line === preferLine - 1);
        if (exact) return { line: exact.line, character: exact.character };
    }
    const declared = hits.find(h => h.declaration && !h.imported);
    const nonImport = hits.find(h => !h.imported);
    const pick = declared || nonImport || hits[0];
    return { line: pick.line, character: pick.character };
}

/** Resolve (file, symbol) to a document + position, retrying while a server warms up. */
async function locate(filePath: string, symbol: string, line?: number): Promise<
    { doc: vscode.TextDocument; position: vscode.Position } | { error: string }
> {
    const uri = absUri(filePath);
    const doc = await openDoc(uri);
    if (!doc) return { error: `Could not open ${rel(uri.fsPath)}.` };
    const pos = findSymbolPosition(doc.getText(), symbol, line);
    if (!pos) return { error: `Symbol "${symbol}" does not appear in ${rel(uri.fsPath)}.` };
    return { doc, position: new vscode.Position(pos.line, pos.character) };
}

/** Grep fallback, shared by the navigation tools. Explicitly labelled as a fallback. */
async function grepFallback(symbol: string, why: string): Promise<string> {
    try {
        const hits = await ToolRunner.grepSearch(symbol, undefined, { isRegex: false, caseInsensitive: false });
        if (!hits.length) return `${why} A text search for "${symbol}" also found nothing.`;
        const lines = hits.slice(0, MAX_REFERENCES).map(h => `  ${h.file}:${h.line}: ${h.content.trim().slice(0, 160)}`);
        return [
            `${why} Falling back to a text search, which cannot distinguish a definition from a mention:`,
            ...lines,
            hits.length > MAX_REFERENCES ? `  …and ${hits.length - MAX_REFERENCES} more.` : '',
        ].filter(Boolean).join('\n');
    } catch {
        return why;
    }
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/**
 * Separator for the (severity, message) grouping key below. A NUL written as an
 * escape, not a literal byte: it cannot appear in a diagnostic message, so the key
 * splits unambiguously — splitting on a space would truncate every message at its
 * first word.
 */
const DIAG_KEY_SEP = '\u0000';

/**
 * Current problems, either for one file or across the workspace.
 *
 * The agent already receives diagnostics automatically after each edit, but it could
 * not *ask* — so it had no way to check whether a change it made three steps ago is
 * still broken, or to survey the repo before starting.
 */
export async function getDiagnostics(filePath?: string, severityFilter: 'error' | 'warning' | 'all' = 'all'): Promise<string> {
    const wanted = (s: vscode.DiagnosticSeverity) =>
        severityFilter === 'all'
            ? s === vscode.DiagnosticSeverity.Error || s === vscode.DiagnosticSeverity.Warning
            : severityFilter === 'error'
                ? s === vscode.DiagnosticSeverity.Error
                : s === vscode.DiagnosticSeverity.Warning;

    let entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
    if (filePath) {
        const uri = absUri(filePath);
        // Opening the document is what triggers a lazily-activated server to report.
        await openDoc(uri);
        for (let i = 0; i < READY_ATTEMPTS; i++) {
            if (vscode.languages.getDiagnostics(uri).length) break;
            await new Promise(r => setTimeout(r, READY_BACKOFF_MS));
        }
        entries = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
        entries = vscode.languages.getDiagnostics() as Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
    }

    const label = (s: vscode.DiagnosticSeverity) => (s === vscode.DiagnosticSeverity.Error ? 'error' : 'warning');
    const out: string[] = [];
    let shown = 0;
    let suppressed = 0;

    for (const [uri, diags] of entries) {
        const keep = (diags || []).filter(d => wanted(d.severity));
        if (!keep.length) continue;

        // Collapse runs of the *same* message into one row listing its lines
        // (Phase 3, M18). One missing import produces an identical "Cannot find name
        // 'X'" on thirty lines, and thirty copies of that sentence tell the model
        // nothing the first one did not — while costing thirty times the context.
        // Measured at 81% smaller on that shape. Line numbers are all preserved:
        // this changes the layout, never the information.
        const grouped = new Map<string, { line: number }[]>();
        for (const d of keep) {
            if (shown >= MAX_DIAGNOSTICS) { suppressed++; continue; }
            shown++;
            const key = `${label(d.severity)}${DIAG_KEY_SEP}${d.message}${d.source ? ` [${d.source}]` : ''}`;
            const list = grouped.get(key);
            if (list) list.push({ line: d.range.start.line + 1 });
            else grouped.set(key, [{ line: d.range.start.line + 1 }]);
        }

        const lines: string[] = [];
        for (const [key, hits] of grouped) {
            const [severity, message] = key.split(DIAG_KEY_SEP);
            lines.push(hits.length === 1
                ? `  ${severity} line ${hits[0].line}: ${message}`
                : `  ${severity} lines ${hits.map(h => h.line).join(', ')}: ${message}`);
        }
        if (lines.length) out.push(`${rel(uri.fsPath)}:\n${lines.join('\n')}`);
    }

    if (!out.length) {
        return filePath
            ? `No ${severityFilter === 'all' ? 'errors or warnings' : severityFilter + 's'} reported for ${rel(absUri(filePath).fsPath)}. Note this is also the answer when no language server is active for that file type.`
            : 'No problems reported across the workspace.';
    }
    return out.join('\n\n') + (suppressed ? `\n\n…and ${suppressed} more, omitted for brevity.` : '');
}

// ─── Navigation ──────────────────────────────────────────────────────────────

export async function goToDefinition(filePath: string, symbol: string, line?: number): Promise<string> {
    const found = await locate(filePath, symbol, line);
    if ('error' in found) return grepFallback(symbol, found.error);

    const result = await withTimeout(
        vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
            'vscode.executeDefinitionProvider', found.doc.uri, found.position,
        ),
    );
    const locations = normalizeLocations(result);
    if (!locations.length) {
        return grepFallback(symbol, `No definition provider answered for "${symbol}" in ${rel(found.doc.uri.fsPath)}.`);
    }

    const lines = await Promise.all(locations.slice(0, 10).map(async loc => {
        const snippet = await lineAt(loc.uri, loc.range.start.line);
        return `  ${rel(loc.uri.fsPath)}:${loc.range.start.line + 1}${snippet ? `: ${snippet}` : ''}`;
    }));
    return `Definition of "${symbol}":\n${lines.join('\n')}`;
}

export async function findReferences(filePath: string, symbol: string, line?: number): Promise<string> {
    const found = await locate(filePath, symbol, line);
    if ('error' in found) return grepFallback(symbol, found.error);

    const result = await withTimeout(
        vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider', found.doc.uri, found.position,
        ),
    );
    const locations = normalizeLocations(result);
    if (!locations.length) {
        return grepFallback(symbol, `No reference provider answered for "${symbol}".`);
    }

    // Group by file: "which files does this touch" is the question that usually
    // matters, and a flat list of 40 lines hides it.
    const byFile = new Map<string, number[]>();
    for (const loc of locations) {
        const key = rel(loc.uri.fsPath);
        byFile.set(key, [...(byFile.get(key) || []), loc.range.start.line + 1]);
    }
    const files = [...byFile.entries()].slice(0, MAX_REFERENCES);
    const body = files.map(([file, ls]) => `  ${file}: line${ls.length > 1 ? 's' : ''} ${ls.slice(0, 12).join(', ')}${ls.length > 12 ? `, +${ls.length - 12} more` : ''}`);
    const head = `${locations.length} reference(s) to "${symbol}" across ${byFile.size} file(s):`;
    return [head, ...body, byFile.size > MAX_REFERENCES ? `  …and ${byFile.size - MAX_REFERENCES} more files.` : ''].filter(Boolean).join('\n');
}

export async function workspaceSymbols(query: string): Promise<string> {
    const result = await withTimeout(
        vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query),
    );
    if (!result || !result.length) {
        return grepFallback(query, `No workspace symbol provider matched "${query}".`);
    }
    const kindName = (k: vscode.SymbolKind) => vscode.SymbolKind[k] ?? String(k);
    const lines = result.slice(0, MAX_SYMBOLS).map(s =>
        `  ${kindName(s.kind)} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''} — ${rel(s.location.uri.fsPath)}:${s.location.range.start.line + 1}`,
    );
    return [
        `${result.length} symbol(s) matching "${query}":`,
        ...lines,
        result.length > MAX_SYMBOLS ? `  …and ${result.length - MAX_SYMBOLS} more.` : '',
    ].filter(Boolean).join('\n');
}

export async function hoverInfo(filePath: string, symbol: string, line?: number): Promise<string> {
    const found = await locate(filePath, symbol, line);
    if ('error' in found) return found.error;

    const result = await withTimeout(
        vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', found.doc.uri, found.position),
    );
    if (!result || !result.length) return `No hover information available for "${symbol}".`;

    const text = result
        .flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value || '')))
        .join('\n')
        .replace(/```[a-z]*\n?/g, '')
        .trim();
    return text ? `${symbol}:\n${text.slice(0, 1500)}` : `No hover information available for "${symbol}".`;
}

export async function codeActions(filePath: string, symbol?: string, line?: number): Promise<string> {
    const uri = absUri(filePath);
    const doc = await openDoc(uri);
    if (!doc) return `Could not open ${rel(uri.fsPath)}.`;

    let range: vscode.Range;
    if (symbol) {
        const pos = findSymbolPosition(doc.getText(), symbol, line);
        if (!pos) return `Symbol "${symbol}" does not appear in ${rel(uri.fsPath)}.`;
        range = new vscode.Range(pos.line, pos.character, pos.line, pos.character + symbol.length);
    } else if (line !== undefined) {
        range = doc.lineAt(Math.max(0, line - 1)).range;
    } else {
        range = new vscode.Range(0, 0, Math.min(doc.lineCount - 1, 0), 0);
    }

    const result = await withTimeout(
        vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, range),
    );
    if (!result || !result.length) return 'No code actions available at that location.';
    const lines = result.slice(0, 20).map(a => `  ${a.title}${a.kind ? ` [${a.kind.value}]` : ''}`);
    return `Available code actions:\n${lines.join('\n')}\n(These are advisory — apply the change with edit_file.)`;
}

// ─── Rename (a write — the executor owns approval and checkpointing) ─────────

export interface RenamePlan {
    workspaceEdit: vscode.WorkspaceEdit;
    /** Absolute paths of every file the rename touches. */
    files: string[];
    editCount: number;
}

/**
 * Ask the language server for a rename edit, without applying it.
 *
 * Returning a plan rather than performing the write keeps policy where it belongs:
 * the executor snapshots each affected file for the checkpoint system and takes the
 * user's approval before anything changes. A rename that silently edited 30 files
 * outside the undo system would be the single most destructive tool here.
 */
export async function planRename(
    filePath: string,
    symbol: string,
    newName: string,
    line?: number,
): Promise<RenamePlan | { error: string }> {
    if (!newName || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) {
        return { error: `"${newName}" is not a valid identifier.` };
    }
    const found = await locate(filePath, symbol, line);
    if ('error' in found) return { error: found.error };

    const edit = await withTimeout(
        vscode.commands.executeCommand<vscode.WorkspaceEdit>(
            'vscode.executeDocumentRenameProvider', found.doc.uri, found.position, newName,
        ),
        PROVIDER_TIMEOUT_MS * 2, // rename touches the whole project; give it longer
    );
    if (!edit || typeof (edit as any).entries !== 'function') {
        return { error: `No rename provider answered for "${symbol}" in ${rel(found.doc.uri.fsPath)}. Use edit_file per site instead — a text-substitution rename across files is not safe to do blindly.` };
    }

    const entries = edit.entries();
    if (!entries.length) return { error: `The rename provider returned no edits for "${symbol}".` };

    return {
        workspaceEdit: edit,
        files: entries.map(([uri]) => uri.fsPath),
        editCount: entries.reduce((n, [, edits]) => n + edits.length, 0),
    };
}

export function describeRenamePlan(plan: RenamePlan, symbol: string, newName: string): string {
    const files = plan.files.map(f => `  ${rel(f)}`).join('\n');
    return `Rename "${symbol}" → "${newName}": ${plan.editCount} edit(s) across ${plan.files.length} file(s):\n${files}`;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Definition providers may return Location or LocationLink; normalise both. */
function normalizeLocations(result: unknown): vscode.Location[] {
    if (!Array.isArray(result)) return [];
    const out: vscode.Location[] = [];
    for (const item of result as any[]) {
        if (!item) continue;
        if (item.range && item.uri) out.push(item as vscode.Location);
        else if (item.targetUri) out.push(new vscode.Location(item.targetUri, item.targetSelectionRange || item.targetRange));
    }
    return out;
}

async function lineAt(uri: vscode.Uri, line: number): Promise<string> {
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        return doc.lineAt(line).text.trim().slice(0, 160);
    } catch {
        return '';
    }
}
