import { describe, expect, it } from 'vitest';
import { CodeGraph, resolveSpecifier } from '@blackide/agent-core/core/code-graph';

/**
 * Phase 3, M15. The graph is deliberately approximate — resolution is by symbol
 * name, not by binding — so these assertions pin the two properties that make the
 * approximation *safe* rather than merely convenient:
 *
 *   1. it over-approximates (an extra candidate) rather than under-approximating
 *      (a missing caller), and
 *   2. ambiguity is dropped rather than guessed at.
 */

const CURRENCY = `
export function convertMinor(amountMinor: number, from: string, to: string): number {
    return amountMinor;
}

export function formatMoney(amountMinor: number, currency: string): string {
    return String(amountMinor);
}
`.trimStart();

const ORDER_SERVICE = `
import { convertMinor } from '../utils/currency';
import { OrderRepository } from '../repositories/order-repository';

export class OrderService {
    constructor(private readonly orders: OrderRepository) {}

    async place(total: number): Promise<number> {
        return convertMinor(total, 'USD', 'GBP');
    }
}
`.trimStart();

const ORDER_REPO = `
export class OrderRepository {
    async byId(id: string): Promise<unknown> {
        return { id };
    }
}
`.trimStart();

function graphWithCorpus(): CodeGraph {
    const graph = new CodeGraph();
    graph.addFile('src/utils/currency.ts', CURRENCY);
    graph.addFile('src/services/order-service.ts', ORDER_SERVICE);
    graph.addFile('src/repositories/order-repository.ts', ORDER_REPO);
    return graph;
}

describe('symbol table', () => {
    it('records definitions with their file and line span', () => {
        const [convert] = graphWithCorpus().definitionsOf('convertMinor');
        expect(convert.file).toBe('src/utils/currency.ts');
        expect(convert.startLine).toBeGreaterThan(0);
        expect(convert.endLine).toBeGreaterThanOrEqual(convert.startLine);
    });

    it('records a method with its enclosing class', () => {
        const [place] = graphWithCorpus().definitionsOf('place');
        expect(place.parent).toBe('OrderService');
    });

    it('knows nothing about a symbol that is not defined', () => {
        expect(graphWithCorpus().definitionsOf('nonExistent')).toEqual([]);
    });

    it('counts files and symbols', () => {
        const graph = graphWithCorpus();
        expect(graph.fileCount).toBe(3);
        expect(graph.symbolCount).toBeGreaterThan(3);
    });
});

describe('edges', () => {
    it('links an importer to the file it imports by relative path', () => {
        const edges = graphWithCorpus().allEdges();
        const imports = edges.filter(e =>
            e.from === 'src/services/order-service.ts' &&
            e.to === 'src/utils/currency.ts' &&
            e.kind === 'imports');
        expect(imports.length).toBeGreaterThan(0);
        expect(imports[0].confidence).toBe('exact');
    });

    it('links a caller to the file defining the symbol it calls', () => {
        const references = graphWithCorpus().allEdges().filter(e =>
            e.from === 'src/services/order-service.ts' &&
            e.to === 'src/utils/currency.ts' &&
            e.kind === 'references' &&
            e.via === 'convertMinor');
        expect(references).toHaveLength(1);
    });

    it('marks a name-matched edge as inferred, not exact', () => {
        const reference = graphWithCorpus().allEdges()
            .find(e => e.kind === 'references' && e.via === 'convertMinor');
        expect(reference?.confidence).toBe('inferred');
    });

    it('never links a file to itself', () => {
        for (const edge of graphWithCorpus().allEdges()) {
            expect(edge.from).not.toBe(edge.to);
        }
    });

    it('drops a name defined in too many files rather than guessing', () => {
        const graph = new CodeGraph();
        for (let i = 0; i < 6; i++) {
            graph.addFile(`src/m${i}.ts`, 'export function handle() { return 1; }\n');
        }
        graph.addFile('src/caller.ts', 'import x from "./m0";\nhandle();\n');

        // `handle` is defined six times; an edge to each would be six wrong answers
        // dressed as six right ones.
        const guessed = graph.allEdges().filter(e => e.kind === 'references' && e.via === 'handle');
        expect(guessed).toEqual([]);
    });
});

describe('neighbours', () => {
    it('reports outbound and inbound directions separately', () => {
        const graph = graphWithCorpus();
        const fromService = graph.neighbours('src/services/order-service.ts');
        expect(fromService.some(n => n.file === 'src/utils/currency.ts' && n.direction === 'out')).toBe(true);

        const fromCurrency = graph.neighbours('src/utils/currency.ts');
        expect(fromCurrency.some(n => n.file === 'src/services/order-service.ts' && n.direction === 'in')).toBe(true);
    });
});

