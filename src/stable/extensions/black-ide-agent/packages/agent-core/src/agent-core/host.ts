// ─── The host interface (Phase 11, M62) ─────────────────────────────────────
//
// E14's sizing note is the honest one: "largest item here — a real decoupling, not a
// wrapper." What makes it large is not the file moves, it is deciding *what the core is
// allowed to assume*. Get that wrong and the extraction produces a package that compiles
// without `vscode` and still cannot run anywhere else, because it assumed an editor's
// semantics through a differently-named door.
//
// So this interface is deliberately **small and boring**. Every method is something a
// terminal, a CI runner and an editor can all genuinely do. Anything an editor can do that
// a terminal cannot — show a diff, open a file, put a squiggle in a Problems panel — is
// *not here*: it lives behind an optional capability that the core degrades without,
// because a core that requires it is an extension with extra steps.
//
// ── Why an interface rather than "just use node:fs" ──────────────────────────
// The tempting shortcut is to have the core call `fs` directly, since Node is available in
// an extension host too. It fails on the thing this phase exists for: an agent running
// against a *worktree* (Phase 6), a *remote* runner (Phase 12) or an in-memory fixture is
// not reading the same filesystem the process is on. One indirection here is what makes
// all three possible; `fs` everywhere is what makes them rewrites.

import { SandboxTier } from '../core/sandbox';

/** A workspace folder, in the shape `core/workspace-roots.ts` already uses. */
export interface HostRoot {
    path: string;
    name: string;
}

/** The filesystem the agent acts on. Paths are absolute, separators normalised. */
export interface HostFileSystem {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    remove(path: string): Promise<void>;
    /** Directory entries, one level. */
    list(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
    /**
     * Files matching a glob, bounded.
     *
     * Bounded in the signature rather than by convention: this is the call that walks a
     * repository, and an unbounded version of it is how indexing a monorepo becomes a
     * thirty-second freeze. The editor implementation delegates to the editor's own
     * indexed search; the node one walks and filters.
     */
    find(glob: string, options?: { exclude?: string; limit?: number }): Promise<string[]>;
    /** Resolves symlinks. Used by the workspace-boundary guard (M55). */
    realpath?(path: string): Promise<string>;
}

/** Where secrets live. In an editor, the OS keychain; in CI, the environment. */
export interface HostSecrets {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

/** Running a command. The only path to a shell the core has. */
export interface HostProcess {
    run(command: string, options?: {
        cwd?: string;
        timeoutMs?: number;
        signal?: AbortSignal;
        onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
        /**
         * The confinement tier this command must run under (M57).
         *
         * A host that cannot enforce the requested tier must set `refused` and **not run
         * the command**. Silently running it unconfined is the one behaviour this field
         * exists to make impossible: a remote runner (M66) that ignored the tier would
         * turn a local guarantee into a claim about somebody else's machine, and the
         * core would have no way to tell.
         */
        sandbox?: SandboxTier;
    }): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut?: boolean;
        /**
         * Set when the requested tier could not be enforced. The command did **not** run;
         * the string explains why and is safe to show a model.
         */
        refused?: string;
    }>;
}

/**
 * Telling the user something.
 *
 * Deliberately fire-and-forget and deliberately not `Promise<choice>`. A core that can
 * *ask* the user a question cannot run unattended, and every caller that awaits an answer
 * becomes a place a headless run hangs forever. Approval is a separate, explicit concept
 * (`HostApproval`) precisely so that "there is nobody to ask" is a first-class answer.
 */
export interface HostNotifier {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    /** Progress/log line for the run's transcript. */
    log(message: string): void;
}

export type ApprovalKind = 'edit' | 'create' | 'exec';

export interface ApprovalRequest {
    kind: ApprovalKind;
    path?: string;
    command?: string;
    originalContent?: string;
    updatedContent?: string;
}

/**
 * The approval gate.
 *
 * An implementation that always returns `false` is valid and is what a CI runner should
 * use for `exec`: G3's "auto-approve is deliberately ignored in unattended runs" becomes a
 * property of the *host* rather than a flag the core has to remember to check.
 */
export interface HostApproval {
    request(request: ApprovalRequest): Promise<boolean>;
}

/**
 * Capabilities an editor has and a terminal does not.
 *
 * Every one is optional, and the core must work with all of them absent. That is the test
 * of whether the boundary is real: if a missing `diagnostics` makes the agent unable to
 * work rather than merely less informed, the dependency was structural and the split was
 * cosmetic.
 */
export interface HostEditorCapabilities {
    /** Compiler/linter problems for a file, for the post-edit feedback loop (E_10). */
    diagnostics?(path: string): Promise<{ line: number; message: string; severity: string }[]>;
    /** Language-server navigation (Phase 1's LSP tools). Absent ⇒ degrade to grep. */
    languageServer?: unknown;
    /** Surface authoring problems in a Problems panel. Absent ⇒ they go to the log. */
    publishProblems?(source: string, problems: { file: string; message: string; severity: string }[]): void;
    /** Open a file for the user. Meaningless headless; absent ⇒ skipped. */
    openFile?(path: string): void;
}

/** Everything the core needs, and nothing it does not. */
export interface AgentHost {
    readonly roots: HostRoot[];
    readonly fs: HostFileSystem;
    readonly secrets: HostSecrets;
    readonly process: HostProcess;
    readonly notifier: HostNotifier;
    readonly approval: HostApproval;
    /** Absent members are absent capabilities, not errors. */
    readonly editor?: HostEditorCapabilities;
    /** Durable key/value for run history and caches. */
    readonly storage: HostStorage;
}

export interface HostStorage {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T): Promise<void>;
    /** A directory the host owns, for caches and indexes. */
    readonly path: string;
}

/**
 * A host that refuses everything.
 *
 * Not a mock — a *baseline*. Every optional capability absent, every approval denied, and
 * the core must still be able to answer a read-only question. Tests use it to assert that
 * absence degrades rather than breaks, which is the property the whole interface exists to
 * make checkable.
 */
export function denyingApproval(): HostApproval {
    return { request: async () => false };
}

/** A notifier that writes nowhere. For embedding, where the SDK caller owns output. */
export function silentNotifier(): HostNotifier {
    return { info: () => {}, warn: () => {}, error: () => {}, log: () => {} };
}
