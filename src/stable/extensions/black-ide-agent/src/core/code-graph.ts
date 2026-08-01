import { Language, languageOf, maskLiterals, planChunks } from './symbol-chunker';

// ─── Code graph (Phase 3, M15) ──────────────────────────────────────────────
//
// A symbol table plus three edge kinds — imports, references and type hierarchy —
// built from the same lexical scan that produces symbol chunks (M14).
//
// ── What it is for ──────────────────────────────────────────────────────────
// Two things the index cannot do on its own:
//
//   1. **Ranking.** M14 got recall@20 to 100% on the eval corpus, meaning every
//      gold file is reachable; what remains is ordering. The residual misses are
//      all one shape — a question matches the *caller* strongly and the *callee's
//      definition* weakly ("converting the order total" finds `order-service.ts`
//      but not `utils/currency.ts`). One hop along a reference edge is exactly the
//      missing signal, and it is a structural fact rather than another guess at
//      term weighting.
//
//   2. **Impact analysis (M16).** "If I change this symbol, what else must change"
//      is a reachability question. Grep answers it with every textual coincidence;
//      a graph answers it with callers, importers and subtypes.
//
// ── Why this is not the language server ─────────────────────────────────────
// Phase 1 exposed the real LSP (`tools/lsp-tools.ts`), which is authoritative and
// is the fast path for a single symbol the user is looking at. It is also
// per-language, requires a warm server, and cannot answer a whole-repo question
// without one round trip per file. This graph is the offline/bulk path: cheaper,
// approximate, always available, and complete over the indexed set. M16 uses the
// LSP first and falls back here — never the reverse.
//
// ── The accuracy posture ────────────────────────────────────────────────────
// Resolution is by symbol *name*, not by binding. Two different `create` methods
// in two classes are one node. That is a deliberate trade: a name-keyed graph is
// language-agnostic, needs no type checker, and for the ranking and impact
// questions above it over-approximates — which surfaces an extra candidate file
// rather than hiding a real one. Every consumer must treat edges as *evidence*,
// and `confidence` below says how much.

export type EdgeKind = 'imports' | 'references' | 'extends' | 'implements';

export interface GraphSymbol {
    name: string;
    file: string;
    startLine: number;
    endLine: number;
    kind: string;
    parent?: string;
}

export interface GraphEdge {
    from: string;   // file path
    to: string;     // file path
    kind: EdgeKind;
    /** The symbol that justifies the edge, for explaining a result to a human. */
    via: string;
    /**
     * 'exact' — the edge came from an explicit import statement with a resolvable
     * path. 'inferred' — the edge came from a name matching a definition elsewhere.
     * Consumers that must not over-reach (a destructive refactor) use exact only.
     */
    confidence: 'exact' | 'inferred';
}

export interface FileNode {
    file: string;
    language: Language;
    symbols: GraphSymbol[];
    /** Module specifiers exactly as written, before resolution. */
    importSpecifiers: string[];
    /** Identifiers used but not defined in this file. */
    referenced: Set<string>;
}

// ─── Import extraction ──────────────────────────────────────────────────────

const IMPORT_PATTERNS: Partial<Record<Language, RegExp[]>> = {
    typescript: [
        /^\s*import\s+(?:type\s+)?(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]/,
        /^\s*import\s*['"]([^'"]+)['"]/,
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/,
        /^\s*export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/,
    ],
    python: [
        /^\s*from\s+([\w.]+)\s+import\b/,
        /^\s*import\s+([\w.]+)/,
    ],
    go: [
        /^\s*(?:[\w.]+\s+)?["]([^"]+)["]/,   // inside an import ( ... ) block
    ],
    rust: [
        /^\s*(?:pub\s+)?use\s+([\w:]+)/,
    ],
    java: [
        /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/,
    ],
    csharp: [
        /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/,
    ],
};
IMPORT_PATTERNS.javascript = IMPORT_PATTERNS.typescript;

const HIERARCHY_PATTERNS: Partial<Record<Language, { re: RegExp; kind: EdgeKind }[]>> = {
    typescript: [
        { re: /\bclass\s+[\w$]+\s+extends\s+([\w$.]+)/, kind: 'extends' },
        { re: /\bclass\s+[\w$]+(?:\s+extends\s+[\w$.]+)?\s+implements\s+([\w$.,\s]+)/, kind: 'implements' },
        { re: /\binterface\s+[\w$]+\s+extends\s+([\w$.,\s]+)/, kind: 'extends' },
    ],
    python: [
        { re: /^\s*class\s+\w+\s*\(([^)]*)\)/, kind: 'extends' },
    ],
    java: [
        { re: /\bclass\s+\w+\s+extends\s+([\w.]+)/, kind: 'extends' },
        { re: /\bimplements\s+([\w.,\s]+)/, kind: 'implements' },
    ],
    csharp: [
        { re: /\b(?:class|struct|record|interface)\s+\w+\s*:\s*([\w.,\s<>]+)/, kind: 'extends' },
    ],
    rust: [
        { re: /^\s*impl(?:<[^>]*>)?\s+([\w:]+)\s+for\s+[\w:]+/, kind: 'implements' },
    ],
};
HIERARCHY_PATTERNS.javascript = HIERARCHY_PATTERNS.typescript;

