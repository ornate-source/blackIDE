import { MemoryEntry, MemoryStatus, MemoryTier, MemoryType, clamp01, memoryId } from './memory-model';

// ─── The markdown projection (Phase 8, ADR 007) ─────────────────────────────
//
// The store's user-facing form. ADR 007 says the markdown is the thing a human reads and
// edits and the thing that outlives this extension, so the typed index is *derived* — and
// the property that keeps "derived" from quietly becoming "authoritative" is that this
// module round-trips: parse a file into entries, render those entries, and get the same
// bytes back.
//
// ── Why byte-stability is the gate and not a nicety ──────────────────────────
// The file is in the user's repo, so it is in their diffs. A projection that reorders
// entries, normalises a dash, or rewrites `0.80` as `0.8` produces a spurious diff on every
// consolidation pass — and a file that churns without changing meaning is one people stop
// reading, then stop trusting, then delete. The stability requirement is what makes an
// automatic writer acceptable in a directory a human owns.
//
// ── And why unknown content is preserved rather than parsed ──────────────────
// Anything this parser does not understand is kept verbatim in `preamble`/`trailing` and
// written back untouched. A user who adds a paragraph of their own prose to the memory file
// must find it there tomorrow; a projection that silently drops what it cannot model is a
// projection that eats the user's notes.

const HEADING = '# Project Memory';
const ENTRY_PREFIX = '- ';

/** The metadata suffix: `<!-- id type tier conf uses used-at created-at status -->`. */
const META = /<!--\s*mem\s+([^>]*?)\s*-->/;

export interface MemoryDocument {
    entries: MemoryEntry[];
    /** Everything above the first entry, kept verbatim — including the user's own prose. */
    preamble: string;
    /** Everything after the last entry, likewise. */
    trailing: string;
    /** True when the file ended with a newline, so rendering can put it back. */
    trailingNewline: boolean;
}

export const EMPTY_DOCUMENT: MemoryDocument = {
    entries: [], preamble: `${HEADING}\n`, trailing: '', trailingNewline: true,
};

/**
 * Parse the markdown into entries plus whatever else was in the file.
 *
 * Tolerant by construction: a line that looks like an entry but has no metadata comment is
 * still an entry (a human wrote it by hand, which is the point of a human-editable file) and
 * gets defaults. A malformed metadata comment degrades to defaults rather than dropping the
 * line — losing a memory because a number failed to parse is the worst available outcome.
 */
export function parseMemoryMarkdown(text: string): MemoryDocument {
    const raw = String(text ?? '');
    if (!raw.trim()) return { ...EMPTY_DOCUMENT };

    const trailingNewline = raw.endsWith('\n');
    const lines = raw.split('\n');
    if (trailingNewline) lines.pop();

    const entries: MemoryEntry[] = [];
    const preamble: string[] = [];
    const trailing: string[] = [];
    let seenEntry = false;

    for (const line of lines) {
        if (line.startsWith(ENTRY_PREFIX)) {
            const entry = parseEntryLine(line);
            if (entry) {
                entries.push(entry);
                seenEntry = true;
                continue;
            }
        }
        // A blank line directly after the entry block belongs to the block, not to the
        // trailing content — otherwise every round trip grows or loses one.
        if (seenEntry) trailing.push(line);
        else preamble.push(line);
    }

    return {
        entries,
        preamble: preamble.length ? `${preamble.join('\n')}\n` : '',
        trailing: trailing.length ? trailing.join('\n') : '',
        trailingNewline,
    };
}

function parseEntryLine(line: string): MemoryEntry | undefined {
    const body = line.slice(ENTRY_PREFIX.length);
    const match = body.match(META);
    const text = (match ? body.slice(0, match.index) : body).trim();
    if (!text) return undefined;

    const meta = match ? parseMeta(match[1]) : {};
    const createdAt = meta.created ?? 0;
    return {
        id: meta.id || memoryId(text),
        text,
        type: (meta.type as MemoryType) || 'fact',
        tier: (meta.tier as MemoryTier) || 'project',
        confidence: meta.conf !== undefined ? clamp01(meta.conf) : 0.6,
        provenance: { origin: meta.origin as any || 'user', where: meta.where },
        createdAt,
        lastUsedAt: meta.used ?? createdAt,
        uses: meta.uses ?? 0,
        status: (meta.status as MemoryStatus) || 'active',
    };
}

