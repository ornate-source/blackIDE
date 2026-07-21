import * as fs from 'fs';
import * as path from 'path';
import { capSections, allocateBudget } from './text-cap';

// ─── Long-Term Project Memory ────────────────────────────────────────────────
// The `plan.md` `knowledge/` brain: a durable, human-readable set of markdown files
// under `.blackIDE/knowledge/` that both the user and the agents read and update, so
// project understanding accrues across sessions instead of being re-derived every run.
// The mindmap remains the machine-oriented architecture snapshot; this is the curated,
// decision-and-status record layered on top. Pure formatting/merge logic is separated
// from I/O so it can be unit-tested without a filesystem.

export const KNOWLEDGE_FILES: Record<string, string> = {
    'architecture.md':   '# Architecture\n\n_High-level structure, modules, and data flow._\n',
    'decision_log.md':   '# Decision Log (ADRs)\n\n_Architecture Decision Records, newest last._\n',
    'feature_status.md': '# Feature Status\n\n| Feature | Status | Updated | Notes |\n|---|---|---|---|\n',
    'technical_debt.md': '# Technical Debt\n\n_Known shortcuts and their remediation._\n',
    'glossary.md':       '# Glossary\n\n_Domain terms and their meaning._\n',
    'roadmap.md':        '# Roadmap\n\n_Planned and in-flight work._\n',
};

export interface AdrEntry {
    id: number;
    title: string;
    decision: string;
    reason: string;
    alternatives?: string[];
    tradeoffs?: string[];
    date?: string;
}

/** The next ADR id given the current decision_log content (max existing + 1, else 1). Pure. */
export function nextAdrId(existing: string): number {
    let max = 0;
    for (const m of (existing || '').matchAll(/ADR-(\d+)/g)) {
        max = Math.max(max, parseInt(m[1], 10) || 0);
    }
    return max + 1;
}

/** Render an ADR as markdown, matching the plan.md ADR shape. Pure. */
export function formatAdr(entry: AdrEntry): string {
    const id = `ADR-${String(entry.id).padStart(3, '0')}`;
    const lines = [
        `\n## ${id}: ${entry.title}`,
        `**Date:** ${entry.date || new Date().toISOString().slice(0, 10)}`,
        ``,
        `**Decision:** ${entry.decision}`,
        ``,
        `**Reason:** ${entry.reason}`,
    ];
    if (entry.alternatives?.length) lines.push(``, `**Alternatives considered:** ${entry.alternatives.join('; ')}`);
    if (entry.tradeoffs?.length) lines.push(``, `**Trade-offs:** ${entry.tradeoffs.join('; ')}`);
    return lines.join('\n') + '\n';
}

export type FeatureState = 'planned' | 'in-progress' | 'done';
export interface FeatureStatusEntry {
    feature: string;
    status: FeatureState;
    updated?: string;
    notes?: string;
}

/**
 * Upserts a feature row in a `feature_status.md` markdown table by feature name (case-
 * insensitive), preserving the header and other rows. Returns the full updated document.
 * Pure — the single source of truth for the table's shape, so read/modify/write can't drift.
 */
