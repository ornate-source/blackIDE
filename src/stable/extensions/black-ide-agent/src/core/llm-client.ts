import {
    LLMConfigEntry, CompletionRequest, AgentTurnResult, ChatMessage, ToolCall, ImagePart, ToolDefinition
} from './types';

// ─── Multi-Provider AI Client ───────────────────────────────────────────────
// One structured entry point (streamAgentTurn) that speaks each provider's
// NATIVE tool-calling API where available, and falls back to a text-JSON
// protocol for local models. Supports {system, messages[]}, vision images,
// streaming, an AbortSignal, and 429 retries.

export function isAbortError(err: any): boolean {
    return !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

export function supportsNativeTools(config: LLMConfigEntry): boolean {
    return config.type === 'google' || config.type === 'claude'
        || config.type === 'openai' || config.type === 'openrouter';
}

async function fetchWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let retries = 3;
    while (true) {
        const response = await fetch(url, { ...init, signal });
        if (response.ok) return response;
        const errText = await response.text();
        if (response.status === 429 && retries > 0) {
            retries--;
            let waitMs = 5000;
            try {
                const errJson = JSON.parse(errText);
                const retryInfo = errJson.error?.details?.find((d: any) => d['@type']?.includes('RetryInfo'));
                if (retryInfo?.retryDelay) {
                    const seconds = parseFloat(retryInfo.retryDelay);
                    if (!isNaN(seconds)) waitMs = seconds * 1000 + 1000;
                }
            } catch {}
            await new Promise(r => setTimeout(r, waitMs));
            continue;
        }
        throw new Error(`API Error (${response.status}): ${errText}`);
    }
}

export class LLMClient {
    /** Run one agent turn: stream assistant text and collect any tool calls. */
    public static async streamAgentTurn(
        config: LLMConfigEntry,
        request: CompletionRequest,
        onToken: (token: string) => void,
        signal?: AbortSignal
    ): Promise<AgentTurnResult> {
        if (!config) throw new Error('LLM configuration is missing.');
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        if (config.type === 'google') return this.geminiTurn(config, request, onToken, signal);
        if (config.type === 'claude') return this.claudeTurn(config, request, onToken, signal);
        if (supportsNativeTools(config)) return this.openAITurn(config, request, onToken, signal);
        return this.fallbackTurn(config, request, onToken, signal);
    }

    /** Legacy single-shot text completion (autocomplete, inline edit, commit). */
    public static async streamCompletion(
        config: LLMConfigEntry,
        prompt: string,
        onToken: (token: string) => void,
        images?: { path: string; mimeType?: string }[],
        signal?: AbortSignal
    ): Promise<string> {
        const imageParts = readImageParts(images);
        const req: CompletionRequest = {
            messages: [{ role: 'user', content: prompt, images: imageParts }],
        };
        const result = await this.streamAgentTurn(config, req, onToken, signal);
        return result.text;
    }

