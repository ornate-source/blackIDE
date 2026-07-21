import * as vscode from 'vscode';

// Multi-Provider Embeddings Client — Feature 17 / MF-17
// Fetches vector representations of code chunks from OpenAI or local Ollama.

export interface EmbeddingsConfig {
    provider: 'openai' | 'ollama';
    model: string;
    apiKey?: string;
    baseUrl?: string;
}

export class EmbeddingsClient {
    /** Fetch embedding vector for the given text segment */
    public static async getEmbedding(text: string, config: EmbeddingsConfig, abortSignal?: AbortSignal): Promise<number[]> {
        if (config.provider === 'openai') {
            return this.getOpenAIEmbedding(text, config, abortSignal);
        } else if (config.provider === 'ollama') {
            return this.getOllamaEmbedding(text, config, abortSignal);
        } else {
            throw new Error(`Unsupported embeddings provider: ${config.provider}`);
        }
    }

    private static async getOpenAIEmbedding(text: string, config: EmbeddingsConfig, abortSignal?: AbortSignal): Promise<number[]> {
        const apiKey = config.apiKey;
        if (!apiKey) {
            throw new Error('OpenAI API Key is required for embeddings.');
        }

        const baseUrl = (config.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
        const url = `${baseUrl}/v1/embeddings`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: config.model || 'text-embedding-3-small',
                input: text
            }),
            signal: abortSignal
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenAI Embeddings HTTP ${response.status}: ${errText}`);
        }

        const data: any = await response.json();
        if (data && data.data && Array.isArray(data.data) && data.data[0] && data.data[0].embedding) {
            return data.data[0].embedding;
        }

        throw new Error('Unexpected OpenAI embeddings response structure.');
    }

    private static async getOllamaEmbedding(text: string, config: EmbeddingsConfig, abortSignal?: AbortSignal): Promise<number[]> {
        const baseUrl = (config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
        // Standard Ollama api endpoint
        const url = `${baseUrl}/api/embeddings`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: config.model || 'nomic-embed-text',
                prompt: text
            }),
            signal: abortSignal
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Ollama Embeddings HTTP ${response.status}: ${errText}`);
        }

        const data: any = await response.json();
        if (data && data.embedding && Array.isArray(data.embedding)) {
            return data.embedding;
        }

        throw new Error('Unexpected Ollama embeddings response structure.');
    }

    /** Helper to estimate expected dimensions per model for layout validation */
    public static getExpectedDimensions(model: string): number {
        const lower = model.toLowerCase();
        if (lower.includes('text-embedding-3-small')) return 1536;
        if (lower.includes('text-embedding-3-large')) return 3072;
        if (lower.includes('text-embedding-ada-002')) return 1536;
        if (lower.includes('nomic-embed-text')) return 768;
        if (lower.includes('bge-large')) return 1024;
        if (lower.includes('bge-small')) return 384;
        return 768; // Conservative fallback default
    }
}
