import { LLMConfigEntry } from '@blackide/agent-core/core/types';

// ─── Zero-config first run (Phase 4, M27) ───────────────────────────────────
//
// Before this, a fresh install with no API key did nothing useful: every model path
// threw "No LLM configurations found. Configure a model in Settings first." That is a
// dead end for the exact user we claim to serve — §4.5 rules out operating a hosted free
// tier, so *local-first* is the only honest answer to "works before a key is added".
//
// What this does is probe for a model runtime the user already has and offer it. It does
// not install anything, does not phone home, and does not enable anything on its own:
// the detected entry is *offered*, and the user accepts it. An editor that silently
// started routing prompts to a local server the user forgot was running would be a
// privacy surprise even though nothing left the machine.

export interface LocalRuntime {
    id: 'ollama' | 'lmstudio' | 'llamacpp';
    label: string;
    /** Where we look, and what a positive answer means. */
    probeUrl: string;
    chatUrl: string;
    /** Pulls model ids out of that runtime's listing response. */
    parseModels(body: any): string[];
}

export const LOCAL_RUNTIMES: readonly LocalRuntime[] = [
    {
        id: 'ollama',
        label: 'Ollama',
        probeUrl: 'http://localhost:11434/api/tags',
        chatUrl: 'http://localhost:11434/v1/chat/completions',
        parseModels: (body) => (body?.models || []).map((m: any) => String(m?.name || '')).filter(Boolean),
    },
    {
        id: 'lmstudio',
        label: 'LM Studio',
        probeUrl: 'http://localhost:1234/v1/models',
        chatUrl: 'http://localhost:1234/v1/chat/completions',
        parseModels: (body) => (body?.data || []).map((m: any) => String(m?.id || '')).filter(Boolean),
    },
    {
        id: 'llamacpp',
        label: 'llama.cpp',
        probeUrl: 'http://localhost:8080/v1/models',
        chatUrl: 'http://localhost:8080/v1/chat/completions',
        parseModels: (body) => (body?.data || []).map((m: any) => String(m?.id || '')).filter(Boolean),
    },
];

/** How long we wait for a local port. Short on purpose — see `probeLocalRuntimes`. */
export const PROBE_TIMEOUT_MS = 1_200;

export interface LocalDetection {
    runtime: LocalRuntime;
    models: string[];
    /** Ready-to-save configs, newest-looking model first. */
    configs: LLMConfigEntry[];
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; json(): Promise<any> }>;

/**
 * Probes every known local runtime in parallel and returns the ones that answered.
 *
 * **Every failure mode here is "not running", and none of them is an error.** A refused
 * connection, a timeout, a 404, HTML from an unrelated server on that port — all mean the
 * same thing to the caller, so they are swallowed rather than surfaced. The timeout is
 * short and non-negotiable because this runs on a path a user is waiting on: a machine
 * with nothing listening must not pay a multi-second stall to discover that.
 */
export async function probeLocalRuntimes(
    fetchImpl: FetchLike = fetch as any,
    timeoutMs = PROBE_TIMEOUT_MS,
): Promise<LocalDetection[]> {
    const results = await Promise.all(LOCAL_RUNTIMES.map(async runtime => {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetchImpl(runtime.probeUrl, { signal: controller.signal });
                if (!response.ok) return undefined;
                const models = runtime.parseModels(await response.json());
                if (!models.length) return undefined;          // running, but nothing pulled
                return { runtime, models, configs: models.map(m => configFor(runtime, m)) };
            } finally {
                clearTimeout(timer);
            }
        } catch {
            return undefined;                                   // not running — the normal case
        }
    }));
    return results.filter((r): r is LocalDetection => !!r);
}

export function configFor(runtime: LocalRuntime, model: string): LLMConfigEntry {
    return {
        id: `${runtime.id}-${model}`,
        name: `${runtime.label}: ${model}`,
        // `local` rather than an OpenAI-compatible type: local models vary wildly in how
        // reliably they emit tool calls, and the text-JSON fallback protocol works on all
        // of them. A first-run default that produces malformed tool calls would read as
        // "this editor is broken", not "this model is weak".
        type: 'local',
        url: runtime.chatUrl,
        model,
        enabled: true,
    };
}

/**
 * The message shown when there is no configured model.
 *
 * Two different sentences for two different situations, because the action differs: with
 * a runtime detected the user has one click to make; without one they need a key. A
 * single generic error made the first case look like the second.
 */
export function noModelGuidance(detections: LocalDetection[]): string {
    if (!detections.length) {
        return 'No model is configured. Add an API key in Settings, or start Ollama / LM Studio '
            + 'locally and reopen this panel — Black IDE will offer the local model with no key required.';
    }
    const named = detections.map(d => `${d.runtime.label} (${d.models.length} model${d.models.length === 1 ? '' : 's'})`).join(', ');
    return `No model is configured, but a local runtime is available: ${named}. `
        + 'Open Settings to use it — no API key needed.';
}
