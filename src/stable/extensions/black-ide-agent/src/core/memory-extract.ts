import { ExtractionCandidate, isWorthRemembering } from '@blackide/agent-core/core/memory-lifecycle';
import { MEMORY_TYPES, MemoryType } from '@blackide/agent-core/core/memory-model';

// ─── End-of-turn extraction: the producer (Phase 8, M41 · P8-1) ─────────────
//
// `sortCandidates` has banded and filtered candidates since Phase 8 shipped, and nothing
// ever produced any. This is the missing half: a model call at the end of a turn that
// reads the turn and proposes facts worth carrying forward.
//
// ── Why a separate call rather than a tool the agent can invoke ──────────────
// `remember` already exists as a tool, and it covers the case where the *agent* notices
// something. It does not cover the case this milestone is for: the user states a
// constraint in passing, the agent uses it correctly for the rest of the turn, and then
// the turn ends and it is gone. An agent mid-task is optimising for finishing the task;
// asking it to also notice durable facts competes for the same attention and reliably
// loses. A separate pass over a finished transcript has one job.
//
// ── Why the producer is deliberately generous and the filter is strict ───────
// The split of responsibility here is the design. This prompt asks for candidates *with
// calibrated confidence*; `sortCandidates` decides what is written, what is confirmed
// and what is dropped, and `isWorthRemembering` refuses the three shapes that are never
// useful. Putting the strictness in the producer would mean tuning it by editing a
// prompt — untestable, unversioned, and different for every provider. The strictness
// lives in code that a unit test can pin, which is why P8-1's *accuracy* clause is the
// only part of it that needed the model tier.
//
// ── Everything here is pure ─────────────────────────────────────────────────
// `buildExtractionPrompt` and `parseExtractionResponse` are the whole module. The call
// itself belongs to the lane that owns the turn, so the same two functions serve the
// chat lane, the task lane and `eval/model-tier.js` without any of them importing a
// model client.

/** Cap on what is sent. An extraction pass must never cost more than the turn did. */
export const MAX_TRANSCRIPT_CHARS = 12_000;

/**
 * Trim a transcript to the budget, keeping the **end**.
 *
 * The end, not the beginning, and not a summary. Durable facts arrive as corrections and
 * asides — "actually we deploy with Terraform", "staging is read-only" — and a correction
 * is by definition later than the thing it corrects. Keeping the head would preserve the
 * original request, which is precisely the content `isWorthRemembering` then throws away
 * as a task restatement.
 */
export function trimTranscript(transcript: string, maxChars = MAX_TRANSCRIPT_CHARS): string {
    const text = String(transcript || '');
    if (text.length <= maxChars) return text;
    const tail = text.slice(text.length - maxChars);
    // Start at a line boundary so the first line handed to the model is not half a
    // sentence the model then treats as a fact about the project.
    const firstBreak = tail.indexOf('\n');
    const clipped = firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail;
    return `[earlier turns omitted]\n${clipped}`;
}

export interface ExtractionContext {
    /** Facts already stored, so the model does not re-propose them every turn. */
    known?: string[];
    /** Run or conversation id, recorded as provenance on anything written. */
    runId?: string;
}

const TYPE_GUIDE = [
    '- preference:  how this user wants things done ("prefers named exports")',
    '- convention:  how this codebase does things ("migrations live in db/migrate")',
    '- fact:        something true about the project ("the staging DB is read-only")',
    '- decision:    a choice made, and why ("chose Terraform over CDK for parity with ops")',
    '- constraint:  something that must not change ("the audit log is append-only")',
].join('\n');

/**
 * The extraction prompt.
 *
 * The negative instructions carry most of the value and are written as *examples of the
 * exact wrong output* rather than as principles. "Do not extract narration" is advice a
 * model agrees with and then ignores; "do not output `The user asked me to fix the
 * failing test`" is a pattern it can match against what it is about to write.
 *
 * Confidence is defined against what the store does with it, not as a vague 0–1 feeling.
 * A model told "0.9 means this is written to a file the user will read without being
 * asked" calibrates differently from one told "rate your confidence", and the bands are
 * the thing being calibrated to.
 */