export function upsertFeatureStatus(existing: string, entry: FeatureStatusEntry): string {
    const header = '| Feature | Status | Updated | Notes |\n|---|---|---|---|';
    const updated = entry.updated || new Date().toISOString().slice(0, 10);
    const escape = (s: string) => (s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const row = `| ${escape(entry.feature)} | ${entry.status} | ${updated} | ${escape(entry.notes || '')} |`;

    const base = existing && existing.includes('| Feature |') ? existing : `# Feature Status\n\n${header}\n`;
    const lines = base.split('\n');
    const key = entry.feature.trim().toLowerCase();
    let replaced = false;
    const out = lines.map(line => {
        if (!replaced && /^\|/.test(line) && !/^\|\s*Feature\s*\|/i.test(line) && !/^\|\s*-/.test(line)) {
            const name = line.split('|')[1]?.trim().toLowerCase();
            if (name === key) { replaced = true; return row; }
        }
        return line;
    });
    if (!replaced) {
        // Append after the separator row (or at end if no table yet).
        const sepIdx = out.findIndex(l => /^\|\s*-/.test(l));
        if (sepIdx >= 0) out.splice(sepIdx + 1, 0, row);
        else out.push(row);
    }
    return out.join('\n');
}

/** Dependency-name → human stack label. Ordered: the first match wins as the primary stack. */
const STACK_SIGNATURES: [RegExp, string][] = [
    [/^next$/, 'Next.js'], [/^nuxt$/, 'Nuxt'], [/^@angular\/core$/, 'Angular'],
    [/^svelte$/, 'Svelte'], [/^vue$/, 'Vue'], [/^react$/, 'React'],
    [/^@nestjs\/core$/, 'NestJS'], [/^express$/, 'Express'], [/^fastify$/, 'Fastify'],
    [/^electron$/, 'Electron'], [/^react-native$/, 'React Native'],
    [/^vite$/, 'Vite'], [/^webpack$/, 'webpack'],
    [/^typescript$/, 'TypeScript'], [/^jest$/, 'Jest'], [/^vitest$/, 'Vitest'],
    [/^tailwindcss$/, 'Tailwind CSS'], [/^prisma$/, 'Prisma'], [/^mongoose$/, 'Mongoose'],
];

const ENTRY_POINT_NAMES = /^(index|main|app|extension|server|cli)\.(ts|tsx|js|jsx|mjs|py|go|rs)$/i;

/**
 * A first-pass architecture summary derived from the file list and package manifest, so a
 * new workspace's knowledge base starts with real content instead of an empty header. Pure
 * — the caller supplies the file list (from CodebaseIndex / workspace.findFiles), so this
 * is unit-testable without a filesystem.
 *
 * Deliberately shallow: this is a *seed* a human or agent then corrects, not an attempt at
 * true architecture inference. It states only what the file tree literally shows.
 */
export function summarizeRepoStructure(files: string[], pkgJson?: any): string {
    const clean = (files || []).map(f => String(f).replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);

    // Group by top-level directory; root files bucket under '(root)'.
    const groups = new Map<string, number>();
    for (const f of clean) {
        const top = f.includes('/') ? f.slice(0, f.indexOf('/')) : '(root)';
        groups.set(top, (groups.get(top) || 0) + 1);
    }
    const ranked = [...groups.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const deps = { ...(pkgJson?.dependencies || {}), ...(pkgJson?.devDependencies || {}) };
    const depNames = Object.keys(deps);
    const stack = STACK_SIGNATURES.filter(([re]) => depNames.some(d => re.test(d))).map(([, label]) => label);

    const entries = clean.filter(f => ENTRY_POINT_NAMES.test(f.slice(f.lastIndexOf('/') + 1)))
        .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
        .slice(0, 8);

    const lines = [
        '# Architecture',
        '',
        '_Seeded automatically from a first-run repository scan. Correct anything wrong —',
        'this file is authoritative once edited and will not be regenerated._',
        '',
    ];

    if (pkgJson?.name) lines.push(`**Project:** ${pkgJson.name}${pkgJson.version ? ` v${pkgJson.version}` : ''}`, '');
    if (stack.length) lines.push(`**Detected stack:** ${stack.join(', ')}`, '');
    lines.push(`**Scanned files:** ${clean.length}`, '');

    if (ranked.length) {
        lines.push('## Top-level structure', '', '| Directory | Files |', '|---|---|');
        for (const [dir, count] of ranked.slice(0, 15)) lines.push(`| \`${dir}\` | ${count} |`);
        if (ranked.length > 15) lines.push(`| _…${ranked.length - 15} more_ | |`);
        lines.push('');
    }

    if (entries.length) {
        lines.push('## Likely entry points', '');
        for (const e of entries) lines.push(`- \`${e}\``);
        lines.push('');
    }

    if (pkgJson?.scripts && Object.keys(pkgJson.scripts).length) {
        lines.push('## Scripts', '');
        for (const [k, v] of Object.entries(pkgJson.scripts).slice(0, 10)) lines.push(`- \`${k}\` — \`${v}\``);
        lines.push('');
    }

    return lines.join('\n');
}

/** Byte ceiling for a single append-only knowledge file before its oldest entries are pruned. */
export const KNOWLEDGE_FILE_MAX_BYTES = 256 * 1024;

/**
 * Which knowledge files grow without bound and are therefore safe to prune. `decision_log.md`
 * is append-only by construction (recordDecision appends an ADR per run).
 *
 * NOTE: this is disk/git hygiene, NOT a token optimisation — `readContext` already budgets
 * what it injects per file, so an oversized log costs no extra tokens. Only structured,
 * regenerable-from-git content is pruned; the curated files (architecture, glossary,
 * roadmap, technical_debt) are never touched, because a human writes those and losing the
 * oldest entry would lose real information.
 */
const PRUNABLE_KNOWLEDGE_FILES = new Set(['decision_log.md']);

/**
 * Bound an append-only knowledge file, preserving the head and the newest entries. Pure —
 * the same `capSections` strategy the mindmap uses (see core/text-cap.ts). Files not in
 * PRUNABLE_KNOWLEDGE_FILES are returned unchanged.
 */
export function capKnowledgeFile(name: string, content: string, maxBytes = KNOWLEDGE_FILE_MAX_BYTES): string {
    if (!PRUNABLE_KNOWLEDGE_FILES.has(name)) return content;
    return capSections(content, maxBytes, {
        notice: '\n\n> _Older ADRs were pruned to bound file size; the full history is in git._\n',
    });
}

export class KnowledgeBase {
    private readonly dir: string;
    constructor(private readonly workspaceRoot: string) {
        this.dir = path.join(workspaceRoot, '.blackIDE', 'knowledge');
    }

    /** Create the knowledge folder and seed any missing standard files with their headers. */
    ensureScaffold(): void {
        try {
            if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
            for (const [name, header] of Object.entries(KNOWLEDGE_FILES)) {
                const p = path.join(this.dir, name);
                if (!fs.existsSync(p)) fs.writeFileSync(p, header, 'utf8');
            }
        } catch { /* best-effort; knowledge base must never break a run */ }
    }

    private readFile(name: string): string {
        try { return fs.readFileSync(path.join(this.dir, name), 'utf8'); }
        catch { return KNOWLEDGE_FILES[name] || ''; }
    }
    private writeFile(name: string, content: string): void {
        try {
            if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
            fs.writeFileSync(path.join(this.dir, name), capKnowledgeFile(name, content), 'utf8');
        } catch { /* best-effort */ }
    }

    /**
     * True when architecture.md still holds nothing but its seeded header — i.e. nothing
     * has been learned or written yet, so it is safe to overwrite.
     */
    isArchitectureUnseeded(): boolean {
        const content = this.readFile('architecture.md').trim();
        return !content || content === (KNOWLEDGE_FILES['architecture.md'] || '').trim();
    }

    /**
     * Seed architecture.md from a repo scan. **No-op if the file has any real content** —
     * a discovery scan must never overwrite what a human or an agent has written, and this
     * runs on activation where a silent clobber would be invisible until the damage showed
     * up in an agent's context. Returns whether it wrote.
     */
    scaffoldArchitecture(summary: string): boolean {
        if (!summary?.trim() || !this.isArchitectureUnseeded()) return false;
        this.writeFile('architecture.md', summary);
        return true;
    }

    /** Append an ADR to decision_log.md, auto-assigning the next id. Returns the id used. */
    recordDecision(entry: Omit<AdrEntry, 'id'>): number {
        const existing = this.readFile('decision_log.md');
        const id = nextAdrId(existing);
        this.writeFile('decision_log.md', existing + formatAdr({ ...entry, id }));
        return id;
    }

    /** Upsert a feature's status row in feature_status.md. */
    recordFeature(entry: FeatureStatusEntry): void {
        this.writeFile('feature_status.md', upsertFeatureStatus(this.readFile('feature_status.md'), entry));
    }

    /**
     * A bounded digest of the durable knowledge for injection into an agent's context —
     * the read side of long-term memory, so a new run starts aware of prior decisions,
     * feature status, tech debt, and architecture instead of re-deriving them. Skips
     * files that are still just their seeded header (nothing learned yet), and caps the
     * total so it can't crowd out the task itself.
     */
    readContext(maxChars = 6000): string {
        const names = ['architecture.md', 'decision_log.md', 'feature_status.md', 'technical_debt.md'];
        const present: { name: string; content: string }[] = [];
        for (const name of names) {
            const content = this.readFile(name).trim();
            const seeded = (KNOWLEDGE_FILES[name] || '').trim();
            if (!content || content === seeded) continue; // nothing learned yet
            present.push({ name, content });
        }
        if (present.length === 0) return '';

        // Budget PER FILE, not across the concatenation. Slicing the joined string would
        // spend the whole budget on whichever file happens to sort first: as decision_log.md
        // grows, its oldest ADRs would crowd out the newest ones AND drop technical_debt.md
        // entirely, so the agent would see a knowledge digest that gets staler as the project
        // learns more — the exact inverse of this method's purpose.
        const SEP = '\n\n---\n\n';
        const budget = Math.max(0, maxChars - SEP.length * (present.length - 1));
        const allowances = allocateBudget(present.map(p => p.content.length), budget);

        const out = present.map((p, i) => this.capSection(p.name, p.content, allowances[i]));
        return out.join(SEP);
    }

    /**
     * Fit one knowledge file into its allowance. The ADR log is section-structured and
     * append-newest-last, so it is pruned oldest-first to keep the newest decisions — the
     * ones a new run most needs. Other files have no section structure to exploit and are
     * truncated with an explicit marker so the agent can tell it is seeing a partial file.
     */
    private capSection(name: string, content: string, allowance: number): string {
        if (content.length <= allowance) return content;
        if (name === 'decision_log.md') {
            return capSections(content, allowance, {
                notice: '\n\n> _Older ADRs pruned from this digest; the full log is in decision_log.md._\n',
                measure: s => s.length,
            });
        }
        const marker = '\n…(truncated)';
        return content.slice(0, Math.max(0, allowance - marker.length)) + marker;
    }
}
