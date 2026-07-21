// Git Lock Mutex Serialization — Feature 22 / MF-22
// Prevents concurrent git executions from stepping on each other's locks (e.g. index.lock)

/** Default ceiling for a single queued git operation. Mirrors ExecutorDeps.commandTimeoutMs. */
export const GIT_OP_TIMEOUT_MS = 120_000;

/** @public — exported for the emitted type of the `gitMutex` singleton (declaration: true). */
export class GitMutex {
    private static instance: GitMutex;
    private queue: Promise<any> = Promise.resolve();

    private constructor() {}

    public static getInstance(): GitMutex {
        if (!GitMutex.instance) {
            GitMutex.instance = new GitMutex();
        }
        return GitMutex.instance;
    }

    /**
     * Run a git-interacting operation sequentially with retry policies.
     *
     * This is a PROCESS-GLOBAL queue: every git operation in the extension — across all
     * concurrent Manager runs and all worktrees — serializes through it. That is what makes
     * concurrent worktree work safe, and it is also a throughput ceiling on any parallel
     * execution path (see ADR: parallel execution cannot exceed this queue's rate).
     *
     * `timeoutMs` bounds a single operation. Without it, one hung `git` subprocess would
     * stall this queue forever and every later git operation in the extension with it — a
     * silent, unrecoverable deadlock. On expiry the offending action is rejected and the
     * queue moves on; the hung work is abandoned, not awaited.
     */
    public async run<T>(action: () => Promise<T>, timeoutMs = GIT_OP_TIMEOUT_MS): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            // Queue the promise chain. Errors are settled onto the caller's promise and
            // never rethrown into the chain, so one failed operation cannot poison the
            // queue for every operation behind it.
            this.queue = this.queue.then(async () => {
                try {
                    // The timeout wraps the whole retry sequence, so lock-retry backoff
                    // cannot extend the deadline indefinitely.
                    resolve(await this.withTimeout(() => this.runWithRetry(action), timeoutMs));
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    /**
     * Reject if `action` outlives `timeoutMs`. The underlying promise is left to settle on
     * its own — there is no way to cancel an in-flight subprocess promise here — but the
     * queue stops waiting on it, which is the property that matters for liveness.
     */
    private withTimeout<T>(action: () => Promise<T>, timeoutMs: number): Promise<T> {
        if (!(timeoutMs > 0) || !isFinite(timeoutMs)) return action(); // 0/∞ = opt out
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Git operation timed out after ${timeoutMs}ms and was abandoned.`)),
                timeoutMs
            );
            action().then(
                v => { clearTimeout(timer); resolve(v); },
                e => { clearTimeout(timer); reject(e); }
            );
        });
    }

    private async runWithRetry<T>(action: () => Promise<T>, retries = 3, delay = 250): Promise<T> {
        try {
            return await action();
        } catch (err: any) {
            const errorMsg = String(err?.message || err || '').toLowerCase();
            // Detect standard Git lock exceptions
            const isLockError = errorMsg.includes('index.lock') ||
                                errorMsg.includes('another git process seems to be running') ||
                                errorMsg.includes('lock file');

            if (isLockError && retries > 0) {
                console.warn(`[GitMutex] Git index lock detected. Retrying in ${delay}ms... (${retries} retries left)`);
                await new Promise(r => setTimeout(r, delay));
                return this.runWithRetry(action, retries - 1, delay * 2);
            }
            throw err;
        }
    }
}
export const gitMutex = GitMutex.getInstance();
