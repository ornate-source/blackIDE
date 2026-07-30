import { findSymbolPosition } from '../src/tools/lsp-tools';

/**
 * Phase 1 (M7). `findSymbolPosition` is the pure half of the LSP tools and the part
 * most likely to be subtly wrong: it decides *which* occurrence of a name the
 * language server is asked about. Pointing a rename or definition provider at an
 * import line is the classic way to get either nothing back or the wrong edit.
 */

describe('findSymbolPosition', () => {
    it('prefers a declaration over an earlier import of the same name', () => {
        const text = [
            `import { Widget } from './widget';`,   // line 0 — import, must not win
            ``,
            `export class Widget {`,                // line 2 — the declaration
            `    render() {}`,
            `}`,
        ].join('\n');
        expect(findSymbolPosition(text, 'Widget')).toEqual({ line: 2, character: 13 });
    });

    it('prefers a non-import mention when there is no declaration', () => {
        const text = [
            `from models import Order`,   // line 0 — import
            `def total(o: Order):`,       // line 1 — usage
        ].join('\n');
        expect(findSymbolPosition(text, 'Order')?.line).toBe(1);
    });

    it('honours an explicit line, overriding the declaration heuristic', () => {
        const text = [
            `import { Widget } from './widget';`,
            `const a = Widget;`,
            `export class Widget {}`,
        ].join('\n');
        // 1-based line 2 == index 1
        expect(findSymbolPosition(text, 'Widget', 2)?.line).toBe(1);
    });

    it('falls back to the declaration when the requested line has no match', () => {
        const text = [`import { Widget } from './w';`, `export class Widget {}`].join('\n');
        expect(findSymbolPosition(text, 'Widget', 99)?.line).toBe(1);
    });

    it('matches whole words only', () => {
        const text = [`const WidgetFactory = 1;`, `class Widget {}`].join('\n');
        // Must skip WidgetFactory on line 0 and find the real Widget on line 1.
        expect(findSymbolPosition(text, 'Widget')?.line).toBe(1);
    });

    it('returns undefined when the symbol is absent', () => {
        expect(findSymbolPosition('const a = 1;', 'Missing')).toBeUndefined();
    });

    it('returns undefined for an empty symbol rather than matching everything', () => {
        expect(findSymbolPosition('const a = 1;', '')).toBeUndefined();
    });

    it('treats regex metacharacters in a symbol name literally', () => {
        // A name like `$scope` or `a.b` must not be compiled as a pattern.
        expect(findSymbolPosition('const $scope = 1;', '$scope')).toEqual({ line: 0, character: 6 });
        expect(findSymbolPosition('let ab = 2;', 'a.b')).toBeUndefined();
    });

    it('reports the character offset of the identifier, not the line start', () => {
        const pos = findSymbolPosition('    def handler(self):', 'handler');
        expect(pos).toEqual({ line: 0, character: 8 });
    });

    it('recognises declarations across the languages the profiler detects', () => {
        // Each of these must beat an import line for the same name, which is what
        // proves the keyword is actually in the declaration heuristic rather than the
        // position merely coming from the "first non-import hit" fallback.
        const cases: Array<[string, string]> = [
            ['def handler():', 'handler'],                     // python
            ['fn handler() {}', 'handler'],                     // rust
            ['func handler() {}', 'handler'],                   // go
            ['public void handler() {}', 'handler'],            // java / c#
            ['interface Handler {}', 'Handler'],                // typescript
            ['struct Handler;', 'Handler'],                     // rust
            ['record Handler(string Id);', 'Handler'],          // c#
            ['class Handler', 'Handler'],                       // python / ruby / ts
        ];
        for (const [decl, symbol] of cases) {
            const text = `import { ${symbol} } from './other';\n${decl}`;
            expect(findSymbolPosition(text, symbol)?.line, decl).toBe(1);
        }
    });
});
