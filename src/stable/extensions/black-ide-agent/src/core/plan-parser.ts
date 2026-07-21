// ─── features_plan.md task extraction ────────────────────────────────────────
// Moves dependency-aware scheduling from per-PHASE to per-TASK granularity (plan.md
// "Dependency Graph"). The Planner writes tasks as `- [ ] [design] do the thing` under
// phase headings; this turns that markdown into a schedulable graph.
//
// This informs ORDERING and parallelism only. Execution stays at phase granularity — one
// LLM call per phase, not per task — because a call per task would multiply run cost
// without improving the result.
//
// Pure: no fs, no vscode.

export interface PhaseGraphEntry { tag: string; dependsOn: string[] }
export type PhaseGraph = Record<string, PhaseGraphEntry>;

export interface PlanTask {
    /** Stable, unique id: `<phase>#<n>`. */
    id: string;
    /** The execution phase (a key of the phase graph) this task belongs to. */
    phase: string;
    /** The task text, with the checkbox and phase tag stripped. */
    text: string;
    /** Whether the plan has it checked off. */
    done: boolean;
    /** Ids of every task in this phase's prerequisite phases. */
    dependsOn: string[];
}

/** `- [ ] text`, `* [x] text`, `- [X] text` — the checkbox syntax the Planner is told to emit. */
const CHECKBOX = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/;

/**
 * Extract the plan's tasks with cross-phase dependency edges.
 *
 * A task's phase comes from an inline `[tag]` when present, else from the most recent
 * phase heading — real Planner output frequently tags only the heading ("Phase 1: Design
 * [design] tasks") and leaves the individual tasks untagged, and dropping those would
 * silently lose most of the plan.
 *
 * Each task depends on ALL tasks in its phase's prerequisite phases, which is what makes
 * a wave boundary meaningful: no frontend task may start until every design and backend
 * task is done.
 */
export function parsePlanTasks(planContent: string, phaseGraph: PhaseGraph): PlanTask[] {
    const tagToPhase = new Map<string, string>();
    for (const [phase, v] of Object.entries(phaseGraph)) tagToPhase.set(v.tag.toLowerCase(), phase);

    const findTag = (line: string): string | undefined => {
        for (const m of line.toLowerCase().matchAll(/\[[a-z-]+\]/g)) {
            const phase = tagToPhase.get(m[0]);
            if (phase) return phase;
        }
        return undefined;
    };

    const tasks: PlanTask[] = [];
    const counters = new Map<string, number>();
    let currentPhase: string | undefined;

    for (const rawLine of (planContent || '').split('\n')) {
        const box = CHECKBOX.exec(rawLine);
        if (!box) {
            // Not a task line — it may be a phase heading that scopes the tasks below it.
            const heading = findTag(rawLine);
            if (heading) currentPhase = heading;
            continue;
        }
        const done = box[1].toLowerCase() === 'x';
        const body = box[2];
        const phase = findTag(body) ?? currentPhase;
        if (!phase) continue; // an untagged task with no enclosing phase is unschedulable

        // Strip the phase tag from the text so the task reads cleanly in artifacts.
        const text = body.replace(new RegExp(escapeRegExp(phaseGraph[phase].tag), 'ig'), '').replace(/\s+/g, ' ').trim();
        const n = (counters.get(phase) || 0) + 1;
        counters.set(phase, n);
        tasks.push({ id: `${phase}#${n}`, phase, text, done, dependsOn: [] });
    }

    // Second pass: a task depends on every task in each prerequisite phase. Done as a
    // second pass because a prerequisite phase's tasks may appear after it in the file.
    const byPhase = new Map<string, PlanTask[]>();
    for (const t of tasks) {
        const list = byPhase.get(t.phase) || [];
        list.push(t);
        byPhase.set(t.phase, list);
    }
    for (const t of tasks) {
        for (const prereqPhase of phaseGraph[t.phase].dependsOn) {
            for (const p of byPhase.get(prereqPhase) || []) t.dependsOn.push(p.id);
        }
    }
    return tasks;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
