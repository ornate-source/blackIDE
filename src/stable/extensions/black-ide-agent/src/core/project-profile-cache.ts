import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    MANIFEST_FILENAMES, ProjectProfile, detectProjectProfile, formatProfileLine,
} from '@blackide/agent-core/core/project-profiler';
import { WorkspaceRoot, defaultRootFor, isWithin, normalizeRoot } from '@blackide/agent-core/core/workspace-roots';

// ─── Per-root project profiles (Phase 6, M36) ───────────────────────────────
//
// Extracted from `extension.ts` (which was over its ≤700-line gate again) and made
// **per root** on the way out, which is the substance of M36 rather than a side effect.
//
// The previous version cached exactly one profile, detected from `workspaceFolders[0]`.
// Open a Django API and a React app side by side — the ordinary shape of a real
// project — and every consumer got `python, django`: the skill resolver injected Django
// packs while the agent edited a React component, and `run_tests` picked pytest for a
// Jest suite. Nothing errored. The wrong idiom simply arrived with full confidence, which
// is the failure mode the whole skills framework exists to avoid.
//
// Caching is per root and permanent for the session, as before. A stack does not change
// while an editor is open, and re-globbing 4 000 files per query would be a real cost for
// a value that does not move.

export interface ProfileCacheOptions {
    /** Cap on files globbed per root. The profiler only needs manifests and extensions. */
    maxFiles?: number;
}

const EXCLUDE = '**/{node_modules,.git,dist,out,build,.next,coverage,vendor,target,bin,obj}/**';

export const EMPTY_PROFILE: ProjectProfile = {
    languages: [], frameworks: [], testFrameworks: [], packageManagers: [],
    stacks: [], confidence: 0, evidence: [],
};

export class ProjectProfileCache {
    private readonly byRoot = new Map<string, ProjectProfile>();

    constructor(private readonly options: ProfileCacheOptions = {}) {}

    /** Every folder currently open, in the order VS Code reports them. */
    roots(): WorkspaceRoot[] {
        return (vscode.workspace.workspaceFolders || []).map(f => ({
            path: normalizeRoot(f.uri.fsPath),
            name: f.name,
        }));
    }

    /**
     * The profile for one root.
     *
     * Best-effort by design: any failure yields the empty profile, which means "inject no
     * stack skills". That is the fail-safe direction — the alternative is guessing, and a
     * guessed stack is how F1 injected Django packs into repos that had no detected stack
     * at all.
     */
    async forRoot(rootPath: string): Promise<ProjectProfile> {
        const key = normalizeRoot(rootPath);
        if (!key) return EMPTY_PROFILE;
        const cached = this.byRoot.get(key);
        if (cached) return cached;

        try {
            const folder = (vscode.workspace.workspaceFolders || []).find(f => normalizeRoot(f.uri.fsPath) === key);
            const pattern = folder
                ? new vscode.RelativePattern(folder, '**/*')
                : '**/*';
            const uris = await vscode.workspace.findFiles(pattern as any, EXCLUDE, this.options.maxFiles ?? 4000);

            // Paths are made relative to *this* root rather than to the workspace, because
            // the profiler matches on names like `manage.py` and `package.json` at the top
            // of a project. In a multi-root workspace `asRelativePath` prefixes the folder
            // name, so `api/manage.py` would never match `manage.py` and Django would go
            // undetected in precisely the workspaces this function exists for.
            const files = uris
                .map(u => normalizeRoot(u.fsPath))
                .filter(p => isWithin(p, key))
                .map(p => p.slice(key.length + 1));

            const manifests: Record<string, string> = {};
            const readIfExists = (rel: string, mapKey: string) => {
                try { manifests[mapKey] = fs.readFileSync(path.join(key, rel), 'utf8'); } catch { /* absent */ }
            };
            for (const name of MANIFEST_FILENAMES) readIfExists(name, name);
            const csproj = files.find(f => /\.csproj$/i.test(f));
            if (csproj) readIfExists(csproj, 'csproj');
            const sln = files.find(f => /\.sln$/i.test(f));
            if (sln) readIfExists(sln, 'sln');

            const profile = detectProjectProfile(files, manifests);
            this.byRoot.set(key, profile);
            if (profile.stacks.length) {
                console.log(`[Profiler] ${folder?.name || key} — ${formatProfileLine(profile)}`);
            }
            return profile;
        } catch {
            return EMPTY_PROFILE;
        }
    }

    /**
     * The profile for whatever the user is looking at.
     *
     * This is the single-root API every existing caller keeps using, and in a single-root
     * workspace it behaves exactly as before. In a multi-root one it now answers about the
     * file in front of the user instead of about folder zero.
     */
    async current(): Promise<ProjectProfile> {
        const roots = this.roots();
        if (!roots.length) return EMPTY_PROFILE;
        const active = vscode.window.activeTextEditor?.document.uri.fsPath;
        const root = defaultRootFor(active, roots);
        return root ? this.forRoot(root.path) : EMPTY_PROFILE;
    }

    /** Every root's profile, for the settings/diagnostics surfaces. */
    async all(): Promise<{ root: WorkspaceRoot; profile: ProjectProfile }[]> {
        const out: { root: WorkspaceRoot; profile: ProjectProfile }[] = [];
        for (const root of this.roots()) out.push({ root, profile: await this.forRoot(root.path) });
        return out;
    }

    /** Drop the cache — called when folders are added or removed. */
    invalidate(rootPath?: string): void {
        if (rootPath) this.byRoot.delete(normalizeRoot(rootPath));
        else this.byRoot.clear();
    }
}
