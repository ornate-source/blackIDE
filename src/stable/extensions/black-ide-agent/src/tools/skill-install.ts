// Skill-pack installer — Phase 3 of the Project-Aware Agent Skills initiative.
//
// Copies bundled built-in `SKILL.md` packs into the workspace's `.blackide/skills/` so users can
// see, edit, and override them, and so project-specific packs live in the same place. Pure fs — the
// command wrapper in extension.ts handles the quick-pick UI. Everything the fleet uses ultimately
// resolves from `.blackide/skills/` (workspace) / `~/.blackide/skills/` (global) / the bundle.

import * as fs from 'fs';
import * as path from 'path';

export interface BundledPack {
    name: string;
    description: string;
    roles: string[];
    stacks: string[];
}

/** List the bundled packs (name + a little metadata) for a chooser. */
export function listBundledPacks(bundledDir: string): BundledPack[] {
    if (!fs.existsSync(bundledDir)) return [];
    const packs: BundledPack[] = [];
    for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(bundledDir, entry.name, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        let description = '', roles: string[] = [], stacks: string[] = [];
        try {
            const fm = fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
            description = fm.match(/description:\s*(.+)/)?.[1]?.trim() || '';
            const list = (k: string) => (fm.match(new RegExp(`${k}:\\s*(.+)`))?.[1] || '')
                .replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean);
            roles = list('roles'); stacks = list('stacks');
        } catch { /* metadata is best-effort */ }
        packs.push({ name: entry.name, description, roles, stacks });
    }
    return packs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Copy the named bundled packs (or all, if `names` is empty/undefined) into
 * `<workspaceRoot>/.blackide/skills/`. Returns the names actually installed. Overwrites an existing
 * pack of the same name only when `overwrite` is true, so a user's edited pack isn't clobbered.
 */
export function installSkillPacks(bundledDir: string, workspaceRoot: string, names?: string[], overwrite = false): string[] {
    const dest = path.join(workspaceRoot, '.blackide', 'skills');
    fs.mkdirSync(dest, { recursive: true });
    if (!fs.existsSync(bundledDir)) return [];

    const installed: string[] = [];
    for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (names && names.length && !names.includes(entry.name)) continue;
        const src = path.join(bundledDir, entry.name, 'SKILL.md');
        if (!fs.existsSync(src)) continue;

        const outDir = path.join(dest, entry.name);
        const outFile = path.join(outDir, 'SKILL.md');
        if (fs.existsSync(outFile) && !overwrite) continue;
        fs.mkdirSync(outDir, { recursive: true });
        fs.copyFileSync(src, outFile);
        installed.push(entry.name);
    }
    return installed.sort();
}
