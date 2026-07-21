// ─── Dependency-Aware Task Scheduler ─────────────────────────────────────────
// The `plan.md` "Dependency Graph" + "Priority Engine": order work by prerequisite,
// not just by phase tag. Pure and vscode-free so the ordering logic is fully unit-
// testable independently of the pipeline that consumes it.

export interface SchedulableTask {
    id: string;
    /** ids this task depends on (must run first). Unknown ids are ignored (treated as satisfied). */
    dependsOn?: string[];
    /** Higher runs earlier among tasks that are otherwise ready. Default 0. */
    priority?: number;
}

export interface ScheduleResult<T extends SchedulableTask> {
    /** Topologically ordered tasks (dependencies before dependents). */
    order: T[];
    /** Task ids that could not be scheduled because they sit on a dependency cycle. */
    cyclic: string[];
}

/**
 * Deterministic topological order over a task graph, with a stable tie-break: among tasks
 * whose dependencies are all satisfied, higher `priority` first, then original input order.
 * Tasks on a cycle are reported in `cyclic` rather than silently dropped or infinite-looped
 * — the caller decides whether to surface an error or fall back to input order.
 *
 * Kahn's algorithm. Pure — no I/O, no throw on cycles.
 */
export function scheduleTasks<T extends SchedulableTask>(tasks: T[]): ScheduleResult<T> {
    const byId = new Map<string, T>();
    for (const t of tasks) byId.set(t.id, t);

    // Indegree = number of *known* dependencies still unscheduled. Unknown deps are
    // treated as already satisfied (they're not part of this graph).
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // depId -> tasks waiting on it
    const inputIndex = new Map<string, number>();
    tasks.forEach((t, i) => inputIndex.set(t.id, i));

    for (const t of tasks) {
        const knownDeps = (t.dependsOn || []).filter(d => byId.has(d) && d !== t.id);
        indegree.set(t.id, knownDeps.length);
        for (const d of knownDeps) {
            if (!dependents.has(d)) dependents.set(d, []);
            dependents.get(d)!.push(t.id);
        }
    }

    // Ready set = indegree 0. Pop the best (priority desc, then input order asc) each step.
    const ready: string[] = tasks.filter(t => (indegree.get(t.id) || 0) === 0).map(t => t.id);
    const order: T[] = [];

    const pickNext = (): string | undefined => {
        if (ready.length === 0) return undefined;
        let best = 0;
        for (let i = 1; i < ready.length; i++) {
            const a = byId.get(ready[i])!, b = byId.get(ready[best])!;
            const pa = a.priority ?? 0, pb = b.priority ?? 0;
            if (pa > pb || (pa === pb && inputIndex.get(a.id)! < inputIndex.get(b.id)!)) best = i;
        }
        return ready.splice(best, 1)[0];
    };

    let next: string | undefined;
    while ((next = pickNext()) !== undefined) {
        order.push(byId.get(next)!);
        for (const dep of dependents.get(next) || []) {
            indegree.set(dep, (indegree.get(dep) || 0) - 1);
            if ((indegree.get(dep) || 0) === 0) ready.push(dep);
        }
    }

    // Anything never scheduled is on (or downstream of) a cycle.
    const scheduled = new Set(order.map(t => t.id));
    const cyclic = tasks.filter(t => !scheduled.has(t.id)).map(t => t.id);

    return { order, cyclic };
}

/**
 * Groups a scheduled order into dependency "waves": each wave contains tasks whose
 * dependencies are all in earlier waves, so tasks WITHIN a wave can run in parallel.
 * This is what a parallel executor (plan.md Phase E) consumes. Pure.
 */
export function toParallelWaves<T extends SchedulableTask>(tasks: T[]): { waves: T[][]; cyclic: string[] } {
    const { order, cyclic } = scheduleTasks(tasks);
    const depth = new Map<string, number>();
    const byId = new Map<string, T>();
    for (const t of order) byId.set(t.id, t);

    for (const t of order) {
        const deps = (t.dependsOn || []).filter(d => byId.has(d) && d !== t.id);
        const d = deps.length === 0 ? 0 : Math.max(...deps.map(x => (depth.get(x) ?? 0) + 1));
        depth.set(t.id, d);
    }

    const waves: T[][] = [];
    for (const t of order) {
        const d = depth.get(t.id) || 0;
        (waves[d] ||= []).push(t);
    }
    return { waves: waves.filter(Boolean), cyclic };
}
