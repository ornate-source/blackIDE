import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SecretManager } from './secret-manager';
import { EmbeddingsClient, EmbeddingsConfig } from './embeddings-client';

// ─── Codebase Retrieval ─────────────────────────────────────────────────────
// Ranked natural-language code search with Hybrid BM25 keyword matching and 
// semantic vector embeddings fused via Reciprocal Rank Fusion (RRF).
// Uses a custom high-performance flat Float32 Binary Vector Store (vectors.bin)
// to avoid large JSON parsing lags on startup.

interface Chunk {
    file: string;   // workspace-relative
    startLine: number;
    text: string;
    tokens: Map<string, number>;
    length: number;
    embedding?: number[]; // In-memory vector cache
}

interface StoredChunk {
    file: string;
    startLine: number;
    text: string;
    tokens: Record<string, number>;
    length: number;
}

interface StoredFile {
    mtimeMs: number;
    size: number;
    chunks: StoredChunk[];
}

interface StoredIndex {
    version: number;
    files: Record<string, StoredFile>;
}

const INDEX_VERSION = 2; // Incremented schema version for hybrid search
const VECTORS_VERSION = 1;

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'with', 'as', 'by', 'at', 'be', 'this', 'that', 'from', 'if', 'else', 'return', 'const', 'let', 'var', 'function', 'import', 'export']);

function tokenize(text: string): string[] {
    return (text.toLowerCase().match(/[a-z0-9_]+/g) || [])
        .filter(t => t.length > 1 && t.length < 40 && !STOP.has(t));
}

function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, mA = 0, mB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        mA += a[i] * a[i];
        mB += b[i] * b[i];
    }
    if (mA === 0 || mB === 0) return 0;
    return dot / (Math.sqrt(mA) * Math.sqrt(mB));
}

async function getEmbeddingsConfig(secretManager: SecretManager): Promise<EmbeddingsConfig | undefined> {
    try {
        const settingsRaw = await secretManager.getKey('general-settings');
        if (!settingsRaw) return undefined;
        const settings = JSON.parse(settingsRaw);
        if (!settings.embeddingsProvider) return undefined;
        return {
            provider: settings.embeddingsProvider,
            model: settings.embeddingsModel || (settings.embeddingsProvider === 'openai' ? 'text-embedding-3-small' : 'nomic-embed-text'),
            apiKey: settings.embeddingsApiKey || '',
            baseUrl: settings.embeddingsUrl || ''
        };
    } catch {
        return undefined;
    }
}

const CHUNK_LINES = 50;
const CHUNK_OVERLAP = 10;
const MAX_FILE_BYTES = 512 * 1024;
const TEXT_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|swift|scala|sh|json|yaml|yml|toml|md|html|css|scss|vue|svelte|sql|graphql)$/i;

export class CodebaseIndex {
    private files = new Map<string, { mtimeMs: number; size: number; chunks: Chunk[] }>();
    private df = new Map<string, number>();
    private avgLen = 1;
    private built = false;
    private embeddingsConfig?: EmbeddingsConfig;

    /** `storageDir` omitted → in-memory only. */
    constructor(private readonly storageDir?: string) {}

    /**
     * Bring the index up to date. Unchanged files are reused from the cache, so a
     * warm run touches only what the user actually edited.
     */
    async build(secretManager?: SecretManager, maxFiles = 800): Promise<{ indexed: number; reused: number; removed: number }> {
        // Load existing index and vectors from disk first
        await this.load();

        if (secretManager) {
            this.embeddingsConfig = await getEmbeddingsConfig(secretManager);
        }

        const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,dist,out,build,.git}/**', maxFiles);
        const seen = new Set<string>();
        let indexed = 0, reused = 0;

        for (const uri of uris) {
            if (!TEXT_EXTS.test(uri.fsPath)) continue;

            let stat: fs.Stats;
            try {
                stat = await fs.promises.stat(uri.fsPath);
            } catch { continue; }
            if (stat.size > MAX_FILE_BYTES) continue;

            const rel = vscode.workspace.asRelativePath(uri);
            seen.add(rel);

            const cached = this.files.get(rel);
            if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
                reused++;
                continue;
            }

            let content: string;
            try {
                content = await fs.promises.readFile(uri.fsPath, 'utf8');
            } catch { continue; }
            if (content.indexOf(String.fromCharCode(0)) !== -1) continue; // binary

            const chunks = chunkFile(rel, content);

            // Fetch embeddings sequentially for new chunks if configured
            if (this.embeddingsConfig) {
                for (const chunk of chunks) {
                    try {
                        chunk.embedding = await EmbeddingsClient.getEmbedding(chunk.text, this.embeddingsConfig);
                    } catch (e: any) {
                        console.warn(`[Index] Embedding generation failed for chunk in ${rel}: ${e?.message || e}`);
                        // Gracefully fail back and allow indexing without embeddings
                    }
                }
            }

            this.files.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size, chunks });
            indexed++;
        }

        // Drop files that no longer exist, or the index grows forever.
        let removed = 0;
        for (const rel of Array.from(this.files.keys())) {
            if (!seen.has(rel)) { this.files.delete(rel); removed++; }
        }

        this.reindexTerms();
        this.built = true;

        if (indexed > 0 || removed > 0) {
            await this.persist();
        }
        return { indexed, reused, removed };
    }

    /** Recompute document frequencies across all chunks. Cheap relative to file I/O. */
    private reindexTerms(): void {
        this.df.clear();
        let totalLen = 0, count = 0;
        for (const entry of this.files.values()) {
            for (const chunk of entry.chunks) {
                for (const term of chunk.tokens.keys()) {
                    this.df.set(term, (this.df.get(term) || 0) + 1);
                }
                totalLen += chunk.length;
                count++;
            }
        }
        this.avgLen = count ? totalLen / count : 1;
    }

