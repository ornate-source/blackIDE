import { describe, expect, it } from 'vitest';
import { STACK_MINDMAP_HEADING } from '../src/core/project-profiler';
import {
    describeMindmap, isAutoSync, parseMindmap, renderMindmapContext,
} from '../src/core/mindmap-readback';

/**
 * Phase 8, M46 — mindmap read-back.
 *
 * C7 has said "read-back is still thin" since plan.md's Phase 5. The write half works;
 * nothing has ever read the file, so `project_mindmap.md` has been a write-only log. The
 * agent recomputes what it already wrote down, and a convention a *human* added is
 * invisible to every run — in a file the agent maintains and the user therefore assumes it
 * reads.
 */

const MINDMAP = [
    '# Project Mindmap',
    '',
    `## ${STACK_MINDMAP_HEADING}`,
    '- Languages: typescript, python',
    '- Frameworks: django, react',
    '',
    '## Data access',
    'We use the repository pattern for all data access. Do not call the ORM directly',
    'from a view.',
    '',
    '## Auto-Sync 2026-08-01',
    '- Backend Executor touched src/api/users.py',
    '',
].join('\n');

describe('parseMindmap', () => {
    it('finds the detected-stack section', () => {
        expect(parseMindmap(MINDMAP).stack).toContain('django, react');
    });

    it('finds the sections a human wrote', () => {
        expect(parseMindmap(MINDMAP).sections['Data access']).toContain('repository pattern');
    });

    it('keeps a section whole rather than splitting on deeper headings', () => {
        // Splitting on `###` turns one coherent convention into fragments the budget then
        // truncates independently.
        const nested = '## Conventions\nintro text\n### Naming\nuse camelCase\n### Files\none per class\n';
        expect(parseMindmap(nested).sections['Conventions']).toContain('use camelCase');
        expect(Object.keys(parseMindmap(nested).sections)).toEqual(['Conventions']);
    });

    it('reports an empty mindmap as empty rather than as sections of nothing', () => {
        expect(parseMindmap('# Project Mindmap\n').empty).toBe(true);
        expect(parseMindmap('').empty).toBe(true);
        expect(parseMindmap(undefined as any).empty).toBe(true);
    });

    it('drops a heading whose body is blank', () => {
        expect(parseMindmap('## Empty\n\n## Real\ncontent\n').sections).toEqual({ Real: 'content' });
    });
});

describe('renderMindmapContext', () => {
    it('puts the detected stack first', () => {
        // The profiler computes this too; leading with it lets the model reconcile the two
        // instead of treating an agreement as a coincidence.
        const rendered = renderMindmapContext(parseMindmap(MINDMAP));
        expect(rendered.startsWith(`## ${STACK_MINDMAP_HEADING}`)).toBe(true);
    });

    it('includes the human-written conventions', () => {
        expect(renderMindmapContext(parseMindmap(MINDMAP))).toContain('repository pattern');
    });

    it('excludes auto-sync blocks', () => {
        // A log of what this tool did is not knowledge about the project; feeding it back
        // spends the budget re-reading the agent's own history.
        const rendered = renderMindmapContext(parseMindmap(MINDMAP));
        expect(rendered).not.toContain('Backend Executor touched');
    });

    it('is empty when there is nothing but auto-sync', () => {
        const onlyLogs = '## Auto-Sync 2026-08-01\n- touched a.ts\n';
        expect(renderMindmapContext(parseMindmap(onlyLogs))).toBe('');
    });

    it('is empty for an empty mindmap, rather than a header with nothing under it', () => {
        expect(renderMindmapContext(parseMindmap(''))).toBe('');
    });

    it('stays inside its budget', () => {
        const big = `## A\n${'x'.repeat(5_000)}\n## B\n${'y'.repeat(5_000)}\n`;
        expect(renderMindmapContext(parseMindmap(big), 500).length).toBeLessThanOrEqual(500);
    });

    it('marks a truncated section rather than cutting it silently', () => {
        const big = `## A\n${'x'.repeat(5_000)}\n`;
        expect(renderMindmapContext(parseMindmap(big), 500)).toContain('truncated');
    });
});

describe('isAutoSync', () => {
    it('matches the headings the orchestrator writes', () => {
        expect(isAutoSync('Auto-Sync 2026-08-01')).toBe(true);
        expect(isAutoSync('auto sync')).toBe(true);
        expect(isAutoSync('Autosync')).toBe(true);
    });

    it('does not match a real section', () => {
        expect(isAutoSync('Data access')).toBe(false);
        expect(isAutoSync(STACK_MINDMAP_HEADING)).toBe(false);
    });
});

describe('describeMindmap', () => {
    it('says what was read, so "did it read the mindmap" is answerable', () => {
        const described = describeMindmap(parseMindmap(MINDMAP));
        expect(described).toContain('2 sections');
        expect(described).toContain('detected stack');
    });

    it('says so plainly when there is none', () => {
        expect(describeMindmap(parseMindmap(''))).toBe('no project mindmap yet');
    });
});