    // ─── OpenAI-compatible (OpenAI, OpenRouter) ─────────────────────────────
    private static async openAITurn(config: LLMConfigEntry, request: CompletionRequest, onToken: (t: string) => void, signal?: AbortSignal): Promise<AgentTurnResult> {
        const url = config.url || 'https://api.openai.com/v1/chat/completions';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
        if (config.type === 'openrouter') {
            headers['HTTP-Referer'] = 'https://github.com/blackide';
            headers['X-Title'] = 'Black IDE';
        }

        const messages: any[] = [];
        if (request.system) messages.push({ role: 'system', content: request.system });
        for (const m of request.messages) {
            messages.push(...toOpenAIMessages(m));
        }

        const body: any = {
            model: config.model || 'gpt-4o',
            messages,
            stream: true,
            max_tokens: request.maxTokens || 4096,
        };
        if (request.tools?.length) {
            body.tools = request.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
            body.tool_choice = 'auto';
        }

        const response = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) }, signal);
        if (!response.body) throw new Error('Response body is null');

        const toolAcc: Record<number, { id: string; name: string; args: string }> = {};
        let fullText = '';

        await readSSE(response, (data) => {
            const delta = data.choices?.[0]?.delta;
            if (!delta) return;
            if (delta.content) { fullText += delta.content; onToken(delta.content); }
            if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const acc = toolAcc[idx] || (toolAcc[idx] = { id: '', name: '', args: '' });
                    if (tc.id) acc.id = tc.id;
                    if (tc.function?.name) acc.name += tc.function.name;
                    if (tc.function?.arguments) acc.args += tc.function.arguments;
                }
            }
        });

        return { text: fullText, toolCalls: buildToolCalls(toolAcc) };
    }

    // ─── Anthropic Claude ───────────────────────────────────────────────────
    private static async claudeTurn(config: LLMConfigEntry, request: CompletionRequest, onToken: (t: string) => void, signal?: AbortSignal): Promise<AgentTurnResult> {
        const url = config.url || 'https://api.anthropic.com/v1/messages';
        const body: any = {
            model: config.model || 'claude-3-5-sonnet-20241022',
            max_tokens: request.maxTokens || 4096,
            messages: request.messages.map(toClaudeMessage),
            stream: true,
        };
        if (request.system) body.system = request.system;
        if (request.tools?.length) {
            body.tools = request.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
        }

        const response = await fetchWithRetry(url, {
            method: 'POST',
            headers: {
                'x-api-key': config.apiKey || '',
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify(body),
        }, signal);
        if (!response.body) throw new Error('Response body is null');

        const toolAcc: Record<number, { id: string; name: string; args: string }> = {};
        let fullText = '';

        await readSSE(response, (data) => {
            if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
                toolAcc[data.index] = { id: data.content_block.id, name: data.content_block.name, args: '' };
            } else if (data.type === 'content_block_delta') {
                if (data.delta?.type === 'text_delta' && data.delta.text) {
                    fullText += data.delta.text; onToken(data.delta.text);
                } else if (data.delta?.type === 'input_json_delta' && toolAcc[data.index]) {
                    toolAcc[data.index].args += data.delta.partial_json || '';
                }
            }
        });

        return { text: fullText, toolCalls: buildToolCalls(toolAcc) };
    }

    // ─── Google Gemini ──────────────────────────────────────────────────────
    private static async geminiTurn(config: LLMConfigEntry, request: CompletionRequest, onToken: (t: string) => void, signal?: AbortSignal): Promise<AgentTurnResult> {
        const model = config.model || 'gemini-2.5-flash';
        const apiKey = config.apiKey || '';
        const url = config.url || `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}`;

        const body: any = { contents: request.messages.map(toGeminiContent) };
        if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
        if (request.tools?.length) {
            body.tools = [{ functionDeclarations: request.tools.map(t => geminiDecl(t)) }];
        }

        const response = await fetchWithRetry(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }, signal);
        if (!response.body) throw new Error('Response body is null');

        // Stream text tokens live via a lightweight regex, and accumulate the raw
        // buffer so we can authoritatively parse text + functionCalls at the end.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let raw = '';
        let liveEmitted = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            raw += decoder.decode(value, { stream: true });
            let concat = '';
            const regex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
            let m;
            while ((m = regex.exec(raw)) !== null) {
                try { concat += JSON.parse(`"${m[1]}"`); } catch {}
            }
            if (concat.length > liveEmitted) {
                onToken(concat.slice(liveEmitted));
                liveEmitted = concat.length;
            }
        }

        // Authoritative end-parse
        let text = '';
        const toolCalls: ToolCall[] = [];
        try {
            const parsed = JSON.parse(raw.trim());
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            for (const chunk of arr) {
                const parts = chunk.candidates?.[0]?.content?.parts || [];
                for (const p of parts) {
                    if (typeof p.text === 'string') text += p.text;
                    if (p.functionCall) {
                        toolCalls.push({ id: `call_${toolCalls.length}_${Date.now()}`, name: p.functionCall.name, arguments: p.functionCall.args || {} });
                    }
                }
            }
        } catch {
            // Fall back to the live-streamed text if the buffer wasn't valid JSON
            const regex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
            let m; while ((m = regex.exec(raw)) !== null) { try { text += JSON.parse(`"${m[1]}"`); } catch {} }
        }

        return { text, toolCalls };
    }

    // ─── Local / fallback (Ollama, LM Studio, llama.cpp) — text-JSON protocol ─
    private static async fallbackTurn(config: LLMConfigEntry, request: CompletionRequest, onToken: (t: string) => void, signal?: AbortSignal): Promise<AgentTurnResult> {
        const isOllamaGenerate = !!(config.url && config.url.includes('/api/generate'));
        const prompt = flattenRequest(request);
        let fullText = '';

        if (isOllamaGenerate) {
            const url = config.url || 'http://localhost:11434/api/generate';
            const response = await fetchWithRetry(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: config.model || 'llama3', prompt, stream: true }),
            }, signal);
            if (!response.body) throw new Error('Response body is null');
            await readJSONLines(response, (obj) => {
                const t = obj.response || '';
                if (t) { fullText += t; onToken(t); }
            });
        } else {
            // OpenAI-compatible local server, but without native tools (more robust for varied local models)
            const url = config.url || 'http://localhost:11434/v1/chat/completions';
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
            const messages: any[] = [];
            if (request.system) messages.push({ role: 'system', content: request.system });
            for (const m of request.messages) messages.push(...toOpenAIMessages(m, /*flattenTools*/ true));
            const response = await fetchWithRetry(url, {
                method: 'POST', headers,
                body: JSON.stringify({ model: config.model || 'local-model', messages, stream: true }),
            }, signal);
            if (!response.body) throw new Error('Response body is null');
            await readSSE(response, (data) => {
                const t = data.choices?.[0]?.delta?.content || '';
                if (t) { fullText += t; onToken(t); }
            });
        }

        return { text: fullText, toolCalls: parseFallbackToolCalls(fullText) };
    }
}

