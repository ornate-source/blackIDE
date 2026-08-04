// ─── Command Safety Policy ──────────────────────────────────────────────────
// Gates run_command against a configurable allow/deny policy. The agent runs a
// real shell, so this is the highest-value security surface.

export type PolicyDecision = 'allow' | 'deny' | 'ask';

// Always-blocked destructive patterns, regardless of settings.
const HARD_DENY: RegExp[] = [
    /\brm\s+-rf?\s+[~/](\s|$)/i,     // rm -rf / or ~
    /\brm\s+-rf?\s+\/\*/i,
    /\bmkfs(\.\w+)?\b/i,
    /\bdd\s+if=/i,
    /:\s*\(\s*\)\s*\{.*\|.*&.*\}/,    // fork bomb
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bhalt\b/i,
    />\s*\/dev\/sd[a-z]/i,
    /\bchmod\s+-R?\s+000\s+[~/]/i,
];

export class CommandPolicy {
    private allow: RegExp[];
    private deny: RegExp[];
    private autoApprove: boolean;

    constructor(opts?: { allow?: string[]; deny?: string[]; autoApprove?: boolean }) {
        this.allow = (opts?.allow || []).map(safeRegex).filter(Boolean) as RegExp[];
        this.deny = (opts?.deny || []).map(safeRegex).filter(Boolean) as RegExp[];
        this.autoApprove = !!opts?.autoApprove;
    }

    evaluate(command: string): { decision: PolicyDecision; reason?: string } {
        const cmd = command.trim();
        for (const rx of HARD_DENY) {
            if (rx.test(cmd)) return { decision: 'deny', reason: 'Blocked: matches a destructive-command guard.' };
        }
        for (const rx of this.deny) {
            if (rx.test(cmd)) return { decision: 'deny', reason: 'Blocked by your deny list.' };
        }
        for (const rx of this.allow) {
            if (rx.test(cmd)) return { decision: 'allow' };
        }
        return { decision: this.autoApprove ? 'allow' : 'ask' };
    }
}

function safeRegex(pattern: string): RegExp | null {
    try {
        // Treat entries as substrings unless they look like a regex (contain regex metachars).
        if (/[.*+?^${}()|[\]\\]/.test(pattern)) return new RegExp(pattern, 'i');
        return new RegExp(escapeRegExp(pattern), 'i');
    } catch { return null; }
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
