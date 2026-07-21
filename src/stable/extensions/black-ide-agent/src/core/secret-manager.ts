import * as vscode from 'vscode';
import { PROVIDER, LEGACY_ANTHROPIC_KEY } from './constants';

const LEGACY_ANTHROPIC_STORAGE_KEY = `black-ide-${LEGACY_ANTHROPIC_KEY}-key`;

// Secure Secret Manager wrapper using VS Code Secrets API
export class SecretManager {
    constructor(private readonly secrets: vscode.SecretStorage) {}

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
