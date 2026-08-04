// ─── Reviewer mode: the decision layer (Phase 9, M47 · P9-2) ────────────────
//
// `black-ide.reviewChanges` reads the working diff and produces a `review` artifact.
// This module is everything about that which has to be *right*: what the reviewer is
// asked, what counts as a finding, which findings are confident enough to offer a fix
// for, and what the artifact says. Pure — no git, no model, no vscode.
//
// ── The failure this design is built around ─────────────────────────────────
// An automated reviewer's failure mode is not missing bugs. It is producing twelve
// findings of which two matter, because a developer who reads three worthless findings
// stops reading the fourth, and from then on the tool is worse than nothing: it costs a
// model call and it launders a real bug into a list nobody opens. P9-2's acceptance
// clause prices exactly this — ≥60% true positives at ≤1 false positive per 10 findings —
// and every decision below is aimed at the second number rather than the first.
//
// Three mechanisms serve it:
//   1. The prompt names the categories that are *out of scope* concretely, because
//      "style nit" is the single largest source of low-value findings and a model will
//      not infer that from "be useful".
//   2. `parseFindings` requires a concrete failure scenario. A finding that cannot say
//      what breaks is a code-taste opinion wearing a bug's clothes, and dropping it
//      costs nothing that was worth reading.
//   3. `offersFix` is a much higher bar than `confidence >= x`. A fix that is applied
//      and wrong is more expensive than a finding that is merely noisy.
//
// ── Read-only is enforced at the executor, not requested here ────────────────
// The prompt says the reviewer may not edit. That is worth saying and worth nothing on
// its own: the enforcement is `REVIEW_TOOLS` below, applied as the acting mode's
// allowlist, under the tier-2 sandbox from M57. Same argument as M56's — a gate that
// content can talk its way past is not a gate.

import { SandboxTier } from './sandbox';

export type FindingSeverity = 'high' | 'medium' | 'low';

export interface ReviewFinding {
    /** Stable within one review, used by the panel and by the fix offer. */
    id: string;
    file: string;
    /** 1-indexed line in the *new* file. 0 when the finding is about the change as a whole. */
    line: number;
    severity: FindingSeverity;
    /** Short kebab-case class: `correctness`, `resource-leak`, `injection`, … */
    category: string;
    /** One sentence naming the defect. */
    summary: string;
    /**
     * Concrete inputs or state → wrong output or crash. Required, and the requirement is
     * the filter: see the module header.
     */
    failureScenario: string;
    /** 0–1, the model's own confidence. Gates the fix offer, never the display. */
    confidence: number;
    /** The reviewer's suggested change, when it offered one. */
    suggestedFix?: string;
}

export interface ReviewRequest {
    /** Unified diff of the working tree. */
    diff: string;
    /** Optional context files the reviewer asked for, already read. */
    context?: { path: string; content: string }[];
    /** What the change is meant to do, when the caller knows. */
    intent?: string;
}

/**
 * The tools a reviewer may call.
 *
 * Read-only by construction rather than by instruction. `run_command` is absent even
 * though a reviewer would plausibly want to run the tests: a review that can run commands
 * is a review that can run `npm install` on a diff it is reading, and the diff is
 * untrusted content by M56's definition. If a review needs test results, the caller runs
 * the tests and passes them in.
 */
export const REVIEW_TOOLS: readonly string[] = [
    'read_file', 'grep_search', 'list_directory', 'codebase_search',
    'go_to_definition', 'find_references', 'workspace_symbols', 'hover',
    'document_symbols', 'impact_analysis', 'blame', 'search_history', 'why_was_this_changed',
    'expand_output', 'complete_task',
];

/**
 * The sandbox tier a review runs under.
 *
 * Tier 2 (`restricted`) rather than tier 1, and the reason is not that the reviewer runs
 * commands — it cannot. It is that `REVIEW_TOOLS` is a list in a TypeScript file and the
 * tier is a property of the process: if a future edit adds `run_command` back to the list
 * by accident, the tier is what still stops it reaching the network. Defence in depth is
 * cheap here and the cost of being wrong is a model reading a diff with the network open.
 */
export const REVIEW_TIER: SandboxTier = 'restricted';

/** Categories the reviewer is asked for, in the order they are worth reading. */
const CATEGORIES = [
    'correctness   — the code does not do what it says (off-by-one, inverted condition, wrong operator)',
    'resource      — something is acquired and not released, or cached and never invalidated',
    'concurrency   — a race, a lost update, an await that should not be there or is missing',
    'security      — unvalidated path, injection, a secret in a log, a guard that can be bypassed',
    'error-path    — a failure mode that is swallowed, or reported as success',
    'api-contract  — a caller elsewhere in the repo is now wrong; the change is not self-contained',
];

/**
 * The review prompt.
 *
 * The out-of-scope list is longer than the in-scope list, deliberately. Every entry on it
 * was chosen because it is a category a language model volunteers unprompted and a
 * developer skips unread — and one skipped finding costs more than one missed bug, because
 * it is what teaches the reader to skip the next one.
 */