    /** Top-k hybrid ranked chunks using Reciprocal Rank Fusion (RRF) of semantic & BM25 search */
    async search(query: string, k = 6): Promise<{ file: string; startLine: number; snippet: string; score: number }[]> {
        if (!this.built) return [];

        const allChunks: Chunk[] = [];
        for (const entry of this.files.values()) {
            allChunks.push(...entry.chunks);
        }
        if (allChunks.length === 0) return [];

        // 1. Lexical BM25 Ranked List
        const qTokens = tokenize(query);
        const bm25Scored: { chunk: Chunk; score: number }[] = [];
        if (qTokens.length > 0) {
            const N = allChunks.length;
            const k1 = 1.5, b = 0.75;
            for (const chunk of allChunks) {
                let score = 0;
                for (const qt of qTokens) {
                    const f = chunk.tokens.get(qt);
                    if (!f) continue;
                    const df = this.df.get(qt) || 1;
                    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
                    const denom = f + k1 * (1 - b + b * (chunk.length / this.avgLen));
                    score += idf * (f * (k1 + 1)) / denom;
                }
                if (score > 0) {
                    bm25Scored.push({ chunk, score });
                }
            }
        }
        bm25Scored.sort((a, b) => b.score - a.score);

        // 2. Semantic Embedding Cosine-Similarity Ranked List
        const semanticScored: { chunk: Chunk; score: number }[] = [];
        if (this.embeddingsConfig) {
            try {
                const queryEmbedding = await EmbeddingsClient.getEmbedding(query, this.embeddingsConfig);
                for (const chunk of allChunks) {
                    if (chunk.embedding) {
                        const sim = cosineSimilarity(chunk.embedding, queryEmbedding);
                        if (sim > 0.1) { // Low threshold filters unrelated noise
                            semanticScored.push({ chunk, score: sim });
                        }
                    }
                }
            } catch (e: any) {
                console.warn(`[Search] Embedding query failed: ${e?.message || e}. Falling back to BM25.`);
            }
        }
        semanticScored.sort((a, b) => b.score - a.score);

        // 3. Reciprocal Rank Fusion (RRF)
        const rrfMap = new Map<Chunk, number>();
        const RRF_CONSTANT = 60; // Standard k constant for RRF

        bm25Scored.forEach((item, index) => {
            const rank = index + 1;
            rrfMap.set(item.chunk, (rrfMap.get(item.chunk) || 0) + (1 / (RRF_CONSTANT + rank)));
        });

        semanticScored.forEach((item, index) => {
            const rank = index + 1;
            rrfMap.set(item.chunk, (rrfMap.get(item.chunk) || 0) + (1 / (RRF_CONSTANT + rank)));
        });

        const scored = Array.from(rrfMap.entries())
            .map(([chunk, score]) => ({ chunk, score }))
            .sort((a, b) => b.score - a.score);

        // Deduplicate: max 2 chunks per file to prevent single file dominance
        const perFile = new Map<string, number>();
        const out: { file: string; startLine: number; snippet: string; score: number }[] = [];
        for (const { chunk, score } of scored) {
            const count = perFile.get(chunk.file) || 0;
            if (count >= 2) continue;
            perFile.set(chunk.file, count + 1);
            out.push({
                file: chunk.file,
                startLine: chunk.startLine,
                snippet: chunk.text.split(/\r?\n/).slice(0, 20).join('\n'),
                score: Math.round(score * 1000) / 10, // Scale for readability
            });
            if (out.length >= k) break;
        }

        // Default fallback if no matches found in hybrid search
        if (out.length === 0 && bm25Scored.length === 0) {
            return [];
        }

        return out;
    }

    get size(): number {
        let n = 0;
        for (const entry of this.files.values()) n += entry.chunks.length;
        return n;
    }

    // ─── Persistence ────────────────────────────────────────────────────────

    private get file(): string | undefined {
        return this.storageDir ? path.join(this.storageDir, 'codebase-index.json') : undefined;
    }

    private get vectorFile(): string | undefined {
        return this.storageDir ? path.join(this.storageDir, 'vectors.bin') : undefined;
    }

