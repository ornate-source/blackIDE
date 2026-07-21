// Scheduled Background Tasks — Feature 23
// Supports one-shot timers and recurring interval-based task scheduling.

export interface ScheduledTask {
    id: string;
    name: string;
    type: 'once' | 'recurring';
    status: 'active' | 'completed' | 'cancelled';
    intervalMs?: number;
    maxRuns?: number;
    currentRuns: number;
}

export class AgentScheduler {
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private tasks: Map<string, ScheduledTask> = new Map();

    /** Schedule a one-shot task */
    scheduleOnce(id: string, name: string, delayMs: number, callback: () => void): ScheduledTask {
        const task: ScheduledTask = {
            id,
            name,
            type: 'once',
            status: 'active',
            currentRuns: 0,
        };

        const timer = setTimeout(() => {
            callback();
            task.currentRuns = 1;
            task.status = 'completed';
            this.timers.delete(id);
        }, delayMs);

        this.timers.set(id, timer);
        this.tasks.set(id, task);
        return task;
    }

    /** Schedule a recurring task */
    scheduleRecurring(
        id: string,
        name: string,
        intervalMs: number,
        callback: () => void,
        maxRuns?: number
    ): ScheduledTask {
        const task: ScheduledTask = {
            id,
            name,
            type: 'recurring',
            status: 'active',
            intervalMs,
            maxRuns,
            currentRuns: 0,
        };

        const timer = setInterval(() => {
            task.currentRuns++;
            callback();

            if (maxRuns && task.currentRuns >= maxRuns) {
                this.cancel(id);
                task.status = 'completed';
            }
        }, intervalMs);

        this.timers.set(id, timer as any);
        this.tasks.set(id, task);
        return task;
    }

    /** Cancel a scheduled task */
    cancel(id: string): void {
        const timer = this.timers.get(id);
        if (timer) {
            clearTimeout(timer);
            clearInterval(timer);
            this.timers.delete(id);
        }

        const task = this.tasks.get(id);
        if (task) {
            task.status = 'cancelled';
        }
    }

    /** Cancel all tasks */
    cancelAll(): void {
        for (const [id] of this.timers) {
            this.cancel(id);
        }
    }

    /** List all scheduled tasks */
    list(): ScheduledTask[] {
        return Array.from(this.tasks.values());
    }

    /** Get active tasks */
    getActive(): ScheduledTask[] {
        return Array.from(this.tasks.values()).filter(t => t.status === 'active');
    }
}
