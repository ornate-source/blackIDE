import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards against a class of defect that is invisible in an editor and silent in CI.
 *
 * Phase 3 shipped two files containing literal NUL bytes, used as a separator in a
 * composite grouping key. The code was *correct* — NUL cannot occur in a diagnostic
 * message, so it is a sound sentinel — but a raw control byte in source makes the
 * file binary to `grep`, `diff`, `awk` and most review tools, which silently stop
 * showing its contents. It was found only because `grep` started returning nothing
 * for a file that plainly had matches.
 *
 * The fix is to write such a sentinel as an escape (`'\\u0000'`), which this asserts.
 * Kept general rather than specific to that byte: any raw control character in source
 * is a mistake, and none of them announce themselves.
 */

const SRC = path.join(__dirname, '..', 'src');
const EVAL = path.join(__dirname, '..', 'eval');

function sourceFiles(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            sourceFiles(full, out);
        } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Everything below U+0020 except tab, LF and CR, plus DEL.
 *
 * Built with `String.fromCharCode` rather than written as a character class, because
 * a literal escape in a regex is exactly the thing that keeps turning into a raw
 * byte here — a guard that trips over the defect it guards against is worse than no
 * guard, since it fails in a way that looks like the guard working.
 */
const FORBIDDEN_CODES: number[] = [
    ...range(0x00, 0x08), 0x0b, 0x0c, ...range(0x0e, 0x1f), 0x7f,
];

function range(from: number, to: number): number[] {
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function firstControlCharacter(text: string): { index: number; code: number } | undefined {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (FORBIDDEN_CODES.includes(code)) return { index: i, code };
    }
    return undefined;
}

describe('source hygiene', () => {
    const files = [...sourceFiles(SRC), ...sourceFiles(EVAL), ...sourceFiles(__dirname)];

    it('finds source files to check', () => {
        expect(files.length).toBeGreaterThan(20);
    });

    it('contains no raw control characters', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            const found = firstControlCharacter(text);
            if (!found) continue;
            const line = text.slice(0, found.index).split('\n').length;
            const code = found.code.toString(16).padStart(4, '0').toUpperCase();
            offenders.push(`${path.relative(SRC, file)}:${line} contains U+${code} — write it as an escape`);
        }
        expect(offenders).toEqual([]);
    });
});
