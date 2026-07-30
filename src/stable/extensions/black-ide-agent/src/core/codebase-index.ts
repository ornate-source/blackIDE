import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SecretManager } from './secret-manager';
import { EmbeddingsClient, EmbeddingsConfig } from './embeddings-client';
import { planChunks, languageOf, SymbolKind } from './symbol-chunker';
import { CodeGraph } from './code-graph';
import { tokenize, splitIdentifier, stem } from './text-tokens';
import { LexicalReranker, Reranker, RerankCandidate, RERANK_DEPTH } from './reranker';

// Re-exported so existing callers and tests keep one import site for these.
export { splitIdentifier, stem };

// ─── Codebase Retrieval ─────────────────────────────────────────────────────
// Ranked natural-language code search with Hybrid BM25 keyword matching and 
// semantic vector embeddings fused via Reciprocal Rank Fusion (RRF).
// Uses a custom high-performance flat Float32 Binary Vector Store (vectors.bin)
// to avoid large JSON parsing lags on startup.

interface Chunk {
    file: string;   // workspace-relative
    startLine: number;
    endLine?: number;
    text: string;
    tokens: Map<string, number>;
    length: number;
    /** Name of the definition this chunk is, when it is one (Phase 3, M14). */
    symbol?: string;
    kind?: SymbolKind;
    parent?: string;
    embedding?: number[]; // In-memory vector cache
}

interface StoredChunk {
    file: string;
    startLine: number;
    endLine?: number;
    text: string;
    tokens: Record<string, number>;
    length: number;
    symbol?: string;
    kind?: SymbolKind;
    parent?: string;
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

const INDEX_VERSION = 3; // Phase 3 (M14): symbol chunks + identifier-aware tokens
const VECTORS_VERSION = 1;

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
/** Upper bound on how many chunks of one file a single result set may contain. */
const MAX_CHUNKS_PER_FILE = 2;
/** Floor applied to a chunk's token count before BM25 length normalisation. */
const MIN_NORMALISED_LENGTH = 40;
/** How many top-ranked files may pull in a neighbour through the code graph (M15). */
const GRAPH_EXPANSION_SEEDS = 5;
const MAX_FILE_BYTES = 512 * 1024;
const TEXT_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|swift|scala|sh|json|yaml|yml|toml|md|html|css|scss|vue|svelte|sql|graphql)$/i;

export class CodebaseIndex {
    private files = new Map<string, { mtimeMs: number; size: number; chunks: Chunk[] }>();
    private df = new Map<string, number>();
    private avgLen = 1;
    private built = false;
    private embeddingsConfig?: EmbeddingsConfig;

    /**
     * Symbol/import/reference graph over the same files (Phase 3, M15). Built
     * alongside the chunks so it cannot drift from what is searchable, and exposed
     * so `impact_analysis` and the graph-backed reference tools (M16) read the same
     * structure retrieval ranks with.
     */
    readonly graph = new CodeGraph();

    /**
     * Second-stage ranking (Phase 3, M17). Defaults to the deterministic lexical
     * reranker; Phase 4 swaps in a cross-encoder on the `rerank` model role by
     * assigning here, with no other change to this class.
     */
    reranker: Reranker = new LexicalReranker();

    /** `storageDir` omitted → in-memory only. */
    constructor(private readonly storageDir?: string) {}

    /**
     * Bring the index up to date. Unchanged files are reused from the cache, so a
     * warm run touches only what the user actually edited.
     */
    async build(secretManager?: SecretManager, maxFiles = 800): Promise<{ indexed: number; reused: number; removed: number }> {
        // Load existing index and vectors from disk first
        await this.load();
        this.seedGraphFromCache();

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
            this.graph.addFile(rel, content);

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
            if (!seen.has(rel)) { this.files.delete(rel); this.graph.remove(rel); removed++; }
        }

        this.reindexTerms();
        this.built = true;

