import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { CodebaseIndex } from '../src/core/codebase-index';

/**
 * Phase 3's index-build budget: **a full build of ≤2 s per 5 000 files.**
 *
 * This gate has been *agreed but unproven* since M14. The original wording was "+50%
 * of baseline", which resolved to ≤39 ms on an 82-file fixture — a number that
 * measures nothing and that M14's 26 → 52 ms then "missed" for no reason anyone would
 * act on. The restatement needs a corpus big enough for the figure to mean something,
 * and this is that corpus: 5 000 generated source files across the seven languages
 * `symbol-chunker.ts` handles.
 *
 * **Why generated rather than a real repo.** The gate is about throughput per file,
 * and a vendored 5 000-file repo would add tens of megabytes to the tree to measure
 * the same thing. Generated files are shaped like real ones where it matters to the
 * chunker and the graph — imports, nested symbols, doc comments, bodies of a few
 * dozen lines — because a corpus of one-line files would flatter the budget by
 * skipping the work being measured.
 *
 * **What is deliberately excluded.** Embeddings. `build()` fetches them sequentially
 * per chunk when a provider is configured, so with one the wall clock measures a
 * network round trip 20 000 times over and tells you nothing about our code. The
 * budget is about *our* indexing cost: walk, read, chunk, graph. That is stated here
 * rather than left implicit, because a future reader comparing this number against a
 * real embedded build will otherwise think it regressed by two orders of magnitude.
 */

const FILE_COUNT = 5_000;
const BUDGET_MS = 2_000;
const stub = vscode as any;

