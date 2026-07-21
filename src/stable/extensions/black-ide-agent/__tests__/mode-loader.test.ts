import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ModeLoader, validateModeFrontmatter } from '../src/core/mode-loader';

describe('ModeLoader', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-tests-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads built-in modes (Ask, Plan, Agent)', async () => {
        const loader = new ModeLoader();
        const modes = await loader.loadAll('/empty');
        expect(modes.map(m => m.name)).toEqual(expect.arrayContaining(['Ask', 'Plan', 'Agent']));
    });

    it('parses valid YAML frontmatter with js-yaml', async () => {
        fs.writeFileSync(path.join(tmpDir, 'test.md'), '---\nname: Test Mode\ndescription: A test\n---\nSystem prompt here');
        const loader = new ModeLoader();
        await loader['_loadFromDirectory'](tmpDir, 'workspace');
        const mode = loader.getMode('test mode');
        expect(mode?.name).toBe('Test Mode');
        expect(mode?.systemPrompt).toBe('System prompt here');
    });

    it('rejects mode files without frontmatter', async () => {
        fs.writeFileSync(path.join(tmpDir, 'bad.md'), 'No frontmatter here');
        const loader = new ModeLoader();
        await loader['_loadFromDirectory'](tmpDir, 'workspace');
        expect(loader.getMode('bad')).toBeUndefined();
    });

    it('rejects mode files with invalid YAML', async () => {
        fs.writeFileSync(path.join(tmpDir, 'invalid.md'), '---\nname: [unclosed\n---\nBody');
        const loader = new ModeLoader();
        await loader['_loadFromDirectory'](tmpDir, 'workspace');
        expect(loader.getMode('unclosed')).toBeUndefined();
    });

    it('rejects mode files missing required "name" field', async () => {
        fs.writeFileSync(path.join(tmpDir, 'noname.md'), '---\ndescription: No name\n---\nBody');
        const loader = new ModeLoader();
        await loader['_loadFromDirectory'](tmpDir, 'workspace');
        expect(loader.getAllModes().find(m => m.description === 'No name')).toBeUndefined();
    });

    it('prevents overriding built-in modes', async () => {
        fs.writeFileSync(path.join(tmpDir, 'agent.md'), '---\nname: Agent\n---\nOverridden');
        const loader = new ModeLoader();
        await loader.loadAll('/empty');
        await loader['_loadFromDirectory'](tmpDir, 'workspace');
        expect(loader.getMode('agent')?.source).toBe('builtin');
    });

    it('handles name collisions with priority ordering', async () => {
        fs.writeFileSync(path.join(tmpDir, 'custom.md'), '---\nname: Custom\n---\nGlobal version');
        const loader = new ModeLoader();
        await loader['_loadFromDirectory'](tmpDir, 'global');
        fs.writeFileSync(path.join(tmpDir, 'custom.md'), '---\nname: Custom\n---\nWorkspace version');
        await loader['_loadFromDirectory'](tmpDir, 'workspace');
        expect(loader.getMode('custom')?.systemPrompt).toBe('Workspace version');
    });

    it('validates tool allowlist format', async () => {
        fs.writeFileSync(path.join(tmpDir, 'badtools.md'), '---\nname: Bad\ntools: not-an-array\n---\nBody');
        const loader = new ModeLoader();
        await loader['_loadFromDirectory'](tmpDir, 'workspace');
        expect(loader.getMode('bad')).toBeUndefined();
    });

    it('validates maxIterations range', async () => {
        fs.writeFileSync(path.join(tmpDir, 'toomany.md'), '---\nname: TooMany\nmaxIterations: 9999\n---\nBody');
        const loader = new ModeLoader();
        await loader['_loadFromDirectory'](tmpDir, 'workspace');
        expect(loader.getMode('toomany')).toBeUndefined();
    });
});

describe('validateModeFrontmatter', () => {
    it('accepts valid frontmatter', () => {
        expect(validateModeFrontmatter({ name: 'Valid' })).toHaveLength(0);
    });

    it('rejects missing name', () => {
        expect(validateModeFrontmatter({})).toContainEqual(expect.stringContaining('name'));
    });

    it('rejects name exceeding 50 chars', () => {
        expect(validateModeFrontmatter({ name: 'x'.repeat(51) })).toContainEqual(expect.stringContaining('50'));
    });
});
