import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_ROLES } from '../src/core/model-router';
import {
    PROVIDER_PRESETS, authHeaders, endpointFor, isOpenAICompatible, presetFor,
} from '../src/core/providers';
import { supportsNativeTools } from '../src/core/llm-client';
import {
    LOCAL_RUNTIMES, configFor, noModelGuidance, probeLocalRuntimes,
} from '../src/core/local-models';
import { LLMConfigEntry } from '../src/core/types';

/**
 * Phase 4, M26 (provider breadth) and M27 (zero-config first run).
 *
 * M26 is mostly data, and the assertions are about the two places where "mostly" bites:
 * every preset must actually be reachable by the OpenAI-compatible dispatch, and Azure —
 * the one provider whose shape differs — must get its own auth header and URL layout.
 * Sending a bearer token to Azure produces a 401 that reads exactly like a bad key.
 */

describe('provider registry', () => {
    it('ships the breadth the roadmap asked for, minus the two that are not config', () => {
        // 16 presets. Bedrock and Vertex are deliberately absent: SigV4 signing and a
        // Google OAuth exchange are auth implementations, not base URLs, and a half-working
        // entry would accept the user's key and fail every call.
        expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(15);
        const types = PROVIDER_PRESETS.map(p => p.type);
        for (const expected of ['deepseek', 'groq', 'mistral', 'xai', 'together', 'fireworks', 'cerebras', 'litellm', 'vllm', 'azure-openai']) {
            expect(types, `${expected} missing`).toContain(expected);
        }
        expect(types).not.toContain('bedrock');
        expect(types).not.toContain('vertex');
    });

    it('gives every keyless preset a local URL and every keyed one a real endpoint', () => {
        for (const preset of PROVIDER_PRESETS) {
            if (preset.type === 'azure-openai' || preset.type === 'google') continue;  // built per-config
            expect(preset.defaultUrl, `${preset.type} has no default URL`).toMatch(/^https?:\/\//);
            if (!preset.needsApiKey) expect(preset.defaultUrl).toMatch(/localhost/);
        }
    });

    it('routes every OpenAI-compatible provider through native tool calling', () => {
        // The trap this closes: `supportsNativeTools` was an `||` chain of provider names,
        // so a new provider silently fell through to the text-JSON fallback protocol and
        // its tool calls became prose the parser had to guess at.
        for (const preset of PROVIDER_PRESETS) {
            const config = { id: 'x', name: 'x', type: preset.type } as LLMConfigEntry;
            const expected = preset.type !== 'local';
            expect(supportsNativeTools(config), `${preset.type}`).toBe(expected);
        }
        expect(isOpenAICompatible('local')).toBe(false);
        expect(isOpenAICompatible('claude')).toBe(false);
    });

    it('prefers an explicit url over the preset default', () => {
        expect(endpointFor({ id: 'a', name: 'a', type: 'groq', url: 'http://proxy/v1/chat/completions' }))
            .toBe('http://proxy/v1/chat/completions');
        expect(endpointFor({ id: 'a', name: 'a', type: 'groq' })).toBe(presetFor('groq')!.defaultUrl);
    });

    it('sends a bearer token everywhere except Azure', () => {
        expect(authHeaders({ id: 'a', name: 'a', type: 'groq', apiKey: 'k' })).toEqual({ Authorization: 'Bearer k' });
        expect(authHeaders({ id: 'a', name: 'a', type: 'azure-openai', apiKey: 'k' })).toEqual({ 'api-key': 'k' });
        expect(authHeaders({ id: 'a', name: 'a', type: 'groq' })).toEqual({});
    });

    it('builds an Azure deployment URL, and refuses to guess one', () => {
        const built = endpointFor({
            id: 'a', name: 'a', type: 'azure-openai',
            url: 'https://my-resource.openai.azure.com', azureDeployment: 'gpt4o', azureApiVersion: '2024-10-21',
        });
        expect(built).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21');

        // A pasted full endpoint is left alone.
        const pasted = 'https://r.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-10-21';
        expect(endpointFor({ id: 'a', name: 'a', type: 'azure-openai', url: pasted })).toBe(pasted);

        // No resource, or no deployment → empty, which surfaces as "not configured" rather
        // than a request to somebody else's API.
        expect(endpointFor({ id: 'a', name: 'a', type: 'azure-openai' })).toBe('');
        expect(endpointFor({ id: 'a', name: 'a', type: 'azure-openai', url: 'https://r.openai.azure.com' })).toBe('');
    });
});

describe('zero-config first run', () => {
    const ok = (body: any) => ({ ok: true, json: async () => body });
    const notFound = { ok: false, json: async () => ({}) };

    it('detects Ollama and offers ready-to-save configs', async () => {
        const detections = await probeLocalRuntimes(async (url: string) => {
            if (url.includes('11434')) return ok({ models: [{ name: 'llama3.1' }, { name: 'qwen2.5-coder' }] });
            return notFound;
        }, 50);

        expect(detections).toHaveLength(1);
        expect(detections[0].runtime.id).toBe('ollama');
        expect(detections[0].models).toEqual(['llama3.1', 'qwen2.5-coder']);
        expect(detections[0].configs[0]).toMatchObject({ type: 'local', model: 'llama3.1', enabled: true });
    });

    it('detects LM Studio and llama.cpp from the OpenAI-shaped listing', async () => {
        const detections = await probeLocalRuntimes(async (url: string) => {
            if (url.includes('1234') || url.includes('8080')) return ok({ data: [{ id: 'local-model' }] });
            return notFound;
        }, 50);
        expect(detections.map(d => d.runtime.id).sort()).toEqual(['llamacpp', 'lmstudio']);
    });

    it('treats every failure as "not running", including a hang', async () => {
        // A refused connection, a timeout, a 404 and HTML from an unrelated server on that
        // port all mean the same thing to the caller, so none of them is an error.
        const detections = await probeLocalRuntimes(async (_url: string, init: any) => {
            await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
            return notFound;
        }, 30);
        expect(detections).toEqual([]);

        const thrown = await probeLocalRuntimes(async () => { throw new Error('ECONNREFUSED'); }, 30);
        expect(thrown).toEqual([]);
    });

    it('ignores a runtime that is running with no models pulled', async () => {
        // Offering "Ollama (0 models)" as a one-click default produces a config that cannot
        // answer, which reads as the editor being broken.
        const detections = await probeLocalRuntimes(async () => ok({ models: [] }), 50);
        expect(detections).toEqual([]);
    });

    it('probes only localhost, and every runtime it knows', () => {
        expect(LOCAL_RUNTIMES.length).toBeGreaterThanOrEqual(3);
        for (const runtime of LOCAL_RUNTIMES) {
            expect(runtime.probeUrl).toMatch(/^http:\/\/localhost:/);
            expect(runtime.chatUrl).toMatch(/^http:\/\/localhost:/);
        }
    });

    it('marks a detected model `local`, not OpenAI-compatible', () => {
        // Local models vary wildly in how reliably they emit tool calls; the text-JSON
        // protocol works on all of them. A first-run default that produced malformed tool
        // calls would read as "this editor is broken", not "this model is weak".
        expect(configFor(LOCAL_RUNTIMES[0], 'llama3.1').type).toBe('local');
    });

    it('says something different, and actionable, in each of the two situations', async () => {
        const none = noModelGuidance([]);
        expect(none).toMatch(/Add an API key/);
        expect(none).toMatch(/Ollama|LM Studio/);

        const detections = await probeLocalRuntimes(async (url: string) =>
            url.includes('11434') ? ok({ models: [{ name: 'llama3.1' }] }) : notFound, 50);
        const some = noModelGuidance(detections);
        expect(some).toMatch(/no API key needed/i);
        expect(some).toMatch(/Ollama \(1 model\)/);
        expect(some).not.toMatch(/Add an API key/);
    });
});

/**
 * Host↔webview message contract for the Phase 4 surfaces.
 *
 * The Phase 2 trap in reverse: a host that posts a message nobody handles looks like it
 * works and does nothing. Both of these are user-visible offers — the zero-config model
 * and the failover notice — so a dropped message means the feature silently is not there.
 */
describe('Phase 4 messages are handled on both sides', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'App.tsx'), 'utf8');
    const chatTask = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'chat-task.ts'), 'utf8');

    it('the zero-config offer is posted and consumed', () => {
        expect(chatTask).toMatch(/type: 'localModelsAvailable'/);
        expect(app).toMatch(/case 'localModelsAvailable'/);
    });

    it('the failover substitution is posted and consumed', () => {
        expect(chatTask).toMatch(/type: 'modelSubstituted'/);
        expect(app).toMatch(/case 'modelSubstituted'/);
    });

    it('every router role except embed is offered in the settings UI', () => {
        // `embed` is resolved by the embeddings config, not the router, so a control for it
        // would do nothing — and a control that does nothing is worse than none.
        for (const role of MODEL_ROLES) {
            if (role === 'embed') continue;
            expect(app, `no settings control for the ${role} role`).toMatch(new RegExp(`role: '${role}'`));
        }
    });
});