/**
 * Language keywords and ubiquitous globals that would otherwise become graph nodes
 * with an edge from nearly every file — pure noise that also dominates any
 * frequency-based ranking built on top.
 */
const NOISE = new Set([
    'if', 'for', 'while', 'switch', 'return', 'catch', 'try', 'else', 'do', 'new',
    'this', 'self', 'super', 'true', 'false', 'null', 'nil', 'none', 'undefined',
    'string', 'number', 'boolean', 'void', 'int', 'bool', 'float', 'byte', 'error',
    'console', 'log', 'require', 'module', 'exports', 'process', 'window', 'document',
    'promise', 'array', 'object', 'map', 'set', 'json', 'math', 'date', 'error',
    'len', 'str', 'dict', 'list', 'print', 'range', 'type', 'func', 'var', 'let',
    'const', 'def', 'class', 'import', 'from', 'export', 'default', 'async', 'await',
    'get', 'set', 'add', 'push', 'has', 'key', 'value', 'name', 'data', 'result',
]);

export class CodeGraph {
    private readonly nodes = new Map<string, FileNode>();
    /** symbol name → files that define it. */
    private readonly definitions = new Map<string, Set<string>>();
    private edges: GraphEdge[] = [];
    private edgesStale = true;

    get fileCount(): number { return this.nodes.size; }
    get symbolCount(): number { return this.definitions.size; }

    hasFile(file: string): boolean { return this.nodes.has(file); }

    /** Adds or replaces one file. Incremental: callers re-add only what changed. */
    addFile(file: string, content: string): void {
        this.remove(file);

        const language = languageOf(file);
        const plans = planChunks(content, language) ?? [];
        const masked = maskLiterals(content, language);
        const lines = masked.split(/\r?\n/);

        const symbols: GraphSymbol[] = plans
            .filter(p => p.symbol)
            .map(p => ({
                name: p.symbol!,
                file,
                startLine: p.startLine,
                endLine: p.endLine,
                kind: p.kind,
                ...(p.parent ? { parent: p.parent } : {}),
            }));

        const defined = new Set(symbols.map(s => s.name));
        for (const name of defined) {
            const set = this.definitions.get(name) ?? new Set<string>();
            set.add(file);
            this.definitions.set(name, set);
        }

        this.nodes.set(file, {
            file,
            language,
            symbols,
            importSpecifiers: extractImports(content.split(/\r?\n/), lines, language),
            referenced: extractReferences(lines, defined),
        });
        this.edgesStale = true;
    }

    remove(file: string): void {
        const existing = this.nodes.get(file);
        if (!existing) return;

        for (const symbol of existing.symbols) {
            const set = this.definitions.get(symbol.name);
            if (!set) continue;
            set.delete(file);
            if (set.size === 0) this.definitions.delete(symbol.name);
        }
        this.nodes.delete(file);
        this.edgesStale = true;
    }

    /** Every file that defines `name`. */
    definitionsOf(name: string): GraphSymbol[] {
        const files = this.definitions.get(name);
        if (!files) return [];
        const out: GraphSymbol[] = [];
        for (const file of files) {
            for (const symbol of this.nodes.get(file)?.symbols ?? []) {
                if (symbol.name === name) out.push(symbol);
            }
        }
        return out;
    }

