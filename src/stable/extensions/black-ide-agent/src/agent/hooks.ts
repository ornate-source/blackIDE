import * as path from 'path';
import * as fs from 'fs';
import { ToolRunner } from '../tools/tool-runner';

// Agent Hooks / Lifecycle Events — Feature 24
// Allows users to define custom hooks that run before/after tool calls.

export type HookPhase = 'beforeToolCall' | 'afterToolCall' | 'beforeResponse' | 'onError';

export interface HookConfig {
    afterFileEdit?: string;    // Command to run after any file edit
    afterWriteFile?: string;   // Command to run after file creation
    beforeResponse?: string;   // Command to run before final response
    onError?: string;          // Command to run on errors
}

export class AgentHooks {
    private hooks: Map<HookPhase, ((context: any) => Promise<void>)[]> = new Map();

    /** Register a hook for a specific lifecycle phase */
    register(phase: HookPhase, handler: (context: any) => Promise<void>): void {
        const existing = this.hooks.get(phase) || [];
        existing.push(handler);
        this.hooks.set(phase, existing);
    }

    /** Run all hooks for a phase */
    async run(phase: HookPhase, context: any): Promise<void> {
        const handlers = this.hooks.get(phase) || [];
        for (const handler of handlers) {
            try {
                await handler(context);
            } catch (err) {
                console.error(`Hook error in ${phase}:`, err);
            }
        }
    }

    /** Load hooks from workspace .blackide/hooks.json */
    async loadFromWorkspace(rootPath: string): Promise<void> {
        const hooksFile = path.join(rootPath, '.blackide', 'hooks.json');
        if (!fs.existsSync(hooksFile)) return;

        try {
            const config: HookConfig = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));

            // Run a lint/format command after every file edit
            if (config.afterFileEdit) {
                const cmd = config.afterFileEdit;
                this.register('afterToolCall', async (ctx) => {
                    if (ctx.action === 'edit_file' || ctx.action === 'write_file') {
                        try {
                            await ToolRunner.executeCommand(cmd, rootPath, 15000);
                        } catch {}
                    }
                });
            }

            // Run a command before final response
            if (config.beforeResponse) {
                const cmd = config.beforeResponse;
                this.register('beforeResponse', async () => {
                    try {
                        await ToolRunner.executeCommand(cmd, rootPath, 15000);
                    } catch {}
                });
            }

            // Run a command on errors
            if (config.onError) {
                const cmd = config.onError;
                this.register('onError', async (ctx) => {
                    try {
                        await ToolRunner.executeCommand(`${cmd} "${ctx.error || 'unknown'}"`, rootPath, 15000);
                    } catch {}
                });
            }
        } catch {
            // skip malformed hooks.json
        }
    }

    /** Check if any hooks are registered */
    get hasHooks(): boolean {
        return this.hooks.size > 0;
    }
}