        if (indexed > 0 || removed > 0) {
            await this.persist();
        }
        return { indexed, reused, removed };
    }

    /**
     * Rebuilds graph nodes for files served from the on-disk cache.
     *
     * A warm build skips unchanged files entirely — that is the point of the cache —
     * so without this the graph would contain only the handful of files edited since
     * the last run, and `impactOf` would confidently return almost nothing. The
     * file's text is reconstituted by concatenating its chunks, which is exact
     * because chunking covers every line exactly once (asserted in
     * `__tests__/symbol-chunker.test.ts`). Reparsing beats persisting a second
     * on-disk structure that could fall out of step with the chunks it describes.
     */
    private seedGraphFromCache(): void {
        for (const [rel, entry] of this.files) {
            if (this.graph.hasFile(rel)) continue;
            const ordered = [...entry.chunks].sort((a, b) => a.startLine - b.startLine);
            this.graph.addFile(rel, ordered.map(c => c.text).join('\n'));
        }
    }

    /**
     * Runs the second-stage reranker over the head of the fused list (Phase 3, M17).
     *
     * Only the top `RERANK_DEPTH` are rescored; the tail keeps its fused order and is
     * appended unchanged. Reordering position 200 cannot affect a top-10 answer, and
     * a reranker that has to score the whole index is one that gets switched off for
     * being slow.
     *
     * Failure is non-fatal by construction: a reranker that throws — which a
     * model-backed one will, on a timeout or a missing key — leaves the fused
     * ranking in place. Search degrading to first-stage quality is a much better
     * outcome than search returning an error.
     */
    private async applyRerank(
        query: string,
        fused: { chunk: Chunk; score: number }[],
    ): Promise<{ chunk: Chunk; score: number }[]> {
        if (fused.length < 2) return fused;

        const head = fused.slice(0, RERANK_DEPTH);
        const tail = fused.slice(RERANK_DEPTH);

        const candidates: RerankCandidate[] = head.map((item, i) => ({
            file: item.chunk.file,
            startLine: item.chunk.startLine,
            text: item.chunk.text,
            ...(item.chunk.symbol ? { symbol: item.chunk.symbol } : {}),
            rank: i + 1,
        }));

        let ordered;
        try {
            ordered = await this.reranker.rerank(query, candidates);
        } catch (e: any) {
            console.warn(`[Search] Rerank failed (${e?.message || e}); keeping first-stage order.`);
            return fused;
        }

        // Map back by identity of (file, startLine) — the reranker returns candidates,
        // not chunks, and must not be trusted to preserve object references.
        const byKey = new Map(head.map(item => [`${item.chunk.file}:${item.chunk.startLine}`, item]));
        const rescored: { chunk: Chunk; score: number }[] = [];
        for (const candidate of ordered) {
            const original = byKey.get(`${candidate.file}:${candidate.startLine}`);
            if (!original) continue;
            byKey.delete(`${candidate.file}:${candidate.startLine}`);
            rescored.push({ chunk: original.chunk, score: candidate.score });
        }
        // Anything the reranker dropped keeps its place rather than disappearing.
        for (const leftover of byKey.values()) rescored.push(leftover);

        return [...rescored, ...tail];
    }

    /**
     * Promotes definition files that the top-ranked results *point at* (Phase 3, M15).
     *
     * The residual failure after M14 has one shape. A behavioural question —
     * "converting the order total into the customer's currency" — matches the
     * **caller** on every domain word, while the **definition** it calls
     * (`convertMinor` in `utils/currency.ts`) shares only one or two. Both files are
     * needed to answer, but no amount of term weighting will lift the definition,
     * because lexically it genuinely is the weaker match. What connects them is not
     * vocabulary, it is a reference edge — a structural fact the graph already knows.
     *
     * So: take the strongest results, walk to the files whose symbols they call, and
     * splice those in just behind the file that pointed at them. The definition rides
     * in on its caller's rank rather than competing with it.
     *
     * Three deliberate limits, because expansion is how a retriever starts returning
     * plausible noise:
     *  - only the top `GRAPH_EXPANSION_SEEDS` results seed a walk;
     *  - one hop only, never transitive;
     *  - the edge's symbol must overlap the query, so `order-service.ts` importing
     *    `config.ts` does not drag config into every result set. This last rule is
     *    what keeps expansion from being a popularity contest.
     */
    private applyGraphExpansion(
        grouped: Map<string, { chunk: Chunk; score: number }[]>,
        queryTokens: string[],
        k: number,
    ): void {
        if (grouped.size === 0 || this.graph.fileCount === 0) return;

        const queryTerms = new Set(queryTokens);
        const seeds = Array.from(grouped.keys()).slice(0, GRAPH_EXPANSION_SEEDS);
        const seedSet = new Set(seeds);
        const promotions = new Map<string, string>();   // promoted file → its referrer

        for (const seed of seeds) {
            for (const edge of this.graph.neighbours(seed)) {
                if (edge.direction !== 'out') continue;             // only what the seed uses
                if (seedSet.has(edge.file) || promotions.has(edge.file)) continue;

                // The linking symbol must be something the question actually asked
                // about. Without this every file's `config` and `logger` imports
                // would be promoted into every result.
                const linkTerms = tokenize(edge.via);
                if (!linkTerms.some(t => queryTerms.has(t))) continue;

                promotions.set(edge.file, seed);
            }
        }
        if (promotions.size === 0) return;

        // A promoted file is usually already in the ranking, just far down it — the
        // definition scored *something*, only not enough. Promotion therefore has to
        // move an existing entry, not merely insert a missing one; the first version
        // of this method only inserted, and consequently did nothing at all on every
        // query it was written for.
        const rebuilt = new Map<string, { chunk: Chunk; score: number }[]>();
        for (const [file, items] of grouped) {
            if (promotions.has(file) && !rebuilt.has(file)) continue;   // placed by its referrer
            rebuilt.set(file, items);

            for (const [promoted, after] of promotions) {
                if (after !== file || rebuilt.has(promoted)) continue;
                const existing = grouped.get(promoted);
                const chunks = existing ?? this.bestChunksFor(promoted, queryTerms);
                if (chunks.length > 0) rebuilt.set(promoted, chunks);
            }
        }
        for (const [file, items] of grouped) {
            if (!rebuilt.has(file)) rebuilt.set(file, items);
        }

        grouped.clear();
        for (const [file, items] of rebuilt) grouped.set(file, items);
    }

    /**
     * Chunks of a promoted file, best first. Ranked by raw query-term overlap rather
     * than BM25: the file is here because of a graph edge, not because it scored, so
     * the only job left is picking which part of it to show.
     */
    private bestChunksFor(file: string, queryTerms: Set<string>): { chunk: Chunk; score: number }[] {
        const entry = this.files.get(file);
        if (!entry) return [];

        return entry.chunks
            .map(chunk => {
                let overlap = 0;
                for (const term of queryTerms) overlap += chunk.tokens.get(term) ?? 0;
                // A named chunk beats an anonymous one on a tie: the caller followed
                // a symbol here, so the definition is what it came for.
                return { chunk, score: overlap + (chunk.symbol ? 0.5 : 0) };
            })
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_CHUNKS_PER_FILE);
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
                    // Length is floored before normalisation. BM25 rewards short
                    // documents, which was harmless when every chunk was a 50-line
                    // window but is not under symbol chunking (M14): a two-line
                    // accessor containing one query term otherwise outscores the
                    // substantive definition next to it, and enough of those crowd
                    // out the head of the ranking. The floor caps that reward at the
                    // length of a plausibly meaningful chunk.
                    const effectiveLength = Math.max(chunk.length, MIN_NORMALISED_LENGTH);
                    const denom = f + k1 * (1 - b + b * (effectiveLength / this.avgLen));
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

        const fused = Array.from(rrfMap.entries())
            .map(([chunk, score]) => ({ chunk, score }))
            .sort((a, b) => b.score - a.score);

        const scored = await this.applyRerank(query, fused);

        // ── 4. File-diversified selection ───────────────────────────────────
        //
        // Every file's BEST chunk is offered before any file's second chunk, in
        // global rank order; only then does a second round fill remaining slots.
        //
        // The previous rule — "take the ranked list, cap at 2 chunks per file" —
        // was equivalent while chunks were coarse 50-line windows, because a file
        // rarely had two of them ranked highly. Symbol chunking (M14) took this
        // corpus from 112 chunks to 479, and the old rule immediately started
        // spending two of the top-5 slots on two methods of the *same* file while a
        // second file that the answer needed fell off the end. Measured on the eval
        // corpus that cost 2.3 points of recall@5 — a ranking regression caused
        // entirely by better chunking, which is exactly the sort of interaction the
        // baseline exists to catch.
        //
        // Diversifying is also what the consumer wants: the question is "which
        // files must change", so breadth across files beats depth within one.
        const grouped = new Map<string, { chunk: Chunk; score: number }[]>();
        for (const item of scored) {
            const list = grouped.get(item.chunk.file);
            if (list) list.push(item);
            else grouped.set(item.chunk.file, [item]);   // already in descending score order
        }

        this.applyGraphExpansion(grouped, qTokens, k);

        // Files keep their BEST chunk's rank — insertion order above.
        //
        // Aggregating a file's chunk scores was tried and measurably rejected: a
        // damped sum (best + second/2 + third/3 …) cost 12 points of recall@5,
        // because a large file with many weak mentions climbed over a small file with
        // the one right definition. Under symbol chunking the number of chunks a file
        // has reflects how many symbols it declares, not how relevant it is, so any
        // count-sensitive aggregate rewards size. Recorded here because it is a
        // plausible idea that a future reader will otherwise re-implement.
        const out: { file: string; startLine: number; snippet: string; score: number }[] = [];
        for (let round = 0; round < MAX_CHUNKS_PER_FILE && out.length < k; round++) {
            for (const items of grouped.values()) {
                if (out.length >= k) break;
                const item = items[round];
                if (!item) continue;
                out.push({
                    file: item.chunk.file,
                    startLine: item.chunk.startLine,
                    snippet: item.chunk.text.split(/\r?\n/).slice(0, 20).join('\n'),
                    score: Math.round(item.score * 1000) / 10, // Scale for readability
                });
            }
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
                        ...(c.endLine !== undefined ? { endLine: c.endLine } : {}),
                        ...(c.symbol ? { symbol: c.symbol } : {}),
                        ...(c.kind ? { kind: c.kind } : {}),
                        ...(c.parent ? { parent: c.parent } : {}),
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
                            ...(c.endLine !== undefined ? { endLine: c.endLine } : {}),
                            ...(c.symbol ? { symbol: c.symbol } : {}),
                            ...(c.kind ? { kind: c.kind } : {}),
                            ...(c.parent ? { parent: c.parent } : {}),
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

/**
 * How many times a chunk's own symbol name is counted in its term frequencies.
 *
 * A definition should win its own name against files that merely call it. Two is a
 * nudge, not an override: BM25 saturates term frequency, so this shifts ties without
 * letting a short function outrank a genuinely better match on volume alone. Raising
 * it further measurably *hurt* recall@5 on the eval corpus by pushing trivial
 * one-line accessors above the substantive definitions they belong to.
 */
const SYMBOL_TERM_BOOST = 2;

/**
 * Splits a file into chunks, preferring symbol boundaries and falling back to the
 * fixed line window.
 *
 * The fallback is not a rare edge case — it is the correct answer for JSON, YAML,
 * SQL, CSS and every language without a declaration pattern, and it is what runs if
 * a backend throws. Structural chunking failing closed to something that still
 * indexes is the whole reason the two are separated.
 */
function chunkFile(rel: string, content: string): Chunk[] {
    const lines = content.split(/\r?\n/);

    let plans;
    try {
        plans = planChunks(content, languageOf(rel));
    } catch {
        plans = undefined;   // a malformed file must not take the index build down
    }

    if (!plans || plans.length === 0) return lineWindowChunks(rel, content, lines);

    const chunks: Chunk[] = [];
    for (const plan of plans) {
        const text = lines.slice(plan.startLine - 1, plan.endLine).join('\n');
        if (!text.trim()) continue;

        // The symbol name, its parts, the parent and the path all become searchable
        // terms of this chunk even when they appear nowhere in its body.
        const context = [rel, plan.symbol ?? '', plan.parent ?? ''].join(' ');
        const toks = tokenize(text + ' ' + context);
        if (toks.length === 0) continue;

        const tf = new Map<string, number>();
        for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
        if (plan.symbol) {
            for (const t of tokenize(plan.symbol)) {
                tf.set(t, (tf.get(t) || 0) + SYMBOL_TERM_BOOST);
            }
        }

        chunks.push({
            file: rel,
            startLine: plan.startLine,
            endLine: plan.endLine,
            text,
            tokens: tf,
            length: toks.length,
            ...(plan.symbol ? { symbol: plan.symbol } : {}),
            ...(plan.kind ? { kind: plan.kind } : {}),
            ...(plan.parent ? { parent: plan.parent } : {}),
        });
    }

    return chunks.length > 0 ? chunks : lineWindowChunks(rel, content, lines);
}

/** The pre-Phase-3 chunker, kept as the fallback for unstructured content. */
function lineWindowChunks(rel: string, _content: string, lines: string[]): Chunk[] {
    const chunks: Chunk[] = [];
    for (let start = 0; start < lines.length; start += (CHUNK_LINES - CHUNK_OVERLAP)) {
        const text = lines.slice(start, start + CHUNK_LINES).join('\n');
        if (!text.trim()) continue;
        const toks = tokenize(text + ' ' + rel);
        if (toks.length === 0) continue;
        const tf = new Map<string, number>();
        for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
        chunks.push({
            file: rel, startLine: start + 1, endLine: Math.min(start + CHUNK_LINES, lines.length),
            text, tokens: tf, length: toks.length,
        });
        if (lines.length <= CHUNK_LINES) break;
    }
    return chunks;
}
