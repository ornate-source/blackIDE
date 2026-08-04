// ─── Symbol-aware chunking (Phase 3, M14) ───────────────────────────────────
//
// Replaces the fixed 50-line window `chunkFile()` used since the index was written.
//
// The window was not merely coarse, it had a specific and measurable failure mode.
// Phase 3's recall baseline (docs/notes/eval-baseline.md) found that every miss at
// k=10 was the same shape: the file where a symbol is *defined* loses to the file
// that *calls* it, whenever the query describes behaviour instead of naming the
// symbol. A 50-line window straddling `convertMinor` dilutes it with whatever else
// shares the window, while the caller repeats the domain vocabulary in prose and in
// argument names. Chunking on the definition is the fix.
//
// ── Backends ────────────────────────────────────────────────────────────────
// `ChunkerBackend` exists so the parser is a swappable detail. The roadmap calls
// for tree-sitter, which is a native/WASM dependency this extension does not have
// today (it ships with exactly one runtime dependency) and which cannot be
// validated against the packaged build from here. `LexicalBackend` below needs no
// dependency at all and targets the same six languages; if tree-sitter is later
// vendored it implements this interface and `chunkFile` does not change.
//
// ── The invariant that makes this safe to swap in ───────────────────────────
// Every line of the file lands in exactly one chunk. A structural chunker that
// silently drops the space between definitions — imports, top-level constants,
// module docstrings — would make some content permanently unfindable, which is a
// far worse regression than coarse chunks. `__tests__/symbol-chunker.test.ts`
// asserts total coverage on every fixture.

export type SymbolKind =
    | 'function' | 'method' | 'class' | 'interface' | 'struct' | 'enum'
    | 'type' | 'trait' | 'impl' | 'module' | 'section' | 'code';

export interface SymbolRegion {
    /** 1-based, inclusive. */
    startLine: number;
    endLine: number;
    symbol?: string;
    kind: SymbolKind;
    /** Enclosing class/impl/trait name, when the region is a member of one. */
    parent?: string;
}

export interface ChunkerBackend {
    readonly id: string;
    /** Returns undefined when this backend does not handle the language at all. */
    regions(content: string, language: Language): SymbolRegion[] | undefined;
}

export type Language =
    | 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'csharp'
    | 'markdown' | 'other';

const BY_EXTENSION: Record<string, Language> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', pyi: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    cs: 'csharp',
    md: 'markdown', markdown: 'markdown',
};

export function languageOf(filePath: string): Language {
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
    return BY_EXTENSION[ext] ?? 'other';
}

/** Languages whose blocks are delimited by braces rather than indentation. */
const BRACE_LANGUAGES = new Set<Language>(['typescript', 'javascript', 'go', 'rust', 'java', 'csharp']);

// ─── Masking ────────────────────────────────────────────────────────────────

/**
 * Returns a copy of `content` with the *interior* of every string and comment
 * replaced by spaces, preserving length and line structure exactly.
 *
 * Brace counting on raw source is wrong in a way that is easy to miss and painful
 * to debug: a `{` inside a string literal or a comment shifts every subsequent
 * region by one nesting level, so definitions silently merge. Masking first makes
 * the depth arithmetic below trustworthy. Offsets are preserved so the masked view
 * and the real lines stay index-aligned.
 */
export function maskLiterals(content: string, language: Language): string {
    const out = content.split('');
    const n = content.length;
    const hashComments = language === 'python';
    const pythonDocstrings = language === 'python';

    let i = 0;
    const blank = (from: number, to: number) => {
        for (let j = from; j < to && j < n; j++) {
            if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
        }
    };

    while (i < n) {
        const c = content[i];
        const next = content[i + 1];

        // Line comments
        if ((c === '/' && next === '/') || (hashComments && c === '#')) {
            let end = content.indexOf('\n', i);
            if (end === -1) end = n;
            blank(i, end);
            i = end;
            continue;
        }

        // Block comments
        if (c === '/' && next === '*') {
            let end = content.indexOf('*/', i + 2);
            end = end === -1 ? n : end + 2;
            blank(i, end);
            i = end;
            continue;
        }

        // Python triple-quoted strings (also its docstrings)
        if (pythonDocstrings && (c === '"' || c === "'") && content.startsWith(c.repeat(3), i)) {
            const quote = c.repeat(3);
            let end = content.indexOf(quote, i + 3);
            end = end === -1 ? n : end + 3;
            blank(i, end);
            i = end;
            continue;
        }

        // Ordinary strings, including template literals. Escapes are honoured so a
        // trailing `\"` does not leave the scanner inside the string forever.
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < n) {
                if (content[j] === '\\') { j += 2; continue; }
                if (content[j] === c) { j++; break; }
                // An unterminated single-quoted string ends at the newline for every
                // language here except template literals, which legally span lines.
                if (content[j] === '\n' && c !== '`') break;
                j++;
            }
            blank(i, j);
            i = j;
            continue;
        }

        i++;
    }

    return out.join('');
}

