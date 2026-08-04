import { describe, expect, it } from 'vitest';
import { describeFindings, redact, redactDeep, shannonBits } from '@blackide/agent-core/core/redaction';

/**
 * Phase 9, M54 (P0) — secret redaction.
 *
 * G6 has read ⬜/❌ since rev 1: file contents and command output go into prompts and logs
 * with no scrubbing. The gate is "no secret reaches a log or a provider request".
 *
 * Half of this suite is about **not** redacting. Over-redaction is not a safe failure: an
 * agent whose view of the code is peppered with `[redacted]` cannot reason about the code,
 * and the user's response to that is to switch redaction off — after which nothing is
 * protected at all. So known credential shapes are caught anywhere, and entropy alone is
 * never enough.
 */

const clean = (text: string) => redact(text).text;

describe('known credential shapes are caught anywhere they appear', () => {
    const cases: Array<[string, string]> = [
        ['github-token', 'ghp_' + 'a'.repeat(36)],
        ['github-pat', 'github_pat_' + 'b'.repeat(30)],
        ['openai-key', 'sk-' + 'c'.repeat(32)],
        ['anthropic-key', 'sk-ant-' + 'd'.repeat(40)],
        ['aws-key-id', 'AKIAIOSFODNN7EXAMPLE'],
        ['google-api-key', 'AIza' + 'e'.repeat(35)],
        ['slack-token', 'xoxb-1234567890-abcdefghij'],
        ['stripe-key', 'sk_live_' + 'f'.repeat(24)],
        ['npm-token', 'npm_' + 'g'.repeat(36)],
        ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
    ];

    for (const [kind, secret] of cases) {
        it(`redacts a ${kind} in prose`, () => {
            const out = clean(`The build failed. Token was ${secret} — retry.`);
            expect(out).not.toContain(secret);
            expect(out).toContain(`[redacted:${kind}]`);
            // Surrounding text is preserved; the agent still gets the context.
            expect(out).toContain('The build failed.');
        });
    }

    it('redacts a whole PEM block, not just part of it', () => {
        const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA' + 'x'.repeat(60) + '\n-----END RSA PRIVATE KEY-----';
        const out = clean(`key file:\n${pem}\ndone`);
        expect(out).not.toContain('MIIEowIBAAKCAQEA');
        expect(out).toContain('[redacted:private-key]');
        // A partially redacted key is worse than either outcome — it looks handled.
        expect(out.match(/redacted/g)).toHaveLength(1);
    });

    it('redacts only the password in a URL, keeping the host as context', () => {
        const out = clean('postgres://admin:s3cr3tp4ss@db.internal:5432/app');
        expect(out).not.toContain('s3cr3tp4ss');
        expect(out).toContain('db.internal');
        expect(out).toContain('admin');
    });

    it('redacts an Authorization header value', () => {
        const out = clean('Authorization: Bearer abcdefghijklmnop1234');
        expect(out).not.toContain('abcdefghijklmnop1234');
        expect(out).toContain('[redacted:auth-header]');
    });
});

describe('assignment-shaped secrets', () => {
    it('redacts by key name even when the value has no entropy', () => {
        // `password=hunter2` has no entropy signal and is still a password.
        expect(clean('password=hunter2')).toContain('[redacted:named-secret]');
        expect(clean('password=hunter2')).not.toContain('hunter2');
    });

    it('handles the three assignment shapes', () => {
        expect(clean('API_KEY=abc123def456')).not.toContain('abc123def456');
        expect(clean('api_key: abc123def456')).not.toContain('abc123def456');
        expect(clean('"apiKey": "abc123def456"')).not.toContain('abc123def456');
    });

    it('catches nested config keys', () => {
        expect(clean('db.client_secret = "wxyz9876543210"')).toContain('redacted');
    });

    it('redacts a high-entropy value even under a neutral key name', () => {
        const blob = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MHF3ZXJ0eXVpb3A=';
        expect(clean(`value = "${blob}"`)).not.toContain(blob);
    });
});

// ─── The half that matters just as much: not over-redacting ─────────────────

