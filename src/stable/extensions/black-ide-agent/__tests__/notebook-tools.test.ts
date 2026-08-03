import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentToolExecutor, ExecutorDeps } from '../src/agent/tool-executor';
import { BASE_TOOLS, NOTEBOOK_EDIT_TOOLS, NOTEBOOK_READ_TOOLS, isToolAllowedInMode, toolsForMode } from '../src/core/tools';
import { ModeLoader } from '../src/core/mode-loader';
import { parseNotebook, roundTrip } from '../src/core/notebook';

/**
 * Notebook tools reaching the agent (Phase 10, M61).
 *
 * `core/notebook.ts` has been complete and fully unit-tested since Phase 10 and was
 * reachable from nothing: neither tool was registered, so every `.ipynb` question went
 * through `read_file` and `edit_file`, which are the two worst tools for the job. These
 * assert the wiring, and — the half that is a defect fix rather than a feature — that
 * the generic tools now refuse a notebook instead of corrupting one.
 */

/** A notebook with the array-shaped `source` Jupyter actually writes. */
const NOTEBOOK = JSON.stringify({
    cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# Analysis\n'] },
        {
            cell_type: 'code',
            metadata: {},
            execution_count: 1,
            source: ['import pandas as pd\n', 'df = pd.read_csv("in.csv")\n'],
            outputs: [{ output_type: 'stream', name: 'stdout', text: ['loaded 4 rows\n'] }],
        },
        {
            cell_type: 'code',
            metadata: {},
            execution_count: 2,
            source: ['df.plot()\n'],
            outputs: [{ output_type: 'display_data', data: { 'image/png': 'A'.repeat(40_000) }, metadata: {} }],
        },
    ],
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
    nbformat: 4,
    nbformat_minor: 5,
}, null, 1) + '\n';

let root: string;
let saved: any;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-tools-'));
    fs.writeFileSync(path.join(root, 'Analysis.ipynb'), NOTEBOOK, 'utf8');
    fs.writeFileSync(path.join(root, 'plain.py'), 'x = 1\n', 'utf8');
    saved = (vscode as any).workspace.workspaceFolders;
    (vscode as any).workspace.workspaceFolders = [{ uri: { fsPath: root }, name: 'repo', index: 0 }];
});

afterEach(() => {
    (vscode as any).workspace.workspaceFolders = saved;
    fs.rmSync(root, { recursive: true, force: true });
});

const deps = (over: Partial<ExecutorDeps> = {}): ExecutorDeps => ({
    mode: 'agent',
    rootPath: root,
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

const call = (name: string, args: any = {}) => ({ id: 't1', name, arguments: args }) as any;
const read = () => fs.readFileSync(path.join(root, 'Analysis.ipynb'), 'utf8');

describe('the tools are registered with the right risk class', () => {
    it('registers read_notebook as safe and edit_notebook_cell as an edit', () => {
        expect(BASE_TOOLS.find(t => t.name === 'read_notebook')?.risk).toBe('safe');
        expect(BASE_TOOLS.find(t => t.name === 'edit_notebook_cell')?.risk).toBe('edit');
    });

    it('keeps the two groups disjoint, so a spread cannot put a write into a read-only mode', () => {
        const overlap = (NOTEBOOK_READ_TOOLS as readonly string[])
            .filter(n => (NOTEBOOK_EDIT_TOOLS as readonly string[]).includes(n));
        expect(overlap).toEqual([]);
    });

    it('offers reading in every mode and editing only in agent mode', () => {
        for (const mode of ['ask', 'plan', 'agent'] as const) {
            expect(isToolAllowedInMode('read_notebook', mode), `read in ${mode}`).toBe(true);
        }
        expect(isToolAllowedInMode('edit_notebook_cell', 'ask')).toBe(false);
        expect(isToolAllowedInMode('edit_notebook_cell', 'plan')).toBe(false);
        expect(isToolAllowedInMode('edit_notebook_cell', 'agent')).toBe(true);
        expect(toolsForMode('ask').map(t => t.name)).toContain('read_notebook');
    });
});

describe('per-mode allowlists admit them — the trap tool-surface.test.ts exists for', () => {
    it('gives read_notebook to every mode that can already read a file', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        const missing = modes
            .filter(m => m.tools?.length && m.tools.includes('read_file') && !m.tools.includes('read_notebook'))
            .map(m => m.name);
        expect(missing).toEqual([]);
    });

    it('gives edit_notebook_cell to every mode that can already edit a file', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        const missing = modes
            .filter(m => m.tools?.length && m.tools.includes('edit_file') && !m.tools.includes('edit_notebook_cell'))
            .map(m => m.name);
        expect(missing).toEqual([]);
    });

    it('gives it to no mode that cannot edit a file', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        const leaked = modes
            .filter(m => m.tools?.includes('edit_notebook_cell') && !m.tools.includes('edit_file'))
            .map(m => m.name);
        expect(leaked).toEqual([]);
    });

    it('refuses edit_notebook_cell at the executor for a read-only mode', async () => {
        const modes = await new ModeLoader().loadAll('/empty');
        for (const name of ['Plan', 'Manager', 'Learn']) {
            const mode = modes.find(m => m.name === name)!;
            const exec = new AgentToolExecutor(deps({ allowedTools: mode.tools }));
            const r = await exec.execute(call('edit_notebook_cell', { path: 'Analysis.ipynb', index: 0, text: 'x' }));
            expect(r.isError, `${name} must refuse edit_notebook_cell`).toBe(true);
            expect(read(), `${name} must not have written`).toBe(NOTEBOOK);
        }
    });
});

