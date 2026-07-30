import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blame, searchHistory, whyWasThisChanged } from '../src/tools/git-history';

/**
 * Phase 3, M22.
 *
 * Run against a real throwaway repository rather than a mocked `execFile`. The
 * interesting behaviour is entirely in how git's output is parsed and shaped —
 * porcelain blame's metadata-only-on-first-appearance rule, `-S` pickaxe semantics,
 * the separator handling — and a mock would be asserting my own assumptions about
 * git's output back at me.
 */

let repo: string;
let available = true;

function git(args: string[], cwd = repo): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function commit(message: string, files: Record<string, string>): void {
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
        fs.writeFileSync(path.join(repo, name), content, 'utf8');
    }
    git(['add', '-A']);
    git(['commit', '-m', message, '--no-gpg-sign']);
}

beforeAll(() => {
    try {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-githist-'));
        git(['init', '-q'], repo);
        git(['config', 'user.email', 'test@example.com']);
        git(['config', 'user.name', 'Test User']);
        git(['config', 'commit.gpgsign', 'false']);

        commit('feat: add currency conversion', {
            'src/currency.ts': 'export function convertMinor(a: number) {\n    return a;\n}\n',
        });
        commit('fix: round half-up in convertMinor\n\nThe previous banker\'s rounding disagreed with\nthe payment gateway by a cent on every other order.', {
            'src/currency.ts': 'export function convertMinor(a: number) {\n    return Math.round(a);\n}\n\nexport function formatMoney(a: number) {\n    return String(a);\n}\n',
        });
        commit('chore: unrelated change', { 'README.md': '# demo\n' });
    } catch {
        available = false;   // git absent or unusable in this environment
    }
});

afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe('searchHistory', () => {
    it('finds commits that added a symbol', async () => {
        if (!available) return;
        const text = await searchHistory('convertMinor', { cwd: repo });
        expect(text).toMatch(/added or removed "convertMinor"/);
        expect(text).toContain('add currency conversion');
    });

    it('finds commits whose message mentions a term', async () => {
        if (!available) return;
        const text = await searchHistory('rounding', { cwd: repo });
        expect(text).toMatch(/message mentions "rounding"/);
    });

    it('does not list the same commit under both headings', async () => {
        if (!available) return;
        // `convertMinor` appears in a message AND in diffs; reporting it twice would
        // double-count the evidence.
        const text = await searchHistory('convertMinor', { cwd: repo });
        const occurrences = text.split('round half-up').length - 1;
        expect(occurrences).toBeLessThanOrEqual(1);
    });

    it('says plainly when nothing matches', async () => {
        if (!available) return;
        expect(await searchHistory('nothingLikeThisExists', { cwd: repo }))
            .toMatch(/No commits mention/);
    });

    it('rejects an empty query rather than dumping all history', async () => {
        expect(await searchHistory('   ', { cwd: repo || os.tmpdir() }))
            .toMatch(/non-empty query/);
    });

    it('reports why history is unavailable outside a repository', async () => {
        const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-norepo-'));
        try {
            const text = await searchHistory('anything', { cwd: notARepo });
            expect(text).toMatch(/unavailable/i);
        } finally {
            fs.rmSync(notARepo, { recursive: true, force: true });
        }
    });
});

describe('blame', () => {
    it('attributes lines to the commit that wrote them', async () => {
        if (!available) return;
        const text = await blame('src/currency.ts', 1, 6, { cwd: repo });
        expect(text).toMatch(/Blame for src\/currency\.ts/);
        expect(text).toMatch(/Test User/);
    });

    it('collapses consecutive lines from one commit into a single row', async () => {
        if (!available) return;
        const text = await blame('src/currency.ts', 1, 6, { cwd: repo });
        const rows = text.split('\n').filter(l => l.startsWith('  '));
        // Six lines, at most two commits — never six rows.
        expect(rows.length).toBeLessThanOrEqual(3);
    });

    it('refuses an invalid range instead of guessing one', async () => {
        expect(await blame('src/currency.ts', 10, 2, { cwd: repo || os.tmpdir() }))
            .toMatch(/valid line range/);
    });

    it('reports unavailability for an unknown file', async () => {
        if (!available) return;
        expect(await blame('does/not/exist.ts', 1, 5, { cwd: repo })).toMatch(/unavailable|No blame/i);
    });
});

describe('whyWasThisChanged', () => {
    it('includes the full commit body, where the reasoning lives', async () => {
        if (!available) return;
        const text = await whyWasThisChanged('convertMinor', { cwd: repo });
        expect(text).toContain('disagreed with');
        expect(text).toContain('payment gateway');
    });

    it('names the earliest commit in the scanned window', async () => {
        if (!available) return;
        const text = await whyWasThisChanged('convertMinor', { cwd: repo });
        expect(text).toMatch(/earliest in this window is [0-9a-f]{7,}/);
    });

    it('states the limits of pickaxe evidence rather than implying certainty', async () => {
        if (!available) return;
        const text = await whyWasThisChanged('convertMinor', { cwd: repo });
        expect(text).toMatch(/not a proof/);
        expect(text).toMatch(/rename/);
    });

    it('suggests a next step when a symbol is not found', async () => {
        if (!available) return;
        const text = await whyWasThisChanged('neverExisted', { cwd: repo });
        expect(text).toMatch(/search_history/);
    });

    it('rejects an empty symbol', async () => {
        expect(await whyWasThisChanged('', { cwd: repo || os.tmpdir() })).toMatch(/needs a symbol/);
    });
});
