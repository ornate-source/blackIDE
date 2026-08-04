import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    REVIEW_TIER, REVIEW_TOOLS, ReviewFinding, buildReviewPrompt, offersFix, parseFindings,
    rankFindings, renderReviewArtifact, summariseReview,
} from '../src/core/code-review';
import { applyFix, reindent, runReview } from '../src/agent/review-runner';
import { ARTIFACT_TYPES } from '../src/core/artifacts';

/**
 * Reviewer mode (Phase 9, M47 · P9-2).
 *
 * The acceptance clause is a *precision* number — "≥60% TP at ≤1 FP per 10 findings" —
 * and the rate itself needs the model tier to measure. What is asserted here is
 * everything that decides whether that rate is achievable: which findings survive
 * parsing, which are confident enough to offer a button for, and that the reviewer
 * cannot edit anything.
 *
 * The parser's *drops* get the most attention, and that is the right emphasis. An
 * automated reviewer fails by producing twelve findings of which two matter, and the
 * three mechanisms that stop it are all here.
 */

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
    id: 'r-1', file: 'src/a.ts', line: 10, severity: 'high', category: 'correctness',
    summary: 'Off-by-one in the slice bound', confidence: 0.9,
    failureScenario: 'With size=10 and index=1, page 1 returns item 10 twice.',
    ...over,
});

describe('read-only is structural, not requested', () => {
    it('the reviewer allowlist contains no write or exec tool', () => {
        for (const forbidden of ['write_file', 'edit_file', 'run_command', 'run_tests',
            'edit_notebook_cell', 'apply_patch', 'mcp_call', 'spawn_subagent']) {
            expect(REVIEW_TOOLS, `${forbidden} must not be reachable from a review`).not.toContain(forbidden);
        }
    });

    it('run_command is absent even though a reviewer would want to run the tests', () => {
        // The diff is untrusted content (M56). A review that can run commands is a review
        // that can be talked into running one by the thing it is reading.
        expect(REVIEW_TOOLS).not.toContain('run_command');
        expect(REVIEW_TOOLS).toContain('read_file');
        expect(REVIEW_TOOLS).toContain('find_references');
    });

    it('a review runs confined, so widening the allowlist by accident is not enough', () => {
        expect(REVIEW_TIER).toBe('restricted');
    });

    it('review is a first-class artifact type, so the panel can filter to it', () => {
        expect(ARTIFACT_TYPES).toContain('review');
    });
});

describe('the prompt spends more words on what NOT to report', () => {
    const prompt = buildReviewPrompt({ diff: '--- a/x\n+++ b/x\n@@\n+const a = 1;' });

    it('names the low-value categories concretely rather than as a principle', () => {
        expect(prompt).toMatch(/naming, formatting, import order/);
        expect(prompt).toMatch(/consider adding a comment/);
        expect(prompt).toMatch(/already existed and this diff did not touch/);
    });

    it('requires a failure scenario and says what to do without one', () => {
        expect(prompt).toMatch(/MUST include a failure scenario/);
        expect(prompt).toMatch(/you do not have a finding — drop it/);
    });

    it('tells the model an empty result is legitimate', () => {
        // Without this a model produces something to justify having been asked, which is
        // the single largest source of false positives.
        expect(prompt).toMatch(/An empty array is a legitimate and common answer/);
    });

    it('carries the intent and any context files it was given', () => {
        const withContext = buildReviewPrompt({
            diff: 'd', intent: 'fix the pagination overlap',
            context: [{ path: 'src/pagination.ts', content: 'export function page() {}' }],
        });
        expect(withContext).toMatch(/fix the pagination overlap/);
        expect(withContext).toMatch(/--- src\/pagination\.ts ---/);
    });
});

