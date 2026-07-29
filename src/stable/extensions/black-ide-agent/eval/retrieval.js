/*
 * Retrieval measurement (Phase 3).
 *
 * Builds a real `CodebaseIndex` over `eval/retrieval-corpus/` and scores the golden
 * queries in `eval/retrieval-queries.js`. Requires `test/vscode-stub.js` to already
 * be installed in the require cache — the caller does that (see run-eval.js).
 *
 * ── What this measures, honestly ─────────────────────────────────────────────
 * The **lexical tier only**. `CodebaseIndex.search()` fuses BM25 with embedding
 * cosine similarity through RRF, but embeddings need a configured provider and a
 * network call, so in CI the semantic list is empty and RRF degrades to BM25 order.
 * That is the right baseline for Phase 3 to move: symbol chunking and the reranker
 * both change what the lexical tier can reach, and a metric that silently depended
 * on an API key would be unrunnable in the gate that has to catch their regressions.
 *
 * Index state is written to a scratch dir and removed afterwards, so a run never
 * reads a stale `codebase-index.json` from a previous one — a cached index would
 * make a chunking change look like a no-op.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CORPUS_DIR = path.join(__dirname, 'retrieval-corpus');
const queries = require('./retrieval-queries');

/** recall@k for one query: share of its gold files present in the top-k results. */
function recallAtK(results, mustFind, k) {
    const retrieved = new Set(
        results.slice(0, k).map(r => String(r.file).split(path.sep).join('/'))
    );
    const hits = mustFind.filter(f => retrieved.has(f));
    return { hits, recall: mustFind.length === 0 ? 1 : hits.length / mustFind.length };
}

/**
 * @param {object} vscodeStub  the shared stub, already in the require cache
 * @param {object} CodebaseIndexModule  the compiled dist module
 * @param {number[]} ks  cut-offs to report (recall@k for each)
 */
async function measureRetrieval(vscodeStub, CodebaseIndexModule, ks = [3, 5, 10, 20]) {
    const { CodebaseIndex } = CodebaseIndexModule;

    const previousFolders = vscodeStub.workspace.workspaceFolders;
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-eval-index-'));

    try {
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: CORPUS_DIR }, name: 'corpus', index: 0 }];

        const index = new CodebaseIndex(storageDir);
        const startedAt = Date.now();
        const built = await index.build(undefined, 2000);
        const buildMs = Date.now() - startedAt;

        // Fail loudly rather than reporting 0% recall. An empty index is almost always
        // a broken `findFiles` stub, not a retrieval regression, and the two must not
        // look the same in the gate — that confusion is what deferred this metric for
        // three phases in the first place.
        if (index.size === 0) {
            throw new Error(
                `Indexed nothing from ${CORPUS_DIR} — the vscode stub's findFiles is not enumerating. ` +
                `Recall cannot be measured against an empty index.`
            );
        }

        const rows = [];
        const totals = new Map(ks.map(k => [k, 0]));

        for (const q of queries) {
            // Ask for the largest cut-off once; the smaller ks are prefixes of it.
            const results = await index.search(q.query, Math.max(...ks));
            const row = { id: q.id, query: q.query, mustFind: q.mustFind, at: {} };

            for (const k of ks) {
                const { hits, recall } = recallAtK(results, q.mustFind, k);
                row.at[k] = { recall, hits, missed: q.mustFind.filter(f => !hits.includes(f)) };
                totals.set(k, totals.get(k) + recall);
            }
            row.top = results.slice(0, 10).map(r => String(r.file).split(path.sep).join('/'));
            rows.push(row);
        }

        const metrics = {
            corpusFiles: built.indexed + built.reused,
            corpusChunks: index.size,
            queries: queries.length,
            buildMs,
        };
        for (const k of ks) {
            metrics[`recallAt${k}Pct`] = Math.round((totals.get(k) / queries.length) * 1000) / 10;
        }

        return { metrics, rows, ks };
    } finally {
        vscodeStub.workspace.workspaceFolders = previousFolders;
        fs.rmSync(storageDir, { recursive: true, force: true });
    }
}

module.exports = { measureRetrieval, recallAtK, CORPUS_DIR };
