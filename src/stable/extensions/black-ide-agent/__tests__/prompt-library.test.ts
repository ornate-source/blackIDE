import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    parsePromptFile, expandPrompt, parseSlashInvocation, resolveWorkflow,
    RESERVED_PROMPT_NAMES, UserPrompt,
} from '../src/core/prompt-library';
import { PromptLibrary } from '../src/core/prompt-library-loader';

/** Phase 2 (M12) — user-defined slash commands and workflows. */

const mk = (over: Partial<UserPrompt> & { name: string }): UserPrompt => ({
    description: '', template: 'body', mode: undefined, steps: [], file: `/p/${over.name}.md`, ...over,
});

describe('parsePromptFile', () => {
    it('accepts a bare markdown file, naming it after the file', () => {
        const { prompt, problems } = parsePromptFile('/p/api-review.md', 'Review this against our API checklist.', 'api-review');
        expect(prompt!.name).toBe('api-review');
        expect(prompt!.template).toBe('Review this against our API checklist.');
        // Only the missing-description warning.
        expect(problems.every(p => p.severity === 'warning')).toBe(true);
    });

    it('reads name, description and mode from frontmatter', () => {
        const { prompt } = parsePromptFile('/p/x.md', '---\nname: audit\ndescription: Security audit\nmode: Sr Architect\n---\nAudit it.', 'x');
        expect(prompt!.name).toBe('audit');
        expect(prompt!.description).toBe('Security audit');
        expect(prompt!.mode).toBe('Sr Architect');
    });

    it('refuses to let a user file shadow any built-in slash command', () => {
        for (const reserved of RESERVED_PROMPT_NAMES) {
            const { prompt, problems } = parsePromptFile('/p/x.md', `---\nname: ${reserved}\n---\nbody`, 'x');
            expect(prompt, reserved).toBeUndefined();
            expect(problems[0].severity).toBe('error');
            expect(problems[0].message).toMatch(/built-in slash command/);
        }
    });

    it('rejects names that would not work as a command', () => {
        for (const bad of ['With Space', 'UPPER!', '9lives', 'a'.repeat(40)]) {
            const { prompt } = parsePromptFile('/p/x.md', `---\nname: "${bad}"\n---\nbody`, 'x');
            expect(prompt, bad).toBeUndefined();
        }
    });

    it('lower-cases the name so /Foo and /foo are the same command', () => {
        const { prompt } = parsePromptFile('/p/x.md', '---\nname: MyPrompt\n---\nbody', 'x');
        expect(prompt!.name).toBe('myprompt');
    });

    it('rejects a file with neither a body nor steps', () => {
        const { prompt, problems } = parsePromptFile('/p/x.md', '---\nname: empty\n---\n\n', 'x');
        expect(prompt).toBeUndefined();
        expect(problems[0].message).toMatch(/neither a body nor/);
    });

    it('accepts a steps-only workflow with no body of its own', () => {
        const { prompt } = parsePromptFile('/p/x.md', '---\nname: full\nsteps: [a, b]\n---\n', 'x');
        expect(prompt!.steps).toEqual(['a', 'b']);
    });

    it('reports invalid YAML as an error', () => {
        const { prompt, problems } = parsePromptFile('/p/x.md', '---\nname: [oops\n---\nbody', 'x');
        expect(prompt).toBeUndefined();
        expect(problems[0].severity).toBe('error');
    });
});

describe('expandPrompt', () => {
    it('substitutes $ARGS', () => {
        expect(expandPrompt('Review $ARGS please', 'src/a.ts')).toBe('Review src/a.ts please');
    });

    it('substitutes positional $1..$9', () => {
        expect(expandPrompt('Compare $1 with $2', 'a.ts b.ts')).toBe('Compare a.ts with b.ts');
    });

    it('leaves an unsupplied positional empty rather than printing the token', () => {
        expect(expandPrompt('Only $1 and $2', 'a.ts')).toBe('Only a.ts and');
    });

    it('appends arguments when the template has no placeholder, rather than dropping them', () => {
        // Silently discarding what the user typed is the one behaviour nobody expects.
        expect(expandPrompt('Run the checklist.', 'on the auth module')).toBe('Run the checklist.\n\non the auth module');
    });

    it('does not append anything when there are no arguments', () => {
        expect(expandPrompt('Run the checklist.', '   ')).toBe('Run the checklist.');
    });

    it('collapses repeated whitespace between positional words', () => {
        expect(expandPrompt('$1|$2', 'a    b')).toBe('a|b');
    });
});

