import { PROVIDER, LEGACY_ANTHROPIC_KEY } from './constants';

/**
 * The three methods this class uses from `vscode.SecretStorage`.
 *
 * Structural rather than imported (Phase 11, M62): `vscode.SecretStorage` is an interface,
 * so importing the module bought a type and cost the whole editor dependency — and it is
 * the reason the *entire retrieval stack* was reachable from `vscode`, since the codebase
 * index takes a SecretManager. A `vscode.SecretStorage` still satisfies this by structure,
 * so the extension passes one unchanged; a CLI passes an env-backed store.
 */
export interface SecretVault {
    get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
    store(key: string, value: string): Thenable<void> | Promise<void>;
    delete(key: string): Thenable<void> | Promise<void>;
}

const LEGACY_ANTHROPIC_STORAGE_KEY = `black-ide-${LEGACY_ANTHROPIC_KEY}-key`;

// Secure Secret Manager wrapper using VS Code Secrets API
export class SecretManager {
    constructor(private readonly secrets: SecretVault) {}

    /** Canonicalize the legacy 'antropics' typo (MF-36) to the real provider id. */
    private canonical(provider: string): string {
        return provider === LEGACY_ANTHROPIC_KEY ? PROVIDER.ANTHROPIC : provider;
    }

    public async saveKey(provider: string, key: string): Promise<void> {
        await this.secrets.store(`black-ide-${this.canonical(provider)}-key`, key);
    }

    public async getKey(provider: string): Promise<string> {
        const canonicalProvider = this.canonical(provider);
        const key = await this.secrets.get(`black-ide-${canonicalProvider}-key`);
        if (key) {
            return key;
        }

        // If asking for 'anthropic' (or legacy 'antropics') and not found, check the alternate/legacy storage key
        if (canonicalProvider === PROVIDER.ANTHROPIC) {
            const legacyKey = await this.secrets.get(LEGACY_ANTHROPIC_STORAGE_KEY);
            if (legacyKey) {
                // Perform the migration: store under the new key, and delete the legacy key
                await this.secrets.store(`black-ide-${PROVIDER.ANTHROPIC}-key`, legacyKey);
                await this.secrets.delete(LEGACY_ANTHROPIC_STORAGE_KEY);
                return legacyKey;
            }
        }

        return '';
    }

    public async deleteKey(provider: string): Promise<void> {
        const canonicalProvider = this.canonical(provider);
        await this.secrets.delete(`black-ide-${canonicalProvider}-key`);
        if (canonicalProvider === PROVIDER.ANTHROPIC) {
            await this.secrets.delete(LEGACY_ANTHROPIC_STORAGE_KEY);
        }
    }
}
