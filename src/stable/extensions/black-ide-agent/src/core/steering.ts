import { ChatMessage } from './types';

// ─── Mid-run steering (Phase 7, M39) ────────────────────────────────────────
//
// A9 has read "we can only cancel + rerun" since rev 1. Cancelling a run to correct it
// throws away every file it read and every conclusion it reached, so the cheapest possible
// correction — "no, use the existing helper" — costs the same as starting over. This is the
// path that makes a correction cost one turn.
//
// A steering note is a comment the user leaves (on an artifact region, or free-form) while
// the agent is running. It is queued, and the loop drains it into the *next* turn.
//
// ── The invariant this module exists to protect ──────────────────────────────
// The message list mid-run is not a transcript, it is a protocol. Two rules govern where a
// steering note may land, and breaking either produces a hard provider rejection rather
// than a degraded answer:
//
//   1. **Never between a `tool_use` and its `tool_result`.** The assistant's turn requested
//      three tools; the next user message carries their results. Anything inserted between
//      those two is an unanswered tool call, which Anthropic and OpenAI both reject outright.
//   2. **Never two user messages in a row.** Anthropic requires alternating roles. Appending
//      a steering message straight after the tool-results message breaks that — which is the
//      same trap `ContextManager.withSummary` documents and solves the same way: fold the
//      text into the existing message rather than adding a new one.
//
// Both are handled in `applySteering`, which is pure, so the rules are testable without a
// provider — the only place they can be tested at all, since the failure is a 400 from
// somebody else's API.

export interface SteeringNote {
    id: string;
    text: string;
    at: number;
    /** The artifact this comment was left on, when it came from the review panel. */
    artifactPath?: string;
    /** The quoted region the comment refers to, so the agent knows what "this" means. */
    region?: string;
}

/**
 * Notes waiting to reach the agent.
 *
 * A queue rather than a single slot: a user reading a plan leaves three comments in fifteen
 * seconds, and a slot would silently keep only the last one — the two dropped comments
 * being the ones they will assume were understood.
 */
export class SteeringQueue {
    private notes: SteeringNote[] = [];
    private sequence = 0;

    add(text: string, options: { artifactPath?: string; region?: string; at?: number } = {}): SteeringNote | undefined {
        const trimmed = String(text || '').trim();
        if (!trimmed) return undefined;
        const note: SteeringNote = {
            id: `steer_${++this.sequence}`,
            text: trimmed,
            at: options.at ?? Date.now(),
            artifactPath: options.artifactPath,
            region: options.region,
        };
        this.notes.push(note);
        return note;
    }

    get pending(): number { return this.notes.length; }
    peek(): SteeringNote[] { return [...this.notes]; }

    /** Take everything and clear. Drained once per turn by the loop. */
    drain(): SteeringNote[] {
        const taken = this.notes;
        this.notes = [];
        return taken;
    }

    /**
     * Put back a note the loop could not inject this turn.
     *
     * Unshifted rather than pushed, so a deferred correction stays ahead of one the user
     * typed while it was waiting — otherwise a note held back for one turn silently becomes
     * the *last* instruction the agent reads, reversing the order the user wrote them in.
     */
    requeue(note: SteeringNote): void {
        this.notes.unshift(note);
    }

    clear(): void { this.notes = []; }
}

/**
 * Render notes as the text the model reads.
 *
 * Marked as coming from the user *now*, and phrased as an instruction that outranks the
 * plan, because the whole point is that it arrived after the agent decided what to do. A
 * note rendered as ordinary context gets weighed against the original task and frequently
 * loses — which looks exactly like steering not working.
 */
export function renderSteering(notes: SteeringNote[]): string {
    if (!notes.length) return '';
    const lines: string[] = [
        notes.length === 1
            ? '[The user is watching this run and has just sent a correction. Apply it to what you do next, before continuing with the original plan.]'
            : `[The user is watching this run and has just sent ${notes.length} corrections. Apply them to what you do next, before continuing with the original plan.]`,
    ];
    for (const note of notes) {
        if (note.artifactPath) {
            const where = note.region ? `${note.artifactPath}, on:\n> ${note.region.replace(/\n/g, '\n> ')}` : note.artifactPath;
            lines.push(`\nOn ${where}\n${note.text}`);
        } else {
            lines.push(`\n${note.text}`);
        }
    }
    return lines.join('\n');
}

/**
 * Fold steering notes into a conversation, safely.
 *
 * Returns a **new** array; the caller's list is not mutated, so a failed turn cannot leave
 * half-applied steering behind.
 *
 * Where the text lands is the whole of this function:
 *   - Nothing pending, or an empty conversation → unchanged.
 *   - The last message is a `user` turn (which, mid-run, is the tool-results message) →
 *     the text is appended to *its* content. This keeps the results attached to their call
 *     and keeps roles alternating.
 *   - The last message is an `assistant` turn **with unanswered tool calls** → the notes
 *     are held back. Injecting here is rule 1's violation, and the correct behaviour is to
 *     wait one turn rather than to break the run to be prompt.
 *   - Otherwise → a new user message.
 */
export function applySteering(
    messages: ChatMessage[],
    notes: SteeringNote[],
): { messages: ChatMessage[]; applied: SteeringNote[]; deferred: SteeringNote[] } {
    if (!notes.length || !messages.length) {
        return { messages, applied: [], deferred: notes.length ? [...notes] : [] };
    }

    const last = messages[messages.length - 1];

    if (last.role === 'assistant' && (last.toolCalls?.length ?? 0) > 0) {
        // Rule 1. The results for these calls have not arrived; anything inserted here is
        // an unanswered tool_use, and the provider rejects the whole request.
        return { messages, applied: [], deferred: [...notes] };
    }

    const text = renderSteering(notes);
    const next = [...messages];

    if (last.role === 'user') {
        // Rule 2. Fold into the existing user turn rather than adding a second one.
        next[next.length - 1] = {
            ...last,
            content: last.content ? `${last.content}\n\n${text}` : text,
        };
    } else {
        next.push({ role: 'user', content: text });
    }

    return { messages: next, applied: [...notes], deferred: [] };
}

/** One line for the run log and the audit trail (Phase 9). */
export function describeSteering(note: SteeringNote): string {
    const where = note.artifactPath ? ` on ${note.artifactPath}` : '';
    const flat = note.text.replace(/\s+/g, ' ').trim();
    return `steering${where}: ${flat.length > 120 ? `${flat.slice(0, 119)}…` : flat}`;
}
