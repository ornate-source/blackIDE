import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Agent Memory / Knowledge Persistence — Feature 14 / MF-02
// Stores learned patterns, user preferences, and project knowledge across sessions.

export interface KnowledgeItem {
    key: string;
    summary: string;
    content: string;
    source: 'user_correction' | 'learned_pattern' | 'project_context';
    references?: string[];
    timestamp: number;
    hash?: string;
}

function tokenize(text: string): string[] {
    return (text.toLowerCase().match(/[a-z0-9_]+/g) || [])
        .filter(t => t.length > 1 && t.length < 40);
}

export class KnowledgeStore {
    private storePath: string;
    private maxMemories = 200;

    constructor(context: vscode.ExtensionContext) {
        this.storePath = path.join(context.globalStorageUri.fsPath, 'knowledge');
        if (!fs.existsSync(this.storePath)) {
            fs.mkdirSync(this.storePath, { recursive: true });
        }
    }

    private getContentHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    }

    /** Save a knowledge item with deduplication and LRU eviction */
    async save(key: string, data: {
        summary: string;
        content: string;
        source: 'user_correction' | 'learned_pattern' | 'project_context';
        references?: string[];
    }): Promise<void> {
        const contentHash = this.getContentHash(data.content);
        const allItems = await this.getAll();

        // 1. SHA-256 content-hash deduplication: check if this content already exists
        const duplicate = allItems.find(item => item.hash === contentHash || item.content === data.content);
        let targetKey = key;
        
        if (duplicate) {
            // Deduplicate: merge references and update metadata instead of adding a new file
            targetKey = duplicate.key;
            duplicate.summary = data.summary;
            duplicate.source = data.source;
            duplicate.timestamp = Date.now();
            if (data.references) {
                const mergedRefs = new Set([...(duplicate.references || []), ...data.references]);
                duplicate.references = Array.from(mergedRefs);
            }
            const sanitizedKey = targetKey.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
            const filePath = path.join(this.storePath, `${sanitizedKey}.json`);
            fs.writeFileSync(filePath, JSON.stringify(duplicate, null, 2));
            return;
        }

        // 2. Capacity Check (LRU eviction)
        if (allItems.length >= this.maxMemories) {
            // Sort by timestamp ascending (oldest first)
            const sorted = [...allItems].sort((a, b) => a.timestamp - b.timestamp);
            const toEvictCount = allItems.length - this.maxMemories + 1;
            for (let i = 0; i < toEvictCount; i++) {
                const oldest = sorted[i];
                await this.delete(oldest.key);
            }
        }

        const entry: KnowledgeItem = {
            ...data,
            key: targetKey,
            timestamp: Date.now(),
            hash: contentHash
        };
        const sanitizedKey = targetKey.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
        const filePath = path.join(this.storePath, `${sanitizedKey}.json`);
        fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
    }

    /** Retrieve all knowledge items matching a query using BM25 keyword relevance ranking */
    async search(query: string, limit = 10): Promise<KnowledgeItem[]> {
        const allItems = await this.getAll();
        if (allItems.length === 0) return [];

        const qTokens = tokenize(query);
        if (qTokens.length === 0) {
            return allItems.slice(0, limit);
        }

        // Calculate IDF for each query token
        const docs = allItems.map(item => {
            const text = `${item.key} ${item.summary} ${item.content} ${(item.references || []).join(' ')}`;
            const tokens = tokenize(text);
            const tfMap = new Map<string, number>();
            for (const t of tokens) {
                tfMap.set(t, (tfMap.get(t) || 0) + 1);
            }
            return { item, tokens, tfMap, docLen: tokens.length };
        });

        const N = docs.length;
        const avgDocLen = docs.reduce((sum, d) => sum + d.docLen, 0) / N;

        // DF (document frequency) for each token
        const dfMap = new Map<string, number>();
        for (const qt of qTokens) {
            let df = 0;
            for (const doc of docs) {
                if (doc.tfMap.has(qt)) df++;
            }
            dfMap.set(qt, df);
        }

        const k1 = 1.2;
        const b = 0.75;

        const scored = docs.map(doc => {
            let score = 0;
            for (const qt of qTokens) {
                const tf = doc.tfMap.get(qt) || 0;
                if (tf === 0) continue;

                const df = dfMap.get(qt) || 1;
                const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
                const denom = tf + k1 * (1 - b + b * (doc.docLen / avgDocLen));
                score += idf * (tf * (k1 + 1)) / denom;
            }
            return { item: doc.item, score };
        }).filter(s => s.score > 0);

        scored.sort((a, b) => b.score - a.score);

        return scored.map(s => s.item).slice(0, limit);
    }

    /** Get all knowledge items */
    async getAll(): Promise<KnowledgeItem[]> {
        if (!fs.existsSync(this.storePath)) return [];

        const files = fs.readdirSync(this.storePath).filter(f => f.endsWith('.json'));
        const items: KnowledgeItem[] = [];

        for (const file of files) {
            try {
                items.push(JSON.parse(fs.readFileSync(path.join(this.storePath, file), 'utf8')));
            } catch {}
        }

        return items.sort((a, b) => b.timestamp - a.timestamp);
    }

    /** Get relevant context for system prompt injection */
    async getRelevantContext(prompt: string): Promise<string> {
        const items = await this.search(prompt, 5);
        if (items.length === 0) return '';

        return '\n\nRelevant knowledge from previous sessions:\n' +
            items.map(i => `- [${i.source}] ${i.summary}: ${i.content.slice(0, 300)}`).join('\n');
    }

    /** Delete a knowledge item */
    async delete(key: string): Promise<void> {
        const sanitizedKey = key.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
        const filePath = path.join(this.storePath, `${sanitizedKey}.json`);
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch {}
        }
    }
}
