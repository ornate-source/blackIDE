export interface LLMConfigEntry {
    id: string;
    name: string;
    type: 'google' | 'claude' | 'openai' | 'openrouter' | 'local';
    url?: string;
    apiKey?: string;
    model?: string;
    enabled?: boolean;
}

export interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
}

export interface GrepResult {
    file: string;
    line: number;
    content: string;
}

export interface TokenUsageEntry {
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
}

// ─── Structured, multimodal, tool-aware message model ───────────────────────
// Shared by every provider adapter so we get real roles, a system prompt,
// multi-turn context, image input, and native tool calling for free.

export interface ImagePart {
    mediaType: string;   // e.g. 'image/png'
    dataBase64: string;  // raw base64, no data: prefix
}

/** A tool the model requested us to run, parsed from a provider's tool-call output. */
export interface ToolCall {
    id: string;          // provider tool-call id (or synthesized for fallback)
    name: string;        // tool/action name
    arguments: any;      // parsed JSON arguments
}

/** The result of running a tool, fed back to the model on the next turn. */
export interface ToolResult {
    id: string;          // matches ToolCall.id
    name: string;
    content: string;     // textual result
    isError?: boolean;
    images?: ImagePart[]; // e.g. a browser screenshot fed back as vision
}

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    images?: ImagePart[];
    toolCalls?: ToolCall[];   // assistant turn requested these tools
    toolResults?: ToolResult[]; // user turn carries results for prior toolCalls
}

/** Ask = read-only Q&A; Plan = read-only research + planning; Agent = full access. */
export type AgentMode = 'ask' | 'plan' | 'agent';

/** JSON-schema-ish description of a tool exposed to the model. */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
    /** Approval risk class — drives the permission/auto-approve gate. */
    risk: 'safe' | 'edit' | 'create' | 'exec';
}

export interface CompletionRequest {
    system?: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
}

export interface AgentTurnResult {
    text: string;          // assistant prose (reasoning / final answer)
    toolCalls: ToolCall[]; // tools the model wants to run this turn
}
