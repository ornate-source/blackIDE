// ─── Secret redaction (Phase 9, M54 — P0) ───────────────────────────────────
//
// G6 has read ⬜/❌ since rev 1: "we put file contents and command output into prompts and
// logs with no scrubbing." That is the whole defect. The agent reads `.env` because the
// user asked what the config does, and the contents go to a third-party provider; a build
// fails, the stack trace carries a connection string, and it lands in the diagnostics
// export the user then attaches to a bug report.
//
// ── The tension this module is entirely about ────────────────────────────────
// Over-redaction is not a safe failure. An agent whose view of the code is peppered with
// `[redacted]` cannot reason about the code, and the user's response to that is to turn
// redaction off — after which nothing is protected. So the two detector families are
// treated completely differently:
//
//   - **Known patterns** (`ghp_…`, `sk-…`, `AKIA…`, PEM blocks, JWTs) are shaped like
//     nothing else. They are high precision, so they are redacted wherever they appear.
//   - **Entropy** is low precision. A base64 blob is a secret, a minified bundle, a hash,
//     a UUID, or a git SHA, and redacting all of those makes source unreadable. So entropy
//     alone never triggers: it must *also* be sitting in a secret-shaped slot —
//     `API_KEY=…`, `"password": "…"`, `Authorization: Bearer …`.
//
// The result is a detector that is deliberately conservative on entropy and aggressive on
// shape, which is the trade that keeps it switched on.

export interface Finding {
    /** What matched, for the log line — never the secret itself. */
    kind: string;
    /** Character offset in the input. */
    index: number;
    length: number;
}

export interface RedactionResult {
    text: string;
    findings: Finding[];
    get redacted(): boolean;
}

/** What replaces a secret. Length-independent, so it leaks nothing about the original. */
export const PLACEHOLDER = '[redacted:%KIND%]';

interface Detector {
    kind: string;
    pattern: RegExp;
    /** Which capture group is the secret; 0 means the whole match. */
    group?: number;
}

/**
 * High-precision detectors: vendor-issued credentials with a distinctive shape.
 *
 * Ordered longest/most-specific first, because a `-----BEGIN PRIVATE KEY-----` block also
 * contains base64 that a weaker detector would match in the middle of, producing a
 * partially redacted key — which is worse than either outcome, since it looks handled.
 */
const KNOWN: Detector[] = [
    { kind: 'private-key', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
    { kind: 'aws-secret', pattern: /\baws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi, group: 1 },
    { kind: 'aws-key-id', pattern: /\b((?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16})\b/g, group: 1 },
    { kind: 'github-token', pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/g, group: 1 },
    { kind: 'github-pat', pattern: /\b(github_pat_[A-Za-z0-9_]{22,255})\b/g, group: 1 },
    // Anthropic before OpenAI: `sk-ant-…` also matches the broader `sk-…`, and the first
    // detector to claim a span wins. Found by a test asserting the *kind*, not just that
    // something was redacted — the value was scrubbed either way, so a weaker assertion
    // would have passed while mislabelling every Anthropic key in the audit trail.
    { kind: 'anthropic-key', pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, group: 1 },
    { kind: 'openai-key', pattern: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,})\b/g, group: 1 },
    { kind: 'google-api-key', pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g, group: 1 },
    { kind: 'slack-token', pattern: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/g, group: 1 },
    { kind: 'stripe-key', pattern: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g, group: 1 },
    { kind: 'npm-token', pattern: /\b(npm_[A-Za-z0-9]{36})\b/g, group: 1 },
    { kind: 'jwt', pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, group: 1 },
    // Credentials embedded in a URL. The password is the secret; the host is context the
    // agent legitimately needs, so only the credential pair is replaced.
    { kind: 'url-credentials', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gi, group: 1 },
];

/**
 * Names that make a value secret regardless of what it looks like.
 *
 * Matched against the *key*, not the value, which is what lets a short or low-entropy
 * password be caught — `password=hunter2` has no entropy signal at all and is still a
 * password.
 */