describe('the generic file tools refuse a notebook', () => {
    it('sends read_file at a notebook to read_notebook instead of dumping the JSON', async () => {
        const exec = new AgentToolExecutor(deps());
        const r = await exec.execute(call('read_file', { path: 'Analysis.ipynb' }));
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/read_notebook/);
        // The point of the refusal: the 40 KB of base64 never enters the transcript.
        expect(r.content).not.toMatch(/AAAA/);
    });

    it('refuses edit_file on a notebook rather than writing invalid JSON', async () => {
        const exec = new AgentToolExecutor(deps());
        const r = await exec.execute(call('edit_file', {
            path: 'Analysis.ipynb',
            search_replace_blocks: '<<<<<<< ORIGINAL\ndf.plot()\n=======\ndf.hist()\n>>>>>>> UPDATED',
        }));
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/edit_notebook_cell/);
        expect(read()).toBe(NOTEBOOK);
    });

    it('leaves ordinary files alone', async () => {
        const exec = new AgentToolExecutor(deps());
        const r = await exec.execute(call('read_file', { path: 'plain.py' }));
        expect(r.isError).toBeFalsy();
        expect(r.content).toBe('x = 1\n');
    });

    it('refuses edit_notebook_cell on a file that is not a notebook', async () => {
        const exec = new AgentToolExecutor(deps());
        const r = await exec.execute(call('edit_notebook_cell', { path: 'plain.py', index: 0, text: 'y = 2' }));
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/edit_file/);
        expect(fs.readFileSync(path.join(root, 'plain.py'), 'utf8')).toBe('x = 1\n');
    });
});

describe('read_notebook', () => {
    it('lists the cells and renders the source without the outputs', async () => {
        const exec = new AgentToolExecutor(deps());
        const r = await exec.execute(call('read_notebook', { path: 'Analysis.ipynb' }));
        expect(r.isError).toBeFalsy();
        expect(r.content).toMatch(/3 cells/);
        expect(r.content).toMatch(/import pandas as pd/);
        // Outputs excluded by default — the base64 image is the whole reason.
        expect(r.content).not.toMatch(/AAAA/);
        expect(r.content).not.toMatch(/loaded 4 rows/);
    });

    it('names an image output by size rather than inlining it, when outputs are asked for', async () => {
        const exec = new AgentToolExecutor(deps());
        const r = await exec.execute(call('read_notebook', { path: 'Analysis.ipynb', include_outputs: true }));
        expect(r.content).toMatch(/loaded 4 rows/);
        expect(r.content).toMatch(/image\/png output/);
        expect(r.content).not.toMatch(/AAAA/);
    });

    it('reads one cell under its real index, not its index in the slice', async () => {
        const exec = new AgentToolExecutor(deps());
        const r = await exec.execute(call('read_notebook', { path: 'Analysis.ipynb', cell: 2 }));
        expect(r.content).toMatch(/--- cell 2 /);
        expect(r.content).not.toMatch(/--- cell 0 /);
        expect(r.content).toMatch(/df\.plot\(\)/);
        expect(r.content).not.toMatch(/import pandas/);
    });

    it('names the valid range when the index is out of range', async () => {
        const exec = new AgentToolExecutor(deps());
        const r = await exec.execute(call('read_notebook', { path: 'Analysis.ipynb', cell: 9 }));
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/0–2/);
    });
});

