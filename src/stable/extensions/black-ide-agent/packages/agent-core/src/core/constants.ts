/**
 * Canonical LLM provider identifiers.
 *
 * Use these constants instead of raw strings to prevent typos.
 * Historical note: the Anthropic provider was previously stored as
 * 'antropics' (missing "h", extra "s"). See MF-36 for the migration.
 */
export const PROVIDER = {
    ANTHROPIC: 'anthropic',
    OPENAI: 'openai',
    GOOGLE: 'google',
    OPENROUTER: 'openrouter',
    OLLAMA: 'ollama',
} as const;

export type ProviderId = (typeof PROVIDER)[keyof typeof PROVIDER];

/** Legacy provider key that may exist in persisted user configuration. */
export const LEGACY_ANTHROPIC_KEY = 'antropics';
