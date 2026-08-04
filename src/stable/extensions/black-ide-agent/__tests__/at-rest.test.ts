import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    ENCRYPTION_OFF, SEAL_PREFIX, SealingSink, deriveKey, encrypts, generateKey, isSealed,
    newSalt, open, openDocument, openIfSealed, openLines, readEncryptionSettings, sameKey,
    seal, sealDocument,
} from '@blackide/agent-core/core/at-rest';
import { AuditTrail, parseAuditTrail } from '@blackide/agent-core/core/audit-trail';
import { MemoryStore } from '../src/memory/memory-store';
import { parseMemoryMarkdown, renderMemoryMarkdown } from '@blackide/agent-core/core/memory-markdown';

/**
 * Optional at-rest encryption (Phase 9, M58 · P9-7).
 *
 * The roadmap's own note frames this correctly: it is "the one P3 whose *cost* is in the
 * invariants it must not break". Two are named in the acceptance clause — the audit
 * trail's append-only property and the memory markdown's byte-stable round-trip — and
 * both are broken by the obvious implementation, in different ways. Most of this file is
 * about those two, not about the cipher.
 */

const key = generateKey();
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-atrest-'));

describe('off by default, and only turned on by an explicit request', () => {
    it('absent, malformed and explicitly-false all mean off', () => {
        // The only way to get encryption is to ask for it in a form this understands. A
        // parse failure that enabled it would leave a user with an unreadable audit trail
        // and a key they never set.
        expect(readEncryptionSettings(undefined)).toEqual(ENCRYPTION_OFF);
        expect(readEncryptionSettings({})).toEqual(ENCRYPTION_OFF);
        expect(readEncryptionSettings({ atRestEncryption: 'yes' })).toEqual(ENCRYPTION_OFF);
        expect(readEncryptionSettings({ atRestEncryption: { enabled: 'true' } })).toEqual(ENCRYPTION_OFF);
        expect(readEncryptionSettings({ atRestEncryption: { enabled: false, scope: { memory: true } } }))
            .toEqual(ENCRYPTION_OFF);
    });

    it('scope is per part, so the trail can be encrypted while memory stays editable', () => {
        // The combination most people want: the trail carries prompts and tool output;
        // the memory file carries eleven sentences they wrote themselves.
        const settings = readEncryptionSettings({ atRestEncryption: { enabled: true, scope: { auditTrail: true } } });
        expect(encrypts(settings, 'auditTrail')).toBe(true);
        expect(encrypts(settings, 'memory')).toBe(false);
        expect(encrypts(ENCRYPTION_OFF, 'auditTrail')).toBe(false);
    });
});

describe('the envelope', () => {
    it('round-trips exactly, including whitespace and unicode', () => {
        for (const text of ['', 'plain', '  leading and trailing  ', 'line\nbreak\n', '日本語 · émoji 🔐']) {
            expect(open(seal(text, key), key)).toBe(text);
        }
    });

    it('produces a single line, so a sealed JSONL entry is still one entry', () => {
        // Invariant 1 enforced by the encoding rather than by a comment: base64 contains
        // no newline, so an append stays an append.
        const sealed = seal('{"a":1}\nwith\nnewlines', key);
        expect(sealed).not.toContain('\n');
        expect(sealed.startsWith(SEAL_PREFIX)).toBe(true);
    });

    it('uses a fresh IV, so identical plaintext does not produce identical ciphertext', () => {
        // Reusing an IV under AES-GCM leaks the XOR of two plaintexts and forges the
        // authenticator. It is generated inside `seal` because an IV a caller supplies is
        // an IV a caller can loop.
        expect(seal('same', key)).not.toBe(seal('same', key));
    });

    it('refuses a tampered payload rather than recovering what it can', () => {
        const sealed = seal('the truth', key);
        const tampered = SEAL_PREFIX + Buffer.from(
            Buffer.from(sealed.slice(SEAL_PREFIX.length), 'base64').map((b, i) => (i > 30 ? b ^ 0xff : b)),
        ).toString('base64');
        expect(() => open(tampered, key)).toThrow();
    });

    it('refuses the wrong key', () => {
        expect(() => open(seal('secret', key), generateKey())).toThrow();
    });

    it('refuses a truncated payload', () => {
        expect(() => open(`${SEAL_PREFIX}AAAA`, key)).toThrow(/truncated/);
    });

    it('derives the same key from the same passphrase and salt, and not from another', () => {
        const salt = newSalt();
        expect(sameKey(deriveKey('correct horse', salt), deriveKey('correct horse', salt))).toBe(true);
        expect(sameKey(deriveKey('correct horse', salt), deriveKey('battery staple', salt))).toBe(false);
        expect(sameKey(deriveKey('correct horse', salt), deriveKey('correct horse', newSalt()))).toBe(false);
    });

    it('an empty passphrase is refused rather than silently keyed', () => {
        expect(() => deriveKey('', newSalt())).toThrow(/passphrase is required/);
    });
});

