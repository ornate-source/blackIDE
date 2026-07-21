import { LLMConfigEntry } from '../core/types';

// Model Discovery — extracted from extension.ts
// Fetches available models from various LLM providers.
export async function performFetchModels(dataValue: any): Promise<LLMConfigEntry[]> {
    const { provider, apiKey, baseUrl } = dataValue;
    let fetched: any[] = [];

    if (provider === 'google') {
        if (!apiKey) throw new Error('API Key is required.');
        const cleanBase = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
        const url = `${cleanBase}/v1beta/models?key=${apiKey}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const dataJson: any = await response.json();
        if (dataJson.models && Array.isArray(dataJson.models)) {
            fetched = dataJson.models
                .filter((m: any) => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
                .map((m: any) => {
                    const modelName = m.name.replace('models/', '');
                    return {
                        id: `google/${modelName}`,
                        name: `Google: ${m.displayName || modelName}`,
                        type: 'google',
                        model: modelName,
                        apiKey: apiKey,
                        url: `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?key=${apiKey}`,
                        enabled: true
                    };
                });
        }
    } else if (provider === 'openai') {
        if (!apiKey) throw new Error('API Key is required.');
        const cleanBase = (baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
        const url = `${cleanBase}/v1/models`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const dataJson: any = await response.json();
        if (dataJson.data && Array.isArray(dataJson.data)) {
            fetched = dataJson.data
                .filter((m: any) => m.id.startsWith('gpt') || m.id.startsWith('o1'))
                .map((m: any) => ({
                    id: `openai/${m.id}`,
                    name: `OpenAI: ${m.id}`,
                    type: 'openai',
                    model: m.id,
                    apiKey: apiKey,
                    url: `${cleanBase}/v1/chat/completions`,
                    enabled: true
                }));
        }
    } else if (provider === 'anthropic') {
        if (!apiKey) throw new Error('API Key is required.');
        try {
            const cleanBase = (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
            const url = `${cleanBase}/v1/models`;
            const response = await fetch(url, {
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json'
                }
            });
            if (response.ok) {
                const dataJson: any = await response.json();
                if (dataJson.data && Array.isArray(dataJson.data)) {
                    fetched = dataJson.data.map((m: any) => ({
                        id: `anthropic/${m.id}`,
                        name: `Anthropic: ${m.display_name || m.id}`,
                        type: 'claude',
                        model: m.id,
                        apiKey: apiKey,
                        url: 'https://api.anthropic.com/v1/messages',
                        enabled: true
                    }));
                }
            }
        } catch (e) {}
        if (fetched.length === 0) {
            const fallbacks = [
                { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
                { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
                { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' }
            ];
            fetched = fallbacks.map(f => ({
                id: `anthropic/${f.id}`,
                name: `Anthropic: ${f.name}`,
                type: 'claude',
                model: f.id,
                apiKey: apiKey,
                url: 'https://api.anthropic.com/v1/messages',
                enabled: true
            }));
        }
    } else if (provider === 'openrouter') {
        if (!apiKey) throw new Error('API Key is required.');
        const cleanBase = (baseUrl || 'https://openrouter.ai').replace(/\/+$/, '');
        const url = `${cleanBase}/api/v1/models`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const dataJson: any = await response.json();
        if (dataJson.data && Array.isArray(dataJson.data)) {
            fetched = dataJson.data.map((m: any) => ({
                id: `openrouter/${m.id}`,
                name: `OpenRouter: ${m.name || m.id}`,
                type: 'openrouter',
                model: m.id,
                apiKey: apiKey,
                url: `${cleanBase}/api/v1/chat/completions`,
                enabled: true
            }));
        }
    } else if (provider === 'ollama') {
        const cleanBase = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
        let dataJson: any = null;
        try {
            const response = await fetch(`${cleanBase}/api/tags`);
            if (response.ok) {
                dataJson = await response.json();
            }
        } catch {}
        if (dataJson && dataJson.models && Array.isArray(dataJson.models)) {
            fetched = dataJson.models.map((m: any) => ({
                id: `ollama/${m.name}`,
                name: `Ollama: ${m.name}`,
                type: 'local',
                model: m.name,
                url: `${cleanBase}/v1/chat/completions`,
                enabled: true
            }));
        } else {
            const response = await fetch(`${cleanBase}/v1/models`);
            if (!response.ok) throw new Error('Ollama service offline or not reachable.');
            const v1Data: any = await response.json();
            if (v1Data.data && Array.isArray(v1Data.data)) {
                fetched = v1Data.data.map((m: any) => ({
                    id: `ollama/${m.id}`,
                    name: `Ollama: ${m.id}`,
                    type: 'local',
                    model: m.id,
                    url: `${cleanBase}/v1/chat/completions`,
                    enabled: true
                }));
            }
        }
    } else if (provider === 'lmstudio') {
        const cleanBase = (baseUrl || 'http://localhost:1234').replace(/\/+$/, '');
        const response = await fetch(`${cleanBase}/v1/models`);
        if (!response.ok) throw new Error('LM Studio service offline or not reachable.');
        const dataJson: any = await response.json();
        if (dataJson.data && Array.isArray(dataJson.data)) {
            fetched = dataJson.data.map((m: any) => ({
                id: `lmstudio/${m.id}`,
                name: `LM Studio: ${m.id}`,
                type: 'openai',
                model: m.id,
                url: `${cleanBase}/v1/chat/completions`,
                enabled: true
            }));
        }
    } else if (provider === 'llama.cpp') {
        const cleanBase = (baseUrl || 'http://localhost:8080').replace(/\/+$/, '');
        const response = await fetch(`${cleanBase}/v1/models`);
        if (!response.ok) throw new Error('llama.cpp service offline or not reachable.');
        const dataJson: any = await response.json();
        if (dataJson.data && Array.isArray(dataJson.data)) {
            fetched = dataJson.data.map((m: any) => ({
                id: `llama.cpp/${m.id}`,
                name: `llama.cpp: ${m.id}`,
                type: 'openai',
                model: m.id,
                url: `${cleanBase}/v1/chat/completions`,
                enabled: true
            }));
        }
    }

    if (fetched.length === 0) {
        throw new Error('No models returned by provider.');
    }

    return fetched;
}
