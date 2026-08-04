import { CodeGraph, GraphSymbol } from '@blackide/agent-core/core/code-graph';

// ─── Graph-backed analysis tools (Phase 3, M16) ─────────────────────────────
//
// `impact_analysis` answers "if I change X, what else must change?" — the question
// an agent should ask *before* editing a shared symbol, and the one it currently
// answers by grepping and hoping.
//
// ── Relationship to the Phase 1 LSP tools ───────────────────────────────────
// `find_references` (tools/lsp-tools.ts) is authoritative and stays the first
// choice for a single symbol: it resolves bindings, so it can tell two same-named
// methods apart. It also needs a warm language server for that language, and gives
// a flat list of locations rather than a ranked view of consequence.
//
// These are the offline/bulk path: always available, language-agnostic, complete
// over the indexed set, approximate about identity. `findReferencesViaGraph` exists
// specifically as the *degraded* answer for when the LSP has no provider — which is
// the common case for Go, Rust and Python in a fork that ships only some servers.
//
// ── Honesty in the output ───────────────────────────────────────────────────
// Every result says how it was derived. A model told "3 files reference this" acts
// differently from one told "3 files probably reference this, matched by name".
// The wording here is deliberate and should not be smoothed away.

export interface ImpactResult {
    symbol: string;
    definedIn: GraphSymbol[];
    direct: { file: string; via: string }[];
    transitive: { file: string; via: string }[];
    /** Present when the graph cannot answer, explaining why rather than returning empty. */
    note?: string;
}

/**
 * Files affected by changing `symbol`, split by hop distance.
 *
 * Direct callers are reported separately from transitive ones because they are
 * qualitatively different: a direct caller almost certainly needs editing, while a
 * transitive one usually only needs checking. Collapsing them into one list is how
 * impact analysis becomes a wall of filenames nobody reads.
 */
export function analyseImpact(graph: CodeGraph, symbol: string, maxDepth = 2): ImpactResult {
    const definedIn = graph.definitionsOf(symbol);

    if (definedIn.length === 0) {
        return {
            symbol,
            definedIn: [],
            direct: [],
            transitive: [],
            note: graph.fileCount === 0
                ? 'The codebase index has not been built yet, so no impact can be computed.'
                : `No definition of "${symbol}" is indexed. Check the spelling, or use workspace_symbols to find the real name.`,
        };
    }

    const affected = graph.impactOf(symbol, maxDepth);
    return {
        symbol,
        definedIn,
        direct: affected.filter(a => a.depth === 1).map(({ file, via }) => ({ file, via })),
        transitive: affected.filter(a => a.depth > 1).map(({ file, via }) => ({ file, via })),
    };
}

/** Human/model-readable rendering. Failures-only discipline: no filler when empty. */
export function formatImpact(result: ImpactResult): string {
    if (result.note) return result.note;

    const lines: string[] = [];
    const where = result.definedIn
        .map(d => `${d.file}:${d.startLine}${d.parent ? ` (in ${d.parent})` : ''}`)
        .join(', ');
    lines.push(`"${result.symbol}" is defined in ${where}.`);

    if (result.definedIn.length > 1) {
        lines.push(
            `Note: ${result.definedIn.length} definitions share this name, so the results below ` +
            `may mix them. Use go_to_definition to pin down the one you mean.`,
        );
    }

    if (result.direct.length === 0) {
        lines.push('No other indexed file references it. It may be dead code, or reached dynamically.');
        return lines.join('\n');
    }

    lines.push('', `Directly affected (${result.direct.length}) — these very likely need changing:`);
    for (const hit of result.direct) lines.push(`  ${hit.file}  (uses ${hit.via})`);

    if (result.transitive.length > 0) {
        lines.push('', `Indirectly affected (${result.transitive.length}) — worth checking, probably not editing:`);
        for (const hit of result.transitive) lines.push(`  ${hit.file}  (via ${hit.via})`);
    }

    lines.push(
        '',
        'Derived from the offline code graph, which matches symbols by name rather than by ' +
        'binding — treat it as a strong hint, not a proof. find_references is authoritative ' +
        'where a language server is available.',
    );
    return lines.join('\n');
}

/**
 * Graph-derived references, for when the language server has no provider.
 *
 * Returned wording states its own limitation on purpose: this cannot distinguish
 * two same-named symbols, and a model that believes otherwise will confidently
 * rename the wrong one.
 */
export function findReferencesViaGraph(graph: CodeGraph, symbol: string): string {
    const files = graph.referencesOf(symbol);
    const definitions = graph.definitionsOf(symbol);

    if (definitions.length === 0 && files.length === 0) {
        return `No indexed file defines or references "${symbol}".`;
    }

    const lines: string[] = [];
    if (definitions.length > 0) {
        lines.push('Defined in:');
        for (const d of definitions) lines.push(`  ${d.file}:${d.startLine}  ${d.kind}${d.parent ? ` in ${d.parent}` : ''}`);
    }
    if (files.length > 0) {
        lines.push('', `Referenced in ${files.length} file(s):`);
        for (const file of files) lines.push(`  ${file}`);
    }
    lines.push('', 'Name-matched from the offline code graph (no language server available for this file).');
    return lines.join('\n');
}
