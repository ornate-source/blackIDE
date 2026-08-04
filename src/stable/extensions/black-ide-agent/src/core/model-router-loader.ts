import { LLMConfigEntry } from '@blackide/agent-core/core/types';
import { SecretManager } from '@blackide/agent-core/core/secret-manager';
import { ModelRouter, ProviderHealth, RouterSettings } from '@blackide/agent-core/core/model-router';

// Loading half of the ModelRouter (Phase 4, M23/M24).
//
// Separate from `model-router.ts` so that stays pure and vscode-free — it is state the
// Phase 11 `agent-core` extraction needs to carry, and a module that reads
// `SecretStorage` cannot move there.

/**
 * Health is process-wide, deliberately.
 *
 * A router built per turn would forget every breaker between turns, so a dead provider
 * would be retried on each one — which is the failure mode circuit breaking exists to
 * prevent. This is the one piece of router state that must outlive a request.
 */
export const providerHealth = new ProviderHealth();

export interface LoadedRouter {
    router: ModelRouter;
    configs: LLMConfigEntry[];
    settings: any;
}

/**
 * Builds a router from stored config. Never throws for "nothing configured" — an empty
 * config list is a legitimate first-run state that `resolve()` reports as undefined, and
 * the caller turns into the zero-config offer (M27) rather than an error.
 */
export async function loadModelRouter(secretManager: SecretManager): Promise<LoadedRouter> {
    const configs = await readConfigs(secretManager);
    const settings = await readSettings(secretManager);
    return { router: new ModelRouter(configs, routerSettings(settings), providerHealth), configs, settings };
}

async function readConfigs(secretManager: SecretManager): Promise<LLMConfigEntry[]> {
    try {
        const raw = await secretManager.getKey('llm-config');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        // Corrupt JSON reads as "no models" rather than crashing activation. The settings
        // panel is still reachable, which is where it can be fixed.
        return [];
    }
}

async function readSettings(secretManager: SecretManager): Promise<any> {
    try {
        const raw = await secretManager.getKey('general-settings');
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

/** Picks the router's fields out of the general settings blob. */
export function routerSettings(settings: any): RouterSettings {
    return {
        selectedModelId: settings?.selectedModelId,
        roleModels: settings?.roleModels || {},
        autocompleteModelId: settings?.autocompleteModelId,
        disableFailover: settings?.disableFailover === true,
    };
}
