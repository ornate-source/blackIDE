import { LLMConfigEntry } from './types';

// ─── ModelRouter (Phase 4, M23 + M24) ───────────────────────────────────────
//
// Until now a "model" meant one thing: `settings.selectedModelId`, read directly at
// five call sites (`chat-task.ts`, `pipeline-entry.ts`, `commit-message.ts`,
// `inline-chat-controller.ts`, `inline-completion.ts`). The one exception —
// `inline-completion.ts` preferring `settings.autocompleteModelId` — is the shape of
// this whole feature, discovered one call site at a time.
//
// A **role** is what a call site actually needs: `chat` wants the strongest model,
// `apply` wants the cheapest one that can copy text exactly, `autocomplete` wants the
// fastest, `rerank` wants a scorer. Roles are named here, resolved here, and every
// call site asks for a role instead of reaching for a setting.
//
// ── Failover (M24) is part of the same module on purpose ─────────────────────
// `LLMClient.fallbackTurn` is the *local-protocol* path, not provider failover — a
// distinction the docs got wrong for two revisions (F7). Real failover needs to know
// which provider just failed, which one is next for this role, and whether the failing
// one should be skipped for a while. That is routing, and splitting it from resolution
// would mean two components each holding half of "which model runs next".

/**
 * `review` (Phase 9, M47) is its own role rather than reusing `edit` or `plan`.
 *
 * The distinction is real and points the opposite way from the usual reason to add a
 * role. Most roles exist so a cheap task can be pointed at a cheap model; `review` exists
 * because reviewing is the task where a cheaper model costs the most — a reviewer that
 * misses defects and volunteers style opinions is worse than no reviewer, and its whole
 * acceptance clause is a precision number. Routing it through `edit` would have quietly
 * put reviews on whichever model somebody chose for commit messages.
 */
export type ModelRole =
    'chat' | 'plan' | 'edit' | 'apply' | 'autocomplete' | 'embed' | 'rerank' | 'review';

export const MODEL_ROLES: readonly ModelRole[] = [
    'chat', 'plan', 'edit', 'apply', 'autocomplete', 'embed', 'rerank', 'review',
];

/** The subset of general settings the router reads. */
export interface RouterSettings {
    /** The user's headline model — the fallback for every role. */
    selectedModelId?: string;
    /** Role → `LLMConfigEntry.id`. Unset or unresolvable entries fall through. */
    roleModels?: Partial<Record<ModelRole, string>>;
    /**
     * Pre-roles per-feature override, still honoured for the `autocomplete` role.
     * Dropping it would silently move existing users' completions onto their chat
     * model — a config that quietly stops being applied is worse than one that errors.
     */
    autocompleteModelId?: string;
    /** Opt-out. With failover off, a role resolves to exactly one model and stops. */
    disableFailover?: boolean;
}

export interface Resolution {
    config: LLMConfigEntry;
    role: ModelRole;
    /** How this model was chosen, for the UI and the audit trail. */
    reason: 'override' | 'role' | 'legacy-autocomplete' | 'selected' | 'first-enabled';
}

/** Why a turn ended up on a different provider than the one it asked for. */
export interface Substitution {
    from: LLMConfigEntry;
    to: LLMConfigEntry;
    because: string;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Per-config circuit breaker.
 *
 * Deliberately counts *consecutive* failures and resets on any success: a provider that
 * fails one request in ten is having a bad day, not an outage, and tripping on a
 * cumulative count would eventually disable every provider a long-running window ever
 * touched.
 */
export class ProviderHealth {
    private readonly failures = new Map<string, number>();
    private readonly openUntil = new Map<string, number>();

    constructor(
        private readonly threshold = DEFAULT_FAILURE_THRESHOLD,
        private readonly cooldownMs = DEFAULT_COOLDOWN_MS,
        private readonly now: () => number = Date.now,
    ) {}

    recordSuccess(id: string): void {
        this.failures.delete(id);
        this.openUntil.delete(id);
    }

    recordFailure(id: string): void {
        const count = (this.failures.get(id) ?? 0) + 1;
        this.failures.set(id, count);
        if (count >= this.threshold) this.openUntil.set(id, this.now() + this.cooldownMs);
    }

    /** False while the breaker is open. Half-open by construction: the next attempt after
     *  the cooldown is a real attempt, and one success closes it. */
    isUsable(id: string): boolean {
        const until = this.openUntil.get(id);
        if (until === undefined) return true;
        if (this.now() >= until) {
            this.openUntil.delete(id);
            this.failures.delete(id);
            return true;
        }
        return false;
    }

    /** For the UI: which providers are currently circuit-broken, and for how long. */
    openBreakers(): { id: string; msRemaining: number }[] {
        const out: { id: string; msRemaining: number }[] = [];
        for (const [id, until] of this.openUntil) {
            const remaining = until - this.now();
            if (remaining > 0) out.push({ id, msRemaining: remaining });
        }
        return out;
    }
}

export class ModelRouter {
    constructor(
        private readonly configs: LLMConfigEntry[],
        private readonly settings: RouterSettings = {},
        readonly health: ProviderHealth = new ProviderHealth(),
    ) {}

    private enabled(): LLMConfigEntry[] {
        return this.configs.filter(c => c.enabled !== false);
    }

    private byId(id?: string): LLMConfigEntry | undefined {
        if (!id) return undefined;
        return this.enabled().find(c => c.id === id);
    }