const SECRET_KEY = /(?:^|[_.\-[\]"'])(?:secret|password|passwd|pwd|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credential|passphrase)(?:[_.\-\]"']|$)/i;

/**
 * Assignment shapes: `KEY=value`, `key: value`, `"key": "value"`.
 *
 * Deliberately one regex rather than three passes — the shapes overlap, and running them
 * separately double-redacts the same span and corrupts the offsets in `findings`.
 */
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.\-[\]]{1,60})["']?\s*(?:=|:)\s*(?:"([^"\n]{6,200})"|'([^'\n]{6,200})'|([^\s"',;)]{6,200}))/g;

/** `Authorization: Bearer …` and friends — a header, not an assignment. */
const AUTH_HEADER = /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})/gi;

/** Below this, a string is too short or too structured to be a credential. */
const MIN_ENTROPY_LENGTH = 16;
const MIN_ENTROPY_BITS = 3.2;

/**
 * Scrub a string.
 *
 * Runs known patterns first and records the spans they consumed, so the contextual pass
 * cannot redact inside an already-redacted region — which would otherwise produce
 * `[redacted:[redacted:jwt]]` and shift every subsequent offset.
 */
export function redact(input: string): RedactionResult {
    const text = String(input ?? '');
    if (!text) return result(text, []);

    const findings: Finding[] = [];
    const spans: Array<[number, number]> = [];

    let out = text;
    // Collect first, replace after: replacing while scanning invalidates every later index.
    const replacements: Array<{ start: number; end: number; kind: string }> = [];

    for (const detector of KNOWN) {
        detector.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = detector.pattern.exec(text)) !== null) {
            const group = detector.group ?? 0;
            const value = match[group];
            if (!value) continue;
            const start = match.index + (group === 0 ? 0 : match[0].indexOf(value));
            const end = start + value.length;
            if (overlaps(spans, start, end)) continue;
            spans.push([start, end]);
            replacements.push({ start, end, kind: detector.kind });
        }
    }

    for (const [start, end, kind] of contextualMatches(text)) {
        if (overlaps(spans, start, end)) continue;
        spans.push([start, end]);
        replacements.push({ start, end, kind });
    }

    if (!replacements.length) return result(text, []);

    replacements.sort((a, b) => b.start - a.start);
    for (const replacement of replacements) {
        out = out.slice(0, replacement.start)
            + PLACEHOLDER.replace('%KIND%', replacement.kind)
            + out.slice(replacement.end);
        findings.push({ kind: replacement.kind, index: replacement.start, length: replacement.end - replacement.start });
    }

    findings.reverse();
    return result(out, findings);
}

/** Assignment- and header-shaped secrets, where the key or the entropy gives them away. */
function* contextualMatches(text: string): Generator<[number, number, string]> {
    AUTH_HEADER.lastIndex = 0;
    let header: RegExpExecArray | null;
    while ((header = AUTH_HEADER.exec(text)) !== null) {
        const value = header[1];
        const start = header.index + header[0].lastIndexOf(value);
        yield [start, start + value.length, 'auth-header'];
    }

    ASSIGNMENT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ASSIGNMENT.exec(text)) !== null) {
        const key = match[1];
        const value = match[2] ?? match[3] ?? match[4];
        if (!value) continue;

        const named = SECRET_KEY.test(key);
        // Entropy alone is never enough: a base64 blob is as likely to be a hash, a UUID,
        // a git SHA, a URL or a chunk of a minified bundle, and redacting those makes
        // source unreadable — after which the user turns redaction off and nothing is
        // protected. `looksLikeToken` is the shape gate; entropy only breaks ties within
        // things that already look like credentials.
        const highEntropy = looksLikeToken(value) && shannonBits(value) >= MIN_ENTROPY_BITS;
        if (!named && !highEntropy) continue;
        // A named key with an obviously non-secret value (a placeholder, an env reference)
        // is left alone: redacting `API_KEY=${process.env.KEY}` teaches nothing and hides
        // the shape of the config from the agent.
        if (named && isPlaceholder(value)) continue;

        const start = match.index + match[0].lastIndexOf(value);
        yield [start, start + value.length, named ? 'named-secret' : 'high-entropy'];
    }
}

