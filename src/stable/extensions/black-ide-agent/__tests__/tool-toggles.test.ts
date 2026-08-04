import * as fs from 'fs';
import * as path from 'path';
import {
    UNDISABLABLE_TOOLS,
    advertisedTools,
    applyToggle,
    applyToolToggles,
    isDeniedByUser,
    isDisablable,
    toolPanelEntries,
} from '@blackide/agent-core/core/tool-toggles';
import { AgentToolExecutor, ExecutorDeps } from '../src/agent/tool-executor';
import { toolsForMode } from '@blackide/agent-core/core/tools';

/**
 * Session tool toggles (Phase 2, M10) — the tools half of the session panel.
 *
 * The point of these assertions is that a toggle is *enforced*, not advertised. Phase 2
 * shipped the rules half and found that per-mode tool allowlists were advertising-only
 * (the B4 finding); a user switching `run_command` off is making the same class of
 * decision, so it rides the same executor gate.
 */

const deps = (over: Partial<ExecutorDeps>): ExecutorDeps => ({
    mode: 'agent',
    rootPath: '/tmp/repo',
    browserTool: {} as any,
    mcpClient: {} as any,
    artifactManager: {} as any,
    knowledgeStore: {} as any,
    codebaseIndex: {} as any,
    checkpoint: { snapshot: () => {} } as any,
    log: () => {},
    approve: async () => true,
    ...over,
});

const call = (name: string, args: any = {}) => ({ id: 't1', name, arguments: args });

describe('applyToggle', () => {
    it('adds and removes a tool, idempotently in both directions', () => {
        expect(applyToggle([], 'run_command', false)).toEqual(['run_command']);
        expect(applyToggle(['run_command'], 'run_command', false)).toEqual(['run_command']);
        expect(applyToggle(['run_command'], 'run_command', true)).toEqual([]);
        expect(applyToggle([], 'run_command', true)).toEqual([]);
    });

    it('matches case-insensitively, so a stale webview still toggles the right tool', () => {
        expect(applyToggle(['run_command'], 'RUN_COMMAND', true)).toEqual([]);
    });

    it('refuses to disable the loop terminator', () => {
        // A toggle that can stop the agent from finishing is a defect: the loop would
        // run to its cap and report as a failure, which reads as a broken agent rather
        // than as the consequence of a switch the user flipped.
        expect(UNDISABLABLE_TOOLS).toContain('complete_task');
        expect(isDisablable('complete_task')).toBe(false);
        expect(applyToggle([], 'complete_task', false)).toEqual([]);
    });

    it('ignores an empty name rather than storing one', () => {
        expect(applyToggle(['run_command'], '', false)).toEqual(['run_command']);
    });
});

describe('the advertised list and the panel are one construction', () => {
    it('advertisedTools narrows the coarse sandbox by the mode allowlist', () => {
        const all = advertisedTools('agent');
        expect(all.length).toBe(toolsForMode('agent').length);

        const narrowed = advertisedTools('agent', ['read_file', 'complete_task']);
        expect(narrowed.map(t => t.name).sort()).toEqual(['complete_task', 'read_file']);
    });

    it('never widens a read-only sandbox, even if the mode lists a write tool', () => {
        // A custom mode's `tools` array is a filter, never a grant — otherwise a mode
        // file could hand Ask mode the ability to write.
        const asked = advertisedTools('ask', ['write_file', 'run_command', 'read_file']);
        expect(asked.map(t => t.name)).toEqual(['read_file']);
    });

    it('chat-task builds its advertised list through advertisedTools, not its own filter', () => {
        // Two independent constructions of "what this mode offers" is exactly how the
        // panel starts lying about the prompt — the failure mode rules-panel-fidelity
        // guards on the rules side.
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'chat-task.ts'), 'utf8');
        expect(src).toMatch(/advertisedTools\(effectiveMode, customModeDef\?\.tools\)/);
    });

    it('panel entries report the disabled ones as off, and still list them', () => {
        const entries = toolPanelEntries(advertisedTools('agent'), ['run_command']);
        const runCommand = entries.find(e => e.name === 'run_command');
        expect(runCommand?.enabled).toBe(false);
        // Listed, not dropped: the switch that turned it off is also the switch that
        // turns it back on.
        expect(entries.length).toBe(advertisedTools('agent').length);
        expect(entries.find(e => e.name === 'complete_task')?.disablable).toBe(false);
    });
});

