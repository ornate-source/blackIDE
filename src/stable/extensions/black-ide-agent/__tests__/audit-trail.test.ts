import { describe, expect, it } from 'vitest';
import { AuditTrail, auditRelativePath, parseAuditTrail } from '@blackide/agent-core/core/audit-trail';

/**
 * Phase 9, M53 — the append-only audit trail.
 *
 * G5's complaint has been precise since rev 1: "Diagnostics export ≠ audit trail." A
 * diagnostics export is a snapshot of what the extension thinks *now*; a trail is an
 * ordered record of what happened that cannot be rewritten afterwards. The difference
 * shows up the moment somebody asks what an agent did to their repository at 14:20.
 *
 * The property this suite spends most of its assertions on is **redaction on the way in**.
 * An audit file containing a live credential is a credential sitting in the user's repo
 * under a filename that invites them to attach it to a bug report — and redacting at
 * export time would leave it on disk for the entire window that matters.
 */

function trail() {
    const lines: string[] = [];
    let clock = 1_000;
    const audit = new AuditTrail('run_1', { append: (line) => lines.push(line) }, () => ++clock);
    return { audit, lines };
}

describe('secrets never reach the file', () => {
    it('scrubs a credential in a tool argument', () => {
        const { audit, lines } = trail();
        audit.toolCall('run_command', { command: 'curl -H "Authorization: Bearer abcdefghij123456" https://api.example.com' });

        expect(lines.join('\n')).not.toContain('abcdefghij123456');
        expect(lines.join('\n')).toContain('redacted');
    });

    it('scrubs a credential nested anywhere in an argument object', () => {
        // A tool's arguments are whatever the model decided to pass, so which key holds a
        // secret is not knowable in advance — which is why this is a deep scrub and not a
        // field allowlist.
        const { audit, lines } = trail();
        audit.toolCall('create_file', {
            path: 'config.ts',
            content: { env: { GITHUB_TOKEN: 'ghp_' + 'a'.repeat(36) } },
        });
        expect(lines.join('\n')).not.toContain('ghp_aaaa');
    });

    it('scrubs a secret in a tool result summary', () => {
        const { audit, lines } = trail();
        audit.toolResult('read_file', true, 'AWS_SECRET=' + 'A'.repeat(40));
        expect(lines.join('\n')).not.toContain('A'.repeat(40));
    });

    it('scrubs a steering comment', () => {
        const { audit, lines } = trail();
        audit.steering('use the key sk-' + 'b'.repeat(32) + ' instead');
        expect(lines.join('\n')).not.toContain('sk-bbbb');
    });

    it('returns the scrubbed entry, so a caller cannot re-log the original', () => {
        const { audit } = trail();
        const entry = audit.toolCall('x', { token: 'ghp_' + 'c'.repeat(36) });
        expect(JSON.stringify(entry)).not.toContain('ghp_cccc');
    });
});

describe('append-only ordering', () => {
    it('numbers entries monotonically, so order survives equal timestamps', () => {
        const audit = new AuditTrail('run_1', undefined, () => 5_000);
        audit.record('run-started');
        audit.record('tool-call');
        audit.record('run-ended');
        expect(audit.all().map(e => e.seq)).toEqual([1, 2, 3]);
        expect(new Set(audit.all().map(e => e.at))).toEqual(new Set([5_000]));
    });

    it('writes one line per entry', () => {
        const { audit, lines } = trail();
        audit.record('tool-call');
        audit.record('tool-result');
        expect(lines).toHaveLength(2);
        for (const line of lines) expect(line).not.toContain('\n');
    });

    it('offers no way to edit or reorder a recorded entry', () => {
        // Asserted on the shape of the class: an audit trail with an update method is a log.
        const audit = new AuditTrail('run_1');
        const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(audit));
        for (const forbidden of ['update', 'edit', 'remove', 'delete', 'clear', 'sort']) {
            expect(methods, forbidden).not.toContain(forbidden);
        }
    });
});

describe('a failed write never fails the run', () => {
    it('keeps going when the sink throws', () => {
        const audit = new AuditTrail('run_1', { append: () => { throw new Error('EACCES'); } });
        expect(() => audit.record('tool-call')).not.toThrow();
        // …and the in-memory copy survives, so the export still has it.
        expect(audit.all()).toHaveLength(1);
    });
});

describe('bounds', () => {
    it('caps a result summary rather than logging a whole file', () => {
        const { audit } = trail();
        const entry = audit.toolResult('read_file', true, 'x'.repeat(50_000));
        expect(String(entry.detail.summary).length).toBeLessThan(600);
    });

    it('caps a steering comment', () => {
        const { audit } = trail();
        const entry = audit.steering('y'.repeat(5_000));
        expect(String(entry.detail.text).length).toBeLessThan(600);
    });
});

describe('export and parse', () => {
    it('round-trips through JSONL', () => {
        const { audit } = trail();
        audit.toolCall('read_file', { path: 'a.ts' });
        audit.toolResult('read_file', true, 'contents');
        expect(parseAuditTrail(audit.export())).toEqual(audit.all());
    });

    it('tolerates a truncated final line, which is what a host crash leaves', () => {
        // Refusing to read a trail because its last line is half-written would throw away
        // the record in the one situation it exists for.
        const { audit } = trail();
        audit.record('run-started');
        audit.record('tool-call');
        const truncated = audit.export().slice(0, -20);
        expect(parseAuditTrail(truncated).length).toBeGreaterThanOrEqual(1);
    });

    it('skips a line that is valid JSON but not an entry', () => {
        expect(parseAuditTrail('{"hello":"world"}\n')).toEqual([]);
    });

    it('exports nothing for an empty trail', () => {
        expect(new AuditTrail('r').export()).toBe('');
        expect(parseAuditTrail('')).toEqual([]);
    });
});

describe('summary', () => {
    it('counts by kind and totals the tokens', () => {
        const { audit } = trail();
        audit.toolCall('read_file', {});
        audit.toolCall('grep_search', {});
        audit.usage(1_200, 0.01);
        audit.usage(800, 0.01);

        const summary = audit.summary();
        expect(summary).toContain('2 tool-call');
        expect(summary).toContain('2,000 tokens');
    });

    it('is empty for an empty trail', () => {
        expect(new AuditTrail('r').summary()).toBe('');
    });
});

describe('auditRelativePath', () => {
    it('lives in the user\'s repo, so the record travels with the project', () => {
        expect(auditRelativePath('run_abc')).toBe('.blackIDE/audit/run_abc.jsonl');
    });

    it('sanitises a hostile run id', () => {
        expect(auditRelativePath('../../etc/passwd')).not.toContain('..');
        expect(auditRelativePath('a/b')).not.toContain('a/b');
    });

    it('falls back rather than producing a dotfile with no name', () => {
        expect(auditRelativePath('')).toBe('.blackIDE/audit/run.jsonl');
    });
});