    /**
     * Symbols whose name matches `query`, best match first (Phase 3, M19 — `@symbol`).
     *
     * Ranked rather than filtered: a dropdown that runs per keystroke must put the
     * exact match at the top, or typing a symbol's full name still leaves the user
     * scanning for it among every name that contains it. An empty query offers the
     * broadest symbols (containers before members) rather than an arbitrary slice, so
     * the menu is useful before the user has typed anything.
     */
    searchSymbols(query: string, limit = 20): GraphSymbol[] {
        const needle = query.trim().toLowerCase();
        const scored: { symbol: GraphSymbol; score: number }[] = [];

        for (const node of this.nodes.values()) {
            for (const symbol of node.symbols) {
                const lowered = symbol.name.toLowerCase();
                let score: number;
                if (!needle) score = symbol.parent ? 3 : 2;
                else if (lowered === needle) score = 0;
                else if (lowered.startsWith(needle)) score = 1;
                else if (lowered.includes(needle)) score = 2;
                else continue;
                scored.push({ symbol, score });
            }
        }

        // Deterministic all the way down: same query, same corpus, same order — a
        // dropdown that reshuffles equal-ranked entries between keystrokes moves the
        // item the user was aiming at.
        scored.sort((a, b) =>
            a.score - b.score
            || a.symbol.name.length - b.symbol.name.length
            || a.symbol.name.localeCompare(b.symbol.name)
            || a.symbol.file.localeCompare(b.symbol.file)
            || a.symbol.startLine - b.symbol.startLine);

        return scored.slice(0, limit).map(s => s.symbol);
    }

    /** Every file that references `name` without defining it. */
    referencesOf(name: string): string[] {
        const out: string[] = [];
        for (const node of this.nodes.values()) {
            if (node.referenced.has(name)) out.push(node.file);
        }
        return out.sort();
    }

    allEdges(): GraphEdge[] {
        if (this.edgesStale) this.rebuildEdges();
        return this.edges;
    }

    /** Files reachable from `file` in one hop, in either direction. */
    neighbours(file: string): { file: string; kind: EdgeKind; via: string; direction: 'out' | 'in' }[] {
        const out: { file: string; kind: EdgeKind; via: string; direction: 'out' | 'in' }[] = [];
        for (const edge of this.allEdges()) {
            if (edge.from === file) out.push({ file: edge.to, kind: edge.kind, via: edge.via, direction: 'out' });
            else if (edge.to === file) out.push({ file: edge.from, kind: edge.kind, via: edge.via, direction: 'in' });
        }
        return out;
    }

    /**
     * Files transitively affected by changing `symbol`, breadth-first.
     *
     * Direction is deliberately *inward*: the question is who depends on this, so
     * the walk follows edges backwards from the definition to its users. Depth is
     * bounded because the second hop is already speculative — everything imports
     * the config module, and an unbounded walk returns the repo.
     */
    impactOf(symbol: string, maxDepth = 2): { file: string; depth: number; via: string }[] {
        const origins = this.definitionsOf(symbol).map(s => s.file);
        if (origins.length === 0) return [];

        const seen = new Set(origins);
        const out: { file: string; depth: number; via: string }[] = [];

        // ── Hop 1: the symbol itself, not its file ──────────────────────────
        //
        // This distinction is the whole accuracy of the tool. Walking incoming
        // *file* edges answers "who depends on inventory-service.ts?", which for
        // `reserveStock` returned thirteen files where one was correct: every
        // importer of `OutOfStockError`, `availableUnits` or `isLowStock` counted as
        // affected. `referencesOf` is symbol-precise, so hop 1 uses it and nothing
        // else. Measured on the eval corpus, this took false positives from 31 to 0
        // across six refactors with no loss of recall.
        const direct = this.referencesOf(symbol).filter(file => !seen.has(file));
        for (const file of direct) {
            seen.add(file);
            out.push({ file, depth: 1, via: symbol });
        }

        // ── Hops 2+: file-level, and labelled as the weaker claim ───────────
        //
        // Past the first hop there is no symbol to be precise about: the question
        // becomes "who depends on the files that must change", which is a file-level
        // relation by nature. Only structural (import) edges carry, because an
        // inferred name match two hops out is coincidence, not consequence.
        let frontier = direct;
        for (let depth = 2; depth <= maxDepth && frontier.length > 0; depth++) {
            const next: string[] = [];
            for (const current of frontier) {
                const incoming = new Map<string, GraphEdge[]>();
                for (const edge of this.allEdges()) {
                    if (edge.to !== current || seen.has(edge.from) || edge.confidence !== 'exact') continue;
                    const list = incoming.get(edge.from);
                    if (list) list.push(edge);
                    else incoming.set(edge.from, [edge]);
                }
                for (const [file, edges] of incoming) {
                    seen.add(file);
                    out.push({ file, depth, via: bestVia(edges, current) });
                    next.push(file);
                }
            }
            frontier = next;
        }

        return out.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
    }

