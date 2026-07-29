// ─── Text tokenisation for retrieval (Phase 3, M14) ─────────────────────────
//
// Extracted from `codebase-index.ts` so the reranker (M17) can tokenise without
// importing the index that imports it. The index re-exports `splitIdentifier` and
// `stem`, so its public surface is unchanged.
//
// Every rule here is applied identically to indexed text and to the query. That is
// what makes an imperfect stem harmless: a token only has to match itself.

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'with', 'as', 'by', 'at', 'be', 'this', 'that', 'from', 'if', 'else', 'return', 'const', 'let', 'var', 'function', 'import', 'export']);

/**
 * Splits an identifier into its parts: `convertMinor` → `convert`, `minor`;
 * `MAX_RETRIES` → `max`, `retries`; `HTTPResponse` → `http`, `response`.
 *
 * Phase 3 (M14) found this to be a root cause of the recall baseline's misses.
 * The tokenizer used to emit `[a-z0-9_]+` runs only, so `convertMinor` became the
 * single opaque token `convertminor` — which a query saying "convert" could never
 * match. The *caller* of a function usually repeats the domain words in prose and
 * in argument names, so it matched and the definition did not. Both the whole
 * identifier and its parts are indexed: the whole one keeps exact-name queries
 * precise, the parts make behavioural queries reachable.
 */
export function splitIdentifier(identifier: string): string[] {
    return identifier
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // camelCase
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // HTTPResponse → HTTP Response
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map(part => part.toLowerCase());
}

/**
 * Strips the handful of English inflections that stand between a question and a
 * function name.
 *
 * Identifiers are written in base forms — `convertMinor`, `reserveStock`,
 * `maskEmail` — and questions are not: *"**converting** the order total"*,
 * *"stock is **reserved**"*, *"never **writes** a full address"*. Without stemming,
 * `convert` and `converting` are unrelated tokens and the definition is unreachable
 * by any query phrased naturally. This closed three of the five definition-site
 * misses in the Phase 3 baseline on its own.
 *
 * Deliberately not a full Porter stemmer. The aggressive later steps (`-ational` →
 * `-ate`, `-iveness` → `-ive`) conflate identifiers that mean different things in
 * code, and every rule here is applied to the query and the index identically, so
 * an imperfect stem still matches itself. Minimum lengths stop `is`/`as`/`class`
 * being mangled.
 */
export function stem(token: string): string {
    if (token.length <= 3) return token;
    if (/[0-9]/.test(token)) return token;   // identifiers like `sha256`, `base64url`

    let s = token;
    if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
    else if (s.endsWith('sses')) s = s.slice(0, -2);
    else if (s.endsWith('ing') && s.length > 5) s = undouble(s.slice(0, -3));
    else if (s.endsWith('ed') && s.length > 4) s = undouble(s.slice(0, -2));
    else if (s.endsWith('ly') && s.length > 4) s = s.slice(0, -2);
    else if (s.endsWith('es') && s.length > 4) s = s.slice(0, -1);
    else if (s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && s.length > 3) s = s.slice(0, -1);

    // Drop a trailing silent `e` last, and unconditionally.
    //
    // Without this the stemmer disagrees with itself on the single most important
    // case it exists for: `reserveStock` yields the part `reserve`, while the
    // question "stock is **reserved**" yields `reserv` — two tokens that never meet,
    // which is exactly the failure stemming was added to fix. Normalising both to
    // `reserv` costs nothing, because the rule is applied identically to the query
    // and to the index.
    if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
    return s;
}

/** `runn` → `run`, `stopp` → `stop`. Leaves `ll`/`ss`/`ff` alone (`call`, `pass`). */
function undouble(stemmed: string): string {
    const last = stemmed[stemmed.length - 1];
    if (stemmed.length > 3 && last === stemmed[stemmed.length - 2] && !'lsfz'.includes(last)) {
        return stemmed.slice(0, -1);
    }
    return stemmed;
}

function accept(token: string, out: string[]): void {
    if (token.length > 1 && token.length < 40 && !STOP.has(token)) out.push(stem(token));
}

export function tokenize(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.match(/[A-Za-z0-9_$]+/g) || []) {
        accept(raw.toLowerCase(), out);

        const parts = splitIdentifier(raw);
        if (parts.length < 2) continue;   // nothing gained by re-adding the whole token
        for (const part of parts) accept(part, out);
    }
    return out;
}
