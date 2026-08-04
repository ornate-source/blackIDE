import { LLMConfigEntry, OpenAICompatibleProvider } from './types';

// ─── Provider registry (Phase 4, M26) ───────────────────────────────────────
//
// 6 providers → 16. Almost all of the increase is data, and that is the finding, not a
// shortcut: DeepSeek, Groq, Mistral, xAI, Together, Fireworks, Cerebras, LiteLLM and
// vLLM all speak OpenAI's `/chat/completions` shape, so what was missing was a base URL
// and a name, not an adapter. Writing nine adapters would have been nine places for the
// streaming/tool-call parsing to drift.
//
// **Bedrock and Vertex are deliberately not here.** The roadmap lists them beside these,
// but they are not config: Bedrock needs SigV4 request signing and Vertex needs a Google
// OAuth token exchange, so each is an auth implementation with its own failure modes and
// its own way of being wrong in production. Shipping a half-working entry for either
// would be worse than not offering it — the user's key would appear to be accepted and
// every call would fail. Recorded as scope, not as done.

export interface ProviderPreset {
    /** Stable `LLMConfigEntry.type`. */
    type: OpenAICompatibleProvider | 'google' | 'claude' | 'local';
    label: string;
    /** Full chat-completions endpoint, ready to use. */
    defaultUrl: string;
    /** False for local runtimes that accept any key, including none. */
    needsApiKey: boolean;
    /** A model id that exists on that provider, so a first config is runnable. */
    exampleModel: string;
    /** Where a user gets a key. Shown in settings, never fetched. */
    keysUrl?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
    // ── Native request shapes ────────────────────────────────────────────────
    { type: 'claude', label: 'Anthropic', defaultUrl: 'https://api.anthropic.com/v1/messages', needsApiKey: true, exampleModel: 'claude-sonnet-4-5', keysUrl: 'https://console.anthropic.com/settings/keys' },
    { type: 'google', label: 'Google Gemini', defaultUrl: '', needsApiKey: true, exampleModel: 'gemini-2.5-flash', keysUrl: 'https://aistudio.google.com/apikey' },

    // ── OpenAI-compatible ────────────────────────────────────────────────────
    { type: 'openai', label: 'OpenAI', defaultUrl: 'https://api.openai.com/v1/chat/completions', needsApiKey: true, exampleModel: 'gpt-4o', keysUrl: 'https://platform.openai.com/api-keys' },
    { type: 'openrouter', label: 'OpenRouter', defaultUrl: 'https://openrouter.ai/api/v1/chat/completions', needsApiKey: true, exampleModel: 'anthropic/claude-sonnet-4.5', keysUrl: 'https://openrouter.ai/keys' },
    { type: 'deepseek', label: 'DeepSeek', defaultUrl: 'https://api.deepseek.com/v1/chat/completions', needsApiKey: true, exampleModel: 'deepseek-chat', keysUrl: 'https://platform.deepseek.com/api_keys' },
    { type: 'groq', label: 'Groq', defaultUrl: 'https://api.groq.com/openai/v1/chat/completions', needsApiKey: true, exampleModel: 'llama-3.3-70b-versatile', keysUrl: 'https://console.groq.com/keys' },
    { type: 'mistral', label: 'Mistral', defaultUrl: 'https://api.mistral.ai/v1/chat/completions', needsApiKey: true, exampleModel: 'mistral-large-latest', keysUrl: 'https://console.mistral.ai/api-keys' },
    { type: 'xai', label: 'xAI (Grok)', defaultUrl: 'https://api.x.ai/v1/chat/completions', needsApiKey: true, exampleModel: 'grok-4', keysUrl: 'https://console.x.ai' },
    { type: 'together', label: 'Together AI', defaultUrl: 'https://api.together.xyz/v1/chat/completions', needsApiKey: true, exampleModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keysUrl: 'https://api.together.ai/settings/api-keys' },
    { type: 'fireworks', label: 'Fireworks AI', defaultUrl: 'https://api.fireworks.ai/inference/v1/chat/completions', needsApiKey: true, exampleModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', keysUrl: 'https://fireworks.ai/account/api-keys' },
    { type: 'cerebras', label: 'Cerebras', defaultUrl: 'https://api.cerebras.ai/v1/chat/completions', needsApiKey: true, exampleModel: 'llama-3.3-70b', keysUrl: 'https://cloud.cerebras.ai' },
    { type: 'azure-openai', label: 'Azure OpenAI', defaultUrl: '', needsApiKey: true, exampleModel: 'gpt-4o' },

    // ── Self-hosted / local ──────────────────────────────────────────────────
    { type: 'litellm', label: 'LiteLLM proxy', defaultUrl: 'http://localhost:4000/v1/chat/completions', needsApiKey: false, exampleModel: 'gpt-4o' },
    { type: 'vllm', label: 'vLLM server', defaultUrl: 'http://localhost:8000/v1/chat/completions', needsApiKey: false, exampleModel: 'meta-llama/Llama-3.1-8B-Instruct' },
    { type: 'local', label: 'Ollama / LM Studio / llama.cpp', defaultUrl: 'http://localhost:11434/v1/chat/completions', needsApiKey: false, exampleModel: 'llama3.1' },
];

const OPENAI_COMPATIBLE: readonly string[] = [
    'openai', 'openrouter', 'deepseek', 'groq', 'mistral', 'xai',
    'together', 'fireworks', 'cerebras', 'litellm', 'vllm', 'azure-openai',
];

export function isOpenAICompatible(type: string): boolean {
    return OPENAI_COMPATIBLE.includes(type);
}

export function presetFor(type: string): ProviderPreset | undefined {
    return PROVIDER_PRESETS.find(p => p.type === type);
}

/**
 * The endpoint for a config: its explicit `url`, else the preset's default.
 *
 * Azure is the exception and cannot have a useful default — the host name contains the
 * user's resource name and the path contains their deployment — so it returns the URL
 * built from the parts they gave us, and an empty string if they gave us none. An empty
 * string surfaces as a clear "endpoint not configured" at the call site instead of a
 * request to somebody else's API.
 */
export function endpointFor(config: LLMConfigEntry): string {
    if (config.type === 'azure-openai') return azureUrl(config);
    if (config.url) return config.url;
    return presetFor(config.type)?.defaultUrl ?? '';
}

function azureUrl(config: LLMConfigEntry): string {
    if (!config.url) return '';
    const base = config.url.replace(/\/+$/, '');
    // Already a full path (the user pasted the endpoint from the portal) — leave it.
    if (base.includes('/chat/completions')) return base;
    const deployment = config.azureDeployment || config.model || '';
    const version = config.azureApiVersion || '2024-10-21';
    if (!deployment) return '';
    return `${base}/openai/deployments/${deployment}/chat/completions?api-version=${version}`;
}

/**
 * Auth headers for an OpenAI-compatible provider.
 *
 * Azure authenticates with `api-key`, not `Authorization: Bearer` — sending the bearer
 * header to Azure fails with a 401 that reads exactly like a bad key, which is the kind
 * of error that costs an hour.
 */
export function authHeaders(config: LLMConfigEntry): Record<string, string> {
    if (!config.apiKey) return {};
    if (config.type === 'azure-openai') return { 'api-key': config.apiKey };
    return { Authorization: `Bearer ${config.apiKey}` };
}
