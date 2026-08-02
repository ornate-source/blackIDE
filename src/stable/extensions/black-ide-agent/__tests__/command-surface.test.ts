import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every contributed command is registered, and every registered command is contributed.
 *
 * `command-registry.ts` states the rule in a comment — "a command registered without
 * being contributed is invisible in the palette, and one contributed without being
 * registered throws when invoked" — and until Phase 5 nothing checked it. Phase 1 found
 * the same class of defect on the tool surface (`tool-surface.test.ts`): a thing can be
 * fully implemented, correctly wired, and silently unreachable, and neither the compiler
 * nor any runtime test notices.
 *
 * Phase 5 adds five commands and four keybindings, which is exactly when a comment should
 * become an assertion.
 */

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function sourceText(): string {
    const parts: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.ts$/.test(entry.name)) parts.push(fs.readFileSync(full, 'utf8'));
        }
    };
    walk(SRC);
    return parts.join('\n');
}

const source = sourceText();
const contributed: string[] = (manifest.contributes.commands || []).map((c: any) => c.command);
const registered = [...source.matchAll(/registerCommand\(\s*'([^']+)'/g)].map(m => m[1]);

describe('command surface', () => {
    it('contributes the Phase 5 commands', () => {
        for (const command of [
            'black-ide.nextEdit.jump',
            'black-ide.nextEdit.dismiss',
            'black-ide.nextEdit.showStats',
            'black-ide.terminalCommand',
            'black-ide.compactConversation',
        ]) {
            expect(contributed, `${command} is missing from contributes.commands`).toContain(command);
        }
    });

    it('registers every contributed command', () => {
        const missing = contributed.filter(c => !registered.includes(c));
        expect(missing, 'contributed but never registered — invoking these throws').toEqual([]);
    });

    it('contributes every registered command', () => {
        const missing = registered.filter(c => c.startsWith('black-ide.') && !contributed.includes(c));
        expect(missing, 'registered but not contributed — invisible in the palette').toEqual([]);
    });

    it('binds keys only to commands that exist', () => {
        const bound = (manifest.contributes.keybindings || []).map((k: any) => k.command);
        const unknown = bound.filter((c: string) => !contributed.includes(c));
        expect(unknown).toEqual([]);
    });
});

describe('keybinding guards', () => {
    const keybindings: any[] = manifest.contributes.keybindings || [];
    const find = (command: string) => keybindings.find(k => k.command === command);

    it('gates the next-edit jump on a prediction actually being armed', () => {
        // Without the context key the binding would swallow the key in every editor,
        // whether or not there is anything to jump to.
        expect(find('black-ide.nextEdit.jump')?.when).toContain('blackIde.nextEditAvailable');
    });

    it('does not bind next-edit to Tab', () => {
        // Tab is the obvious choice and the wrong one: if the context key ever leaks, the
        // developer loses indentation and completion accept, which is a far worse failure
        // than an unfamiliar shortcut. Discoverability is handled by the status bar item.
        const key = find('black-ide.nextEdit.jump')?.key;
        expect(key).not.toBe('tab');
    });

    it('lets Escape reach the widgets that own it before next-edit does', () => {
        const when = find('black-ide.nextEdit.dismiss')?.when ?? '';
        for (const guard of ['!suggestWidgetVisible', '!inlineSuggestionVisible', '!renameInputVisible', '!findWidgetVisible']) {
            expect(when, `Escape would be stolen from ${guard.slice(1)}`).toContain(guard);
        }
    });

    it('scopes the terminal command to terminal focus', () => {
        // Cmd+K in an editor is "delete line" and in the chat view is something else
        // again; unscoped, this would take a key that already means three things.
        expect(find('black-ide.terminalCommand')?.when).toBe('terminalFocus');
    });
});
