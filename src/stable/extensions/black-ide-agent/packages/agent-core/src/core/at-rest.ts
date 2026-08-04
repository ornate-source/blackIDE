import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// ─── Optional at-rest encryption for `.blackIDE/` (Phase 9, M58 · P9-7) ────
//
// Off by default, and the roadmap's own note on this milestone is the right frame: "it is
// the one P3 whose *cost* is in the invariants it must not break." Two of them, named in
// the acceptance clause:
//
//   1. the audit trail stays **append-only**;
//   2. the memory markdown still **round-trips byte-stable**.
//
// Both are broken by the obvious implementation, and each is broken in a different way.
//
// ── Invariant 1 forces line-level sealing ──────────────────────────────────
// Encrypting a JSONL file as one blob means every append is a read-decrypt-append-
// encrypt-rewrite. That is not an append: it rewrites history on every entry, so a crash
// mid-write loses the whole trail rather than one line, and "entries are never edited or
// reordered" stops being a property of the file and becomes a property of a code path
// nobody can verify from the artifact. `audit-trail.ts` says JSONL was chosen precisely
// so "a partial write loses one line, not the file", and whole-file encryption throws
// that away.
//
// So **each line is sealed independently**. The file stays JSONL, appends stay appends,
// and a corrupted line costs one entry. The cost is a per-line nonce and tag — about 60
// bytes — which is the correct thing to spend to keep the property the file exists for.
//
// ── Invariant 2 forces exact-bytes decryption, not "equivalent" ────────────
// `memory-markdown.ts` round-trips byte-for-byte, and the store writes only when the
// rendered bytes differ from what is on disk — so a decryption that returned *equivalent*
// markdown with a different trailing newline would make every read look like a change,
// rewriting a user's file on every idle pass. AES-GCM returns the exact plaintext, and
// `seal`/`open` add nothing to it.
//
// ── The trade-off encrypting memory.md makes, stated rather than hidden ────
// ADR 007 makes `memory.md` a *user file* — editable in an editor, diffable in git. An
// encrypted one is none of those things. That is a real loss and it is the user's call to
// make, so `EncryptionScope` lets them encrypt the audit trail and the caches while
// leaving memory in plaintext, which is the combination most people want: the trail is
// what carries prompts and tool output, and the memory file is what carries eleven
// sentences they wrote themselves.

/** Which parts of `.blackIDE/` are encrypted. Every field defaults to off. */
export interface EncryptionScope {
    /** `.blackIDE/audit/*.jsonl` — the run record. Carries prompts and tool output. */
    auditTrail?: boolean;
    /** `.blackIDE/knowledge/memory.md` — see the note above on what this costs. */
    memory?: boolean;
    /** Caches and indexes under the extension's storage directory. */
    caches?: boolean;
}

export interface EncryptionSettings {
    /** The master switch. False means nothing below is consulted. */
    enabled: boolean;
    scope: EncryptionScope;
}

export const ENCRYPTION_OFF: EncryptionSettings = { enabled: false, scope: {} };

/**
 * Read the settings blob's encryption section.
 *
 * Absent, malformed and explicitly-false all produce the same result, and that is the
 * right shape for a security default: the only way to get encryption is to ask for it in
 * a form this function understands. A parse failure that silently enabled encryption
 * would be worse than one that silently disabled it — a user would find their audit trail
 * unreadable with a key they never set.
 */
export function readEncryptionSettings(raw: unknown): EncryptionSettings {
    if (!raw || typeof raw !== 'object') return ENCRYPTION_OFF;
    const settings = (raw as Record<string, unknown>).atRestEncryption;
    if (!settings || typeof settings !== 'object') return ENCRYPTION_OFF;

    const record = settings as Record<string, unknown>;
    if (record.enabled !== true) return ENCRYPTION_OFF;

    const scope = (record.scope && typeof record.scope === 'object' ? record.scope : {}) as Record<string, unknown>;
    return {
        enabled: true,
        scope: {
            auditTrail: scope.auditTrail === true,
            memory: scope.memory === true,
            caches: scope.caches === true,
        },
    };
}

export function encrypts(settings: EncryptionSettings, part: keyof EncryptionScope): boolean {
    return settings.enabled && settings.scope[part] === true;
}

// ─── Keys ───────────────────────────────────────────────────────────────────

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;

/**
 * scrypt parameters.
 *
 * N=2^15 is the low end of what is defensible in 2026 and is chosen because this key is
 * derived on extension activation, on a laptop, in the path between the user opening a
 * folder and the editor being usable. A cost that makes startup visibly slow is a cost
 * that gets a "remember my key" feature attached to it within a month, and a remembered
 * key on disk beside the ciphertext is not encryption at all.
 */
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function newSalt(): Buffer {
    return randomBytes(SALT_BYTES);
}

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
    if (!passphrase) throw new Error('An at-rest encryption passphrase is required when encryption is enabled.');
    return scryptSync(passphrase, salt, KEY_BYTES, SCRYPT);
}

/** A random key, for storage in the OS keychain rather than derivation from a passphrase. */
export function generateKey(): Buffer {
    return randomBytes(KEY_BYTES);
}

