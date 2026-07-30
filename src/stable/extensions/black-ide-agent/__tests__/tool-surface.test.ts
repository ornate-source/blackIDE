import { BASE_TOOLS, CODE_INTEL_READ_TOOLS, toolsForMode, isToolAllowedInMode } from '../src/core/tools';
import { ModeLoader } from '../src/core/mode-loader';

/**
 * Phase 1 tool-surface wiring.
 *
 * These exist because of a trap this phase hit: every built-in mode declares an
 * explicit `tools` allowlist, and `_runAgentTask` filters the advertised tool list
 * through it. A new tool can therefore be registered, implemented, allowed by the
 * sandbox gate — and still never be offered to the model, silently, in every mode
 * that declares a list. Registration alone proves nothing; these assert the tools
 * survive the per-mode filter.
 */

const PHASE_1_READ_TOOLS = ['get_diagnostics', 'go_to_definition', 'find_references', 'workspace_symbols', 'hover', 'code_actions'];
/** Phase 3 added graph-backed (M16), git-history (M22) and compaction (M18) members. */
const PHASE_3_READ_TOOLS = [
    'impact_analysis', 'search_history', 'blame', 'why_was_this_changed', 'expand_output',
];
const ALL_CODE_INTEL_READ_TOOLS = [...PHASE_1_READ_TOOLS, ...PHASE_3_READ_TOOLS];

describe('Phase 1 tools are registered', () => {
    it('registers every read-only LSP tool as safe', () => {
        for (const name of PHASE_1_READ_TOOLS) {
            const tool = BASE_TOOLS.find(t => t.name === name);
            expect(tool, name).toBeDefined();
            expect(tool!.risk, name).toBe('safe');
        }
    });

    it('keeps CODE_INTEL_READ_TOOLS in sync with what is registered', () => {
        expect([...CODE_INTEL_READ_TOOLS].sort()).toEqual([...ALL_CODE_INTEL_READ_TOOLS].sort());
    });

    it('registers the graph-backed tools as safe too', () => {
        for (const name of PHASE_3_READ_TOOLS) {
            const tool = BASE_TOOLS.find(t => t.name === name);
            expect(tool, name).toBeDefined();
            expect(tool!.risk, name).toBe('safe');
        }
    });

    it('classifies rename_symbol as a write and run_tests as exec', () => {
        expect(BASE_TOOLS.find(t => t.name === 'rename_symbol')?.risk).toBe('edit');
        expect(BASE_TOOLS.find(t => t.name === 'run_tests')?.risk).toBe('exec');
    });

    it('declares required parameters for each new tool', () => {
        const required: Record<string, string[]> = {
            go_to_definition: ['path', 'symbol'],
            find_references: ['path', 'symbol'],
            workspace_symbols: ['query'],
            hover: ['path', 'symbol'],
            rename_symbol: ['path', 'symbol', 'new_name'],
        };
        for (const [name, params] of Object.entries(required)) {
            const tool = BASE_TOOLS.find(t => t.name === name)!;
            expect(tool.parameters.required, name).toEqual(params);
        }
    });

    it('leaves get_diagnostics and run_tests callable with no arguments', () => {
        for (const name of ['get_diagnostics', 'run_tests']) {
            expect(BASE_TOOLS.find(t => t.name === name)!.parameters.required, name).toEqual([]);
        }
    });
});

describe('the sandbox gate', () => {
    it('allows read-only code-intelligence tools in every mode, including read-only ones', () => {
        for (const mode of ['ask', 'plan', 'agent'] as const) {
            for (const name of ALL_CODE_INTEL_READ_TOOLS) {
                expect(isToolAllowedInMode(name, mode), `${name} in ${mode}`).toBe(true);
            }
        }
    });

    it('refuses the write and exec tools in read-only modes', () => {
        for (const mode of ['ask', 'plan'] as const) {
            expect(isToolAllowedInMode('rename_symbol', mode), `rename in ${mode}`).toBe(false);
            expect(isToolAllowedInMode('run_tests', mode), `run_tests in ${mode}`).toBe(false);
        }
        expect(isToolAllowedInMode('rename_symbol', 'agent')).toBe(true);
        expect(isToolAllowedInMode('run_tests', 'agent')).toBe(true);
    });

    it('advertises the read tools in ask mode', () => {
        const names = toolsForMode('ask').map(t => t.name);
        for (const name of ALL_CODE_INTEL_READ_TOOLS) expect(names, name).toContain(name);
    });
});

describe('per-mode allowlists actually admit the new tools', () => {
    // This is the assertion that would have caught the silent-filtering trap.
    it('gives every built-in mode that declares a tool list the read-only code-intelligence tools', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        const declaring = modes.filter(m => m.tools && m.tools.length > 0);
        expect(declaring.length).toBeGreaterThan(8);

        const missing: string[] = [];
        for (const mode of declaring) {
            for (const name of ALL_CODE_INTEL_READ_TOOLS) {
                if (!mode.tools!.includes(name)) missing.push(`${mode.name} lacks ${name}`);
            }
        }
        expect(missing).toEqual([]);
    });

    it('gives run_tests to every mode that can already run commands', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        const missing = modes
            .filter(m => m.tools?.includes('run_command') && !m.tools.includes('run_tests'))
            .map(m => m.name);
        expect(missing).toEqual([]);
    });

    it('gives rename_symbol to every mode that can already edit files', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        const missing = modes
            .filter(m => (m.tools?.includes('edit_file') || m.tools?.includes('write_file')) && !m.tools.includes('rename_symbol'))
            .map(m => m.name);
        expect(missing).toEqual([]);
    });

    it('does not hand write tools to analysis-only modes', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        for (const name of ['Plan', 'Manager', 'Sr Architect']) {
            const mode = modes.find(m => m.name === name);
            expect(mode?.tools, name).toBeDefined();
            expect(mode!.tools, name).not.toContain('rename_symbol');
            expect(mode!.tools, name).not.toContain('run_tests');
        }
    });

    it('gives the Testing Executor the tools its prompt now tells it to use', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        const testing = modes.find(m => m.name === 'Testing Executor')!;
        expect(testing.tools).toContain('run_tests');
        expect(testing.tools).toContain('find_references');
        expect(testing.tools).toContain('get_diagnostics');
        // The prompt must not still be steering it to the raw command path for tests.
        expect(testing.systemPrompt).toContain('run_tests');
    });
});