describe('edit_notebook_cell writes a diff the user can read', () => {
    it('replaces one cell and leaves every other byte alone', async () => {
        const exec = new AgentToolExecutor(deps());
        const r = await exec.execute(call('edit_notebook_cell', {
            path: 'Analysis.ipynb', operation: 'replace', index: 2, text: 'df.hist()\n',
        }));
        expect(r.isError).toBeFalsy();

        const after = read();
        expect(after).toMatch(/df\.hist\(\)/);
        expect(after).not.toMatch(/df\.plot\(\)/);

        // The property that makes this tool worth having: the file did not churn.
        const before = NOTEBOOK.split('\n');
        const changed = after.split('\n').filter((line, i) => before[i] !== line);
        expect(changed.length, `only the edited cell should differ, got:\n${changed.join('\n')}`).toBeLessThan(3);

        // And the edit did not destroy results the user may not be able to reproduce.
        const cells = parseNotebook(after).notebook.cells!;
        expect(cells).toHaveLength(3);
        expect((cells[2] as any).outputs).toHaveLength(1);
        expect((cells[1] as any).source).toEqual(['import pandas as pd\n', 'df = pd.read_csv("in.csv")\n']);
    });

    it('keeps the array-shaped source Jupyter writes, so the file stays round-trip stable', async () => {
        const exec = new AgentToolExecutor(deps());
        await exec.execute(call('edit_notebook_cell', {
            path: 'Analysis.ipynb', operation: 'replace', index: 0, text: '# Analysis\n## Revised\n',
        }));
        const after = read();
        expect(Array.isArray((parseNotebook(after).notebook.cells![0] as any).source)).toBe(true);
        expect(roundTrip(after)).toBe(after);
    });

    it('inserts and deletes, reporting the resulting cell count', async () => {
        const exec = new AgentToolExecutor(deps());
        const inserted = await exec.execute(call('edit_notebook_cell', {
            path: 'Analysis.ipynb', operation: 'insert', index: 1, cell_type: 'markdown', text: '## Load\n',
        }));
        expect(inserted.content).toMatch(/4 cells/);
        expect(parseNotebook(read()).notebook.cells![1].cell_type).toBe('markdown');

        const deleted = await exec.execute(call('edit_notebook_cell', {
            path: 'Analysis.ipynb', operation: 'delete', index: 1,
        }));
        expect(deleted.content).toMatch(/3 cells/);
        expect(read()).toBe(NOTEBOOK);
    });

    it('writes nothing when the user rejects the approval', async () => {
        const exec = new AgentToolExecutor(deps({ approve: async () => false }));
        const r = await exec.execute(call('edit_notebook_cell', {
            path: 'Analysis.ipynb', operation: 'delete', index: 0,
        }));
        expect(r.isError).toBeFalsy();
        expect(r.content).toMatch(/rejected/);
        expect(read()).toBe(NOTEBOOK);
    });

    it('snapshots before writing, so the change is checkpointed like any other edit', async () => {
        const snapshots: string[] = [];
        const exec = new AgentToolExecutor(deps({ checkpoint: { snapshot: (p: string) => snapshots.push(p) } as any }));
        await exec.execute(call('edit_notebook_cell', { path: 'Analysis.ipynb', operation: 'replace', index: 0, text: 'x' }));
        expect(snapshots).toEqual([path.join(root, 'Analysis.ipynb')]);
    });

    it('refuses an out-of-range index without touching the file', async () => {
        const exec = new AgentToolExecutor(deps());
        const r = await exec.execute(call('edit_notebook_cell', { path: 'Analysis.ipynb', operation: 'replace', index: 7, text: 'x' }));
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/does not exist/);
        expect(read()).toBe(NOTEBOOK);
    });

    it('refuses an operation it does not know rather than defaulting to a write', async () => {
        const exec = new AgentToolExecutor(deps());
        const r = await exec.execute(call('edit_notebook_cell', { path: 'Analysis.ipynb', operation: 'clear_outputs', index: 1 }));
        expect(r.isError).toBe(true);
        expect(read()).toBe(NOTEBOOK);
    });

    it('refuses the argument combinations that would otherwise write an empty cell', async () => {
        const exec = new AgentToolExecutor(deps());
        for (const args of [
            { operation: 'replace', index: 1 },          // no text
            { operation: 'insert', index: 1 },           // no text
            { operation: 'delete' },                     // no index
            { operation: 'replace', text: 'x' },         // no index
        ]) {
            const r = await exec.execute(call('edit_notebook_cell', { path: 'Analysis.ipynb', ...args }));
            expect(r.isError, JSON.stringify(args)).toBe(true);
        }
        expect(read()).toBe(NOTEBOOK);
    });
});