// ─── Invariant 1: the audit trail stays append-only ─────────────────────────

describe('invariant 1 — the audit trail stays append-only', () => {
    it('sealing wraps a sink and can only ever append one more line', () => {
        /*
         * Whole-file encryption would make every append a read-decrypt-append-encrypt-
         * rewrite: not an append. A crash mid-write would lose the whole trail rather
         * than one line, and "entries are never edited or reordered" would stop being a
         * property of the file. `SealingSink` cannot rewrite what came before it, because
         * the only thing it can do to the inner sink is append.
         */
        const written: string[] = [];
        const trail = new AuditTrail('run-1', new SealingSink({ append: l => written.push(l) }, key));

        trail.record('run-started', { prompt: 'do the thing' });
        trail.toolCall('read_file', { path: 'src/a.ts' });
        trail.record('run-ended', { ok: true });

        expect(written).toHaveLength(3);
        expect(written.every(isSealed)).toBe(true);
        // Each entry is exactly one line: the file is still JSONL.
        expect(written.every(line => !line.includes('\n'))).toBe(true);
    });

    it('a sealed trail parses back in order, with sequence numbers intact', () => {
        const written: string[] = [];
        const trail = new AuditTrail('run-1', new SealingSink({ append: l => written.push(l) }, key));
        trail.record('run-started', {});
        trail.toolCall('grep_search', { query: 'x' });
        trail.record('run-ended', {});

        const parsed = parseAuditTrail(written.join('\n'), key);
        expect(parsed.map(e => e.seq)).toEqual([1, 2, 3]);
        expect(parsed[1].detail).toMatchObject({ tool: 'grep_search' });
    });

    it('one corrupted line costs one entry, not the file', () => {
        // The property JSONL was chosen for. A whole-file envelope would lose everything.
        const written: string[] = [];
        const trail = new AuditTrail('run-1', new SealingSink({ append: l => written.push(l) }, key));
        trail.record('run-started', {});
        trail.record('tool-call', { tool: 'a' });
        trail.record('run-ended', {});

        written[1] = `${written[1].slice(0, -6)}XXXXXX`;
        const parsed = parseAuditTrail(written.join('\n'), key);
        expect(parsed).toHaveLength(2);
        expect(parsed.map(e => e.seq)).toEqual([1, 3]);
    });

    it('sealed and plaintext lines coexist — enabling encryption does not orphan old runs', () => {
        /*
         * Not an edge case. Enabling the setting does not rewrite what is on disk, so a
         * trail can hold plaintext lines written before the change and sealed ones after.
         */
        const plain = JSON.stringify({ seq: 1, at: 1, kind: 'run-started', detail: {} });
        const sealed = seal(JSON.stringify({ seq: 2, at: 2, kind: 'run-ended', detail: {} }), key);
        expect(parseAuditTrail(`${plain}\n${sealed}\n`, key).map(e => e.seq)).toEqual([1, 2]);
    });

    it('a build with encryption off still reads every trail it wrote before', () => {
        const plain = JSON.stringify({ seq: 1, at: 1, kind: 'run-started', detail: {} });
        expect(parseAuditTrail(`${plain}\n`, undefined)).toHaveLength(1);
    });

    it('a sealed trail read with no key yields nothing rather than throwing', () => {
        const sealed = seal(JSON.stringify({ seq: 1, at: 1, kind: 'run-started', detail: {} }), key);
        expect(parseAuditTrail(`${sealed}\n`, undefined)).toEqual([]);
    });

    it('an unopenable line becomes a visible gap, never a silent omission', () => {
        /*
         * An audit trail is evidence. Dropping an entry that will not decrypt would
         * produce a *shorter, apparently complete* record — the one output an evidence
         * file must never produce.
         */
        const good = seal('{"seq":1,"at":1,"kind":"run-started","detail":{}}', key);
        const bad = `${SEAL_PREFIX}bm90LXJlYWxseS1zZWFsZWQ=`;
        const result = openLines(`${good}\n${bad}\n`, key);
        expect(result.failed).toBe(1);
        expect(result.lines).toHaveLength(2);
        expect(result.lines[1]).toMatch(/could not be decrypted/);
    });

    it('there is still no way to edit an earlier entry', () => {
        // The class has no update method, deliberately. Encryption must not have added one.
        const trail = new AuditTrail('run-1');
        expect((trail as unknown as Record<string, unknown>).update).toBeUndefined();
        expect((trail as unknown as Record<string, unknown>).rewrite).toBeUndefined();
    });
});

