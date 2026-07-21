import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { gitMutex } from './git-mutex';
import { ToolRunner } from '../tools/tool-runner';

// Parallel Subagents Worktree Manager — Feature 22 / MF-22
// Controls creation, merging, removal, and orphan cleanup of isolated subagent git environments.

/** @public — exported for the emitted type of the `worktreeManager` singleton (declaration: true). */
export class WorktreeManager {
    private static instance: WorktreeManager;

    private constructor() {}

    public static getInstance(): WorktreeManager {
        if (!WorktreeManager.instance) {
            WorktreeManager.instance = new WorktreeManager();
        }
        return WorktreeManager.instance;
    }

    private getHash(rootPath: string): string {
        return crypto.createHash('md5').update(rootPath).digest('hex').slice(0, 8);
    }

    private getWorktreeRoot(rootPath: string, branchName: string): string {
        const hash = this.getHash(rootPath);
        return path.join(os.homedir(), '.blackide', 'worktrees', hash, branchName);
    }

    /** Create a new branch and checkout into an isolated worktree folder */
    public async createWorktree(branchName: string): Promise<string> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) {
            throw new Error('No workspace folder open. Cannot create worktree.');
        }

        const worktreeDir = this.getWorktreeRoot(rootPath, branchName);

        await gitMutex.run(async () => {
            // Clean up any existing directory at target
            if (fs.existsSync(worktreeDir)) {
                try {
                    fs.rmSync(worktreeDir, { recursive: true, force: true });
                } catch (e: any) {
                    console.warn(`[WorktreeManager] Failed clearing dir ${worktreeDir}: ${e?.message}`);
                }
            }

            // Create worktree off current HEAD
            const res = await ToolRunner.executeCommand(
                `git worktree add -b ${branchName} "${worktreeDir}"`,
                rootPath
            );

            if (res.exitCode !== 0) {
                throw new Error(`Git worktree creation failed: ${res.stderr || res.stdout}`);
            }
        });

        return worktreeDir;
    }

    /**
     * Copies whatever uncommitted state the live workspace has (tracked modifications +
     * untracked files) into a freshly-created worktree. `git worktree add` only clones
     * from committed HEAD, so without this, a worktree created moments after, say, the
     * pipeline's Planner phase wrote `.blackIDE/features_plan.md` wouldn't contain that
     * file at all — callers depending on the live uncommitted state must call this right
     * after `createWorktree`, before running anything inside it.
     */
    public async syncUncommittedChanges(branchName: string): Promise<void> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) throw new Error('No workspace folder open. Cannot sync worktree.');
        const worktreeDir = this.getWorktreeRoot(rootPath, branchName);

        // 1. Tracked modifications/deletions: diff against HEAD, apply in the worktree.
        const diffRes = await ToolRunner.executeCommand('git diff --binary HEAD', rootPath);
        if (diffRes.exitCode === 0 && diffRes.stdout.trim()) {
            const patchFile = path.join(os.tmpdir(), `blackide-worktree-sync-${Date.now()}.patch`);
            fs.writeFileSync(patchFile, diffRes.stdout, 'utf8');
            try {
                const applyRes = await ToolRunner.executeCommand(`git apply --whitespace=nowarn "${patchFile}"`, worktreeDir);
                if (applyRes.exitCode !== 0) {
                    throw new Error(`Failed applying uncommitted changes to worktree: ${applyRes.stderr || applyRes.stdout}`);
                }
            } finally {
                try { fs.unlinkSync(patchFile); } catch {}
            }
        }

        // 2. Untracked files: `git diff` can't see these at all — copy by path. -z avoids
        // quoting/escaping headaches for filenames with spaces or unicode.
        const statusRes = await ToolRunner.executeCommand('git status --porcelain -z --untracked-files=all', rootPath);
        if (statusRes.exitCode === 0 && statusRes.stdout) {
            const entries = statusRes.stdout.split('\0').filter(Boolean);
            for (const entry of entries) {
                if (!entry.startsWith('?? ')) continue;
                const relPath = entry.slice(3);
                const src = path.join(rootPath, relPath);
                const dest = path.join(worktreeDir, relPath);
                try {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.copyFileSync(src, dest);
                } catch (e: any) {
                    throw new Error(`Failed copying untracked file "${relPath}" to worktree: ${e.message}`);
                }
            }
        }
    }

    /**
     * Commits everything currently in the worktree's working directory and returns the
     * new commit's SHA. `git diff`/`git apply` (see applyDelta) need real commits to
     * diff between — uncommitted working-directory state isn't visible to them.
     */
    public async commitWorktreeChanges(branchName: string, message: string): Promise<string> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) throw new Error('No workspace folder open. Cannot commit worktree changes.');
        const worktreeDir = this.getWorktreeRoot(rootPath, branchName);

        return await gitMutex.run(async () => {
            const addRes = await ToolRunner.executeCommand('git add -A', worktreeDir);
            if (addRes.exitCode !== 0) {
                throw new Error(`Failed staging worktree changes: ${addRes.stderr || addRes.stdout}`);
            }
            const safeMessage = message.replace(/"/g, '\\"');
            // --allow-empty: an execution phase that made no file changes should still be
            // a safe, no-op commit rather than a thrown error.
            const commitRes = await ToolRunner.executeCommand(`git commit -m "${safeMessage}" --allow-empty`, worktreeDir);
            if (commitRes.exitCode !== 0) {
                throw new Error(`Failed committing worktree changes: ${commitRes.stderr || commitRes.stdout}`);
            }
            const shaRes = await ToolRunner.executeCommand('git rev-parse HEAD', worktreeDir);
            return shaRes.stdout.trim();
        });
    }

    /**
     * Applies exactly what changed between two commits on the worktree's branch onto the
     * LIVE workspace, via `git apply` rather than `git merge`. This is deliberate: a plain
     * `git merge` compares the incoming branch against live HEAD, and since the worktree's
     * baseline commit already contains a copy of whatever the live workspace had
     * uncommitted (see syncUncommittedChanges), merging the whole branch back would make
     * git refuse ("local changes would be overwritten") on every file that was already
     * dirty before the pipeline even started — which in practice is every run, since
     * features_plan.md itself is always one of them. Diffing fromRef→toRef isolates just
     * the execution phases' own changes, which the live tree was never dirty for (unless a
     * phase touched a file the user was also concurrently editing — that should conflict).
     */
    public async applyDelta(branchName: string, fromRef: string, toRef: string): Promise<void> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) throw new Error('No workspace folder open. Cannot apply worktree delta.');
        const worktreeDir = this.getWorktreeRoot(rootPath, branchName);

        // Worktrees of the same repo share one object database, so this diff can be read
        // from either working directory — using the worktree keeps it visibly scoped to
        // the branch it's about.
        const diffRes = await ToolRunner.executeCommand(`git diff --binary ${fromRef} ${toRef}`, worktreeDir);
        if (diffRes.exitCode !== 0) {
            throw new Error(`Failed computing execution delta: ${diffRes.stderr || diffRes.stdout}`);
        }
        if (!diffRes.stdout.trim()) return; // Execution phases made no net change — nothing to apply.

        const patchFile = path.join(os.tmpdir(), `blackide-worktree-delta-${Date.now()}.patch`);
        fs.writeFileSync(patchFile, diffRes.stdout, 'utf8');
        try {
            const applyRes = await ToolRunner.executeCommand(`git apply --whitespace=nowarn "${patchFile}"`, rootPath);
            if (applyRes.exitCode !== 0) {
                throw new Error(`Failed applying execution delta to the live workspace: ${applyRes.stderr || applyRes.stdout}`);
            }
        } finally {
            try { fs.unlinkSync(patchFile); } catch {}
        }
    }

    /** Merge subagent branch back into the current branch in main workspace */
    public async mergeWorktree(branchName: string): Promise<void> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) {
            throw new Error('No workspace folder open. Cannot merge worktree.');
        }

        await gitMutex.run(async () => {
            // Merge branchName into the current checked out branch of main workspace
            const res = await ToolRunner.executeCommand(`git merge ${branchName}`, rootPath);
            
            if (res.exitCode !== 0) {
                // Hard conflict: abort merge to prevent leaving repo in broken state
                await ToolRunner.executeCommand('git merge --abort', rootPath);
                throw new Error(`Merge conflict occurred while merging subagent branch: ${branchName}. Automatic merge aborted.`);
            }
        });
    }

    /** Prune and clean up a subagent worktree and delete its temporary branch */
    public async removeWorktree(branchName: string): Promise<void> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) return;

        const worktreeDir = this.getWorktreeRoot(rootPath, branchName);

        await gitMutex.run(async () => {
            // Forcefully remove worktree reference from Git
            await ToolRunner.executeCommand(`git worktree remove "${worktreeDir}" --force`, rootPath);
            
            // Delete subagent branch
            await ToolRunner.executeCommand(`git branch -D ${branchName}`, rootPath);

            // Clean file system
            if (fs.existsSync(worktreeDir)) {
                try {
                    fs.rmSync(worktreeDir, { recursive: true, force: true });
                } catch (e: any) {
                    console.warn(`[WorktreeManager] Failed to remove worktree folder ${worktreeDir}: ${e?.message}`);
                }
            }
        });
    }

    /** Prune any dangling worktrees registered in Git */
    public async pruneOrphans(): Promise<void> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) return;

        await gitMutex.run(async () => {
            await ToolRunner.executeCommand('git worktree prune', rootPath);
        });
    }
}
export const worktreeManager = WorktreeManager.getInstance();
