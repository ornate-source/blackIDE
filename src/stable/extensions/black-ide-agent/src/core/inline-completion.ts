import * as vscode from 'vscode';
import { LLMConfigEntry } from '../core/types';
import { SecretManager } from '../core/secret-manager';
import { LLMClient } from '../core/llm-client';

// Inline Completion Provider — extracted from extension.ts
// Provides FIM-aware code completions using configured LLM models.
export class BlackIdeInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    constructor(private readonly secretManager: SecretManager) {}

    public async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[]> {
        let settings: any = {};
        try {
            const settingsRaw = await this.secretManager.getKey('general-settings');
            if (settingsRaw) {
                settings = JSON.parse(settingsRaw);
            }
        } catch {}

        if (!settings.enableAutocomplete) {
            return [];
        }

        const debounceMs = settings.autocompleteDebounce !== undefined ? Number(settings.autocompleteDebounce) : 250;
        await new Promise(resolve => setTimeout(resolve, debounceMs));
        if (token.isCancellationRequested) {
            return [];
        }

        const maxContext = 1000;
        const offset = document.offsetAt(position);
        const text = document.getText();
        const prefix = text.substring(Math.max(0, offset - maxContext), offset);
        const suffix = text.substring(offset, Math.min(text.length, offset + maxContext));

        const configJson = await this.secretManager.getKey('llm-config');
        if (!configJson) return [];
        const configs: LLMConfigEntry[] = JSON.parse(configJson);
        const activeModelId = settings.autocompleteModelId || settings.selectedModelId;
        const modelConfig = configs.find((c: any) => c.id === activeModelId) || configs.find((c: any) => c.enabled !== false) || configs[0];
        if (!modelConfig) return [];

        const modelName = (modelConfig.model || '').toLowerCase();
        let fimPrompt = '';
        if (modelName.includes('deepseek')) {
            fimPrompt = `<｜fim begin｜>${prefix}<｜fim hole｜>${suffix}<｜fim end｜>`;
        } else if (modelName.includes('qwen') || modelName.includes('llama3') || modelName.includes('codegemma')) {
            fimPrompt = `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
        } else {
            fimPrompt = `Complete the code at the cursor (marked as <cursor>) in the following context.
Output ONLY the code to insert at the cursor. No formatting, no explanations, no markdown fences.
CONTEXT:
${prefix}<cursor>${suffix}
INSERT CODE:`;
        }

        try {
            let completion = '';
            await LLMClient.streamCompletion(modelConfig, fimPrompt, (t) => {
                completion += t;
            });

            completion = completion.replace(/^```\w*\r?\n/, '').replace(/\r?\n```$/, '').replace(/^```/, '');

            if (token.isCancellationRequested || !completion) {
                return [];
            }

            const range = new vscode.Range(position, position);
            return [new vscode.InlineCompletionItem(completion, range)];
        } catch {
            return [];
        }
    }
}
