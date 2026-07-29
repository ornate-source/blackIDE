import { describe, expect, it } from 'vitest';
import { CodeGraph } from '../src/core/code-graph';
import { analyseImpact, formatImpact, findReferencesViaGraph } from '../src/tools/graph-tools';

/**
 * Phase 3, M16.
 *
 * The tool's output is read by a model, so these assertions are mostly about what
 * it *says*, not just what it computes. An impact report that reads as certain when
 * it is name-matched guesswork will get the wrong symbol renamed, which is a worse
 * outcome than returning nothing.
 */

function corpus(): CodeGraph {
    const graph = new CodeGraph();
    graph.addFile('src/utils/currency.ts',
        'export function convertMinor(a: number, from: string, to: string): number {\n    return a;\n}\n');
    graph.addFile('src/services/order-service.ts',
        'import { convertMinor } from "../utils/currency";\n' +
        'export class OrderService {\n' +
        '    price(total: number) { return convertMinor(total, "USD", "GBP"); }\n' +
        '}\n');
    graph.addFile('src/routes/orders.ts',
        'import { OrderService } from "../services/order-service";\n' +
        'export function routes() { return new OrderService(); }\n');
    graph.addFile('src/unrelated.ts', 'export function nothing() { return 0; }\n');
    return graph;
}

describe('analyseImpact', () => {
    it('separates direct callers from transitive ones', () => {
        const result = analyseImpact(corpus(), 'convertMinor');
        expect(result.direct.map(d => d.file)).toContain('src/services/order-service.ts');
        expect(result.direct.map(d => d.file)).not.toContain('src/routes/orders.ts');
    });

    it('names the symbol that justifies each hop', () => {
        const result = analyseImpact(corpus(), 'convertMinor');
        expect(result.direct[0].via).toBe('convertMinor');
    });

    it('reports where the symbol is defined', () => {
        const result = analyseImpact(corpus(), 'convertMinor');
        expect(result.definedIn.map(d => d.file)).toEqual(['src/utils/currency.ts']);
    });

    it('never lists an unrelated file', () => {
        const result = analyseImpact(corpus(), 'convertMinor');
        const all = [...result.direct, ...result.transitive].map(x => x.file);
        expect(all).not.toContain('src/unrelated.ts');
    });

    it('explains an unknown symbol rather than returning a bare empty result', () => {
        const result = analyseImpact(corpus(), 'noSuchThing');
        expect(result.note).toBeDefined();
        expect(result.note).toMatch(/workspace_symbols/);
    });

    it('says so when the index has not been built, instead of blaming the symbol', () => {
        // These two failures look identical to a model — "no results" — but the fix
        // is completely different, so the message has to distinguish them.
        const result = analyseImpact(new CodeGraph(), 'anything');
        expect(result.note).toMatch(/index has not been built/i);
    });

    it('honours the depth bound', () => {
        const shallow = analyseImpact(corpus(), 'convertMinor', 1);
        expect(shallow.transitive).toEqual([]);
    });
});

describe('formatImpact', () => {
    it('leads with where the symbol is defined', () => {
        const text = formatImpact(analyseImpact(corpus(), 'convertMinor'));
        expect(text).toMatch(/^"convertMinor" is defined in src\/utils\/currency\.ts:\d+/);
    });

    it('states that the result is name-matched rather than authoritative', () => {
        const text = formatImpact(analyseImpact(corpus(), 'convertMinor'));
        expect(text).toMatch(/name rather than by binding/);
        expect(text).toMatch(/find_references is authoritative/);
    });

    it('warns when several definitions share the name', () => {
        const graph = corpus();
        graph.addFile('src/other/currency.ts', 'export function convertMinor() { return 0; }\n');
        const text = formatImpact(analyseImpact(graph, 'convertMinor'));
        expect(text).toMatch(/2 definitions share this name/);
    });

    it('says a symbol may be dead code when nothing references it', () => {
        const text = formatImpact(analyseImpact(corpus(), 'nothing'));
        expect(text).toMatch(/dead code|reached dynamically/);
    });

    it('passes an explanatory note straight through', () => {
        expect(formatImpact(analyseImpact(new CodeGraph(), 'x'))).toMatch(/index has not been built/i);
    });

    it('does not pad the output when there is nothing to report', () => {
        const text = formatImpact(analyseImpact(corpus(), 'nothing'));
        expect(text.split('\n').length).toBeLessThan(5);
    });
});

describe('findReferencesViaGraph', () => {
    it('lists definitions and referencing files', () => {
        const text = findReferencesViaGraph(corpus(), 'convertMinor');
        expect(text).toMatch(/Defined in:/);
        expect(text).toContain('src/utils/currency.ts');
        expect(text).toContain('src/services/order-service.ts');
    });

    it('declares that it is the degraded, name-matched path', () => {
        const text = findReferencesViaGraph(corpus(), 'convertMinor');
        expect(text).toMatch(/no language server available/i);
    });

    it('reports honestly when the symbol is unknown', () => {
        expect(findReferencesViaGraph(corpus(), 'ghost')).toMatch(/No indexed file/);
    });
});