// ─── Invariant 2: the memory markdown round-trips byte-stable ───────────────

const MEMORY = [
    '# Project Memory',
    '',
    'Facts this project has accumulated.',
    '',
    '- This project uses pnpm, never npm <!-- mem id=m_abc type=convention tier=project conf=0.90 uses=3 used=1700 created=1000 status=active origin=user -->',
    '',
].join('\n');

describe('invariant 2 — the memory markdown round-trips byte-stable', () => {
    it('a sealed document opens to the exact original bytes', () => {
        /*
         * Exact, not equivalent. The store writes only when the rendered bytes differ
         * from what is on disk, so a decryption that returned equivalent-but-different
         * text — one trailing newline out — would make every read look like a change and
         * rewrite the user's file on every idle pass.
         */
        expect(openDocument(sealDocument(MEMORY, key), key)).toBe(MEMORY);
    });

    it('the parse/render round-trip still holds through the envelope', () => {
        const opened = openDocument(sealDocument(MEMORY, key), key);
        expect(renderMemoryMarkdown(parseMemoryMarkdown(opened))).toBe(MEMORY);
    });

    it('an encrypted store round-trips a real write', () => {
        const root = scratch();
        const store = new MemoryStore(root, key);
        store.offer('This project deploys with Terraform, not CDK');

        // The file on disk is genuinely encrypted…
        const onDisk = fs.readFileSync(store.filePath, 'utf8');
        expect(isSealed(onDisk.trim())).toBe(true);
        expect(onDisk).not.toMatch(/Terraform/);

        // …and a second store with the same key reads it back.
        expect(new MemoryStore(root, key).entries().map(e => e.text))
            .toEqual(['This project deploys with Terraform, not CDK']);
    });

    it('an unchanged document is NOT rewritten, despite the IV changing every seal', () => {
        /*
         * The one that would have shipped broken. A fresh IV means the ciphertext differs
         * on every call even when nothing changed, so a byte comparison would rewrite the
         * file on every idle consolidation pass — defeating the mtime guard and filling
         * the user's git status with churn.
         */
        const root = scratch();
        const store = new MemoryStore(root, key);
        store.offer('This project deploys with Terraform, not CDK');

        const before = fs.statSync(store.filePath).mtimeMs;
        const bytesBefore = fs.readFileSync(store.filePath, 'utf8');
        store.consolidateAndDecay(Date.now());

        expect(fs.readFileSync(store.filePath, 'utf8')).toBe(bytesBefore);
        expect(fs.statSync(store.filePath).mtimeMs).toBe(before);
    });

    it('refuses to write over a file it could not read, rather than emptying it', () => {
        /*
         * The data-loss bug this feature would otherwise introduce. A memory file
         * encrypted with a key this process does not have parses as *empty*, and without
         * the guard the next mutation renders that empty document straight over the
         * user's memories — on the day they change their passphrase, or open the repo on
         * a second machine.
         */
        const root = scratch();
        new MemoryStore(root, key).offer('This project deploys with Terraform, not CDK');
        const original = fs.readFileSync(path.join(root, '.blackIDE', 'knowledge', 'memory.md'), 'utf8');

        const wrongKey = new MemoryStore(root, generateKey());
        expect(wrongKey.entries()).toEqual([]);
        wrongKey.offer('Something else entirely, which must not land');

        expect(fs.readFileSync(path.join(root, '.blackIDE', 'knowledge', 'memory.md'), 'utf8')).toBe(original);
        expect(new MemoryStore(root, key).entries().map(e => e.text))
            .toEqual(['This project deploys with Terraform, not CDK']);
    });

    it('a plaintext store is unchanged by any of this — the default path is untouched', () => {
        const root = scratch();
        const store = new MemoryStore(root);
        store.offer('This project deploys with Terraform, not CDK');
        const onDisk = fs.readFileSync(store.filePath, 'utf8');
        expect(isSealed(onDisk.trim())).toBe(false);
        expect(onDisk).toMatch(/Terraform/);
        expect(new MemoryStore(root).entries()).toHaveLength(1);
    });

    it('a plaintext file is still readable by a store that has a key', () => {
        // Switching encryption on must not orphan what is already there.
        const root = scratch();
        new MemoryStore(root).offer('This project deploys with Terraform, not CDK');
        expect(new MemoryStore(root, key).entries()).toHaveLength(1);
    });

    it('openIfSealed passes plaintext through untouched', () => {
        expect(openIfSealed('{"a":1}', key)).toBe('{"a":1}');
        expect(openIfSealed('{"a":1}', undefined)).toBe('{"a":1}');
    });
});
