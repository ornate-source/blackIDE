import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    LexicalBackend,
    Language,
    languageOf,
    maskLiterals,
    planChunks,
} from '@blackide/agent-core/core/symbol-chunker';
// Tokenisation lives with the index that consumes it, not with the chunker.
import { splitIdentifier, stem } from '@blackide/agent-core/core/codebase-index';

/**
 * Phase 3, M14. The assertions are ordered by what would hurt most if it broke:
 * coverage first (silent content loss), then masking (silent region merging), then
 * per-language recognition.
 */

function plan(source: string, language: Language) {
    return planChunks(source, language) ?? [];
}

function symbols(source: string, language: Language): string[] {
    return plan(source, language).filter(p => p.symbol).map(p => p.symbol!);
}

describe('coverage invariant', () => {
    const CORPUS = path.join(__dirname, '..', 'eval', 'retrieval-corpus');

    function everyFile(dir: string, out: string[] = []): string[] {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) everyFile(full, out);
            else out.push(full);
        }
        return out;
    }

    it('assigns every line of every corpus file to exactly one chunk', () => {
        const violations: string[] = [];

        for (const file of everyFile(CORPUS)) {
            const content = fs.readFileSync(file, 'utf8');
            const plans = planChunks(content, languageOf(file));
            if (!plans) continue;   // line-window fallback covers by construction

            const total = content.split(/\r?\n/).length;
            const seen = new Uint8Array(total + 1);

            for (const p of plans) {
                for (let line = p.startLine; line <= p.endLine; line++) {
                    if (seen[line]) violations.push(`${path.basename(file)}:${line} covered twice`);
                    seen[line] = 1;
                }
            }
            for (let line = 1; line <= total; line++) {
                if (!seen[line]) violations.push(`${path.basename(file)}:${line} covered by nothing`);
            }
        }

        // Content that belongs to no chunk is unfindable forever, and content in two
        // chunks is double-counted by BM25. Both are silent, so they are asserted
        // over the whole corpus rather than a sample.
        expect(violations.slice(0, 10)).toEqual([]);
    });

    it('produces chunks for a majority of corpus files rather than falling back', () => {
        const files = everyFile(CORPUS).filter(f => /\.(ts|tsx|py|go|md)$/.test(f));
        const structured = files.filter(f =>
            planChunks(fs.readFileSync(f, 'utf8'), languageOf(f)) !== undefined);
        expect(structured.length / files.length).toBeGreaterThan(0.9);
    });
});

describe('maskLiterals', () => {
    it('preserves length and line structure exactly', () => {
        const src = 'const a = "hello";\n// comment\nfoo();\n';
        const masked = maskLiterals(src, 'typescript');
        expect(masked).toHaveLength(src.length);
        expect(masked.split('\n')).toHaveLength(src.split('\n').length);
    });

    it('blanks a brace inside a string so it cannot shift nesting', () => {
        const masked = maskLiterals('const s = "{";', 'typescript');
        expect(masked).not.toContain('{');
    });

    it('blanks a brace inside a line comment', () => {
        const masked = maskLiterals('foo(); // opens { here', 'typescript');
        expect(masked).not.toContain('{');
    });

    it('blanks a brace inside a block comment spanning lines', () => {
        const masked = maskLiterals('/*\n {\n*/\nfoo();', 'typescript');
        expect(masked).not.toContain('{');
    });

    it('blanks a brace inside a python docstring', () => {
        const masked = maskLiterals('def f():\n    """a { brace"""\n    pass', 'python');
        expect(masked).not.toContain('{');
    });

    it('does not run away on an escaped quote', () => {
        const masked = maskLiterals('const a = "he said \\"hi\\"";\nconst b = 1;', 'typescript');
        // `const b` must survive — proof the scanner left the string.
        expect(masked).toContain('const b = 1;');
    });

    it('keeps a hash inside a typescript string from acting as a comment', () => {
        const masked = maskLiterals('const url = "a#b";\nconst c = 2;', 'typescript');
        expect(masked).toContain('const c = 2;');
    });
});