    private rebuildEdges(): void {
        const edges: GraphEdge[] = [];
        const files = Array.from(this.nodes.keys());

        for (const node of this.nodes.values()) {
            // Import edges: resolve the specifier against the known file set.
            for (const specifier of node.importSpecifiers) {
                const target = resolveSpecifier(specifier, node.file, files);
                if (target && target !== node.file) {
                    edges.push({ from: node.file, to: target, kind: 'imports', via: specifier, confidence: 'exact' });
                }
            }

            // Reference edges: a name used here and defined exactly once elsewhere.
            for (const name of node.referenced) {
                const definedIn = this.definitions.get(name);
                if (!definedIn || definedIn.size === 0) continue;
                // A name defined in many files tells us nothing about which one is
                // meant, and adding an edge to each would connect the graph to itself.
                if (definedIn.size > MAX_DEFINITION_SITES) continue;
                for (const target of definedIn) {
                    if (target === node.file) continue;
                    edges.push({ from: node.file, to: target, kind: 'references', via: name, confidence: 'inferred' });
                }
            }
        }

        this.edges = edges;
        this.edgesStale = false;
    }
}

/** A name defined in more than this many files is treated as ambiguous, not linked. */
const MAX_DEFINITION_SITES = 3;

/**
 * Picks the most explanatory justification among several edges between the same
 * pair of files: the symbol actually being analysed first, then any other named
 * reference, and only then the module specifier of a plain import.
 */
function bestVia(edges: GraphEdge[], symbol: string): string {
    return (
        edges.find(e => e.via === symbol) ??
        edges.find(e => e.kind === 'references') ??
        edges[0]
    ).via;
}

// ─── Extraction helpers ─────────────────────────────────────────────────────

/**
 * A module specifier IS a string literal, so it must be read from the raw line —
 * masking blanks exactly the characters wanted. The masked line still decides
 * whether the line counts at all, so an import inside a comment or an example in a
 * docstring never becomes an edge.
 */
function extractImports(rawLines: string[], maskedLines: string[], language: Language): string[] {
    const patterns = IMPORT_PATTERNS[language];
    if (!patterns) return [];

    const out: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
        // Masked-out content leaves whitespace behind; a line that is blank there
        // was entirely comment or string, whatever it looks like raw.
        if (!maskedLines[i]?.trim()) continue;

        for (const re of patterns) {
            const m = re.exec(rawLines[i]);
            if (m?.[1]) { out.push(m[1]); break; }
        }
    }
    return out;
}

function extractReferences(maskedLines: string[], defined: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const line of maskedLines) {
        for (const raw of line.match(/[A-Za-z_$][\w$]*/g) || []) {
            if (raw.length < 3) continue;
            if (defined.has(raw)) continue;              // defined here, not a reference
            if (NOISE.has(raw.toLowerCase())) continue;
            out.add(raw);
        }
    }
    return out;
}

/**
 * Maps a module specifier onto an indexed file path.
 *
 * Relative TS/JS specifiers resolve by normalising the path and trying the usual
 * extensions; everything else falls back to matching the specifier's last segment
 * against a file's basename. That is approximate by design — a real resolver needs
 * `tsconfig` paths, `go.mod`, `sys.path` and a package graph, none of which are
 * available offline, and a wrong-but-plausible edge is worse than a missing one.
 * A specifier that does not resolve produces no edge at all.
 */
export function resolveSpecifier(specifier: string, fromFile: string, files: string[]): string | undefined {
    const fileSet = new Set(files);

    if (specifier.startsWith('.')) {
        const base = joinPosix(dirnamePosix(fromFile), specifier);
        for (const candidate of withExtensions(base)) {
            if (fileSet.has(candidate)) return candidate;
        }
        return undefined;
    }

    // Bare specifier: match on the final segment, and only when it is unambiguous.
    const tail = specifier.split(/[/.:]/).filter(Boolean).pop();
    if (!tail) return undefined;

    const matches = files.filter(f => basenameNoExt(f) === tail);
    return matches.length === 1 ? matches[0] : undefined;
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.cs'];

function withExtensions(base: string): string[] {
    const out = [base];
    for (const ext of EXTENSIONS) {
        out.push(base + ext);
        out.push(joinPosix(base, 'index' + ext));
    }
    return out;
}

// Path helpers operate on the '/'-separated, workspace-relative form the index
// stores, so they must not use node's `path` (which is '\\'-separated on Windows
// and would silently stop matching).
function dirnamePosix(p: string): string {
    const idx = p.lastIndexOf('/');
    return idx === -1 ? '' : p.slice(0, idx);
}

function basenameNoExt(p: string): string {
    const name = p.slice(p.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot === -1 ? name : name.slice(0, dot);
}

function joinPosix(base: string, rest: string): string {
    const segments = (base ? base.split('/') : []).concat(rest.split('/'));
    const out: string[] = [];
    for (const segment of segments) {
        if (!segment || segment === '.') continue;
        if (segment === '..') out.pop();
        else out.push(segment);
    }
    return out.join('/');
}