describe('a disabled tool is unadvertised', () => {
    it('is removed from the list handed to the model', () => {
        const before = advertisedTools('agent');
        const after = applyToolToggles(before, ['run_command', 'web_search']);
        expect(after.length).toBe(before.length - 2);
        expect(after.some(t => t.name === 'run_command')).toBe(false);
    });

    it('keeps the terminator even if it is somehow in the disabled list', () => {
        const after = applyToolToggles(advertisedTools('agent'), ['complete_task']);
        expect(after.some(t => t.name === 'complete_task')).toBe(true);
    });

    it('returns the same array when nothing is disabled', () => {
        const before = advertisedTools('agent');
        expect(applyToolToggles(before, [])).toBe(before);
    });
});

describe('a disabled tool is refused at the executor', () => {
    it('refuses a tool the user switched off', async () => {
        // Reaching the gate means the model called a tool it saw on an earlier turn —
        // which is why unadvertising alone would have been advisory.
        const exec = new AgentToolExecutor(deps({ deniedTools: ['run_command'] }));
        const r = await exec.execute(call('run_command', { command: 'ls' }) as any);
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/switched off by the user/);
    });

    it('names the user as the reason, distinctly from the mode gates', async () => {
        const exec = new AgentToolExecutor(deps({ deniedTools: ['web_search'] }));
        const r = await exec.execute(call('web_search', { query: 'x' }) as any);
        expect(r.content).not.toMatch(/allowlist|not available in/);
        expect(r.content).toMatch(/Do not retry/);
    });

    it('does not claim the terminator was switched off', async () => {
        // `complete_task` is intercepted by the agent loop (`agent-loop.ts:85`) and never
        // reaches a handler here, so the executor's own answer is "unknown tool". What
        // matters is that the toggle gate is not what stops it: if the gate ever answered
        // first, a stale toggle could keep the loop from terminating.
        const exec = new AgentToolExecutor(deps({ deniedTools: ['complete_task'] }));
        const r = await exec.execute(call('complete_task', { message: 'done' }) as any);
        expect(r.content).not.toMatch(/switched off/);
    });

    it('switching mcp_call off closes every dynamically-named MCP tool with it', () => {
        // MCP tools are discovered at runtime as `mcp_<serverTool>` and never appear in
        // the panel, so a per-tool switch could not reach them. `mcp_call` is the switch
        // that governs the transport.
        expect(isDeniedByUser('mcp_github_create_issue', ['mcp_call'])).toBe(true);
        expect(isDeniedByUser('mcp_github_create_issue', [])).toBe(false);
    });

    it('an empty denied list changes nothing', async () => {
        const exec = new AgentToolExecutor(deps({ deniedTools: [] }));
        const r = await exec.execute(call('web_search', { query: 'x' }) as any);
        expect(r.content).not.toMatch(/switched off/);
    });
});

describe('the toggle survives delegation', () => {
    it('a subagent inherits the session\'s disabled tools', () => {
        // Otherwise `spawn_subagent` is a one-line bypass for every switch the user
        // flipped — the same hole the mode-propagation comment in chat-task warns about.
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'chat-task.ts'), 'utf8');
        expect(src).toMatch(/subTools = applyToolToggles\(subTools, deps\.session\.disabledTools\)/);
        expect(src).toMatch(/deniedTools: deps\.session\.disabledTools/);
    });
});

describe('the webview and the host agree on the message contract', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'App.tsx'), 'utf8');
    const handler = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'webview-message-handler.ts'), 'utf8');

    it('every message the panel posts has a case that handles it', () => {
        // The Phase 2 trap in reverse: a control that posts a message nobody handles
        // looks like it works and does nothing.
        expect(app).toMatch(/type: 'toggleTool'/);
        expect(handler).toMatch(/case 'toggleTool'/);
        expect(app).toMatch(/type: 'requestTools'/);
        expect(handler).toMatch(/case 'requestTools'/);
    });

    it('every message the host posts is consumed by the panel', () => {
        expect(handler).toMatch(/type: 'toolTogglesChanged'/);
        expect(app).toMatch(/case 'toolTogglesChanged'/);
        expect(app).toMatch(/case 'toolsAvailable'/);
    });
});
