import { TokenUsageEntry } from './types';

// Token Usage & Cost Tracking — Feature 12
export class TokenTracker {
    private entries: TokenUsageEntry[] = [];

    private static PRICING: Record<string, { input: number; output: number }> = {
        'gemini-2.5-flash': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
        'gemini-2.5-pro': { input: 1.25 / 1_000_000, output: 10.00 / 1_000_000 },
        'gemini-2.0-flash': { input: 0.10 / 1_000_000, output: 0.40 / 1_000_000 },
        'claude-3-5-sonnet': { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
        'claude-3-5-haiku': { input: 0.80 / 1_000_000, output: 4.00 / 1_000_000 },
        'claude-3-opus': { input: 15.00 / 1_000_000, output: 75.00 / 1_000_000 },
        'claude-sonnet-4': { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
        'claude-opus-4': { input: 15.00 / 1_000_000, output: 75.00 / 1_000_000 },
        'gpt-4o': { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
        'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
        'gpt-4-turbo': { input: 10.00 / 1_000_000, output: 30.00 / 1_000_000 },
        'o1': { input: 15.00 / 1_000_000, output: 60.00 / 1_000_000 },
        'o1-mini': { input: 3.00 / 1_000_000, output: 12.00 / 1_000_000 },
    };

    track(model: string, inputText: string, outputText: string): TokenUsageEntry {
        const inputTokens = Math.ceil(inputText.length / 4);
        const outputTokens = Math.ceil(outputText.length / 4);

        // Find matching pricing key
        const modelLower = (model || '').toLowerCase();
        let pricing = { input: 0, output: 0 };
        for (const [key, value] of Object.entries(TokenTracker.PRICING)) {
            if (modelLower.includes(key)) {
                pricing = value;
                break;
            }
        }

        const cost = (inputTokens * pricing.input) + (outputTokens * pricing.output);

        const entry: TokenUsageEntry = {
            timestamp: Date.now(),
            model,
            inputTokens,
            outputTokens,
            estimatedCost: cost
        };

        this.entries.push(entry);
        return entry;
    }

    getSessionSummary(): { totalInput: number; totalOutput: number; totalCost: number; turns: number } {
        return {
            totalInput: this.entries.reduce((s, e) => s + e.inputTokens, 0),
            totalOutput: this.entries.reduce((s, e) => s + e.outputTokens, 0),
            totalCost: this.entries.reduce((s, e) => s + e.estimatedCost, 0),
            turns: this.entries.length,
        };
    }

    getLastEntry(): TokenUsageEntry | undefined {
        return this.entries[this.entries.length - 1];
    }

    reset(): void {
        this.entries = [];
    }

    formatCost(cost: number): string {
        if (cost === 0) return 'local';
        if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`;
        return `$${cost.toFixed(4)}`;
    }

    formatTokens(count: number): string {
        if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
        if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
        return `${count}`;
    }
}
