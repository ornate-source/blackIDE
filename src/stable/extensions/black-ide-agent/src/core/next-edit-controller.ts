import * as vscode from 'vscode';
import * as path from 'path';
import { SecretManager } from './secret-manager';
import { LLMClient } from './llm-client';
import { loadModelRouter } from './model-router-loader';
import { CodeGraph } from './code-graph';
import { EditHistory } from './edit-history';
import { agentIsWriting, withinAgentEditGrace } from './edit-origin';
import {
    DocumentStamp, NextEditCandidate, NextEditPrediction, NextEditStats,
    budgetSignal, buildNextEditPrompt, isStale, normalizePath, parseProposal,
    selectCandidates, validateProposal,
} from './next-edit';

// ─── Next-edit: the editor surface (Phase 5, M28) ───────────────────────────
//
// The engine in `next-edit.ts` is pure and tested without a host. This is the half that
// cannot be: document change events, the model call, and how a prediction is put in
// front of a human. It is kept as thin as the seam allows, because everything here runs
// on the keystroke path and everything here is untestable outside an extension host.
//
// ── Why this is not an InlineCompletionItemProvider ──────────────────────────
// Ghost text is rendered where the cursor is. The entire point of next-edit is that the
// next change is usually *not* where the cursor is — two functions down, or in the file
// that imports this one — and the stable inline-completion API has no way to render
// there. So the affordance is a jump: the status bar names the target, one keypress
// takes you to it, and the same keypress applies it once you are there. That is also
// what makes the cross-file case a first-class outcome rather than a special case.
//
// ── Off unless asked for ─────────────────────────────────────────────────────
// This spends a model call every time the developer pauses. That is a real cost on
// somebody else's key, so it is opt-in, exposed in Settings next to autocomplete, and
// never enabled as a side effect of anything else.

/** Idle time after the last keystroke before a prediction is requested. */
const DEFAULT_IDLE_MS = 600;

/** Hard ceiling on the model call. A late prediction is a wrong one — see `isStale`. */
const DEFAULT_BUDGET_MS = 1_500;

/** Candidate files are opened to be read; a huge one is not worth the latency. */
const MAX_CANDIDATE_BYTES = 256_000;

/** How long a settings read is reused before going back to the keychain. */
const SETTINGS_TTL_MS = 5_000;

export interface NextEditSettings {
    enableNextEdit?: boolean;
    nextEditIdleMs?: number;
    nextEditBudgetMs?: number;
}

export class NextEditController implements vscode.Disposable {
    private readonly history = new EditHistory();
    readonly stats = new NextEditStats();

    private readonly disposables: vscode.Disposable[] = [];
    private readonly statusItem: vscode.StatusBarItem;
    private readonly targetDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(96, 165, 250, 0.15)',
        isWholeLine: true,
        overviewRulerColor: 'rgba(96, 165, 250, 0.7)',
        overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    /** The armed prediction, or nothing. Cleared by *any* document change. */
    private pending?: NextEditPrediction;
    private idleTimer?: ReturnType<typeof setTimeout>;
    private inFlight?: AbortController;

    /** Pre-change text per open document — see `snapshot`. */
    private readonly shadows = new Map<string, string>();

    /** True while this controller is the one changing the active editor. */
    private jumping = false;

    /** Idle delay, refreshed from settings on each prediction. */
    private idleMs = DEFAULT_IDLE_MS;

    /** Short-lived settings cache; see `settings()`. */
    private cachedSettings?: { at: number; value: NextEditSettings };

    constructor(
        private readonly secretManager: SecretManager,
        /** Phase 3's graph, for the one-hop neighbourhood. Absent until the index builds. */
        private readonly graph: () => CodeGraph | undefined,
    ) {
        this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusItem.command = 'black-ide.nextEdit.jump';
    }