export function buildExtractionPrompt(transcript: string, context: ExtractionContext = {}): string {
    const known = (context.known || []).slice(0, 40);
    return [
        'Read the finished conversation below and extract facts worth remembering for FUTURE,',
        'unrelated sessions on this project.',
        '',
        'Output JSON only — an array, possibly empty:',
        '[{"text": "...", "type": "...", "confidence": 0.0, "because": "..."}]',
        '',
        'Types:',
        TYPE_GUIDE,
        '',
        'Confidence is not a feeling — it decides what happens to the fact:',
        '  >= 0.8  written to the project memory file immediately, without asking',
        '  >= 0.5  queued for the user to confirm with one click',
        '  < 0.5   discarded',
        'Use >= 0.8 only for something the user stated plainly as true. Use 0.5-0.79 when you',
        'inferred it from what was done rather than from what was said.',
        '',
        'Do NOT extract, no matter how central they were to this conversation:',
        '  - what the user asked for in this session ("The user asked me to fix the failing test")',
        '  - anything you did ("I updated the workflow file", "Let me check the logs")',
        '  - questions, acknowledgements, or restatements of the task',
        '  - facts that are already known (listed below)',
        '  - anything you would have to guess at',
        '',
        'An empty array is the correct and common answer. Most conversations teach nothing',
        'durable, and a memory file full of session narration is worse than an empty one.',
        '',
        known.length ? `Already known — do not repeat these:\n${known.map(k => `  - ${k}`).join('\n')}` : 'Nothing is known yet.',
        '',
        '--- conversation ---',
        trimTranscript(transcript),
        '--- end ---',
        '',
        'JSON array:',
    ].join('\n');
}

/**
 * Parse the model's answer into candidates.
 *
 * Tolerant of the three wrappers every provider adds — a fenced block, a leading
 * sentence, a `{"memories": [...]}` object — and completely intolerant of anything it
 * cannot understand: an unparseable response yields `[]`, never a partial guess. This
 * feature writes to a file in the user's repository, and the cost of misreading a
 * malformed response is a wrong fact asserted with a confidence the model never gave it.
 *
 * The content filter runs here as well as in `sortCandidates`, and the duplication is
 * deliberate: `parseExtractionResponse` is also what `eval/model-tier.js` measures, so a
 * prompt regression that starts emitting narration must show up as a *score* drop rather
 * than being silently cleaned up by a downstream stage the eval does not run.
 */
export function parseExtractionResponse(response: string): ExtractionCandidate[] {
    const parsed = parseJsonArray(response);
    if (!parsed) return [];

    const out: ExtractionCandidate[] = [];
    for (const raw of parsed) {
        if (!raw || typeof raw !== 'object') continue;
        const text = String((raw as any).text ?? '').trim();
        if (!text || !isWorthRemembering(text)) continue;

        const type = MEMORY_TYPES.includes((raw as any).type) ? (raw as any).type as MemoryType : 'fact';
        // A missing or non-numeric confidence becomes 0.5 — the bottom of the confirm
        // band. Defaulting high would auto-write a fact the model never vouched for;
        // defaulting to a drop would silently lose every candidate from a provider whose
        // JSON omits the field.
        const value = Number((raw as any).confidence);
        const confidence = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
        const because = typeof (raw as any).because === 'string' ? (raw as any).because.slice(0, 200) : undefined;

        out.push({ text, type, confidence, because });
    }
    return out;
}

/**
 * Find the JSON array in a response that may be wrapped in prose or a fence.
 *
 * Scans for a balanced `[...]` rather than taking the first `[` and last `]`. The greedy
 * version breaks on the single most likely response shape — an explanatory sentence that
 * itself contains a bracket, or two arrays where the model showed its working — by
 * splicing unrelated text into what it hands `JSON.parse`.
 */
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
        // `{"memories": [...]}` — the commonest deviation from the requested shape.
        if (value && typeof value === 'object') {
            for (const inner of Object.values(value)) {
                if (Array.isArray(inner)) return inner;
            }
        }
    } catch { /* not JSON at this offset */ }
    return undefined;
}

/** Index of the `]` closing the `[` at `start`, ignoring brackets inside strings. */
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

/**
 * Is this turn worth spending an extraction call on?
 *
 * Called before the model, so the common case costs nothing. A two-message exchange has
 * nowhere to hide a durable fact, and running extraction on every trivial turn is how a
 * background feature becomes the thing that doubled everyone's bill.
 */
export function worthExtracting(transcript: string, messageCount: number): boolean {
    if (messageCount < 2) return false;
    return String(transcript || '').trim().length >= 200;
}

/** Render a transcript for extraction from the message list a lane already holds. */
export function transcriptFrom(
    messages: { role: string; content?: string }[],
    maxChars = MAX_TRANSCRIPT_CHARS,
): string {
    const lines: string[] = [];
    for (const message of messages || []) {
        const content = String(message?.content ?? '').trim();
        if (!content) continue;
        // Tool results are the bulk of a transcript and the least likely place a durable
        // fact appears — they are output, not statement. Excluding them is what makes the
        // 12k budget enough for the messages that matter.
        if (message.role === 'tool') continue;
        const who = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role;
        lines.push(`${who}: ${content}`);
    }
    return trimTranscript(lines.join('\n'), maxChars);
}
