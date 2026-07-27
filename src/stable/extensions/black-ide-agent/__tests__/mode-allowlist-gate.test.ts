import { AgentToolExecutor, ExecutorDeps } from '../src/agent/tool-executor';
import { ModeLoader } from '../src/core/mode-loader';

/**
 * The per-mode allowlist gate (Phase 2).
 *
 * Found while adding Learn mode: `isToolAllowedInMode` only knows the three coarse
 * AgentModes, and every mode except Ask and Plan resolves to `agent`. So the `tools`
 * arrays declared by Manager, Sr Architect, the HLD/LLD/Planner phases and the four
 * pipeline Executors shaped only what was *advertised* — a write call emitted anyway
 * would have run. `plan.md` graded per-mode allowlists as enforced; they were not.
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

describe('the mode allowlist is enforced where tools run', () => {
    it('refuses a write tool that the acting mode does not declare', async () => {
        const exec = new AgentToolExecutor(deps({ allowedTools: ['read_file', 'complete_task'] }));
        const r = await exec.execute(call('write_file', { path: 'a.ts', content: 'x' }) as any);
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/not in the allowlist/);
    });

    it('refuses run_command for a read-only mode', async () => {
        const exec = new AgentToolExecutor(deps({ allowedTools: ['read_file'] }));
        const r = await exec.execute(call('run_command', { command: 'rm -rf /' }) as any);
        expect(r.isError).toBe(true);
    });

    it('allows a tool the mode does declare', async () => {
        // grep_search with no workspace returns a normal (non-error) result.
        const exec = new AgentToolExecutor(deps({ allowedTools: ['grep_search'] }));
        const r = await exec.execute(call('grep_search', { query: 'nothing-here' }) as any);
        expect(r.content).not.toMatch(/not in the allowlist/);
    });

    it('imposes no per-mode restriction when the mode declares no tools', async () => {
        // Agent mode and custom modes that omit `tools` behave exactly as before.
        const exec = new AgentToolExecutor(deps({ allowedTools: undefined }));
        const r = await exec.execute(call('grep_search', { query: 'x' }) as any);
        expect(r.content).not.toMatch(/not in the allowlist/);
    });

    it('treats an empty allowlist as "no restriction", matching how advertising works', async () => {
        // `tools: []` on the Ask mode means "no filter", not "no tools".
        const exec = new AgentToolExecutor(deps({ allowedTools: [] }));
        const r = await exec.execute(call('grep_search', { query: 'x' }) as any);
        expect(r.content).not.toMatch(/not in the allowlist/);
    });

    it('blocks dynamic MCP tools unless the mode opted into MCP via mcp_call', async () => {
        const without = new AgentToolExecutor(deps({ allowedTools: ['read_file'] }));
        const blocked = await without.execute(call('mcp_someServerTool') as any);
        expect(blocked.isError).toBe(true);
        expect(blocked.content).toMatch(/not in the allowlist/);
    });

    it('still applies the coarse AgentMode gate first', async () => {
        // Ask mode forbids run_command regardless of any allowlist.
        const exec = new AgentToolExecutor(deps({ mode: 'ask', allowedTools: ['run_command'] }));
        const r = await exec.execute(call('run_command', { command: 'ls' }) as any);
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/not available in ask mode/);
    });
});

describe('the built-in modes this actually protects', () => {
    const writeTools = ['write_file', 'edit_file', 'rename_symbol'];

    it('Manager cannot write code, as its prompt claims', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        const manager = modes.find(m => m.name === 'Manager')!;
        expect(manager.systemPrompt).toMatch(/do NOT write code/i);

        const exec = new AgentToolExecutor(deps({ allowedTools: manager.tools }));
        for (const tool of writeTools) {
            const r = await exec.execute(call(tool, { path: 'a.ts', content: 'x', symbol: 's', new_name: 'n' }) as any);
            expect(r.isError, `${tool} should be refused for Manager`).toBe(true);
        }
    });

    it('the read-only analysis modes cannot write', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        for (const name of ['Plan', 'Sr Architect', 'Sr Architect HLD', 'Sr Engineer LLD', 'Learn']) {
            const mode = modes.find(m => m.name === name);
            expect(mode, name).toBeDefined();
            const exec = new AgentToolExecutor(deps({ allowedTools: mode!.tools }));
            for (const tool of writeTools) {
                const r = await exec.execute(call(tool, { path: 'a.ts', content: 'x', symbol: 's', new_name: 'n' }) as any);
                expect(r.isError, `${name} must refuse ${tool}`).toBe(true);
            }
        }
    });

    it('Learn mode cannot run commands either', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        const learn = modes.find(m => m.name === 'Learn')!;
        const exec = new AgentToolExecutor(deps({ allowedTools: learn.tools }));
        for (const tool of ['run_command', 'run_tests', 'spawn_subagent']) {
            const r = await exec.execute(call(tool, { command: 'ls', name: 'x', task: 'y' }) as any);
            expect(r.isError, `Learn must refuse ${tool}`).toBe(true);
        }
    });

    it('Learn mode can still read, navigate and explain', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        const learn = modes.find(m => m.name === 'Learn')!;
        for (const tool of ['read_file', 'grep_search', 'codebase_search', 'go_to_definition', 'find_references', 'hover']) {
            expect(learn.tools, `Learn should offer ${tool}`).toContain(tool);
        }
    });

    it('the executor phases keep the write tools they need', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        for (const name of ['Backend Executor', 'Frontend Executor', 'Testing Executor', 'Design Executor']) {
            const mode = modes.find(m => m.name === name)!;
            expect(mode.tools, name).toContain('edit_file');
            expect(mode.tools, name).toContain('run_tests');
        }
    });
});