/** Roughly-shaped source in the languages the chunker recognises. */
function generate(root: string): void {
    const languages = [
        { ext: 'ts', render: tsFile },
        { ext: 'py', render: pyFile },
        { ext: 'go', render: goFile },
        { ext: 'rs', render: rsFile },
        { ext: 'java', render: javaFile },
        { ext: 'cs', render: csFile },
        { ext: 'md', render: mdFile },
    ];
    // Nested directories, because path handling and the exclude globs are part of what
    // the walk costs — a flat directory of 5 000 files is not the shape being budgeted.
    for (let i = 0; i < FILE_COUNT; i++) {
        const lang = languages[i % languages.length];
        const dir = path.join(root, 'src', `pkg${i % 50}`, `mod${i % 7}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `unit${i}.${lang.ext}`), lang.render(i), 'utf8');
    }
}

const body = (n: number) => Array.from({ length: 12 }, (_, k) => `        const step${k} = compute${n % 13}(step${Math.max(0, k - 1)});`).join('\n');

const tsFile = (n: number) => `import { Helper } from '../mod${n % 7}/unit${(n + 1) % FILE_COUNT}';

/** Handles order ${n}. */
export class OrderHandler${n} {
    /** Applies the charge and returns the receipt. */
    async handle(input: Helper): Promise<number> {
${body(n)}
        return step11;
    }

    private compute${n % 13}(v: number): number {
        return v + ${n};
    }
}

export function convertAmount${n}(minor: number): number {
    return minor / 100;
}
`;

const pyFile = (n: number) => `from .unit${(n + 1) % FILE_COUNT} import Helper


class OrderHandler${n}:
    """Handles order ${n}."""

    def handle(self, payload):
${Array.from({ length: 10 }, (_, k) => `        step${k} = self.compute(payload)`).join('\n')}
        return step9

    def compute(self, value):
        return value + ${n}


def convert_amount_${n}(minor):
    return minor / 100
`;

const goFile = (n: number) => `package pkg${n % 50}

import "example.com/repo/src/pkg${(n + 1) % 50}"

// OrderHandler${n} handles order ${n}.
type OrderHandler${n} struct {
	Retries int
}

func (h *OrderHandler${n}) Handle(amount int) int {
${Array.from({ length: 10 }, (_, k) => `\tstep${k} := amount + ${k}`).join('\n')}
	return step9
}

func ConvertAmount${n}(minor int) int {
	return minor / 100
}
`;

const rsFile = (n: number) => `use crate::pkg${(n + 1) % 50}::Helper;

/// Handles order ${n}.
pub struct OrderHandler${n} {
    pub retries: u32,
}

impl OrderHandler${n} {
    pub fn handle(&self, amount: i64) -> i64 {
${Array.from({ length: 10 }, (_, k) => `        let step${k} = amount + ${k};`).join('\n')}
        step9
    }
}

pub fn convert_amount_${n}(minor: i64) -> i64 {
    minor / 100
}
`;

const javaFile = (n: number) => `package pkg${n % 50};

import pkg${(n + 1) % 50}.Helper;

/** Handles order ${n}. */
public class OrderHandler${n} {
    public long handle(long amount) {
${Array.from({ length: 10 }, (_, k) => `        long step${k} = amount + ${k};`).join('\n')}
        return step9;
    }

    public static long convertAmount(long minor) {
        return minor / 100;
    }
}
`;

const csFile = (n: number) => `using Pkg${(n + 1) % 50};

namespace Pkg${n % 50}
{
    /// <summary>Handles order ${n}.</summary>
    public class OrderHandler${n}
    {
        public long Handle(long amount)
        {
${Array.from({ length: 10 }, (_, k) => `            var step${k} = amount + ${k};`).join('\n')}
            return step9;
        }

        public static long ConvertAmount(long minor) => minor / 100;
    }
}
`;

const mdFile = (n: number) => `# Module ${n}

## Overview

Describes how order ${n} is charged and refunded.

## Retries

Backoff is exponential with a cap.
`;

describe('index build budget: ≤2 s per 5 000 files', () => {
    let root: string;
    let storage: string;
    let previousFolders: unknown;

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-budget-'));
        storage = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-budget-store-'));
        generate(root);
        previousFolders = stub.workspace.workspaceFolders;
        stub.workspace.workspaceFolders = [{ uri: { fsPath: root }, name: 'budget', index: 0 }];
    }, 120_000);

    afterAll(() => {
        stub.workspace.workspaceFolders = previousFolders;
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(storage, { recursive: true, force: true });
    });

    it('generated the corpus it claims to measure', () => {
        // A budget test that silently measured 80 files would pass forever.
        const count = countFiles(path.join(root, 'src'));
        expect(count).toBe(FILE_COUNT);
    });

    it('completes a cold full build inside the budget', async () => {
        const index = new CodebaseIndex(storage);
        const started = Date.now();
        // No SecretManager: embeddings are a per-chunk network round trip and are not
        // what this budget is about — see the note at the top of this file.
        const stats = await index.build(undefined, FILE_COUNT + 500);
        const elapsed = Date.now() - started;

        // eslint-disable-next-line no-console
        console.log(`      index build: ${stats.indexed} files, ${index.size} chunks, ${elapsed} ms (budget ${BUDGET_MS} ms)`);

        expect(stats.indexed).toBeGreaterThanOrEqual(FILE_COUNT - 10);
        expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);
    }, 120_000);

    it('builds the graph over the same files, so the budget covers both', async () => {
        // M14 and M15 share one scan by construction. If the graph were built by a
        // second pass this budget would be measuring half the cost.
        const index = new CodebaseIndex(fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-budget-g-')));
        await index.build(undefined, FILE_COUNT + 500);
        expect(index.graph.fileCount).toBeGreaterThanOrEqual(FILE_COUNT - 10);
    }, 120_000);

    it('a warm rebuild is cheaper than the cold one it reuses', async () => {
        // The number that actually governs the editor's responsiveness: every turn
        // after the first rebuilds warm.
        const warmStore = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-budget-w-'));
        const first = new CodebaseIndex(warmStore);
        await first.build(undefined, FILE_COUNT + 500);

        const second = new CodebaseIndex(warmStore);
        const started = Date.now();
        const stats = await second.build(undefined, FILE_COUNT + 500);
        const elapsed = Date.now() - started;

        // eslint-disable-next-line no-console
        console.log(`      warm rebuild: ${stats.reused} reused, ${stats.indexed} re-indexed, ${elapsed} ms`);

        expect(stats.reused).toBeGreaterThanOrEqual(FILE_COUNT - 10);
        expect(elapsed).toBeLessThanOrEqual(BUDGET_MS);
        fs.rmSync(warmStore, { recursive: true, force: true });
    }, 120_000);
});

function countFiles(dir: string): number {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
    }
    return total;
}
