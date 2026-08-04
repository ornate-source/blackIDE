/*
 * Model-tier tasks (X-1).
 *
 * These are the only measurements in the harness that cost money, and there are
 * deliberately few of them. Each one exists because a specific roadmap gate clause is
 * phrased as a rate that no deterministic tier can produce:
 *
 *   `lspOverGrep`     → P1-1: "symbol questions resolve through the language server
 *                       rather than a text search", measured rather than asserted.
 *   `memoryExtraction`→ P8-1's accuracy clause: does end-of-turn extraction find the
 *                       facts a turn contained without extracting its narration?
 *   `reviewFindings`  → P9-2's "≥60% TP at ≤1 FP per 10 findings".
 *
 * ── Why the tasks are small ──────────────────────────────────────────────────
 * Every task is one turn with one decision in it. A multi-turn agent run would measure
 * a dozen things at once and attribute the result to whichever one changed last, and it
 * would cost fifty times as much per data point — which matters when the run has a
 * budget cap and N-run variance means each task is paid for N times.
 *
 * ── `planted` is written from the defect, not from the diff ──────────────────
 * The review fixtures name their defects by a stable id rather than a line number.
 * Line numbers move when the fixture is edited, and a scoring key that silently
 * decays into "nothing matches" reports a reviewer regression that never happened.
 */

// ── P1-1 · Does a symbol question reach for the language server? ────────────
//
// Each prompt is a question about a *symbol* — its definition, its callers, its type —
// which is the class the LSP answers exactly and grep answers approximately. Questions
// grep genuinely answers better ("where is the string 'checkout failed'") are excluded
// on purpose: the gate is about tool choice on the cases where the choice matters.
const lspTasks = [
    {
        id: 'lsp-definition', family: 'lspOverGrep',
        prompt: 'Where is `reserveStock` defined? Look it up, do not guess.',
    },
    {
        id: 'lsp-references', family: 'lspOverGrep',
        prompt: 'Which call sites use `convertMinor`? I need all of them before I change its signature.',
    },
    {
        id: 'lsp-rename-impact', family: 'lspOverGrep',
        prompt: 'I want to rename the `OrderTotal` type. Find everything that would need to change.',
    },
    {
        id: 'lsp-symbol-lookup', family: 'lspOverGrep',
        prompt: 'Is there a class called `CheckoutService` anywhere in this workspace?',
    },
    {
        id: 'lsp-signature', family: 'lspOverGrep',
        prompt: 'What type does `maskEmail` return?',
    },
    {
        id: 'lsp-implementers', family: 'lspOverGrep',
        prompt: 'What implements the `PaymentGateway` interface?',
    },
];

// ── P8-1 · Does end-of-turn extraction find facts and refuse narration? ──────
//
// `forbidden` is the half that carries the weight. An extractor that emits everything
// scores perfectly on `expected` and is useless: memory that fills with "the user asked
// me to fix the failing test" is memory nobody reads twice. `sortCandidates` already
// bands and filters what arrives; this measures what arrives.
const extractionTasks = [
    {
        id: 'extract-tooling', family: 'memoryExtraction',
        transcript: [
            'User: the build is failing on CI again',
            'Assistant: I will look at the workflow.',
            'User: fyi we deploy with Terraform, not CDK — the CDK app in infra/ is dead code nobody deleted',
            'Assistant: Understood. I have fixed the workflow; the failing step was the Node version.',
        ].join('\n'),
        expected: ['deploy with Terraform', 'the CDK app in infra/ is dead code'],
        forbidden: ['the build is failing on CI', 'I have fixed the workflow'],
    },
    {
        id: 'extract-preference', family: 'memoryExtraction',
        transcript: [
            'User: rewrite this to use async/await',
            'Assistant: Done.',
            'User: also, always run `make check` rather than npm test here — npm test skips the integration tier',
            'Assistant: Noted, I will use make check.',
        ].join('\n'),
        expected: ['run make check rather than npm test', 'npm test skips the integration tier'],
        forbidden: ['rewrite this to use async/await', 'Noted, I will use make check'],
    },
    {
        id: 'extract-nothing-to-learn', family: 'memoryExtraction',
        transcript: [
            'User: what does this function do?',
            'Assistant: It converts a minor-unit amount to a decimal string.',
            'User: thanks',
        ].join('\n'),
        // A turn with no durable fact in it must produce nothing. This is the case an
        // eager extractor fails, and the one that decides whether memory stays readable.
        expected: [],
        forbidden: ['what does this function do', 'converts a minor-unit amount', 'thanks'],
    },
    {
        id: 'extract-constraint', family: 'memoryExtraction',
        transcript: [
            'User: can you point the tests at the staging database?',
            'Assistant: I can, but I want to check first — is it writable?',
            'User: no, staging is read-only for us, the DBA team owns writes. use the docker fixture instead',
            'Assistant: Switching to the docker fixture.',
        ].join('\n'),
        expected: ['staging is read-only', 'the DBA team owns writes'],
        forbidden: ['point the tests at the staging database', 'Switching to the docker fixture'],
    },
];

