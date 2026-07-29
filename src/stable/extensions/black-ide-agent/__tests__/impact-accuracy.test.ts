import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { CodebaseIndex } from '../src/core/codebase-index';
import { analyseImpact } from '../src/tools/graph-tools';

/**
 * Phase 3 gate: `impact_analysis` accuracy on refactor fixtures, ≤2 false positives.
 *
 * Run against a real index over `eval/retrieval-corpus/` rather than a toy graph,
 * because the failure this guards against only appears at scale. The first
 * implementation walked incoming *file* edges, which answers "who depends on this
 * file" — for `reserveStock` that returned 13 files where 2 were right, since every
 * importer of `OutOfStockError` or `availableUnits` counted as affected. On a
 * three-file fixture that bug is invisible.
 *
 * `expected` sets below are hand-verified by reading the corpus. Test files are
 * included deliberately: a test that imports a symbol genuinely must change when
 * that symbol's signature changes, and omitting them would be scoring the tool
 * against a ground truth that is itself wrong.
 */

const CORPUS = path.join(__dirname, '..', 'eval', 'retrieval-corpus');
const stub = vscode as any;

const REFACTORS: { symbol: string; expected: string[] }[] = [
    {
        symbol: 'convertMinor',
        expected: [
            'src/services/order-service.ts',
            'src/services/subscription-service.ts',
            'src/services/invoice-service.ts',
            'test/currency.test.ts',
        ],
    },
    {
        symbol: 'maskEmail',
        expected: [
            'src/services/notification-service.ts',
            'src/services/audit-service.ts',
            'src/routes/users.ts',
        ],
    },
    {
        symbol: 'withRetry',
        expected: [
            'src/services/payment-service.ts',
            'src/services/notification-service.ts',
            'src/services/shipping-service.ts',
            'src/services/subscription-service.ts',
            'src/services/webhook-service.ts',
        ],
    },
    {
        symbol: 'reserveStock',
        expected: ['src/services/order-service.ts', 'test/order-service.test.ts'],
    },
    {
        symbol: 'formatMoney',
        expected: [
            'src/routes/orders.ts',
            'src/services/invoice-service.ts',
            'src/routes/subscriptions.ts',
            'src/routes/invoices.ts',
            'test/currency.test.ts',
        ],
    },
    {
        symbol: 'canTransition',
        expected: ['src/services/order-service.ts'],
    },
];

describe('impact_analysis accuracy on the retrieval corpus', () => {
    let index: CodebaseIndex;
    let storage: string;
    let previousFolders: unknown;

    beforeAll(async () => {
        previousFolders = stub.workspace.workspaceFolders;
        stub.workspace.workspaceFolders = [{ uri: { fsPath: CORPUS }, name: 'corpus', index: 0 }];
        storage = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-impact-'));
        index = new CodebaseIndex(storage);
        await index.build(undefined, 2000);
    });

    afterAll(() => {
        stub.workspace.workspaceFolders = previousFolders;
        fs.rmSync(storage, { recursive: true, force: true });
    });

    it('indexed the corpus', () => {
        expect(index.graph.fileCount).toBeGreaterThan(50);
    });

    for (const refactor of REFACTORS) {
        it(`stays within 2 false positives for ${refactor.symbol}`, () => {
            const direct = analyseImpact(index.graph, refactor.symbol, 1).direct.map(d => d.file);
            const falsePositives = direct.filter(f => !refactor.expected.includes(f));
            expect(falsePositives, `false positives for ${refactor.symbol}`).toHaveLength(0);
        });

        it(`misses no real user of ${refactor.symbol}`, () => {
            // Recall matters more than precision here: a missed caller is a broken
            // build the agent did not see coming, while an extra candidate costs a
            // glance.
            const direct = analyseImpact(index.graph, refactor.symbol, 1).direct.map(d => d.file);
            const missed = refactor.expected.filter(f => !direct.includes(f));
            expect(missed, `missed users of ${refactor.symbol}`).toEqual([]);
        });
    }

    it('reports the analysed symbol as the reason for every direct hit', () => {
        for (const refactor of REFACTORS) {
            for (const hit of analyseImpact(index.graph, refactor.symbol, 1).direct) {
                expect(hit.via, `${refactor.symbol} → ${hit.file}`).toBe(refactor.symbol);
            }
        }
    });

    it('does not report the defining file as affected by its own change', () => {
        const result = analyseImpact(index.graph, 'convertMinor', 2);
        const all = [...result.direct, ...result.transitive].map(x => x.file);
        expect(all).not.toContain('src/utils/currency.ts');
    });

    it('separates the weaker transitive claim from the direct one', () => {
        const result = analyseImpact(index.graph, 'convertMinor', 2);
        for (const hit of result.direct) {
            expect(result.transitive.map(t => t.file)).not.toContain(hit.file);
        }
    });
});