// ─── The envelope ───────────────────────────────────────────────────────────

/**
 * The marker every sealed payload starts with.
 *
 * Present so `isSealed` is a cheap prefix test rather than a parse attempt, and — more
 * importantly — so a *plaintext* file can be read by a build that has encryption enabled,
 * and vice versa. Switching the setting on must not make yesterday's audit trails
 * unreadable, and switching it off must not make today's look like corrupt JSON.
 */
export const SEAL_PREFIX = 'BIDE1:';

/**
 * Seal one string.
 *
 * Single-line by construction: base64 contains no newline, so a sealed audit entry is
 * still exactly one line of a JSONL file and an append is still an append. That is
 * invariant 1, enforced by the encoding rather than by a comment.
 *
 * A fresh random IV per call. Reusing one under AES-GCM is the catastrophic failure of
 * this construction — it leaks the XOR of two plaintexts and forges the authenticator —
 * and the reason it is generated *here* rather than passed in is that an IV a caller
 * supplies is an IV a caller can loop.
 */
export function seal(plaintext: string, key: Buffer): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return SEAL_PREFIX + Buffer.concat([iv, tag, body]).toString('base64');
}

export function isSealed(line: string): boolean {
    return typeof line === 'string' && line.startsWith(SEAL_PREFIX);
}

/**
 * Open a sealed string, returning the **exact** original bytes.
 *
 * Exact is invariant 2. `memory-markdown.ts` round-trips byte-for-byte and the store
 * writes only when the rendered bytes differ from what is on disk, so a decryption that
 * returned equivalent-but-not-identical text would make every read look like a change and
 * rewrite the user's file on every idle pass.
 *
 * Throws on a tampered payload rather than returning what it can. GCM's tag is the whole
 * reason to use it over CTR, and a decrypt that "recovers what it can" from a failed
 * authentication is a decrypt with no integrity at all.
 */
export function open(sealed: string, key: Buffer): string {
    if (!isSealed(sealed)) throw new Error('Not a sealed payload.');
    const raw = Buffer.from(sealed.slice(SEAL_PREFIX.length), 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('Sealed payload is truncated.');

    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = raw.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * Open a payload that may or may not be sealed.
 *
 * The mixed case is the normal one, not an edge: enabling encryption does not rewrite
 * what is already on disk, so a run's trail can contain plaintext lines written before
 * the setting changed and sealed lines after it. Reading has to cope; writing does not.
 */
export function openIfSealed(line: string, key: Buffer | undefined): string {
    if (!isSealed(line)) return line;
    if (!key) throw new Error('This data is encrypted and no key is available to read it.');
    return open(line, key);
}

// ─── File-level helpers ─────────────────────────────────────────────────────

/**
 * Seal a whole document (memory.md, a cache file).
 *
 * Whole-file rather than per-line, because these are read and written as units — there is
 * no append to preserve — and a single envelope hides the line count, which for a memory
 * file is itself information.
 */
export function sealDocument(text: string, key: Buffer): string {
    // Trailing newline so the file is well-formed for tools that expect one, and stripped
    // on the way back so the round-trip is exact.
    return `${seal(text, key)}\n`;
}

export function openDocument(contents: string, key: Buffer | undefined): string {
    const trimmed = contents.replace(/\n$/, '');
    return openIfSealed(trimmed, key);
}

/**
 * A sink that seals each line before it is appended.
 *
 * Wraps rather than replaces the underlying sink, which is what keeps the append-only
 * property a property of the *file*: this class cannot rewrite what came before it,
 * because the only thing it can do to the sink is append one more line.
 */
export interface LineSink {
    append(line: string): void;
}

export class SealingSink implements LineSink {
    constructor(private readonly inner: LineSink, private readonly key: Buffer) {}

    append(line: string): void {
        this.inner.append(seal(line, this.key));
    }
}

/**
 * Read a sealed or mixed JSONL file back into its lines.
 *
 * A line that fails to open is reported in place rather than dropped or thrown on. An
 * audit trail is evidence; silently omitting an entry that will not decrypt would produce
 * a *shorter, apparently complete* record, which is the one output an evidence file must
 * never produce. `parseAuditTrail` sees a placeholder and the reader sees a gap.
 */
export function openLines(contents: string, key: Buffer | undefined): { lines: string[]; failed: number } {
    const out: string[] = [];
    let failed = 0;
    for (const line of contents.split('\n')) {
        if (!line.trim()) continue;
        try {
            out.push(openIfSealed(line, key));
        } catch {
            failed++;
            out.push(JSON.stringify({ seq: -1, at: 0, kind: 'policy', detail: { error: 'this entry could not be decrypted' } }));
        }
    }
    return { lines: out, failed };
}

/**
 * Constant-time key comparison, for a "is this the same key" check.
 *
 * The timing matters less here than the habit: a fast-path `Buffer.equals` in a key
 * check is the kind of line that gets copied into a place where it does matter.
 */
export function sameKey(a: Buffer | undefined, b: Buffer | undefined): boolean {
    if (!a || !b || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