describe('ordinary source code survives untouched', () => {
    const untouched = [
        'const timeout = 30000;',
        'import { readFile } from "node:fs/promises";',
        'export function calculateTotalPrice(items: Item[]): number {',
        'if (user.isAuthenticated && user.role === "admin") return true;',
        '// TODO: handle the empty case before the release',
        'const url = "https://api.example.com/v2/users";',
        'git commit -m "fix the retry backoff"',
    ];

    for (const line of untouched) {
        it(`leaves alone: ${line.slice(0, 40)}`, () => {
            expect(clean(line)).toBe(line);
        });
    }

    it('does not redact a git SHA', () => {
        const line = 'reverted in commit 9f8e7d6c5b4a3928170615243342516071829304';
        expect(clean(line)).toBe(line);
    });

    it('does not redact a UUID', () => {
        const line = 'id = 550e8400-e29b-41d4-a716-446655440000';
        expect(clean(line)).toBe(line);
    });

    it('does not redact a content hash in a lockfile line', () => {
        const line = 'integrity sha512-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
        expect(clean(line)).toBe(line);
    });

    it('leaves an env reference readable, so config shape stays visible', () => {
        // Redacting this teaches nothing and hides the shape of the config.
        expect(clean('API_KEY=${API_KEY}')).toBe('API_KEY=${API_KEY}');
        expect(clean('api_key = process.env.OPENAI_KEY')).toContain('process.env');
    });

    it('leaves obvious placeholders alone', () => {
        expect(clean('password=changeme')).toBe('password=changeme');
        expect(clean('token=<your-token-here>')).toBe('token=<your-token-here>');
        expect(clean('secret=xxxxxxxx')).toBe('secret=xxxxxxxx');
    });

    it('does not redact a long prose sentence for having many distinct letters', () => {
        const prose = 'description = "The quick brown fox jumps over the lazy dog repeatedly"';
        expect(clean(prose)).toBe(prose);
    });
});

describe('offsets and idempotency', () => {
    it('redacts every secret in a multi-secret blob', () => {
        const a = 'ghp_' + 'a'.repeat(36);
        const b = 'sk-' + 'b'.repeat(32);
        const out = clean(`first ${a} then ${b} end`);
        expect(out).not.toContain(a);
        expect(out).not.toContain(b);
        expect(out).toContain('end');
    });

    it('never nests a placeholder inside another', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        const out = clean(`token: ${jwt}`);
        expect(out).not.toMatch(/redacted:[^\]]*redacted/);
    });

    it('is idempotent — re-scrubbing scrubbed text changes nothing', () => {
        const once = clean('API_KEY=abcdef1234567890 and ghp_' + 'a'.repeat(36));
        expect(clean(once)).toBe(once);
    });

    it('reports findings without reproducing the secret', () => {
        const { findings } = redact('ghp_' + 'a'.repeat(36));
        expect(findings).toHaveLength(1);
        expect(JSON.stringify(findings)).not.toContain('aaaa');
    });

    it('handles empty and non-string input', () => {
        expect(redact('').text).toBe('');
        expect(redact(undefined as any).text).toBe('');
        expect(redact('').redacted).toBe(false);
    });
});

describe('redactDeep', () => {
    it('scrubs strings anywhere in a structure', () => {
        // A tool's arguments are whatever the model decided to pass, so which field might
        // hold a secret is not knowable in advance.
        const scrubbed = redactDeep({
            command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://api.example.com',
            nested: { list: ['ghp_' + 'a'.repeat(36), 'harmless'] },
            count: 42,
        });
        expect(JSON.stringify(scrubbed)).not.toContain('abcdefghijklmnop1234');
        expect(JSON.stringify(scrubbed)).not.toContain('ghp_aaaa');
        expect(scrubbed.nested.list[1]).toBe('harmless');
        expect(scrubbed.count).toBe(42);
    });

    it('leaves non-strings alone', () => {
        expect(redactDeep({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null });
    });

    it('bounds recursion rather than stack-overflowing on a cycle-ish structure', () => {
        let deep: any = { value: 'ghp_' + 'a'.repeat(36) };
        for (let i = 0; i < 40; i++) deep = { deep };
        expect(() => redactDeep(deep)).not.toThrow();
    });
});

describe('shannonBits', () => {
    it('is near zero for a repeated character and high for random base64', () => {
        expect(shannonBits('aaaaaaaaaaaaaaaa')).toBeLessThan(0.1);
        expect(shannonBits('Zm9vYmFyYmF6cXV4MTIzNDU2')).toBeGreaterThan(3.2);
    });

    it('is zero for an empty string', () => {
        expect(shannonBits('')).toBe(0);
    });
});

describe('describeFindings', () => {
    it('names kinds and counts, never values', () => {
        const { findings } = redact(`ghp_${'a'.repeat(36)} and ghp_${'b'.repeat(36)} and password=hunter2`);
        const described = describeFindings(findings);
        expect(described).toContain('2× github-token');
        expect(described).toContain('named-secret');
        expect(described).not.toContain('hunter2');
    });

    it('is empty when nothing matched', () => {
        expect(describeFindings([])).toBe('');
    });
});