describe('TypeScript', () => {
    const src = `
import { X } from './x';

/** Adds two numbers. */
export function add(a: number, b: number): number {
    return a + b;
}

export class Service {
    private cache = new Map<string, number>();

    /** Looks a value up. */
    async lookup(key: string): Promise<number> {
        return this.cache.get(key) ?? 0;
    }

    clear(): void {
        this.cache.clear();
    }
}

export const handler = async (req: Request) => {
    return new Response('ok');
};

export interface Shape { kind: string; }
export type Id = string;
`.trimStart();

    it('finds top-level functions, classes, interfaces and type aliases', () => {
        const found = symbols(src, 'typescript');
        expect(found).toContain('add');
        expect(found).toContain('Service');
        expect(found).toContain('Shape');
        expect(found).toContain('Id');
    });

    it('finds class methods as their own chunks', () => {
        const found = symbols(src, 'typescript');
        expect(found).toContain('lookup');
        expect(found).toContain('clear');
    });

    it('records the enclosing class as the parent of a method', () => {
        const lookup = plan(src, 'typescript').find(p => p.symbol === 'lookup');
        expect(lookup?.parent).toBe('Service');
    });

    it('finds an arrow function assigned to a const', () => {
        expect(symbols(src, 'typescript')).toContain('handler');
    });

    it('attaches the doc comment above a function to it', () => {
        const lines = src.split('\n');
        const add = plan(src, 'typescript').find(p => p.symbol === 'add')!;
        expect(lines[add.startLine - 1]).toContain('Adds two numbers');
    });

    it('does not mistake a call inside a body for a method declaration', () => {
        const body = `
class A {
    run() {
        doSomething(1);
        this.other(2);
    }
}
`.trimStart();
        expect(symbols(body, 'typescript')).toEqual(['A', 'run']);
    });
});

describe('Python', () => {
    const src = `
import os


class Repo:
    """A repository."""

    def get(self, key):
        return self._data[key]

    def put(self, key, value):
        self._data[key] = value


def helper(x):
    # a blank line inside a body must not end it

    return x * 2
`.trimStart();

    it('finds classes and module-level functions', () => {
        const found = symbols(src, 'python');
        expect(found).toContain('Repo');
        expect(found).toContain('helper');
    });

    it('finds methods and marks their parent class', () => {
        const get = plan(src, 'python').find(p => p.symbol === 'get');
        expect(get?.kind).toBe('method');
        expect(get?.parent).toBe('Repo');
    });

    it('does not end a function body at a blank line', () => {
        const helper = plan(src, 'python').find(p => p.symbol === 'helper')!;
        const text = src.split('\n').slice(helper.startLine - 1, helper.endLine).join('\n');
        expect(text).toContain('return x * 2');
    });
});

describe('Go, Rust, Java, C#', () => {
    it('finds Go functions, methods and types', () => {
        const src = `
package worker

type Queue struct {
	name string
}

func New(name string) *Queue {
	return &Queue{name: name}
}

func (q *Queue) Publish(msg string) error {
	return nil
}
`.trimStart();
        const found = symbols(src, 'go');
        expect(found).toContain('Queue');
        expect(found).toContain('New');
        expect(found).toContain('Publish');
    });

    it('finds Rust functions, structs, traits and impls', () => {
        const src = `
pub struct Backoff {
    base: u64,
}

pub trait Retry {
    fn delay(&self) -> u64;
}

impl Retry for Backoff {
    fn delay(&self) -> u64 {
        self.base
    }
}

pub async fn run() {}
`.trimStart();
        const found = symbols(src, 'rust');
        expect(found).toContain('Backoff');
        expect(found).toContain('Retry');
        expect(found).toContain('run');
    });

    it('finds Java classes and methods', () => {
        const src = `
public class Service {
    public int add(int a, int b) {
        return a + b;
    }
}
`.trimStart();
        const found = symbols(src, 'java');
        expect(found).toContain('Service');
        expect(found).toContain('add');
    });

    it('finds C# classes and methods', () => {
        const src = `
public class UsersController {
    public async Task<IActionResult> Index(int page) {
        return Ok();
    }
}
`.trimStart();
        const found = symbols(src, 'csharp');
        expect(found).toContain('UsersController');
        expect(found).toContain('Index');
    });
});

describe('Markdown', () => {
    const src = `
# Title

intro

## Section A

body a

### Nested

deep

## Section B

body b
`.trimStart();

    it('creates one region per heading', () => {
        expect(symbols(src, 'markdown')).toEqual(['Title', 'Section A', 'Nested', 'Section B']);
    });

    it('ignores a "#" inside a fenced code block', () => {
        const fenced = '# Real\n\n```\n# not a heading\n```\n\n## Also real\n';
        expect(symbols(fenced, 'markdown')).toEqual(['Real', 'Also real']);
    });
});