// ─── Stream readers ─────────────────────────────────────────────────────────

async function readSSE(response: Response, onData: (data: any) => void): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const clean = line.trim();
            if (!clean.startsWith('data:')) continue;
            const json = clean.slice(5).trim();
            if (!json || json === '[DONE]') continue;
            try { onData(JSON.parse(json)); } catch {}
        }
    }
}

async function readJSONLines(response: Response, onObj: (obj: any) => void): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (line.trim()) { try { onObj(JSON.parse(line)); } catch {} }
        }
    }
}

// ─── Message converters ─────────────────────────────────────────────────────

function toOpenAIMessages(m: ChatMessage, flattenTools = false): any[] {
    const out: any[] = [];
    if (m.role === 'assistant') {
        if (!flattenTools && m.toolCalls?.length) {
            out.push({
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })),
            });
        } else {
            let content = m.content || '';
            if (flattenTools && m.toolCalls?.length) {
                content += '\n' + m.toolCalls.map(tc => '```json\n' + JSON.stringify({ action: tc.name, ...tc.arguments }) + '\n```').join('\n');
            }
            out.push({ role: 'assistant', content });
        }
        return out;
    }
    // user turn — may carry tool results and/or images
    if (m.toolResults?.length && !flattenTools) {
        for (const tr of m.toolResults) {
            out.push({ role: 'tool', tool_call_id: tr.id, content: tr.content });
        }
        const imgs = m.toolResults.flatMap(tr => tr.images || []);
        if (imgs.length) out.push({ role: 'user', content: imgs.map(imageToOpenAIPart) });
        if (m.content) out.push({ role: 'user', content: m.content });
        return out;
    }
    // plain user (or flattened) message
    let text = m.content || '';
    if (flattenTools && m.toolResults?.length) {
        text = m.toolResults.map(tr => `Tool ${tr.name} result:\n${tr.content}`).join('\n\n') + (text ? '\n\n' + text : '');
    }
    if (m.images?.length) {
        const parts: any[] = [];
        if (text) parts.push({ type: 'text', text });
        for (const im of m.images) parts.push(imageToOpenAIPart(im));
        out.push({ role: 'user', content: parts });
    } else {
        out.push({ role: 'user', content: text });
    }
    return out;
}