// ── P9-2 · Is the Reviewer worth reading? ───────────────────────────────────
//
// Each fixture is a small diff with defects planted at known ids, mixed with changes
// that are merely *stylistically* arguable — an unused import, a long line, a name one
// could bikeshed. Those are the false-positive bait: a reviewer that reports them is
// producing findings a developer learns to skip, which is the failure mode the ≤1-in-10
// clause exists to price.
const reviewTasks = [
    {
        id: 'review-offbyone', family: 'reviewFindings',
        diff: [
            '--- a/src/pagination.ts',
            '+++ b/src/pagination.ts',
            '@@',
            '+import { unused } from "./helpers";            // [n1]',
            '+export function page<T>(items: T[], size: number, index: number): T[] {',
            '+    const start = index * size;                 ',
            '+    return items.slice(start, start + size + 1); // [d1]',
            '+}',
            '+export function totalPages(count: number, size: number): number {',
            '+    return Math.floor(count / size);            // [d2]',
            '+}',
        ].join('\n'),
        planted: ['d1', 'd2'],
        // d1: slice end is off by one, so pages overlap by an item.
        // d2: floor truncates the final partial page out of existence.
        // n1: an unused import — real, trivial, and not what a reviewer is for.
    },
    {
        id: 'review-async', family: 'reviewFindings',
        diff: [
            '--- a/src/cache.ts',
            '+++ b/src/cache.ts',
            '@@',
            '+export class Cache {',
            '+    private entries = new Map<string, Promise<string>>();',
            '+    async get(key: string, load: () => Promise<string>): Promise<string> {',
            '+        if (this.entries.has(key)) return this.entries.get(key)!;   ',
            '+        const pending = load();                                     ',
            '+        this.entries.set(key, pending);                             ',
            '+        return pending;                          // [d3] a rejected load is cached forever',
            '+    }',
            '+    clear(): void { this.entries = new Map(); }  // [n2] could reuse .clear()',
            '+}',
        ].join('\n'),
        planted: ['d3'],
    },
    {
        id: 'review-guard', family: 'reviewFindings',
        diff: [
            '--- a/src/read.ts',
            '+++ b/src/read.ts',
            '@@',
            '+export async function readUserFile(root: string, relative: string): Promise<string> {',
            '+    const target = path.join(root, relative);   // [d4] no traversal guard',
            '+    return fs.promises.readFile(target, "utf8");',
            '+}',
            '+export function isTextFile(name: string): boolean {',
            '+    return [".txt", ".md", ".json"].includes(path.extname(name)); // [n3] case-sensitive',
            '+}',
        ].join('\n'),
        planted: ['d4'],
    },
];

module.exports = [...lspTasks, ...extractionTasks, ...reviewTasks];