    register(context: vscode.ExtensionContext): void {
        for (const document of vscode.workspace.textDocuments) this.snapshot(document);

        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(e => this.onDocumentChanged(e)),
            vscode.workspace.onDidOpenTextDocument(d => this.snapshot(d)),
            vscode.workspace.onDidCloseTextDocument(d => this.shadows.delete(this.relative(d.uri))),
            // Moving to another editor invalidates a prediction the same way an edit does:
            // it was computed for a cursor that is no longer where the developer is. Unless
            // *we* moved them — jumping to a cross-file prediction opens its file, which
            // fires this event, and disarming there would clear the prediction the instant
            // the developer arrived at it, so the second keypress would do nothing.
            vscode.window.onDidChangeActiveTextEditor(() => { if (!this.jumping) this.disarm(); }),
            vscode.commands.registerCommand('black-ide.nextEdit.jump', () => this.jumpOrAccept()),
            vscode.commands.registerCommand('black-ide.nextEdit.dismiss', () => this.disarm()),
            vscode.commands.registerCommand('black-ide.nextEdit.showStats', () => this.showStats()),
            this.statusItem,
            this.targetDecoration,
        );
        context.subscriptions.push(this);
    }

    dispose(): void {
        this.cancelInFlight();
        if (this.idleTimer) clearTimeout(this.idleTimer);
        for (const d of this.disposables) d.dispose();
    }

    // ── Input ───────────────────────────────────────────────────────────────

    private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
        if (event.document.uri.scheme !== 'file' || !event.contentChanges.length) return;

        const file = this.relative(event.document.uri);
        const before = this.shadows.get(file);
        const at = Date.now();
        for (const change of event.contentChanges) {
            this.history.record({
                file,
                startLine: change.range.start.line,
                endLine: change.range.start.line + change.text.split('\n').length - 1,
                removed: before === undefined ? '' : before.substr(change.rangeOffset, change.rangeLength),
                added: change.text,
                at,
            });
        }
        this.snapshot(event.document);

        /*
         * The gate, enforced structurally rather than by checking a flag later.
         *
         * Any change to any document disarms whatever is armed and cancels whatever is in
         * flight. `isStale` is still checked before showing and before applying — this is
         * the cheap first line, that one is the correct last line, and the reason for both
         * is that they fail differently: this one can miss a change in a document we are
         * not listening to, and that one cannot.
         */
        this.disarm();
        this.cancelInFlight();

        // An agent write is not a developer's edit. Predicting after one spends a model
        // call guessing what the developer will type while they are watching an agent
        // work — eleven files edited, eleven predictions, none of them wanted.
        if (agentIsWriting() || withinAgentEditGrace()) return;

        this.schedulePrediction();
    }

    /**
     * Keep a copy of each open document's text, so a change can say what it *replaced*.
     *
     * `onDidChangeTextDocument` fires after the document already holds the new text, and
     * the change describes its range in the pre-change coordinates — so by the time this
     * code runs, the removed text is gone from the only place it lived. Without a shadow
     * copy the history can only ever record insertions, and the single most valuable entry
     * it can hold is `- reserve` / `+ reserveStock`: a rename is invisible if you can only
     * see the half that was typed.
     *
     * Bounded to open, file-scheme documents under `MAX_CANDIDATE_BYTES` and dropped on
     * close. That is a real duplication of memory VS Code already holds, spent knowingly
     * for the one thing that cannot be recovered any other way.
     */
    private snapshot(document: vscode.TextDocument): void {
        if (document.uri.scheme !== 'file') return;
        const text = document.getText();
        if (text.length > MAX_CANDIDATE_BYTES) { this.shadows.delete(this.relative(document.uri)); return; }
        this.shadows.set(this.relative(document.uri), text);
    }

    private schedulePrediction(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => { void this.predict(); }, this.idleMs);
    }

    // ── Prediction ──────────────────────────────────────────────────────────

    private async predict(): Promise<void> {
        const settings = await this.settings();
        if (!settings.enableNextEdit) return;
        this.idleMs = clamp(settings.nextEditIdleMs ?? DEFAULT_IDLE_MS, 100, 5_000);

        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') return;

        const { router } = await loadModelRouter(this.secretManager);
        const model = router.resolve('autocomplete')?.config;
        if (!model) return;

        const activeFile = this.relative(editor.document.uri);
        const cursorLine = editor.selection.active.line;

        const documents = await this.openCandidates(activeFile);
        const candidates = selectCandidates({
            activeFile,
            cursorLine,
            recentFiles: this.history.filesTouched(3),
            neighbours: (file) => (this.graph()?.neighbours(file) ?? []).map(n => ({
                file: n.file, via: n.via, direction: n.direction,
            })),
            read: (file) => documents.get(normalizePath(file))?.getText(),
        });
        if (!candidates.length) return;

        const prompt = buildNextEditPrompt({ activeFile, cursorLine, history: this.history.recent(8), candidates });

        // Stamps are taken *before* the call and carried through it, so the versions
        // compared afterwards are the ones the prediction was actually computed from.
        const stamps: DocumentStamp[] = candidates
            .map(c => documents.get(c.file))
            .filter((d): d is vscode.TextDocument => !!d)
            .map(d => ({ file: this.relative(d.uri), version: d.version }));

        const controller = new AbortController();
        this.inFlight = controller;
        const budget = budgetSignal(clamp(settings.nextEditBudgetMs ?? DEFAULT_BUDGET_MS, 250, 10_000), controller.signal);
        const startedAt = Date.now();

        let response = '';
        try {
            await LLMClient.streamCompletion(model, prompt, (t) => { response += t; }, undefined, budget.signal);
        } catch {
            return;   // aborted, over budget, or the provider failed — all silent by design
        } finally {
            budget.done();
            if (this.inFlight === controller) this.inFlight = undefined;
        }

        const proposal = parseProposal(response);
        if (!proposal) return;   // NO_EDIT is the expected answer most of the time

        const result = validateProposal(proposal, {
            activeFile,
            documents: new Map([...documents].map(([file, doc]) => [file, doc.getText()])),
            stamps,
        });
        if (!result.ok) {
            this.stats.recordRejected(result.kind);
            return;
        }

        if (isStale(result.prediction.stamps, (file) => this.versionOf(file))) {
            this.stats.recordRejected('stale');
            return;
        }

        this.arm(result.prediction, Date.now() - startedAt);
    }

    /**
     * Open the documents a prediction might touch.
     *
     * `openTextDocument` gives a version number and VS Code's own cache, and does not
     * show anything — which is what makes a closed file a legitimate prediction target
     * while keeping the anchor check honest. Bounded hard: this runs on the keystroke
     * path, and every entry costs a file read on a cold cache.
     */
    private async openCandidates(activeFile: string): Promise<Map<string, vscode.TextDocument>> {
        const wanted = new Set<string>([activeFile, ...this.history.filesTouched(3)]);
        const graph = this.graph();
        if (graph) {
            for (const seed of [...wanted]) {
                for (const hop of graph.neighbours(seed).slice(0, 6)) wanted.add(normalizePath(hop.file));
                if (wanted.size >= 10) break;
            }
        }

        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const out = new Map<string, vscode.TextDocument>();
        for (const file of [...wanted].slice(0, 10)) {
            const open = vscode.workspace.textDocuments.find(d => this.relative(d.uri) === file);
            if (open) { out.set(file, open); continue; }
            if (!root) continue;
            try {
                const uri = vscode.Uri.joinPath(root, ...file.split('/'));
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.size > MAX_CANDIDATE_BYTES) continue;
                out.set(file, await vscode.workspace.openTextDocument(uri));
            } catch {
                // Deleted, binary, or outside the workspace. A candidate we cannot read is
                // simply not offered — `selectCandidates` treats that as "skip", not "fail".
            }
        }
        return out;
    }

    // ── Presentation ────────────────────────────────────────────────────────

    private arm(prediction: NextEditPrediction, latencyMs: number): void {
        this.pending = prediction;
        this.stats.recordShown(latencyMs);
        void vscode.commands.executeCommand('setContext', 'blackIde.nextEditAvailable', true);

        const where = prediction.crossFile
            ? `${path.basename(prediction.file)}:${prediction.line + 1}`
            : `line ${prediction.line + 1}`;
        this.statusItem.text = `$(arrow-right) Next edit: ${where}`;
        this.statusItem.tooltip = new vscode.MarkdownString(
            `**Next edit** in \`${prediction.file}\`\n\n\`\`\`\n${preview(prediction.replacement)}\n\`\`\`\n\nJump to it, then press again to apply.`,
        );
        this.statusItem.show();
        this.decorate(prediction);
    }

    private decorate(prediction: NextEditPrediction): void {
        for (const editor of vscode.window.visibleTextEditors) {
            if (this.relative(editor.document.uri) !== prediction.file) continue;
            const start = editor.document.positionAt(prediction.offset);
            const end = editor.document.positionAt(prediction.offset + prediction.old.length);
            editor.setDecorations(this.targetDecoration, [new vscode.Range(start, end)]);
        }
    }

    private disarm(): void {
        this.pending = undefined;
        this.statusItem.hide();
        void vscode.commands.executeCommand('setContext', 'blackIde.nextEditAvailable', false);
        for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.targetDecoration, []);
    }

    private cancelInFlight(): void {
        this.inFlight?.abort();
        this.inFlight = undefined;
    }

    // ── Jump, then accept ───────────────────────────────────────────────────

    /**
     * One command, two meanings: take me there, then do it.
     *
     * Two keys would be more explicit and worse — the developer's hands are on the
     * keyboard mid-thought, and a prediction they have to think about twice is one they
     * will stop using. The two-step is what keeps it honest: nothing is applied to a
     * region the developer has not been shown.
     */
    private async jumpOrAccept(): Promise<void> {
        const prediction = this.pending;
        if (!prediction) return;

        const editor = vscode.window.activeTextEditor;
        const here = editor && this.relative(editor.document.uri) === prediction.file;
        if (!here) { await this.jumpTo(prediction); return; }

        const cursorOffset = editor!.document.offsetAt(editor!.selection.active);
        const withinTarget = cursorOffset >= prediction.offset && cursorOffset <= prediction.offset + prediction.old.length;
        if (!withinTarget) { await this.jumpTo(prediction); return; }

        await this.accept(prediction, editor!);
    }

    private async jumpTo(prediction: NextEditPrediction): Promise<void> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) return;
        this.jumping = true;
        try {
            const uri = vscode.Uri.joinPath(root, ...prediction.file.split('/'));
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
            // Re-locate by content: the offset was recorded against a snapshot, and by the
            // time the developer presses the key the file may have moved under it.
            const at = document.getText().indexOf(prediction.old);
            const position = document.positionAt(at === -1 ? prediction.offset : at);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            this.decorate(prediction);
        } finally {
            this.jumping = false;
        }
    }

    /**
     * Apply, after re-checking everything.
     *
     * The anchor is re-verified against the live document rather than trusted from the
     * offset recorded at prediction time. Offsets are the thing that goes stale first,
     * and an offset that has drifted does not fail loudly — it points at different, valid
     * text and replaces that instead. This is the same reasoning as the SEARCH/REPLACE
     * contract, applied at the last possible moment.
     */
    private async accept(prediction: NextEditPrediction, editor: vscode.TextEditor): Promise<void> {
        if (isStale(prediction.stamps, (file) => this.versionOf(file))) { this.disarm(); return; }

        const text = editor.document.getText();
        const at = text.indexOf(prediction.old);
        if (at === -1 || text.indexOf(prediction.old, at + 1) !== -1) { this.disarm(); return; }

        const start = editor.document.positionAt(at);
        const end = editor.document.positionAt(at + prediction.old.length);
        const applied = await editor.edit(builder => builder.replace(new vscode.Range(start, end), prediction.replacement));
        if (applied) this.stats.recordAccepted(prediction);

        // No checkpoint is written on purpose: this is an edit the developer made in their
        // own editor, and the editor's undo stack is the right and expected way back.
        // `CheckpointManager` exists for edits the *agent* made while nobody was watching.
        this.disarm();
    }

    private showStats(): void {
        const s = this.stats.snapshot();
        const line = s.shown === 0
            ? 'No next-edit predictions have been shown in this session yet.'
            : `Shown ${s.shown} · accepted ${s.accepted} (${pct(s.acceptanceRate)}) · multi-line or cross-file ${pct(s.substantialShare)} of accepted · p50 ${s.p50Ms} ms · p90 ${s.p90Ms} ms`;
        const rejected = Object.entries(s.rejections).map(([k, n]) => `${k}: ${n}`).join(', ');
        vscode.window.showInformationMessage(rejected ? `${line}. Refused — ${rejected}.` : line);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private versionOf(file: string): number | undefined {
        const document = vscode.workspace.textDocuments.find(d => this.relative(d.uri) === normalizePath(file));
        return document?.version;
    }

    private relative(uri: vscode.Uri): string {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return normalizePath(root ? path.relative(root, uri.fsPath) : uri.fsPath);
    }

    /**
     * Settings, cached briefly.
     *
     * `SecretManager.getKey` goes to `vscode.SecretStorage`, which on macOS and Windows is
     * the OS keychain. Reading it once per idle pause — every 600 ms of typing, all day —
     * is the kind of cost that does not show up in a profile of this feature but does show
     * up in the editor. A few seconds of staleness on a toggle the user just flipped is a
     * fair trade; the alternative is an unnecessary keychain round trip on the typing path.
     */
    private async settings(): Promise<NextEditSettings> {
        const now = Date.now();
        if (this.cachedSettings && now - this.cachedSettings.at < SETTINGS_TTL_MS) return this.cachedSettings.value;
        let value: NextEditSettings = {};
        try {
            const raw = await this.secretManager.getKey('general-settings');
            value = raw ? JSON.parse(raw) : {};
        } catch {
            value = {};
        }
        this.cachedSettings = { at: now, value };
        return value;
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Number(value) || min));
}

function pct(fraction: number): string {
    return `${Math.round(fraction * 100)}%`;
}

function preview(text: string): string {
    const lines = text.split('\n').slice(0, 6);
    return lines.join('\n') + (text.split('\n').length > 6 ? '\n…' : '');
}