describe('impactOf', () => {
    it('finds the direct caller of a changed symbol', () => {
        const affected = graphWithCorpus().impactOf('convertMinor');
        expect(affected.map(a => a.file)).toContain('src/services/order-service.ts');
    });

    it('does not report the defining file as affected by its own change', () => {
        const affected = graphWithCorpus().impactOf('convertMinor');
        expect(affected.map(a => a.file)).not.toContain('src/utils/currency.ts');
    });

    it('returns nothing for an unknown symbol rather than everything', () => {
        expect(graphWithCorpus().impactOf('doesNotExist')).toEqual([]);
    });

    it('records the hop distance so a caller outranks a caller-of-a-caller', () => {
        const graph = new CodeGraph();
        graph.addFile('a.ts', 'export function base() { return 1; }\n');
        graph.addFile('b.ts', 'import { base } from "./a";\nexport function mid() { return base(); }\n');
        graph.addFile('c.ts', 'import { mid } from "./b";\nexport function top() { return mid(); }\n');

        const affected = graph.impactOf('base', 2);
        const b = affected.find(a => a.file === 'b.ts');
        expect(b?.depth).toBe(1);
    });

    it('respects the depth bound', () => {
        const graph = new CodeGraph();
        graph.addFile('a.ts', 'export function base() { return 1; }\n');
        graph.addFile('b.ts', 'import { base } from "./a";\nexport function mid() { return base(); }\n');
        graph.addFile('c.ts', 'import { mid } from "./b";\nexport function top() { return mid(); }\n');

        for (const hit of graph.impactOf('base', 1)) {
            expect(hit.depth).toBeLessThanOrEqual(1);
        }
    });
});

describe('incremental updates', () => {
    it('forgets a removed file entirely', () => {
        const graph = graphWithCorpus();
        graph.remove('src/utils/currency.ts');

        expect(graph.definitionsOf('convertMinor')).toEqual([]);
        expect(graph.allEdges().some(e => e.to === 'src/utils/currency.ts')).toBe(false);
    });

    it('replaces rather than duplicates when a file is re-added', () => {
        const graph = graphWithCorpus();
        graph.addFile('src/utils/currency.ts', CURRENCY);
        expect(graph.definitionsOf('convertMinor')).toHaveLength(1);
    });

    it('drops symbols that a re-added file no longer defines', () => {
        const graph = graphWithCorpus();
        graph.addFile('src/utils/currency.ts', 'export function formatMoney() { return ""; }\n');

        expect(graph.definitionsOf('convertMinor')).toEqual([]);
        expect(graph.definitionsOf('formatMoney')).toHaveLength(1);
    });

    it('recomputes edges after a change instead of serving a stale set', () => {
        const graph = graphWithCorpus();
        expect(graph.allEdges().some(e => e.via === 'convertMinor')).toBe(true);

        graph.addFile('src/services/order-service.ts', 'export class OrderService {}\n');
        expect(graph.allEdges().some(e => e.via === 'convertMinor')).toBe(false);
    });

    it('hasFile reflects what the graph actually holds', () => {
        const graph = graphWithCorpus();
        expect(graph.hasFile('src/utils/currency.ts')).toBe(true);
        graph.remove('src/utils/currency.ts');
        expect(graph.hasFile('src/utils/currency.ts')).toBe(false);
    });
});

describe('resolveSpecifier', () => {
    const files = [
        'src/utils/currency.ts',
        'src/services/order-service.ts',
        'src/models/index.ts',
        'analytics/metrics.py',
    ];

    it('resolves a relative specifier and adds the extension', () => {
        expect(resolveSpecifier('../utils/currency', 'src/services/order-service.ts', files))
            .toBe('src/utils/currency.ts');
    });

    it('resolves a directory specifier to its index file', () => {
        expect(resolveSpecifier('../models', 'src/services/order-service.ts', files))
            .toBe('src/models/index.ts');
    });

    it('resolves a dotted python module by its final segment', () => {
        expect(resolveSpecifier('analytics.metrics', 'analytics/pipeline.py', files))
            .toBe('analytics/metrics.py');
    });

    it('returns undefined for a third-party package rather than inventing a file', () => {
        expect(resolveSpecifier('express', 'src/server.ts', files)).toBeUndefined();
    });

    it('returns undefined when a bare specifier is ambiguous', () => {
        const ambiguous = ['a/util.ts', 'b/util.ts'];
        expect(resolveSpecifier('util', 'c/x.ts', ambiguous)).toBeUndefined();
    });

    it('does not resolve a relative path that escapes the known file set', () => {
        expect(resolveSpecifier('../../outside/thing', 'src/a/b.ts', files)).toBeUndefined();
    });
});

describe('language coverage', () => {
    it('links Python modules through a from-import', () => {
        const graph = new CodeGraph();
        graph.addFile('analytics/metrics.py', 'def conversion_rate(a, b):\n    return a / b\n');
        graph.addFile('analytics/pipeline.py', 'from .metrics import conversion_rate\n\ndef run():\n    return conversion_rate(1, 2)\n');

        expect(graph.definitionsOf('conversion_rate')[0].file).toBe('analytics/metrics.py');
        expect(graph.impactOf('conversion_rate').map(a => a.file)).toContain('analytics/pipeline.py');
    });

    it('links Go files that reference a shared symbol', () => {
        const graph = new CodeGraph();
        graph.addFile('worker/queue.go', 'package worker\n\nfunc deadLetter(m string) error {\n\treturn nil\n}\n');
        graph.addFile('worker/handler.go', 'package worker\n\nfunc Handle(m string) error {\n\treturn deadLetter(m)\n}\n');

        expect(graph.impactOf('deadLetter').map(a => a.file)).toContain('worker/handler.go');
    });
});

describe('noise suppression', () => {
    it('does not create a node for a language keyword', () => {
        const graph = new CodeGraph();
        graph.addFile('a.ts', 'export function f() {\n  if (true) { return 1; }\n  return 0;\n}\n');
        expect(graph.definitionsOf('if')).toEqual([]);
        expect(graph.referencesOf('return')).toEqual([]);
    });
});