describe('parsing: the drops are the product', () => {
    const json = (items: unknown[]) => JSON.stringify(items);

    it('keeps a finding with a real failure scenario', () => {
        const parsed = parseFindings(json([{
            file: 'src/a.ts', line: 4, severity: 'high', category: 'correctness',
            summary: 'Slice end is off by one', confidence: 0.9,
            failureScenario: 'With size=10, page 0 and page 1 both contain item index 10.',
        }]));
        expect(parsed).toHaveLength(1);
        expect(parsed[0].id).toBe('r-1');
    });

    it('drops a finding with no failure scenario', () => {
        expect(parseFindings(json([{ file: 'a.ts', summary: 'This looks wrong', confidence: 0.9 }]))).toEqual([]);
    });

    it('drops a scenario that merely restates the summary', () => {
        // "It is wrong because it is wrong" passes a required-field check and fails its
        // purpose, which is why the check is on content rather than presence.
        expect(parseFindings(json([{
            file: 'a.ts', summary: 'The condition is inverted',
            failureScenario: 'the condition is inverted!', confidence: 0.9,
        }]))).toEqual([]);
    });

    it('drops a scenario too short to be one', () => {
        expect(parseFindings(json([{
            file: 'a.ts', summary: 'Race condition', failureScenario: 'it races', confidence: 0.9,
        }]))).toEqual([]);
    });

    it('drops a finding with no file — it cannot be acted on', () => {
        expect(parseFindings(json([{
            summary: 'Something is wrong somewhere',
            failureScenario: 'Given any input at all, the result is incorrect.', confidence: 0.9,
        }]))).toEqual([]);
    });

    it('survives a fenced response with prose around it', () => {
        const response = 'I reviewed the diff and found one issue.\n\n```json\n'
            + json([{
                file: 'a.ts', line: 2, summary: 'Cached rejection',
                failureScenario: 'A failed load is stored, so every later call rejects forever.',
                confidence: 0.85, severity: 'high',
            }])
            + '\n```\n\nLet me know if you want the fix.';
        expect(parseFindings(response)).toHaveLength(1);
    });

    it('survives a {"findings": [...]} wrapper', () => {
        const response = JSON.stringify({ findings: [{
            file: 'a.ts', line: 2, summary: 'Cached rejection',
            failureScenario: 'A failed load is stored, so every later call rejects forever.',
            confidence: 0.85,
        }] });
        expect(parseFindings(response)).toHaveLength(1);
    });

    it('returns nothing for an unparseable response rather than guessing', () => {
        expect(parseFindings('I could not review this.')).toEqual([]);
        expect(parseFindings('')).toEqual([]);
    });

    it('defaults a missing confidence to the middle, never to a fixable one', () => {
        const parsed = parseFindings(json([{
            file: 'a.ts', line: 3, summary: 'Unclosed handle',
            failureScenario: 'The file descriptor leaks on every call after the first error.',
            suggestedFix: 'closeSync(fd);',
        }]));
        expect(parsed[0].confidence).toBe(0.5);
        // A model that did not vouch for its finding must not get a button.
        expect(offersFix(parsed[0])).toBe(false);
    });

    it('clamps a nonsense confidence into range', () => {
        const parsed = parseFindings(json([{
            file: 'a.ts', line: 3, summary: 'Leak', confidence: 47,
            failureScenario: 'The descriptor leaks on every call after the first error.',
        }]));
        expect(parsed[0].confidence).toBe(1);
    });
});

describe('ranking puts severity above confidence', () => {
    it('a 60%-confident high beats a 95%-confident low', () => {
        // The other order puts a confident nit at the top of every review, which is the
        // ranking that makes a reader stop at the third item.
        const ranked = rankFindings([
            finding({ id: 'a', severity: 'low', confidence: 0.95 }),
            finding({ id: 'b', severity: 'high', confidence: 0.6 }),
        ]);
        expect(ranked.map(f => f.id)).toEqual(['b', 'a']);
    });

    it('is stable for two findings of equal severity and confidence', () => {
        const ranked = rankFindings([
            finding({ id: 'a', file: 'src/z.ts', line: 2 }),
            finding({ id: 'b', file: 'src/a.ts', line: 9 }),
        ]);
        expect(ranked.map(f => f.file)).toEqual(['src/a.ts', 'src/z.ts']);
    });
});