    private async load(): Promise<void> {
        const f = this.file;
        const vf = this.vectorFile;
        if (!f || this.files.size > 0) return;

        try {
            if (!fs.existsSync(f)) return;
            const raw = await fs.promises.readFile(f, 'utf8');
            const parsed: StoredIndex = JSON.parse(raw);
            if (parsed.version !== INDEX_VERSION) return; // Rebuild on mismatch

            // Load textual structure
            const flatChunksList: Chunk[] = [];
            for (const [rel, entry] of Object.entries(parsed.files)) {
                const chunks = entry.chunks.map(c => {
                    const chunk: Chunk = {
                        file: c.file,
                        startLine: c.startLine,
                        text: c.text,
                        length: c.length,
                        tokens: new Map(Object.entries(c.tokens)),
                    };
                    flatChunksList.push(chunk);
                    return chunk;
                });
                this.files.set(rel, {
                    mtimeMs: entry.mtimeMs,
                    size: entry.size,
                    chunks
                });
            }

            // Read binary vectors.bin if it exists
            if (vf && fs.existsSync(vf)) {
                const buffer = await fs.promises.readFile(vf);
                if (buffer.length >= 12) {
                    const version = buffer.readUInt32LE(0);
                    const dimension = buffer.readUInt32LE(4);
                    const count = buffer.readUInt32LE(8);

                    if (version === VECTORS_VERSION && count === flatChunksList.length && dimension > 0) {
                        let offset = 12;
                        const vectorBytes = dimension * 4;
                        for (let i = 0; i < count; i++) {
                            if (offset + vectorBytes <= buffer.length) {
                                const vector = new Array<number>(dimension);
                                for (let d = 0; d < dimension; d++) {
                                    vector[d] = buffer.readFloatLE(offset + d * 4);
                                }
                                flatChunksList[i].embedding = vector;
                                offset += vectorBytes;
                            }
                        }
                    } else {
                        console.warn('[Index] Binary vectors count or version mismatch, skipping vector load.');
                    }
                }
            }
        } catch (e: any) {
            console.warn(`[Index] Failed loading cache: ${e?.message || e}. Cold rebuild triggered.`);
        }
    }

    private async persist(): Promise<void> {
        const f = this.file;
        const vf = this.vectorFile;
        if (!f) return;

        try {
            const files: Record<string, StoredFile> = {};
            const flatChunksList: Chunk[] = [];

            for (const [rel, entry] of this.files) {
                files[rel] = {
                    mtimeMs: entry.mtimeMs,
                    size: entry.size,
                    chunks: entry.chunks.map(c => {
                        flatChunksList.push(c);
                        return {
                            file: c.file,
                            startLine: c.startLine,
                            text: c.text,
                            length: c.length,
                            tokens: Object.fromEntries(c.tokens),
                        };
                    }),
                };
            }

            await fs.promises.mkdir(this.storageDir!, { recursive: true });

            // Persist JSON text structure
            const payload: StoredIndex = { version: INDEX_VERSION, files };
            await fs.promises.writeFile(f, JSON.stringify(payload), 'utf8');

            // Persist Float32 vectors in binary flat file if embeddings are available
            const chunksWithVectors = flatChunksList.filter(c => c.embedding && c.embedding.length > 0);
            if (vf && chunksWithVectors.length === flatChunksList.length && flatChunksList.length > 0) {
                const dimension = flatChunksList[0].embedding!.length;
                const count = flatChunksList.length;
                const headerSize = 12; // version(4) + dimension(4) + count(4)
                const vectorSize = dimension * 4;
                const totalBufferSize = headerSize + count * vectorSize;

                const buffer = Buffer.alloc(totalBufferSize);
                buffer.writeUInt32LE(VECTORS_VERSION, 0);
                buffer.writeUInt32LE(dimension, 4);
                buffer.writeUInt32LE(count, 8);

                let offset = headerSize;
                for (const chunk of flatChunksList) {
                    const vector = chunk.embedding!;
                    for (let d = 0; d < dimension; d++) {
                        buffer.writeFloatLE(vector[d] || 0, offset + d * 4);
                    }
                    offset += vectorSize;
                }

                await fs.promises.writeFile(vf, buffer);
            }
        } catch (e: any) {
            console.warn(`[Index] Failed persisting index: ${e?.message || e}`);
        }
    }
}

function chunkFile(rel: string, content: string): Chunk[] {
    const chunks: Chunk[] = [];
    const lines = content.split(/\r?\n/);
    for (let start = 0; start < lines.length; start += (CHUNK_LINES - CHUNK_OVERLAP)) {
        const text = lines.slice(start, start + CHUNK_LINES).join('\n');
        if (!text.trim()) continue;
        const toks = tokenize(text + ' ' + rel);
        if (toks.length === 0) continue;
        const tf = new Map<string, number>();
        for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
        chunks.push({ file: rel, startLine: start + 1, text, tokens: tf, length: toks.length });
        if (lines.length <= CHUNK_LINES) break;
    }
    return chunks;
}