export function buildReviewPrompt(request: ReviewRequest): string {
    const context = (request.context || [])
        .map(c => `--- ${c.path} ---\n${c.content}`)
        .join('\n\n');

    return [
        'Review this working diff. Report defects a competent reviewer would block the change for.',
        '',
        request.intent ? `The change is intended to: ${request.intent}` : '',
        '',
        'Look for:',
        ...CATEGORIES.map(c => `  - ${c}`),
        '',
        'Do NOT report any of the following. They are the reason automated reviews get ignored:',
        '  - naming, formatting, import order, line length, or anything a linter owns',
        '  - "consider adding a comment" / "consider extracting a helper"',
        '  - missing tests, unless the change is untestable as written',
        '  - a defect that already existed and this diff did not touch',
        '  - a possibility you cannot ground in a concrete input ("this could theoretically overflow")',
        '',
        'Every finding MUST include a failure scenario: specific inputs or state, and what goes',
        'wrong as a result. If you cannot write one, you do not have a finding — drop it.',
        '',
        'You are read-only. You cannot edit files or run commands. Suggest a fix in the finding',
        'if you are confident in it; something else applies it.',
        '',
        'Output JSON only:',
        '[{"file": "src/x.ts", "line": 42, "severity": "high", "category": "correctness",',
        '  "summary": "one sentence naming the defect",',
        '  "failureScenario": "given input X, this returns Y instead of Z",',
        '  "confidence": 0.0, "suggestedFix": "optional replacement code"}]',
        '',
        'An empty array is a legitimate and common answer. Most diffs are fine.',
        '',
        context ? `--- context ---\n${context}\n` : '',
        '--- diff ---',
        request.diff,
        '--- end ---',
        '',
        'JSON array:',
    ].filter(line => line !== '').join('\n');
}

const SEVERITIES: FindingSeverity[] = ['high', 'medium', 'low'];

/**
 * Parse the reviewer's answer into findings, dropping everything that is not one.
 *
 * The drops are the product. A finding with no `failureScenario`, or one whose scenario
 * is a restatement of the summary, is exactly the low-value output the ≤1-in-10 clause
 * prices — and a parser that filled in a default for it would convert a model that could
 * not justify its finding into a tool that asserts one.
 */
export function parseFindings(response: string, reviewId = 'r'): ReviewFinding[] {
    const parsed = parseJsonArray(response);
    if (!parsed) return [];

    const out: ReviewFinding[] = [];
    for (const raw of parsed) {
        if (!raw || typeof raw !== 'object') continue;
        const record = raw as Record<string, unknown>;

        const summary = String(record.summary ?? '').trim();
        const failureScenario = String(record.failureScenario ?? record.failure_scenario ?? '').trim();
        const file = String(record.file ?? '').trim();
        if (!summary || !file) continue;

        // The scenario has to add information. "This is wrong because it is wrong" is a
        // finding that passed a required-field check and failed its purpose.
        if (failureScenario.length < 20) continue;
        if (normalise(failureScenario) === normalise(summary)) continue;

        const severity = SEVERITIES.includes(record.severity as FindingSeverity)
            ? record.severity as FindingSeverity
            : 'medium';
        const confidenceValue = Number(record.confidence);
        const confidence = Number.isFinite(confidenceValue) ? Math.min(1, Math.max(0, confidenceValue)) : 0.5;
        const lineValue = Number(record.line);
        const line = Number.isFinite(lineValue) && lineValue > 0 ? Math.floor(lineValue) : 0;
        const suggestedFix = typeof record.suggestedFix === 'string' && record.suggestedFix.trim()
            ? record.suggestedFix
            : undefined;

        out.push({
            id: `${reviewId}-${out.length + 1}`,
            file, line, severity,
            category: String(record.category ?? 'correctness').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'correctness',
            summary, failureScenario, confidence, suggestedFix,
        });
    }
    return rankFindings(out);
}

/**
 * Order findings by what a reader should look at first.
 *
 * Severity outranks confidence, not the other way round. A high-severity finding the
 * reviewer is 60% sure of is worth a developer's thirty seconds; a low-severity one it is
 * 95% sure of is not, and sorting by confidence would put the second at the top of every
 * review — which is the ranking that makes a reader stop at the third item.
 */
export function rankFindings(findings: ReviewFinding[]): ReviewFinding[] {
    const rank = (s: FindingSeverity) => (s === 'high' ? 0 : s === 'medium' ? 1 : 2);
    return [...findings].sort((a, b) =>
        rank(a.severity) - rank(b.severity)
        || b.confidence - a.confidence
        || a.file.localeCompare(b.file)
        || a.line - b.line);
}