describe('the fix offer is a much higher bar than confidence', () => {
    it('offers a fix for a confident, high-severity finding with replacement text', () => {
        expect(offersFix(finding({ confidence: 0.9, suggestedFix: 'return items.slice(start, start + size);' }))).toBe(true);
    });

    it('refuses without concrete replacement text', () => {
        // Generating one from the summary would be a second model call inventing an edit
        // for a defect nobody has confirmed exists.
        expect(offersFix(finding({ confidence: 0.99, suggestedFix: undefined }))).toBe(false);
    });

    it('refuses below 0.8 confidence', () => {
        expect(offersFix(finding({ confidence: 0.79, suggestedFix: 'x' }))).toBe(false);
    });

    it('refuses a low-severity finding however confident', () => {
        // A confident autofix for a nit is a diff in the user's tree they did not ask for.
        expect(offersFix(finding({ severity: 'low', confidence: 1, suggestedFix: 'x' }))).toBe(false);
    });

    it('refuses when there is no line to apply it to', () => {
        expect(offersFix(finding({ line: 0, confidence: 0.95, suggestedFix: 'x' }))).toBe(false);
    });
});

describe('the artifact is written for a human with no panel open', () => {
    it('leads each finding with the failure, not the summary', () => {
        const rendered = renderReviewArtifact([finding({ suggestedFix: 'slice(start, start + size)' })]);
        expect(rendered).toMatch(/\*\*Fails when:\*\* With size=10/);
        expect(rendered).toMatch(/src\/a\.ts:10/);
    });

    it('distinguishes a fix that is offered from one that is only shown', () => {
        const offered = renderReviewArtifact([finding({ confidence: 0.9, suggestedFix: 'x' })]);
        expect(offered).toMatch(/offered as a checkpointed one-click change/);
        const shown = renderReviewArtifact([finding({ confidence: 0.6, suggestedFix: 'x' })]);
        expect(shown).toMatch(/shown only — not offered/);
    });

    it('says "no findings" plainly, and does not claim the change is correct', () => {
        const rendered = renderReviewArtifact([]);
        expect(rendered).toMatch(/\*\*No findings\.\*\*/);
        expect(rendered).toMatch(/not a guarantee the change is correct/);
    });

    it('summarises by severity and fixability', () => {
        const summary = summariseReview([
            finding({ severity: 'high', confidence: 0.9, suggestedFix: 'x' }),
            finding({ severity: 'low', confidence: 0.9, file: 'src/b.ts' }),
        ]);
        expect(summary).toMatchObject({ total: 2, high: 1, low: 1, fixable: 1, files: 2 });
    });
});

// ─── The runner ─────────────────────────────────────────────────────────────

const fakeStore = () => {
    const saved: { type: string; content: string }[] = [];
    return {
        saved,
        store: {
            save: (runId: string, type: string, title: string, content: string) => {
                saved.push({ type, content });
                return { id: 'a1', runId, type, title, path: `/tmp/${title}.md`, createdAt: 1 };
            },
        } as any,
    };
};

