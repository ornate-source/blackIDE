import * as vscode from 'vscode';
import { execFile } from 'child_process';
import {
    ContextProviderRegistry,
    FileProvider,
    FolderProvider,
    GitProvider,
    ProblemsProvider,
    StaticListProvider,
    TerminalHistory,
    TerminalProvider,
} from './context-providers';
import { Rule } from './rules';
import { HistoryStore } from '../memory/history-store';
import { Skill } from '../agent/skills-manager';

// Assembly for the `@`-mention providers (Phase 3, M19).
//
// Separate from `extension.ts` on purpose: that file is under a ≤700 LOC gate it
// only just cleared (G10), and a registry that grows by one provider per phase is
// exactly the kind of wiring that quietly pushes it back over.

export interface ProviderSources {
    getRules(): Rule[];
    getSkills(): Skill[];
    historyStore: HistoryStore;
    terminalHistory: TerminalHistory;
    workspaceRoot(): string | undefined;
}

/** Runs git, resolving with stdout. Rejects with a readable message on failure. */
function makeGitRunner(root: () => string | undefined) {
    return (args: string[]): Promise<string> => new Promise((resolve, reject) => {
        const cwd = root();
        if (!cwd) return reject(new Error('no workspace folder open'));
        // execFile, not exec: arguments are passed as an array and never through a
        // shell, so a branch or path containing shell metacharacters cannot become
        // a command.
        execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).trim().split('\n')[0]));
            resolve(stdout.trim() || '(no output)');
        });
    });
}

export function buildContextProviders(sources: ProviderSources): ContextProviderRegistry {
    const registry = new ContextProviderRegistry();

    registry.register(new FileProvider());
    registry.register(new FolderProvider());
    registry.register(new ProblemsProvider());
    registry.register(new GitProvider(makeGitRunner(sources.workspaceRoot)));
    registry.register(new TerminalProvider(sources.terminalHistory));

    registry.register(new StaticListProvider(
        'rules', 'Rules', 'A project or team rule',
        async () => sources.getRules().map(rule => ({
            id: rule.name,
            label: rule.name,
            detail: `${rule.activation}${rule.globs?.length ? ` · ${rule.globs.join(', ')}` : ''}`,
            body: rule.body,
        })),
    ));

    registry.register(new StaticListProvider(
        'skills', 'Skills', 'A bundled or project skill pack',
        async () => sources.getSkills().map(skill => ({
            id: skill.name,
            label: skill.name,
            detail: [skill.stacks?.join(', '), skill.roles?.join(', ')].filter(Boolean).join(' · '),
            body: skill.instructions ?? '',
        })),
    ));

    registry.register(new StaticListProvider(
        'past-chats', 'Past chats', 'An earlier conversation in this workspace',
        async () => {
            const threads = sources.historyStore.getThreads() as any[];
            return threads.slice(0, 50).map(thread => ({
                id: String(thread.id),
                label: String(thread.title || 'Untitled'),
                detail: thread.updatedAt ? new Date(thread.updatedAt).toLocaleString() : undefined,
                // Only the transcript's text — a past thread's tool results can be
                // enormous and are rarely what the user means by "that conversation".
                body: renderThread(sources.historyStore, String(thread.id)),
            }));
        },
    ));

    return registry;
}

function renderThread(store: HistoryStore, threadId: string): string {
    try {
        const messages = (store.getConversationState(threadId) as any[]) || [];
        return messages
            .filter(m => typeof m?.content === 'string' && m.content.trim())
            .map(m => `${m.role}: ${m.content}`)
            .join('\n\n');
    } catch {
        return '';
    }
}

/** Convenience for callers that only have a `vscode` handle. */
export function currentWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