    /**
     * The model for a role, or undefined when nothing is configured at all.
     *
     * `override` is the caller's explicit choice — the model picked in the chat
     * dropdown, or a Manager run's per-run model. It wins over role configuration
     * because it is a decision made *now* about *this* turn, whereas a role mapping is a
     * standing preference. Getting that precedence backwards would make the model
     * dropdown appear not to work.
     */
    resolve(role: ModelRole, override?: string): Resolution | undefined {
        const explicit = this.byId(override);
        if (explicit) return { config: explicit, role, reason: 'override' };

        const roleChoice = this.byId(this.settings.roleModels?.[role]);
        if (roleChoice) return { config: roleChoice, role, reason: 'role' };

        if (role === 'autocomplete') {
            const legacy = this.byId(this.settings.autocompleteModelId);
            if (legacy) return { config: legacy, role, reason: 'legacy-autocomplete' };
        }

        const selected = this.byId(this.settings.selectedModelId);
        if (selected) return { config: selected, role, reason: 'selected' };

        const first = this.enabled()[0];
        return first ? { config: first, role, reason: 'first-enabled' } : undefined;
    }

    /**
     * The ordered attempt list for a role: the resolved model, then the healthy
     * alternatives, **preferring a different provider type** before another model from
     * the same one.
     *
     * That ordering is the point of health-aware routing. When Anthropic returns 529, a
     * second Anthropic model is behind the same outage; an OpenAI model is not. Sorting
     * by provider diversity rather than by list order is what makes the second attempt
     * likely to succeed instead of merely being a second attempt.
     */
    chainFor(role: ModelRole, override?: string): LLMConfigEntry[] {
        const primary = this.resolve(role, override)?.config;
        if (!primary) return [];
        if (this.settings.disableFailover) return [primary];

        const rest = this.enabled().filter(c => c.id !== primary.id && this.health.isUsable(c.id));
        const differentProvider = rest.filter(c => c.type !== primary.type);
        const sameProvider = rest.filter(c => c.type === primary.type);

        // The primary stays first even when its breaker is open: `runWithFailover` skips
        // unusable entries, and a chain that silently reordered the user's choice would
        // make "which model am I on?" unanswerable from the settings alone.
        return [primary, ...differentProvider, ...sameProvider];
    }

    /** Which role mappings are configured, for the settings UI. */
    describe(): { role: ModelRole; modelId?: string; modelName?: string; reason?: Resolution['reason'] }[] {
        return MODEL_ROLES.map(role => {
            const resolved = this.resolve(role);
            return {
                role,
                modelId: resolved?.config.id,
                modelName: resolved?.config.name,
                reason: resolved?.reason,
            };
        });
    }
}

export interface FailoverOutcome<T> {
    result: T;
    used: LLMConfigEntry;
    substitution?: Substitution;
}

export interface FailoverOptions {
    /** Aborts are the user's decision and must never be retried on another provider. */
    isAbort?: (err: unknown) => boolean;
    /**
     * True once any token has reached the user.
     *
     * The correctness rule of streaming failover: if the primary streamed 400 tokens and
     * then died, retrying on the secondary appends a *second* answer to the first half of
     * one — the user sees two overlapping replies and the transcript is unusable. So a
     * mid-stream failure surfaces as an error and the turn is retried by the user, who
     * still has the partial text. Only a failure before first output may failover.
     */
    hasEmitted?: () => boolean;
    onSubstitution?: (s: Substitution) => void;
}

/**
 * Runs `attempt` down a chain until one succeeds, recording health as it goes.
 *
 * Generic over the attempt so it covers a streamed agent turn, an embedding call and a
 * rerank scoring pass without knowing what any of them are.
 */
export async function runWithFailover<T>(
    chain: LLMConfigEntry[],
    health: ProviderHealth,
    attempt: (config: LLMConfigEntry, isRetry: boolean) => Promise<T>,
    options: FailoverOptions = {},
): Promise<FailoverOutcome<T>> {
    if (!chain.length) throw new Error('No model is configured. Add one in Settings.');

    const isAbort = options.isAbort ?? (() => false);
    const primary = chain[0];
    let lastError: unknown;
    let attempted = 0;

    // Skip tripped breakers — but if *every* entry is tripped, try the chain anyway.
    // Refusing to make a call because all providers recently failed turns a transient
    // outage into a hard stop that only time can clear, and the breaker's whole purpose
    // is to stop wasting attempts, not to forbid the last one.
    const usable = chain.filter(c => health.isUsable(c.id));
    const order = usable.length ? usable : chain;

    for (const config of order) {
        try {
            const result = await attempt(config, attempted > 0);
            health.recordSuccess(config.id);
            const substitution = config.id === primary.id ? undefined : {
                from: primary,
                to: config,
                because: errorText(lastError),
            };
            if (substitution) options.onSubstitution?.(substitution);
            return { result, used: config, substitution };
        } catch (err) {
            attempted++;
            if (isAbort(err)) throw err;                       // the user cancelled
            health.recordFailure(config.id);
            lastError = err;
            if (options.hasEmitted?.()) throw err;             // see FailoverOptions.hasEmitted
        }
    }

    throw lastError ?? new Error('Every configured model failed.');
}

function errorText(err: unknown): string {
    if (!err) return 'unknown error';
    const message = (err as any)?.message ?? String(err);
    return String(message).split('\n')[0].slice(0, 200);
}