function toClaudeMessage(m: ChatMessage): any {
    if (m.role === 'assistant') {
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls || []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        return { role: 'assistant', content: blocks.length ? blocks : (m.content || '') };
    }
    if (m.toolResults?.length) {
        const blocks: any[] = m.toolResults.map(tr => {
            const content: any[] = [{ type: 'text', text: tr.content || '(no output)' }];
            for (const im of tr.images || []) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.dataBase64 } });
            return { type: 'tool_result', tool_use_id: tr.id, content, is_error: !!tr.isError };
        });
        if (m.content) blocks.push({ type: 'text', text: m.content });
        return { role: 'user', content: blocks };
    }
    if (m.images?.length) {
        const blocks: any[] = m.images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.dataBase64 } }));
        if (m.content) blocks.push({ type: 'text', text: m.content });
        return { role: 'user', content: blocks };
    }
    return { role: 'user', content: m.content };
}

function toGeminiContent(m: ChatMessage): any {
    if (m.role === 'assistant') {
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.toolCalls || []) parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        return { role: 'model', parts: parts.length ? parts : [{ text: m.content || '' }] };
    }
    if (m.toolResults?.length) {
        const parts: any[] = m.toolResults.map(tr => ({ functionResponse: { name: tr.name, response: { result: tr.content } } }));
        for (const tr of m.toolResults) for (const im of tr.images || []) parts.push({ inlineData: { mimeType: im.mediaType, data: im.dataBase64 } });
        if (m.content) parts.push({ text: m.content });
        return { role: 'user', parts };
    }
    const parts: any[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const im of m.images || []) parts.push({ inlineData: { mimeType: im.mediaType, data: im.dataBase64 } });
    return { role: 'user', parts: parts.length ? parts : [{ text: '' }] };
}

function geminiDecl(t: ToolDefinition): any {
    const hasProps = Object.keys(t.parameters.properties || {}).length > 0;
    const decl: any = { name: t.name, description: t.description };
    if (hasProps) decl.parameters = t.parameters;
    return decl;
}

function imageToOpenAIPart(im: ImagePart): any {
    return { type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.dataBase64}` } };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildToolCalls(acc: Record<number, { id: string; name: string; args: string }>): ToolCall[] {
    return Object.keys(acc)
        .map(k => parseInt(k, 10))
        .sort((a, b) => a - b)
        .map(idx => {
            const c = acc[idx];
            let args: any = {};
            try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = {}; }
            return { id: c.id || `call_${idx}_${Date.now()}`, name: c.name, arguments: args };
        })
        .filter(tc => tc.name);
}

function parseFallbackToolCalls(text: string): ToolCall[] {
    let raw: string | undefined;
    const fence = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (fence) raw = fence[1];
    if (!raw) {
        const bare = text.match(/\{[\s\S]*?"action"[\s\S]*\}/);
        if (bare) raw = bare[0];
    }
    if (!raw) return [];
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj.action === 'string') {
            const { action, ...args } = obj;
            return [{ id: `call_${Date.now()}`, name: action, arguments: args }];
        }
    } catch {}
    return [];
}

function readImageParts(images?: { path: string; mimeType?: string }[]): ImagePart[] | undefined {
    if (!images?.length) return undefined;
    const fs = require('fs');
    const parts: ImagePart[] = [];
    for (const img of images) {
        try {
            const data = fs.readFileSync(img.path);
            parts.push({ mediaType: img.mimeType || 'image/png', dataBase64: data.toString('base64') });
        } catch {}
    }
    return parts.length ? parts : undefined;
}

/** Flatten a structured request to a single prompt for text-only local models. */
function flattenRequest(request: CompletionRequest): string {
    let prompt = '';
    if (request.system) prompt += `SYSTEM:\n${request.system}\n\n`;
    for (const m of request.messages) {
        const role = m.role === 'user' ? 'USER' : 'ASSISTANT';
        let content = m.content || '';
        if (m.toolCalls?.length) {
            content += '\n' + m.toolCalls.map(tc => '```json\n' + JSON.stringify({ action: tc.name, ...tc.arguments }) + '\n```').join('\n');
        }
        if (m.toolResults?.length) {
            content += (content ? '\n' : '') + m.toolResults.map(tr => `[Tool ${tr.name} result]:\n${tr.content}`).join('\n\n');
        }
        prompt += `${role}: ${content}\n\n`;
    }
    prompt += 'ASSISTANT:';
    return prompt;
}