// ─── Declaration patterns ───────────────────────────────────────────────────

interface DeclPattern {
    re: RegExp;
    kind: SymbolKind;
    /** Which capture group holds the name. */
    group: number;
}

const DECLARATIONS: Record<Language, DeclPattern[]> = {
    typescript: [
        { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', group: 1 },
        { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', group: 1 },
        { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', group: 1 },
        { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/, kind: 'type', group: 1 },
        { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', group: 1 },
        // `export const handler = async (req) => {}` and `const x = function () {}`
        { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: 'function', group: 1 },
        { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/, kind: 'function', group: 1 },
        // Class members. Deliberately last: `constructor(` and `get foo(` would
        // otherwise shadow the more specific patterns above.
        { re: /^\s{1,}(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/, kind: 'method', group: 1 },
    ],
    javascript: [],  // filled below — identical to typescript
    python: [
        { re: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: 'class', group: 2 },
        { re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', group: 2 },
    ],
    go: [
        { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function', group: 1 },
        { re: /^type\s+([A-Za-z_]\w*)\s+struct\b/, kind: 'struct', group: 1 },
        { re: /^type\s+([A-Za-z_]\w*)\s+interface\b/, kind: 'interface', group: 1 },
        { re: /^type\s+([A-Za-z_]\w*)\s+/, kind: 'type', group: 1 },
    ],
    rust: [
        { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:unsafe\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', group: 1 },
        { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct', group: 1 },
        { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum', group: 1 },
        { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait', group: 1 },
        { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/, kind: 'impl', group: 1 },
        { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: 'module', group: 1 },
    ],
    java: [
        { re: /^\s*(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/, kind: 'class', group: 1 },
        { re: /^\s{1,}(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)*[\w$<>\[\],.?\s]+\s+([A-Za-z_$][\w$]*)\s*\(/, kind: 'method', group: 1 },
    ],
    csharp: [
        { re: /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly)\s+)*(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
        { re: /^\s{1,}(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|partial)\s+)*[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\(/, kind: 'method', group: 1 },
    ],
    markdown: [],
    other: [],
};
DECLARATIONS.javascript = DECLARATIONS.typescript;

/** Keywords that look like a call but open a control-flow block, not a definition. */
const CONTROL_KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'try',
    'using', 'lock', 'fixed', 'foreach', 'new', 'await', 'yield', 'typeof',
]);

// ─── The dependency-free backend ────────────────────────────────────────────

export class LexicalBackend implements ChunkerBackend {
    readonly id = 'lexical';

    regions(content: string, language: Language): SymbolRegion[] | undefined {
        if (language === 'markdown') return markdownSections(content);
        if (language === 'python') return pythonRegions(content);
        if (BRACE_LANGUAGES.has(language)) return braceRegions(content, language);
        return undefined;
    }
}

/**
 * Brace languages: find declarations, then take each one's extent from its own line
 * to the line where nesting returns to where it started.
 *
 * Depth is computed from the masked view, so braces inside strings and comments do
 * not participate. A declaration that never opens a brace (a `type` alias, an
 * abstract method, a Go type on one line) is a single-line region, which is correct
 * — it has no body to include.
 */
function braceRegions(content: string, language: Language): SymbolRegion[] {
    const lines = content.split(/\r?\n/);
    const masked = maskLiterals(content, language).split(/\r?\n/);
    const patterns = DECLARATIONS[language];

    // Brace depth at the START of each line.
    const depthAt: number[] = new Array(lines.length).fill(0);
    let depth = 0;
    for (let i = 0; i < masked.length; i++) {
        depthAt[i] = depth;
        for (const ch of masked[i]) {
            if (ch === '{') depth++;
            else if (ch === '}') depth = Math.max(0, depth - 1);
        }
    }

    const regions: SymbolRegion[] = [];
    const openStack: { name: string; kind: SymbolKind; endLine: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
        const maskedLine = masked[i];
        if (!maskedLine.trim()) continue;

        const match = matchDeclaration(maskedLine, patterns, language);
        if (!match) continue;

        const extent = extentOf(masked, depthAt, i);
        const parent = enclosingName(regions, i + 1);

        regions.push({
            startLine: i + 1,
            endLine: extent + 1,
            symbol: match.name,
            kind: match.kind,
            ...(parent ? { parent } : {}),
        });
        void openStack;
    }

    return regions;
}

function matchDeclaration(line: string, patterns: DeclPattern[], language: Language):
    { name: string; kind: SymbolKind } | undefined {
    for (const pattern of patterns) {
        const m = pattern.re.exec(line);
        if (!m) continue;
        const name = m[pattern.group];
        if (!name || CONTROL_KEYWORDS.has(name)) continue;
        // A member pattern must actually be a signature, not a call inside a body.
        // `foo(bar);` matches the method regex; a real signature is followed by a
        // brace, an arrow, a `=>`, or a throws/where clause — never a semicolon on
        // the same line with nothing else.
        if (pattern.kind === 'method' && !looksLikeSignature(line, language)) continue;
        return { name, kind: pattern.kind };
    }
    return undefined;
}

function looksLikeSignature(line: string, language: Language): boolean {
    const trimmed = line.trimEnd();
    if (/[;,]\s*$/.test(trimmed) && language !== 'java' && language !== 'csharp') return false;
    // Assignment means it is a call whose result is stored, not a declaration.
    if (/^\s*(?:const|let|var|return)\b/.test(line)) return false;
    if (/=\s*[A-Za-z_$][\w$]*\s*\(/.test(line)) return false;
    return /\{\s*$/.test(trimmed) || /\)\s*(?::[^;{]*)?\s*\{?\s*$/.test(trimmed) || /;\s*$/.test(trimmed);
}

/** Last line (0-based) of the block opened on or after `start`. */
function extentOf(masked: string[], depthAt: number[], start: number): number {
    const base = depthAt[start];
    let opened = false;

    for (let i = start; i < masked.length; i++) {
        for (const ch of masked[i]) {
            if (ch === '{') opened = true;
        }
        if (opened) {
            // The block is closed once the NEXT line starts back at the base depth.
            if (i + 1 < masked.length && depthAt[i + 1] <= base) return i;
            if (i + 1 === masked.length) return i;
        } else if (/;\s*$/.test(masked[i].trimEnd())) {
            return i;   // declaration with no body
        } else if (i > start + 8) {
            return start;  // runaway: treat as a single line rather than swallowing the file
        }
    }
    return masked.length - 1;
}

function enclosingName(regions: SymbolRegion[], line: number): string | undefined {
    for (let i = regions.length - 1; i >= 0; i--) {
        const r = regions[i];
        if (r.startLine < line && r.endLine >= line && r.kind !== 'method' && r.kind !== 'function') {
            return r.symbol;
        }
    }
    return undefined;
}

/**
 * Python: a definition's body is everything indented deeper than the `def`/`class`
 * line, up to the first line at or below that indentation. Blank lines and comments
 * do not terminate a body — a blank line between two methods belongs to neither, and
 * treating it as a terminator would end every function at its first paragraph break.
 */
function pythonRegions(content: string): SymbolRegion[] {
    const lines = content.split(/\r?\n/);
    const masked = maskLiterals(content, 'python').split(/\r?\n/);
    const regions: SymbolRegion[] = [];
    const patterns = DECLARATIONS.python;

    for (let i = 0; i < lines.length; i++) {
        if (!masked[i].trim()) continue;

        let found: { name: string; kind: SymbolKind; indent: number } | undefined;
        for (const pattern of patterns) {
            const m = pattern.re.exec(lines[i]);
            if (m) { found = { name: m[pattern.group], kind: pattern.kind, indent: m[1].length }; break; }
        }
        if (!found) continue;

        let end = i;
        for (let j = i + 1; j < lines.length; j++) {
            const line = lines[j];
            if (!line.trim()) continue;                       // blank: undecided
            if (masked[j].trim().startsWith('#')) continue;    // comment: undecided
            if (indentOf(line) <= found.indent) break;
            end = j;
        }

        const parent = enclosingName(regions, i + 1);
        regions.push({
            startLine: i + 1,
            endLine: end + 1,
            symbol: found.name,
            kind: found.kind === 'function' && parent ? 'method' : found.kind,
            ...(parent ? { parent } : {}),
        });
    }

    return regions;
}

function indentOf(line: string): number {
    const m = /^[ \t]*/.exec(line);
    return m ? m[0].replace(/\t/g, '    ').length : 0;
}

/** Markdown: one region per heading, running to the next heading of the same or higher level. */
function markdownSections(content: string): SymbolRegion[] {
    const lines = content.split(/\r?\n/);
    const headings: { line: number; level: number; text: string }[] = [];
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
        if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
        if (inFence) continue;
        const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
        if (m) headings.push({ line: i, level: m[1].length, text: m[2].trim() });
    }
    if (headings.length === 0) return [];

    return headings.map((h, idx) => {
        let end = lines.length - 1;
        for (let j = idx + 1; j < headings.length; j++) {
            if (headings[j].level <= h.level) { end = headings[j].line - 1; break; }
            end = lines.length - 1;
        }
        return { startLine: h.line + 1, endLine: end + 1, symbol: h.text, kind: 'section' as SymbolKind };
    });
}

// ─── Doc-comment attachment ─────────────────────────────────────────────────

const COMMENT_LINE: Record<string, RegExp> = {
    brace: /^\s*(\/\/|\/\*|\*|\*\/)/,
    python: /^\s*#/,
};

/** Decorators and attributes belong to the declaration below them, not above. */
const DECORATOR_LINE = /^\s*(@[\w.]|#\[|\[[A-Z]\w*(\(|\]))/;

/**
 * Extends each region backwards over its doc comment and decorators.
 *
 * This is where a definition's *prose* lives, and prose is what a
 * behaviourally-phrased question actually matches. `convertMinor`'s body says
 * `amountMinor / 10 ** exponentFor(from)`; the comment above it says "Converts an
 * amount held in minor units from one currency to another". Leaving that comment in
 * a separate unnamed chunk — which the first version of this file did — throws away
 * the single best signal the file has and was worth several points of recall@10 on
 * the eval corpus.
 *
 * Stops at a blank line, at a non-comment line, and at the end of the previous
 * region, so one definition can never swallow another's trailing lines.
 */
function attachLeadingDocs(regions: SymbolRegion[], lines: string[], language: Language): SymbolRegion[] {
    const commentRe = language === 'python' ? COMMENT_LINE.python
        : BRACE_LANGUAGES.has(language) ? COMMENT_LINE.brace
            : undefined;
    if (!commentRe) return regions;

    const sorted = [...regions].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);

    return sorted.map((region, index) => {
        // A method may walk back into its enclosing class's header — that is where
        // its doc comment lives. Only a region that *ends* before this one starts is
        // a real obstacle; an enclosing region is not, or no member of any class
        // could ever pick up its comment.
        let floor = 1;
        for (let i = 0; i < index; i++) {
            if (sorted[i].endLine < region.startLine) floor = Math.max(floor, sorted[i].endLine + 1);
        }

        let start = region.startLine;
        for (let line = region.startLine - 1; line >= floor; line--) {
            const text = lines[line - 1];
            if (text === undefined || !text.trim()) break;
            if (!commentRe.test(text) && !DECORATOR_LINE.test(text)) break;
            start = line;
        }
        return { ...region, startLine: start };
    });
}

// ─── Assembly ───────────────────────────────────────────────────────────────

export interface ChunkPlan {
    startLine: number;
    endLine: number;
    symbol?: string;
    kind: SymbolKind;
    parent?: string;
}

export interface ChunkOptions {
    /** Split any region longer than this. */
    maxLines: number;
    /** Regions shorter than this are merged with their neighbour rather than emitted alone. */
    minLines: number;
    backend?: ChunkerBackend;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxLines: 80, minLines: 3 };

/**
 * Turns a file into a covering, non-overlapping list of chunk plans.
 *
 * Returns `undefined` when the backend does not handle the language or finds no
 * structure at all, so the caller falls back to the line window rather than
 * emitting one chunk for a 2000-line file.
 */
export function planChunks(
    content: string,
    language: Language,
    options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkPlan[] | undefined {
    const backend = options.backend ?? new LexicalBackend();
    const raw = backend.regions(content, language);
    if (!raw || raw.length === 0) return undefined;

    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    const found = attachLeadingDocs(raw, lines, language);

    // A container yields a *header* chunk carrying its own name plus one chunk per
    // member — never the whole container a second time, which would double-count
    // every method under BM25.
    //
    // The header is not a leftover: `class OrderService { constructor(private
    // orders: OrderRepository) {} ... }` is where the type's name, its doc comment
    // and its fields live, and dropping it (as the first version of this file did,
    // by keeping only leaf regions) lost the name of every class, struct, trait and
    // markdown heading in the corpus.
    const covered = flattenRegions(found);

    // Fill every gap — imports, top-level constants, module docstrings, trailing
    // helpers. This is the coverage invariant; without it those lines vanish.
    const plans: ChunkPlan[] = [];
    let cursor = 1;
    for (const region of covered) {
        if (region.startLine > cursor) {
            plans.push({ startLine: cursor, endLine: region.startLine - 1, kind: 'code' });
        }
        plans.push(region);
        cursor = Math.max(cursor, region.endLine + 1);
    }
    if (cursor <= totalLines) {
        plans.push({ startLine: cursor, endLine: totalLines, kind: 'code' });
    }

    return splitOversized(mergeTiny(plans, options), options);
}

/**
 * Flattens nested regions into a non-overlapping, ordered list.
 *
 * A container becomes its header (declaration → first member) labelled with its own
 * symbol; each member becomes its own chunk, recursively; the space between and
 * after members becomes unnamed filler (usually a closing brace). Regions that
 * merely touch are left alone.
 */
function flattenRegions(regions: SymbolRegion[]): ChunkPlan[] {
    const sorted = [...regions].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
    const out: ChunkPlan[] = [];

    const emit = (region: SymbolRegion, from: number): void => {
        const children = directChildren(sorted, region);
        if (children.length === 0) {
            out.push({ ...region, startLine: from, endLine: region.endLine });
            return;
        }

        // Header: the declaration and everything before the first member.
        if (children[0].startLine > from) {
            out.push({ ...region, startLine: from, endLine: children[0].startLine - 1 });
        }

        let cursor = from;
        for (const child of children) {
            if (child.startLine > cursor && cursor > from) {
                out.push({ startLine: cursor, endLine: child.startLine - 1, kind: 'code' });
            }
            emit(child, child.startLine);
            cursor = child.endLine + 1;
        }
        if (cursor <= region.endLine) {
            out.push({ startLine: cursor, endLine: region.endLine, kind: 'code' });
        }
    };

    for (const region of sorted) {
        if (!sorted.some(other => other !== region && contains(other, region))) {
            emit(region, region.startLine);
        }
    }

    return out.sort((a, b) => a.startLine - b.startLine);
}

function contains(outer: SymbolRegion, inner: SymbolRegion): boolean {
    if (outer.startLine > inner.startLine || outer.endLine < inner.endLine) return false;
    return outer.startLine !== inner.startLine || outer.endLine !== inner.endLine;
}

/** Children with no other region between them and `parent`. */
function directChildren(all: SymbolRegion[], parent: SymbolRegion): SymbolRegion[] {
    return all
        .filter(r => contains(parent, r) && !all.some(mid => mid !== r && contains(parent, mid) && contains(mid, r)))
        .sort((a, b) => a.startLine - b.startLine);
}

/**
 * Merges runs of very short unnamed chunks into their neighbour. A file's import
 * block otherwise becomes a dozen one-line chunks that match everything weakly and
 * nothing well. Named regions are never merged away — the symbol is the point.
 */
function mergeTiny(plans: ChunkPlan[], options: ChunkOptions): ChunkPlan[] {
    const out: ChunkPlan[] = [];
    for (const plan of plans) {
        const length = plan.endLine - plan.startLine + 1;
        const previous = out[out.length - 1];
        const mergeable =
            previous && !plan.symbol && !previous.symbol &&
            length < options.minLines &&
            (previous.endLine - previous.startLine + 1) + length <= options.maxLines;

        if (mergeable) previous.endLine = plan.endLine;
        else out.push({ ...plan });
    }
    return out;
}

/**
 * Splits an oversized region at statement boundaries — a blank line, or a line at
 * the region's own base indentation. Cutting mid-expression produces a chunk whose
 * text does not parse and whose tokens are half an identifier.
 */
function splitOversized(plans: ChunkPlan[], options: ChunkOptions): ChunkPlan[] {
    const out: ChunkPlan[] = [];
    for (const plan of plans) {
        const length = plan.endLine - plan.startLine + 1;
        if (length <= options.maxLines) { out.push(plan); continue; }

        let start = plan.startLine;
        while (start <= plan.endLine) {
            const hardEnd = Math.min(start + options.maxLines - 1, plan.endLine);
            out.push({ ...plan, startLine: start, endLine: hardEnd });
            start = hardEnd + 1;
        }
    }
    return out;
}

/**
 * Chooses a boundary at or before `preferred` that falls on a blank line, so a
 * split never lands mid-statement. Exported for the tests that pin the behaviour.
 */
export function boundaryBefore(lines: string[], from: number, preferred: number): number {
    for (let i = preferred; i > from + 1; i--) {
        if (!lines[i - 1]?.trim()) return i;
    }
    return preferred;
}
