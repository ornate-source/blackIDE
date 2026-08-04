import * as path from 'path';
import * as fs from 'fs';
import { STACK_MINDMAP_HEADING } from './project-profiler';

// ─── Mindmap read-back (Phase 8, M46) ───────────────────────────────────────
//
// C7 has read "sectioned upsert of detected stack shipped; **read-back is still thin**"
// since plan.md's Phase 5. The write half works: every pipeline run syncs the detected
// stack into `project_mindmap.md`. Nothing has ever read it back, so the file is a
// write-only log — the agent recomputes what it already wrote down, and any *convention*
// a human added to that file is invisible to every run.
//
// That last part is the reason this milestone is P1 rather than a nicety. The mindmap is
// where a team writes "we use the repository pattern for data access, not the ORM
// directly" — exactly the kind of instruction the skills framework cannot infer from
// manifests, and exactly what a user assumes an agent has read when it is sitting in a file
// the agent itself maintains.

export const MINDMAP_RELATIVE_PATH = path.join('.blackIDE', 'mindmap', 'project_mindmap.md');

export interface MindmapContext {
    /** The `## Project Stack & Conventions` section, if present. */
    stack?: string;
    /** Other `##` sections a human wrote, keyed by heading. */
    sections: Record<string, string>;
    /** True when the file exists but holds nothing beyond scaffolding. */
    empty: boolean;
}

/**
 * Split the mindmap into sections.
 *
 * `##`-level only. Deeper headings stay inside their parent section because they are
 * structure *within* a topic, and splitting on them would turn one coherent convention into
 * four fragments the budget then truncates independently.
 */
export function parseMindmap(content: string): MindmapContext {
    const text = String(content || '');
    const sections: Record<string, string> = {};

    const lines = text.split('\n');
    let heading: string | undefined;
    let buffer: string[] = [];

    const flush = () => {
        if (heading === undefined) return;
        const body = buffer.join('\n').trim();
        if (body) sections[heading] = body;
        buffer = [];
    };

    for (const line of lines) {
        const match = line.match(/^##\s+(.+?)\s*$/);
        if (match) {
            flush();
            heading = match[1];
            continue;
        }
        if (heading !== undefined) buffer.push(line);
    }
    flush();

    const stack = sections[STACK_MINDMAP_HEADING];
    return {
        stack,
        sections,
        empty: Object.keys(sections).length === 0,
    };
}

/** Read the mindmap for a root. Absent or unreadable is an empty context, never an error. */
export function readMindmap(rootPath: string): MindmapContext {
    try {
        return parseMindmap(fs.readFileSync(path.join(rootPath, MINDMAP_RELATIVE_PATH), 'utf8'));
    } catch {
        return { sections: {}, empty: true };
    }
}

/**
 * Render the mindmap into the prompt.
 *
 * The stack section is rendered **first and separately**, because it is the one the
 * profiler also computes: putting it at the top lets a model reconcile the two, and burying
 * it among a team's prose would make an agreement between them look like a coincidence.
 *
 * Auto-sync sections are excluded. `PipelineOrchestrator` appends a per-run "Auto-Sync"
 * block listing files each phase touched; that is a log of what this tool did, not
 * knowledge about the project, and feeding it back would spend the budget re-reading the
 * agent's own history — the exact loop `readContext` already avoids for the ADR log.
 */
export function renderMindmapContext(context: MindmapContext, maxChars = 1_500): string {
    const parts: string[] = [];

    if (context.stack) {
        parts.push(`## ${STACK_MINDMAP_HEADING}\n${context.stack}`);
    }

    for (const [heading, body] of Object.entries(context.sections)) {
        if (heading === STACK_MINDMAP_HEADING) continue;
        if (isAutoSync(heading)) continue;
        parts.push(`## ${heading}\n${body}`);
    }

    if (!parts.length) return '';

    // Budgeted per section rather than by slicing the join, for the reason
    // `KnowledgeBase.readContext` documents: slicing the concatenation spends the whole
    // allowance on whichever section happens to come first.
    const out: string[] = [];
    let used = 0;
    for (const part of parts) {
        if (used + part.length > maxChars) {
            const remaining = maxChars - used;
            if (remaining > 120) out.push(`${part.slice(0, remaining - 14)}\n…(truncated)`);
            break;
        }
        out.push(part);
        used += part.length + 2;
    }
    return out.join('\n\n');
}

export function isAutoSync(heading: string): boolean {
    return /auto[- ]?sync/i.test(heading);
}

/** One line for the run log, so "did it read the mindmap" is answerable. */
export function describeMindmap(context: MindmapContext): string {
    if (context.empty) return 'no project mindmap yet';
    const named = Object.keys(context.sections).filter(h => !isAutoSync(h));
    return `mindmap: ${named.length} section${named.length === 1 ? '' : 's'}${context.stack ? ' (incl. detected stack)' : ''}`;
}
