import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Where source lives, now that there are two roots (M62 · P11-2) ────────
//
// The core moved to `packages/agent-core/src/`; the editor stayed in `src/`. A dozen
// structural tests read source by path — "does this lane call `runVerification`", "is
// this module free of a hardcoded endpoint" — and every one of them hardcoded `../src`.
//
// This is the test-side twin of the `mod()` resolver in `test/harness.js`: it resolves a
// source-relative path against whichever root actually has it. Resolution by *looking*
// rather than by a hardcoded list, so the next module to cross the boundary — in either
// direction — needs no change here. A list would have to be kept in step by hand, and
// getting it wrong shows up as an ENOENT in an unrelated suite rather than anywhere
// useful.

const EXT = path.join(__dirname, '..');

/** Both source roots, editor first. */
export const SOURCE_ROOTS = [
    path.join(EXT, 'src'),
    path.join(EXT, 'packages', 'agent-core', 'src'),
];

/** Absolute path of a source-relative file, wherever it now lives. */
export function sourcePath(...parts: string[]): string {
    const relative = path.join(...parts);
    for (const root of SOURCE_ROOTS) {
        const candidate = path.join(root, relative);
        if (fs.existsSync(candidate)) return candidate;
    }
    // Return the editor path so the failure message names something a reader recognises,
    // rather than an unexplained "undefined".
    return path.join(SOURCE_ROOTS[0], relative);
}

/** Read a source file by its source-relative path. */
export function readSource(...parts: string[]): string {
    return fs.readFileSync(sourcePath(...parts), 'utf8');
}

export function sourceExists(...parts: string[]): boolean {
    const relative = path.join(...parts);
    return SOURCE_ROOTS.some(root => fs.existsSync(path.join(root, relative)));
}

/** Every `.ts` file under both roots, as `[absolutePath, rootRelativePath]`. */
export function allSourceFiles(): { file: string; rel: string }[] {
    const out: { file: string; rel: string }[] = [];
    for (const root of SOURCE_ROOTS) {
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.ts')) {
                    out.push({ file: full, rel: path.relative(root, full).replace(/\\/g, '/') });
                }
            }
        };
        if (fs.existsSync(root)) walk(root);
    }
    return out;
}