describe('runReview writes an artifact on every path that reaches the model', () => {
    it('writes one when findings are produced', async () => {
        const { saved, store } = fakeStore();
        const outcome = await runReview({
            runId: 'r1', diff: '--- a/x\n+++ b/x\n@@\n+bad', changedFiles: ['x'], artifacts: store,
            complete: async () => JSON.stringify([{
                file: 'x', line: 1, severity: 'high', confidence: 0.9, summary: 'Bad',
                failureScenario: 'Given any call at all, this returns the wrong value.',
            }]),
        });
        expect(outcome.findings).toHaveLength(1);
        expect(saved[0].type).toBe('review');
    });

    it('writes one when nothing was found — a clean review is a result', async () => {
        const { saved, store } = fakeStore();
        const outcome = await runReview({
            runId: 'r1', diff: 'd', changedFiles: ['x'], artifacts: store,
            complete: async () => '[]',
        });
        expect(outcome.findings).toEqual([]);
        expect(saved[0].content).toMatch(/No findings/);
    });

    it('records a FAILED review as failed, never as clean', async () => {
        /*
         * The most expensive possible bug in this feature. "The reviewer found nothing"
         * and "the reviewer did not run" produce the same green tick and lead to opposite
         * decisions about whether a human reads the diff.
         */
        const { saved, store } = fakeStore();
        const outcome = await runReview({
            runId: 'r1', diff: 'd', changedFiles: ['x'], artifacts: store,
            complete: async () => { throw new Error('429 rate limited'); },
        });
        expect(outcome.skipped).toMatch(/429/);
        expect(saved[0].content).toMatch(/did not complete/);
        expect(saved[0].content).toMatch(/This is not a clean review/);
        expect(saved[0].content).not.toMatch(/No findings/);
    });

    it('an empty diff produces a message, not an artifact', async () => {
        const { saved, store } = fakeStore();
        const outcome = await runReview({
            runId: 'r1', diff: '   ', changedFiles: [], artifacts: store, complete: async () => '[]',
        });
        expect(outcome.skipped).toMatch(/no uncommitted changes/);
        expect(saved).toHaveLength(0);
    });
});

describe('applying a fix', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-review-'));
    const fileFor = (content: string) => {
        const absolutePath = path.join(scratch, `f${Math.random().toString(36).slice(2)}.ts`);
        fs.writeFileSync(absolutePath, content, 'utf8');
        return {
            absolutePath,
            read: async () => fs.readFileSync(absolutePath, 'utf8'),
            write: async (updated: string) => fs.writeFileSync(absolutePath, updated, 'utf8'),
        };
    };
    const checkpoint = () => ({ snapshot: vi.fn() }) as any;

    it('snapshots BEFORE writing — the checkpoint is why the button exists', async () => {
        const file = fileFor('a\nWRONG\nc');
        const cp = checkpoint();
        const result = await applyFix(
            finding({ line: 2, confidence: 0.9, suggestedFix: 'RIGHT' }), file, cp);
        expect(result.applied).toBe(true);
        expect(cp.snapshot).toHaveBeenCalledWith(file.absolutePath);
        expect(await file.read()).toBe('a\nRIGHT\nc');
    });

    it('refuses a finding that does not qualify for a fix', async () => {
        const file = fileFor('a\nb');
        const result = await applyFix(finding({ confidence: 0.4, suggestedFix: 'x' }), file, checkpoint());
        expect(result.applied).toBe(false);
        expect(await file.read()).toBe('a\nb');
    });

    it('refuses when the file has shrunk since the review, rather than writing blind', async () => {
        // The user has had the time it took to read the review. Applying a remembered
        // edit to a file that has since changed is how an assistant corrupts work.
        const file = fileFor('only one line');
        const result = await applyFix(
            finding({ line: 40, confidence: 0.9, suggestedFix: 'x' }), file, checkpoint());
        expect(result.applied).toBe(false);
        expect(result.reason).toMatch(/has changed since the review/);
    });

    it('splices a multi-line fix as multiple lines, at the original indentation', async () => {
        const file = fileFor('function f() {\n        return bad;\n}');
        await applyFix(
            finding({ line: 2, confidence: 0.9, suggestedFix: 'if (x) {\n    return good;\n}' }),
            file, checkpoint());
        expect(await file.read()).toBe(
            'function f() {\n        if (x) {\n            return good;\n        }\n}');
    });
});

describe('reindent', () => {
    it('preserves relative structure while moving the block', () => {
        expect(reindent('if (x) {\n    a();\n}', '    ')).toEqual(['    if (x) {', '        a();', '    }']);
    });

    it('does not double an indent the model already applied', () => {
        expect(reindent('        a();', '    ')).toEqual(['    a();']);
    });

    it('leaves blank lines blank rather than filling them with whitespace', () => {
        expect(reindent('a();\n\nb();', '  ')).toEqual(['  a();', '', '  b();']);
    });
});