/**
 * May this finding offer a one-click, checkpointed fix?
 *
 * Three conditions, all required, and the bar is well above "the model was confident".
 * A fix offer is a button that edits the user's code, so the question is not "is this
 * finding probably right" but "if this is wrong, is the damage bounded and visible" —
 * which is why a fix is only offered when the reviewer supplied concrete replacement
 * text. A generated fix from a summary alone would be a second model call inventing an
 * edit for a defect nobody has confirmed exists.
 *
 * `low` severity is excluded regardless of confidence: the whole value of a fix button is
 * saving the user from a defect that matters, and a confident low-severity autofix is a
 * diff in their working tree they did not ask for.
 */
export function offersFix(finding: ReviewFinding): boolean {
    return finding.confidence >= 0.8
        && finding.severity !== 'low'
        && !!finding.suggestedFix
        && finding.line > 0;
}

export interface ReviewSummary {
    total: number;
    high: number;
    medium: number;
    low: number;
    fixable: number;
    files: number;
}

export function summariseReview(findings: ReviewFinding[]): ReviewSummary {
    return {
        total: findings.length,
        high: findings.filter(f => f.severity === 'high').length,
        medium: findings.filter(f => f.severity === 'medium').length,
        low: findings.filter(f => f.severity === 'low').length,
        fixable: findings.filter(offersFix).length,
        files: new Set(findings.map(f => f.file)).size,
    };
}

/**
 * Render the `review` artifact.
 *
 * Markdown rather than JSON because the artifact is a file in the user's repo that they
 * may read in an editor, in a PR, or six months later with no panel in front of them. The
 * structured form travels in the artifact index; this is the copy a human reads, and it
 * leads with the failure scenario rather than the summary because the scenario is what
 * tells a reader in one line whether to care.
 *
 * A review with no findings still produces an artifact. "Nothing found" is a result, and a
 * reviewer that silently produces no file on a clean diff is indistinguishable from one
 * that crashed.
 */
export function renderReviewArtifact(
    findings: ReviewFinding[],
    meta: { title?: string; filesChanged?: number; at?: number; model?: string } = {},
): string {
    const summary = summariseReview(findings);
    const when = new Date(meta.at ?? Date.now()).toISOString();
    const lines: string[] = [
        `# ${meta.title || 'Review of the working diff'}`,
        '',
        `Reviewed ${when}${meta.model ? ` · ${meta.model}` : ''}`
        + `${meta.filesChanged != null ? ` · ${meta.filesChanged} file(s) changed` : ''}`,
        '',
    ];

    if (!findings.length) {
        lines.push(
            '**No findings.**',
            '',
            'The reviewer read the diff and did not find a defect it could ground in a concrete',
            'failure. That is not a guarantee the change is correct — it is one read of it.',
            '',
        );
        return lines.join('\n');
    }

    lines.push(
        `**${summary.total} finding(s)** across ${summary.files} file(s) — `
        + `${summary.high} high, ${summary.medium} medium, ${summary.low} low`
        + `${summary.fixable ? ` · ${summary.fixable} with a suggested fix` : ''}`,
        '',
    );

    for (const finding of findings) {
        const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
        lines.push(
            `## ${severityMark(finding.severity)} ${finding.summary}`,
            '',
            `\`${where}\` · ${finding.category} · confidence ${Math.round(finding.confidence * 100)}%`,
            '',
            `**Fails when:** ${finding.failureScenario}`,
            '',
        );
        if (finding.suggestedFix) {
            lines.push(
                offersFix(finding)
                    ? '**Suggested fix** (offered as a checkpointed one-click change):'
                    : '**Suggested fix** (shown only — not offered as a one-click change):',
                '',
                '```',
                finding.suggestedFix.trim(),
                '```',
                '',
            );
        }
    }
    return lines.join('\n');
}

function severityMark(severity: FindingSeverity): string {
    return severity === 'high' ? '🔴' : severity === 'medium' ? '🟡' : '⚪';
}

function normalise(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ─── Shared JSON salvage ────────────────────────────────────────────────────
// Same shape as `memory-extract.ts`'s, and duplicated rather than shared for one
// reason: extraction writes to the user's memory file and review writes to an artifact,
// so the two have different appetites for salvaging a half-broken response, and a single
// helper would eventually be tuned for one of them at the other's expense.

function parseJsonArray(response: string): unknown[] | undefined {
    const text = String(response || '').trim();
    if (!text) return undefined;

    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
    const body = fenced ? fenced[1].trim() : text;

    const direct = tryParse(body);
    if (direct) return direct;

    for (let i = 0; i < body.length; i++) {
        if (body[i] !== '[') continue;
        const end = matchBracket(body, i);
        if (end < 0) continue;
        const candidate = tryParse(body.slice(i, end + 1));
        if (candidate) return candidate;
    }
    return undefined;
}

function tryParse(text: string): unknown[] | undefined {
    try {
        const value = JSON.parse(text);
        if (Array.isArray(value)) return value;
        if (value && typeof value === 'object') {
            for (const inner of Object.values(value)) {
                if (Array.isArray(inner)) return inner;
            }
        }
    } catch { /* not JSON here */ }
    return undefined;
}

function matchBracket(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '[') depth++;
        else if (ch === ']' && --depth === 0) return i;
    }
    return -1;
}