/**
 * Whether a value has the *shape* of a credential, before entropy is even consulted.
 *
 * Every clause here is a false positive the first implementation produced, and each one
 * would have made real source unreadable:
 *   - **whitespace** — `description = "The quick brown fox jumps over the lazy dog"` has
 *     entropy above the threshold. Prose is not a credential; credentials have no spaces.
 *   - **URLs** — `const url = "https://api.example.com/v2/users"` scored high too.
 *   - **UUIDs** and **all-hex strings** — request ids, git SHAs, integrity hashes. All
 *     high-entropy, all things an agent needs to read.
 *   - **dotted paths** — `process.env.SOMETHING`, `com.example.service.Thing`.
 */
export function looksLikeToken(value: string): boolean {
    const text = String(value || '');
    if (text.length < MIN_ENTROPY_LENGTH) return false;
    if (/\s/.test(text)) return false;                                   // prose
    if (/:\/\/|^\/|^\.{0,2}\//.test(text)) return false;                 // URLs and paths
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return false;  // UUID
    if (/^(?:sha\d+-)?[0-9a-f]+$/i.test(text)) return false;             // git SHA / hex digest
    if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(text)) return false;   // dotted path
    if (!/^[A-Za-z0-9_\-+/=.~]+$/.test(text)) return false;              // not token charset
    // A credential mixes classes; a long lowercase word does not.
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter(re => re.test(text)).length;
    return classes >= 2;
}

/** Obvious non-secrets that share the shape: env references, templates, empty values. */
function isPlaceholder(value: string): boolean {
    const text = value.trim();
    // The env-reference branch has to describe the *whole* value, not its first three
    // characters. Written as a prefix inside an anchored alternation it never matched, so
    // `API_KEY=${API_KEY}` was redacted — hiding the shape of a config file while
    // protecting nothing, which is the over-redaction failure this function exists to stop.
    return /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]+>|xxx+|\*+|changeme|your[_-].*|todo|null|undefined|true|false|\d+)$/i.test(text)
        || /^process\.env\./.test(text);
}

/** Shannon entropy in bits per character. */
export function shannonBits(value: string): number {
    if (!value) return 0;
    const counts = new Map<string, number>();
    for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) {
        const p = count / value.length;
        bits -= p * Math.log2(p);
    }
    return bits;
}

function overlaps(spans: Array<[number, number]>, start: number, end: number): boolean {
    return spans.some(([s, e]) => start < e && end > s);
}

function result(text: string, findings: Finding[]): RedactionResult {
    return { text, findings, get redacted() { return findings.length > 0; } };
}

/**
 * Redact every string in a structure, in place of the caller doing it field by field.
 *
 * Used for the audit trail (M53), where the payload is an arbitrary tool-call argument
 * object and "which fields might hold a secret" is not knowable in advance — a tool's
 * arguments are whatever the model decided to pass.
 */
export function redactDeep<T>(value: T, depth = 0): T {
    if (depth > 8) return value;
    if (typeof value === 'string') return redact(value).text as unknown as T;
    if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1)) as unknown as T;
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
            out[key] = redactDeep(inner, depth + 1);
        }
        return out as unknown as T;
    }
    return value;
}

/** A log line naming what was scrubbed, without reproducing any of it. */
export function describeFindings(findings: Finding[]): string {
    if (!findings.length) return '';
    const counts = new Map<string, number>();
    for (const finding of findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
    return [...counts.entries()].map(([kind, n]) => (n > 1 ? `${n}× ${kind}` : kind)).join(', ');
}
