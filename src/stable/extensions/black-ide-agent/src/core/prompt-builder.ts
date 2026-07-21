// ─── Prompt Builder ─────────────────────────────────────────────────────────
// The system prompt is assembled from independently-budgeted sections rather than
// concatenated. One oversized section (a huge AGENTS.md, a chatty MCP server) can
// then only spend its own budget — it can never crowd out the agent's instructions.

export function estimateTokens(text: string): number {
    return Math.ceil((text || '').length / 4);
}

export interface SectionSpec {
    name: string;
    content: string;
    /** Hard cap for this section. Content beyond it is truncated, not dropped. */
    budgetTokens: number;
    /**
     * Dropped last-to-first when the total budget is blown. Required sections are
     * truncated but never dropped — losing the system instructions is not a
     * degradation, it is a different agent.
     */
    required?: boolean;
}

export interface BuiltSection {
    name: string;
    tokens: number;
    truncated: boolean;
    dropped: boolean;
}

export interface BuiltPrompt {
    text: string;
    totalTokens: number;
    sections: BuiltSection[];
}

const TRUNCATION_NOTE = '\n…(section truncated to fit its token budget)';

export class PromptBuilder {
    private specs: SectionSpec[] = [];

    add(spec: SectionSpec): this {
        if (spec.content && spec.content.trim()) this.specs.push(spec);
        return this;
    }

    /**
     * Assemble the prompt. Sections are truncated to their own budget first; only if
     * the result still exceeds `totalBudgetTokens` are optional sections dropped,
     * lowest-value last (i.e. from the end of the list backwards).
     */
    build(totalBudgetTokens: number): BuiltPrompt {
        const built = this.specs.map(spec => {
            const limit = spec.budgetTokens * 4; // budget is in tokens; content is chars
            const truncated = spec.content.length > limit;
            const content = truncated
                ? spec.content.slice(0, Math.max(0, limit - TRUNCATION_NOTE.length)) + TRUNCATION_NOTE
                : spec.content;
            return { spec, content, truncated, dropped: false };
        });

        let total = built.reduce((sum, b) => sum + estimateTokens(b.content), 0);

        for (let i = built.length - 1; i >= 0 && total > totalBudgetTokens; i--) {
            if (built[i].spec.required || built[i].dropped) continue;
            total -= estimateTokens(built[i].content);
            built[i].dropped = true;
        }

        const text = built
            .filter(b => !b.dropped)
            .map(b => b.content)
            .join('\n\n');

        return {
            text,
            totalTokens: estimateTokens(text),
            sections: built.map(b => ({
                name: b.spec.name,
                tokens: b.dropped ? 0 : estimateTokens(b.content),
                truncated: b.truncated && !b.dropped,
                dropped: b.dropped,
            })),
        };
    }
}