describe('fallback', () => {
    it('returns undefined for a language with no declaration patterns', () => {
        expect(planChunks('{"a": 1}', 'other')).toBeUndefined();
    });

    it('returns undefined for source with no recognisable structure', () => {
        expect(planChunks('const a = 1;\nconst b = 2;\n', 'typescript')).toBeUndefined();
    });

    it('never returns an empty plan list alongside a defined result', () => {
        const plans = planChunks('export function f() {\n  return 1;\n}\n', 'typescript');
        expect(plans && plans.length).toBeGreaterThan(0);
    });
});

describe('oversize splitting', () => {
    it('splits a very long function into bounded chunks', () => {
        const body = Array.from({ length: 300 }, (_, i) => `    const v${i} = ${i};`).join('\n');
        const src = `export function huge() {\n${body}\n}\n`;
        const plans = plan(src, 'typescript');
        for (const p of plans) {
            expect(p.endLine - p.startLine + 1).toBeLessThanOrEqual(80);
        }
    });
});

describe('splitIdentifier', () => {
    it('splits camelCase', () => {
        expect(splitIdentifier('convertMinor')).toEqual(['convert', 'minor']);
    });

    it('splits SCREAMING_SNAKE_CASE', () => {
        expect(splitIdentifier('MAX_RETRY_COUNT')).toEqual(['max', 'retry', 'count']);
    });

    it('splits an acronym run from the word that follows', () => {
        expect(splitIdentifier('HTTPResponse')).toEqual(['http', 'response']);
    });

    it('leaves a single lowercase word alone', () => {
        expect(splitIdentifier('order')).toEqual(['order']);
    });
});

describe('stem', () => {
    it('reduces the inflections that separate prose from identifiers', () => {
        expect(stem('converting')).toBe('convert');
        expect(stem('converts')).toBe('convert');
        expect(stem('reserved')).toBe('reserv');
        expect(stem('retries')).toBe('retry');
    });

    it('is idempotent, so the query and the index agree', () => {
        for (const word of ['converting', 'classes', 'status', 'calls', 'running', 'currency']) {
            expect(stem(stem(word))).toBe(stem(word));
        }
    });

    it('maps a base identifier and its inflections onto one token', () => {
        // The case stemming exists for: `reserveStock` yields the part `reserve`,
        // the question says `reserved`. They must land on the same term.
        expect(stem('reserve')).toBe(stem('reserved'));
        expect(stem('convert')).toBe(stem('converting'));
        expect(stem('store')).toBe(stem('stored'));
        expect(stem('delete')).toBe(stem('deletes'));
    });

    it('leaves short words and double-s endings intact', () => {
        expect(stem('is')).toBe('is');
        expect(stem('class')).toBe('class');
        expect(stem('status')).toBe('status');
    });

    it('does not mangle identifiers carrying digits', () => {
        expect(stem('sha256')).toBe('sha256');
        expect(stem('base64url')).toBe('base64url');
    });

    it('undoubles a consonant left by -ing/-ed', () => {
        expect(stem('running')).toBe('run');
        expect(stem('stopped')).toBe('stop');
    });

    it('leaves ll/ss endings alone when undoubling', () => {
        expect(stem('calling')).toBe('call');
        expect(stem('passed')).toBe('pass');
    });
});

describe('languageOf', () => {
    it('maps the six code languages plus markdown', () => {
        expect(languageOf('a/b.ts')).toBe('typescript');
        expect(languageOf('a/b.tsx')).toBe('typescript');
        expect(languageOf('a/b.py')).toBe('python');
        expect(languageOf('a/b.go')).toBe('go');
        expect(languageOf('a/b.rs')).toBe('rust');
        expect(languageOf('a/b.java')).toBe('java');
        expect(languageOf('a/b.cs')).toBe('csharp');
        expect(languageOf('a/b.md')).toBe('markdown');
    });

    it('returns "other" for anything unrecognised', () => {
        expect(languageOf('a/b.sql')).toBe('other');
        expect(languageOf('Makefile')).toBe('other');
    });
});

describe('backend contract', () => {
    it('LexicalBackend declines languages it does not handle', () => {
        expect(new LexicalBackend().regions('x', 'other')).toBeUndefined();
    });
});