describe('parseSlashInvocation', () => {
    it('splits the command from its arguments', () => {
        expect(parseSlashInvocation('/audit the auth module')).toEqual({ name: 'audit', args: 'the auth module' });
    });

    it('handles a bare command', () => {
        expect(parseSlashInvocation('/audit')).toEqual({ name: 'audit', args: '' });
    });

    it('returns undefined for ordinary prompts', () => {
        expect(parseSlashInvocation('what does this do?')).toBeUndefined();
        expect(parseSlashInvocation('a / b')).toBeUndefined();
    });

    it('lower-cases the command name', () => {
        expect(parseSlashInvocation('/Audit x')!.name).toBe('audit');
    });
});

describe('resolveWorkflow', () => {
    it('returns a single prompt as a one-step workflow', () => {
        const p = mk({ name: 'solo' });
        expect(resolveWorkflow(p, new Map([['solo', p]])).steps.map(s => s.name)).toEqual(['solo']);
    });

    it('expands steps in declared order, including the entry body', () => {
        const a = mk({ name: 'a', template: 'A' });
        const b = mk({ name: 'b', template: 'B' });
        const entry = mk({ name: 'entry', template: 'E', steps: ['a', 'b'] });
        const byName = new Map([['a', a], ['b', b], ['entry', entry]]);
        expect(resolveWorkflow(entry, byName).steps.map(s => s.name)).toEqual(['entry', 'a', 'b']);
    });

    it('omits a steps-only prompt from the executable list', () => {
        const a = mk({ name: 'a', template: 'A' });
        const entry = mk({ name: 'entry', template: '', steps: ['a'] });
        const byName = new Map([['a', a], ['entry', entry]]);
        expect(resolveWorkflow(entry, byName).steps.map(s => s.name)).toEqual(['a']);
    });

    it('detects a direct self-reference instead of recursing forever', () => {
        const entry = mk({ name: 'loop', steps: ['loop'] });
        const res = resolveWorkflow(entry, new Map([['loop', entry]]));
        expect(res.cycle).toBeDefined();
    });

    it('detects an indirect cycle through a chain', () => {
        const a = mk({ name: 'a', steps: ['b'] });
        const b = mk({ name: 'b', steps: ['a'] });
        const res = resolveWorkflow(a, new Map([['a', a], ['b', b]]));
        expect(res.cycle).toBeDefined();
        expect(res.cycle).toContain('a');
    });

    it('skips a step that names a missing prompt without failing the workflow', () => {
        const entry = mk({ name: 'entry', template: 'E', steps: ['nope'] });
        const res = resolveWorkflow(entry, new Map([['entry', entry]]));
        expect(res.cycle).toBeUndefined();
        expect(res.steps.map(s => s.name)).toEqual(['entry']);
    });
});

describe('PromptLibrary loader', () => {
    let repo: string;
    const write = (p: string, c: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'utf8'); };

    beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'blackide-prompts-')); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('loads workspace prompts and exposes them by name', async () => {
        write(path.join(repo, '.blackide', 'prompts', 'audit.md'), '---\nname: audit\ndescription: d\n---\nAudit $ARGS');
        const lib = new PromptLibrary();
        await lib.loadAll(repo);
        expect(lib.get('audit')!.template).toBe('Audit $ARGS');
        expect(lib.getAll().map(p => p.name)).toEqual(['audit']);
    });

    it('is case-insensitive on lookup', async () => {
        write(path.join(repo, '.blackide', 'prompts', 'audit.md'), '---\nname: audit\ndescription: d\n---\nbody');
        const lib = new PromptLibrary();
        await lib.loadAll(repo);
        expect(lib.get('AUDIT')).toBeDefined();
    });

    it('reports a step that names a missing prompt', async () => {
        write(path.join(repo, '.blackide', 'prompts', 'flow.md'), '---\nname: flow\ndescription: d\nsteps: [ghost]\n---\nbody');
        const lib = new PromptLibrary();
        await lib.loadAll(repo);
        expect(lib.getProblems().some(p => /does not match any prompt/.test(p.message))).toBe(true);
    });

    it('keeps valid prompts when a sibling file is malformed', async () => {
        write(path.join(repo, '.blackide', 'prompts', 'bad.md'), '---\nname: /plan\n---\nbody');
        write(path.join(repo, '.blackide', 'prompts', 'good.md'), '---\nname: good\ndescription: d\n---\nbody');
        const lib = new PromptLibrary();
        await lib.loadAll(repo);
        expect(lib.getAll().map(p => p.name)).toEqual(['good']);
        expect(lib.getProblems().length).toBeGreaterThan(0);
    });

    it('rebuilds on reload rather than accumulating', async () => {
        const f = path.join(repo, '.blackide', 'prompts', 'a.md');
        write(f, '---\nname: a\ndescription: d\n---\nbody');
        const lib = new PromptLibrary();
        await lib.loadAll(repo);
        fs.rmSync(f);
        expect(await lib.loadAll(repo)).toEqual([]);
    });
});
