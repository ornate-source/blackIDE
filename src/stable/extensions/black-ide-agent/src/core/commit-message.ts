import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LLMClient } from './llm-client';
import { LLMConfigEntry } from './types';
import { SecretManager } from './secret-manager';

/**
 * Commit-message generation from the working tree.
 *
 * Extracted verbatim from `BlackIdeChatProvider.generateCommitMessage` /
 * `_requestLlmCommitMessage` (Phase 0, M2). The only provider state either half
 * used was `_secretManager`, so both become free functions taking it explicitly.
 *
 * Note the diff is assembled by hand rather than taken from `git diff` alone:
 * untracked files do not appear in `git diff HEAD`, so they are read and rendered
 * as synthetic add-only hunks. Without that, a commit whose entire content is new
 * files would produce a message describing nothing.
 */

/** Per-untracked-file read cap, so one large new file cannot blow the context budget. */
const UNTRACKED_PREVIEW_LIMIT = 10_000;

export async function generateCommitMessage(secretManager: SecretManager): Promise<void> {
    const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (!rootPath) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const gitExtension = vscode.extensions.getExtension<any>('vscode.git')?.exports;
    if (!gitExtension) {
        vscode.window.showErrorMessage('Git extension not found');
        return;
    }

    const git = gitExtension.getAPI(1);
    const repo = git.repositories[0];
    if (!repo) {
        vscode.window.showErrorMessage('No Git repository found in workspace');
        return;
    }

    const { exec } = require('child_process');

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Generating commit message...",
        cancellable: false
    }, async () => {
        return new Promise<void>((resolve) => {
            // Get git status porcelain to find all changes (including untracked files)
            exec('git status --porcelain', { cwd: rootPath }, async (err: any, statusOut: string) => {
                const lines = (statusOut || '').trim().split(/\r?\n/).filter(line => line.trim());
                if (lines.length === 0) {
                    vscode.window.showInformationMessage('No changes detected to generate commit message.');
                    resolve();
                    return;
                }

                const untrackedFiles: string[] = [];
                const trackedChanges: string[] = [];

                for (const line of lines) {
                    const status = line.slice(0, 2);
                    const filePath = line.slice(3).replace(/^"|"$/g, '').trim();

                    if (status === '??') {
                        untrackedFiles.push(filePath);
                    } else {
                        trackedChanges.push(filePath);
                    }
                }

                // 1. Get diff of tracked files (both staged and unstaged against HEAD)
                const getTrackedDiff = () => {
                    return new Promise<string>((res) => {
                        if (trackedChanges.length === 0) {
                            res('');
                            return;
                        }
                        exec('git diff HEAD', { cwd: rootPath }, (errDiff: any, stdoutDiff: string) => {
                            res(stdoutDiff || '');
                        });
                    });
                };

                // 2. Read contents of untracked files to construct mock diffs
                const getUntrackedDiffs = () => {
                    let untrackedDiff = '';
                    for (const file of untrackedFiles) {
                        try {
                            const absPath = path.join(rootPath, file);
                            if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
                                const content = fs.readFileSync(absPath, 'utf8');
                                // limit size to prevent context overflow (e.g. max 10KB per untracked file)
                                const preview = content.length > UNTRACKED_PREVIEW_LIMIT
                                    ? content.slice(0, UNTRACKED_PREVIEW_LIMIT) + '\n... (truncated)'
                                    : content;
                                untrackedDiff += `\n\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${preview.split('\n').length} @@\n`;
                                untrackedDiff += preview.split('\n').map(l => '+' + l).join('\n');
                            }
                        } catch (e) {
                            // skip unreadable files
                        }
                    }
                    return untrackedDiff;
                };

                const trackedDiff = await getTrackedDiff();
                const untrackedDiff = getUntrackedDiffs();

                const diffContent = (trackedDiff + untrackedDiff).trim();

                if (!diffContent) {
                    vscode.window.showInformationMessage('No readable changes detected.');
                    resolve();
                    return;
                }

                await requestLlmCommitMessage(secretManager, diffContent, repo, resolve);
            });
        });
    });
}

async function requestLlmCommitMessage(
    secretManager: SecretManager,
    diff: string,
    repo: any,
    resolve: () => void
): Promise<void> {
    try {
        const configJson = await secretManager.getKey('llm-config');
        if (!configJson) {
            vscode.window.showErrorMessage('No LLM configurations found. Please configure models in settings.');
            resolve();
            return;
        }

        const configs: LLMConfigEntry[] = JSON.parse(configJson);
        let activeModelId = '';
        try {
            const settingsRaw = await secretManager.getKey('general-settings');
            if (settingsRaw) {
                const settings = JSON.parse(settingsRaw);
                activeModelId = settings.selectedModelId || '';
            }
        } catch {}

        const modelConfig = configs.find(c => c.id === activeModelId) || configs.find(c => c.enabled !== false) || configs[0];
        if (!modelConfig) {
            vscode.window.showErrorMessage('No active or enabled model configured');
            resolve();
            return;
        }

        const prompt = `You are an expert developer. Generate a concise, high-quality git commit message following the Conventional Commits specification for the following changes. Do not include any explanations, greetings, markdown formatting, or bullet points. Output ONLY the raw commit message itself, in a single line if possible, or with a description if the changes are complex.

Here is the git diff:
${diff}`;

        let commitMessage = '';
        await LLMClient.streamCompletion(modelConfig, prompt, (token) => {
            commitMessage += token;
        });

        if (commitMessage) {
            repo.inputBox.value = commitMessage.trim();
        } else {
            vscode.window.showWarningMessage('Empty commit message generated.');
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to generate commit message: ${err.message}`);
    } finally {
        resolve();
    }
}
