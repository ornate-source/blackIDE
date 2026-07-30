/*
 * Tool-output compaction measurement (Phase 3, M18).
 *
 * The gate is "≥30% measured token reduction on a fixed corpus of tool outputs".
 * The corpus here is *generated from the real retrieval corpus* rather than
 * hand-written, because hand-written samples are where a compression benchmark goes
 * to lie: it is trivially easy to invent grep output with a 90% shared prefix. These
 * are the results real greps over `eval/retrieval-corpus/` actually produce.
 *
 * Reduction is reported in characters and in the same `/4` token heuristic
 * `TokenTracker` uses, so the number is comparable with what the cost UI reports
 * rather than being a second, prettier metric.
 */

const fs = require('fs');
const path = require('path');

const CORPUS = path.join(__dirname, 'retrieval-corpus');

/** The queries below are chosen to span the range, not to flatter the encoder. */
const GREP_QUERIES = [
    'currency',      // very common: appears across services, routes, models, web
    'async',         // extremely common, spread thin over many files
    'convertMinor',  // rare: two or three files
    'retry',         // clustered in a few files
    'error',         // common and evenly spread
    'export',        // near-universal
    'reservation',   // narrow, one file dominates
];

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

/** Reproduces `ToolRunner.grepSearch`'s row shape without needing vscode. */
function grep(query) {
    const rows = [];
    for (const file of walk(CORPUS)) {
        const rel = path.relative(CORPUS, file).split(path.sep).join('/');
        let content;
        try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
        content.split(/\r?\n/).forEach((line, i) => {
            if (line.toLowerCase().includes(query.toLowerCase())) {
                rows.push({ file: rel, line: i + 1, content: line.trim() });
            }
        });
    }
    return rows;
}

/** Synthesised from real files: one bad import produces the same error repeatedly. */
function diagnosticsSample() {
    const rows = [];
    const files = walk(CORPUS)
        .filter(f => f.endsWith('.ts'))
        .slice(0, 6)
        .map(f => path.relative(CORPUS, f).split(path.sep).join('/'));

    for (const file of files) {
        for (let line = 3; line < 30; line += 3) {
            rows.push({
                file, line, severity: 'error',
                message: "Cannot find name 'OrderRepository'. Did you mean to import it?",
                source: 'ts',
            });
        }
        rows.push({ file, line: 41, severity: 'warning', message: "'total' is declared but never read.", source: 'ts' });
    }
    return rows;
}

function tokens(text) {
    return Math.ceil(text.length / 4);   // same heuristic as core/token-tracker.ts
}

/**
 * A second grep sample over this extension's own `src/`, reported separately.
 *
 * Grouping saves exactly the repeated path prefix, so the reduction is a function of
 * `path length / line length` and nothing else. `retrieval-corpus/` is a flat demo
 * app whose paths average ~25 characters, which makes it a *pessimistic* corpus for
 * this particular measurement — real projects nest, and the files this extension
 * actually runs over average ~62. Both numbers are published rather than picking the
 * flattering one: the fixture figure is the stable gated metric, this one is the
 * realistic figure, and the gap between them is the finding.
 *
 * Not gated, because it drifts as the source changes.
 */
const OWN_SRC = path.join(__dirname, '..', 'src');
const OWN_SRC_QUERIES = ['chunk', 'tool', 'index', 'async', 'search'];

function measureDeepPaths(compactModule) {
    if (!fs.existsSync(OWN_SRC)) return undefined;
    const repoRoot = path.join(__dirname, '..', '..', '..', '..', '..');

    let originalChars = 0, compactChars = 0, pathChars = 0, rowCount = 0;
    for (const query of OWN_SRC_QUERIES) {
        const rows = [];
        for (const file of walk(OWN_SRC)) {
            if (!/\.(ts|tsx)$/.test(file)) continue;
            const rel = path.relative(repoRoot, file).split(path.sep).join('/');
            let content;
            try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
            content.split(/\r?\n/).forEach((line, i) => {
                if (line.toLowerCase().includes(query)) rows.push({ file: rel, line: i + 1, content: line.trim() });
            });
        }
        if (rows.length === 0) continue;
        const result = compactModule.compactGrep(rows);
        originalChars += result.originalChars;
        compactChars += result.compactChars;
        pathChars += rows.reduce((sum, r) => sum + r.file.length, 0);
        rowCount += rows.length;
    }

    if (originalChars === 0) return undefined;
    return {
        savedPct: Math.round(((originalChars - compactChars) / originalChars) * 1000) / 10,
        avgPathChars: Math.round(pathChars / rowCount),
        rows: rowCount,
    };
}

function measureCompaction(compactModule) {
    const { compactGrep, compactDiagnostics } = compactModule;
    const rows = [];
    let originalChars = 0, compactChars = 0;

    for (const query of GREP_QUERIES) {
        const hits = grep(query);
        if (hits.length === 0) continue;
        const result = compactGrep(hits);
        originalChars += result.originalChars;
        compactChars += result.compactChars;
        rows.push({
            sample: `grep "${query}"`,
            count: hits.length,
            originalChars: result.originalChars,
            compactChars: result.compactChars,
            savedPct: result.savedPct,
        });
    }

    const diagnostics = compactDiagnostics(diagnosticsSample());
    originalChars += diagnostics.originalChars;
    compactChars += diagnostics.compactChars;
    rows.push({
        sample: 'get_diagnostics (repeated error)',
        count: diagnosticsSample().length,
        originalChars: diagnostics.originalChars,
        compactChars: diagnostics.compactChars,
        savedPct: diagnostics.savedPct,
    });

    const avgPathChars = (() => {
        let total = 0, count = 0;
        for (const query of GREP_QUERIES) {
            for (const hit of grep(query)) { total += hit.file.length; count++; }
        }
        return count ? Math.round(total / count) : 0;
    })();

    const metrics = {
        samples: rows.length,
        originalChars,
        compactChars,
        originalTokens: tokens('x'.repeat(originalChars)),
        compactTokens: tokens('x'.repeat(compactChars)),
        avgPathChars,
        savedPct: originalChars === 0 ? 0
            : Math.round(((originalChars - compactChars) / originalChars) * 1000) / 10,
    };

    return { metrics, rows, deepPaths: measureDeepPaths(compactModule) };
}

module.exports = { measureCompaction, GREP_QUERIES };
