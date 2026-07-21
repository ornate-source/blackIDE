import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CheckpointManager } from '../src/core/checkpoint-manager';

describe('CheckpointManager', () => {
    let manager: CheckpointManager;
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-test-'));
        manager = new CheckpointManager(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('commits and lists checkpoints', () => {
        const testFile = path.join(tmpDir, 'test.ts');
        fs.writeFileSync(testFile, 'original');
        manager.snapshot(testFile);
        fs.writeFileSync(testFile, 'modified');
        const cp = manager.commit('task-1', 'test commit', tmpDir);
        expect(cp).toBeDefined();
        expect(manager.list().length).toBe(1);
    });

    it('returns undefined when no files changed', () => {
        const testFile = path.join(tmpDir, 'test.ts');
        fs.writeFileSync(testFile, 'same content');
        manager.snapshot(testFile);
        // Don't modify the file
        const cp = manager.commit('task-1', 'no-op', tmpDir);
        expect(cp).toBeUndefined();
    });

    it('prunes oldest checkpoints beyond cap', () => {
        const testFile = path.join(tmpDir, 'test.ts');
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(testFile, `content-${i}`);
            manager.snapshot(testFile);
            fs.writeFileSync(testFile, `content-${i + 1}`);
            manager.commit(`task-${i}`, `label-${i}`, tmpDir);
        }
        manager.pruneOldest(3);
        expect(manager.list().length).toBe(3);
    });

    it('prune is a no-op when under the cap', () => {
        const testFile = path.join(tmpDir, 'test.ts');
        fs.writeFileSync(testFile, 'a');
        manager.snapshot(testFile);
        fs.writeFileSync(testFile, 'b');
        manager.commit('task-1', 'only one', tmpDir);

        manager.pruneOldest(50);
        expect(manager.list().length).toBe(1);
    });

    it('generates inline diff preview from forward hunks', () => {
        const testFile = path.join(tmpDir, 'test.ts');
        fs.writeFileSync(testFile, 'line1\nline2\n');
        manager.snapshot(testFile);
        fs.writeFileSync(testFile, 'line1\nline2-modified\nline3\n');
        const cp = manager.commit('task-1', 'test', tmpDir);
        expect(cp).toBeDefined();
        const preview = manager.getInlineDiffPreview(cp!.id, testFile);
        expect(preview.some(l => l.startsWith('+') || l.startsWith('-'))).toBe(true);
    });

    it('returns empty preview for unknown checkpoint', () => {
        const preview = manager.getInlineDiffPreview('nonexistent', '/fake/path');
        expect(preview).toEqual([]);
    });

    it('persists and loads across instances', () => {
        const testFile = path.join(tmpDir, 'test.ts');
        fs.writeFileSync(testFile, 'before');
        manager.snapshot(testFile);
        fs.writeFileSync(testFile, 'after');
        manager.commit('task-1', 'persist test', tmpDir);

        // Create a new manager from the same storage directory
        const manager2 = new CheckpointManager(tmpDir);
        expect(manager2.list().length).toBe(1);
        expect(manager2.list()[0].label).toBe('persist test');
    });

    it('handles in-memory mode without storageDir', () => {
        const memManager = new CheckpointManager();
        const testFile = path.join(tmpDir, 'test.ts');
        fs.writeFileSync(testFile, 'a');
        memManager.snapshot(testFile);
        fs.writeFileSync(testFile, 'b');
        memManager.commit('task-1', 'mem-only', tmpDir);
        expect(memManager.list().length).toBe(1);
    });

    it('undo reverts file changes via reverse patches', () => {
        const testFile = path.join(tmpDir, 'test.ts');
        fs.writeFileSync(testFile, 'original content');
        manager.snapshot(testFile);
        fs.writeFileSync(testFile, 'modified content');
        const cp = manager.commit('task-1', 'undo test', tmpDir);
        expect(cp).toBeDefined();

        const result = manager.undo(cp!.id);
        expect(result.restored.length).toBe(1);
        expect(result.conflicted.length).toBe(0);
        expect(fs.readFileSync(testFile, 'utf8')).toBe('original content');
    });

    it('tracks created files and removes on undo', () => {
        const newFile = path.join(tmpDir, 'new-file.ts');
        // File doesn't exist yet
        manager.snapshot(newFile);
        fs.writeFileSync(newFile, 'brand new');
        const cp = manager.commit('task-1', 'create test', tmpDir);
        expect(cp).toBeDefined();
        expect(cp!.files[0].kind).toBe('created');

        manager.undo(cp!.id);
        expect(fs.existsSync(newFile)).toBe(false);
    });
});