interface ParsedMeta {
    id?: string; type?: string; tier?: string; conf?: number;
    uses?: number; used?: number; created?: number; status?: string;
    origin?: string; where?: string;
}

/** `key=value` pairs, values URI-encoded so a `where` containing spaces survives. */
function parseMeta(text: string): ParsedMeta {
    const out: ParsedMeta = {};
    for (const pair of text.split(/\s+/)) {
        const index = pair.indexOf('=');
        if (index === -1) continue;
        const key = pair.slice(0, index);
        const value = pair.slice(index + 1);
        switch (key) {
            case 'id': out.id = value; break;
            case 'type': out.type = value; break;
            case 'tier': out.tier = value; break;
            case 'status': out.status = value; break;
            case 'origin': out.origin = value; break;
            case 'where': out.where = safeDecode(value); break;
            case 'conf': out.conf = Number(value); break;
            case 'uses': out.uses = Number(value); break;
            case 'used': out.used = Number(value); break;
            case 'created': out.created = Number(value); break;
        }
    }
    if (out.conf !== undefined && !Number.isFinite(out.conf)) delete out.conf;
    if (out.uses !== undefined && !Number.isFinite(out.uses)) delete out.uses;
    return out;
}

function safeDecode(value: string): string {
    try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * Render a document back to markdown.
 *
 * Entry order is **preserved from the document**, not sorted. Sorting would be tidier and
 * would produce a diff every time a confidence changed — the file's order is the order the
 * user has been reading it in, and churning it is exactly the thing that makes people stop
 * reading a generated file.
 */
export function renderMemoryMarkdown(document: MemoryDocument): string {
    const parts: string[] = [];
    if (document.preamble) parts.push(document.preamble);
    for (const entry of document.entries) parts.push(`${renderEntryLine(entry)}\n`);
    if (document.trailing) parts.push(document.trailing);

    let out = parts.join('');
    if (document.trailingNewline && !out.endsWith('\n')) out += '\n';
    if (!document.trailingNewline && out.endsWith('\n')) out = out.slice(0, -1);
    return out;
}

export function renderEntryLine(entry: MemoryEntry): string {
    const meta = [
        `id=${entry.id}`,
        `type=${entry.type}`,
        `tier=${entry.tier}`,
        `conf=${formatConfidence(entry.confidence)}`,
        `uses=${entry.uses}`,
        `used=${entry.lastUsedAt}`,
        `created=${entry.createdAt}`,
        `status=${entry.status}`,
        `origin=${entry.provenance.origin}`,
        ...(entry.provenance.where ? [`where=${encodeURIComponent(entry.provenance.where)}`] : []),
    ].join(' ');
    return `${ENTRY_PREFIX}${entry.text} <!-- mem ${meta} -->`;
}

/**
 * Two decimals, always.
 *
 * `0.8` and `0.80` are the same number and different bytes, and a formatter that emits
 * whichever `String(n)` happens to produce makes the round trip depend on floating-point
 * representation. Fixing the width is what makes the byte-stability claim hold under
 * arithmetic — decay multiplies confidences, and `0.6 * 0.9` is `0.5399999999999999`.
 */
export function formatConfidence(confidence: number): string {
    return clamp01(confidence).toFixed(2);
}

/** Replace the entries in a document, keeping everything a human wrote around them. */
export function withEntries(document: MemoryDocument, entries: MemoryEntry[]): MemoryDocument {
    return { ...document, entries };
}

/** Parse → render, for asserting the round trip. */
export function roundTrip(text: string): string {
    return renderMemoryMarkdown(parseMemoryMarkdown(text));
}
