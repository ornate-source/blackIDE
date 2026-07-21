import * as vscode from 'vscode';
import { SecretManager } from './secret-manager';
import { LLMClient } from './llm-client';
import { diffLines, Hunk } from './diff';

// Editor Inline Chat Controller — Feature 23 / MF-23
// Powers the Cmd+I multi-turn inline prompt editing loop with visual diff decorators and acceptance controls.

export class InlineChatController {
    private static addedLineDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(74, 222, 128, 0.15)', // Light green whole line background
        isWholeLine: true,
        overviewRulerColor: 'rgba(74, 222, 128, 0.6)',
        overviewRulerLane: vscode.OverviewRulerLane.Full
    });

    public static async start(context: vscode.ExtensionContext, secretManager: SecretManager): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active text editor open.');
            return;
        }

        const document = editor.document;
        const selection = editor.selection;
        
        // Take snapshot of original text and range to allow full revert / multi-turn updates
        const originalText = document.getText(selection) || document.lineAt(selection.active.line).text;
        const targetRange = document.getText(selection) 
            ? new vscode.Range(selection.start, selection.end)
            : new vscode.Range(document.lineAt(selection.active.line).range.start, document.lineAt(selection.active.line).range.end);

        let instruction = '';
        let loop = true;

        while (loop) {
            // Prompt input box
            const userPrompt = await vscode.window.showInputBox({
                prompt: 'Describe changes to apply inline',
                placeHolder: 'e.g. convert to arrow function, handle errors, optimize loop',
                value: instruction // Pre-fill with last instruction if editing again
            });

            if (!userPrompt) {
                // User cancelled input dialog
                break;
            }

            instruction = userPrompt;

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Applying inline changes...',
                cancellable: true
            }, async (progress, token) => {
                try {
                    const configJson = await secretManager.getKey('llm-config');
                    if (!configJson) {
                        throw new Error('No LLM configurations found. Please open Black IDE settings.');
                    }
                    
                    const configs = JSON.parse(configJson);
                    const settingsRaw = await secretManager.getKey('general-settings');
                    let settings = { selectedModelId: '' };
                    if (settingsRaw) {
                        settings = JSON.parse(settingsRaw);
                    }
                    
                    const modelConfig = configs.find((c: any) => c.id === settings.selectedModelId) || 
                                        configs.find((c: any) => c.enabled !== false) || 
                                        configs[0];
                                        
                    if (!modelConfig) {
                        throw new Error('No active or enabled model configured');
                    }

                    const systemPrompt = `You are a world-class code refactoring assistant. Apply the user's requested edit to the code snippet provided. Return ONLY the final corrected code, without markdown formatting or code block fences. Do not include any explanations.`;
                    
                    const fullPrompt = `${systemPrompt}\n\nRequest: ${instruction}\n\nCode Segment:\n${originalText}`;

                    const abortController = new AbortController();
                    token.onCancellationRequested(() => abortController.abort());

                    let replacement = '';
                    await LLMClient.streamCompletion(modelConfig, fullPrompt, (token) => {
                        replacement += token;
                    }, undefined, abortController.signal);

                    // Clean code fence blocks
                    replacement = replacement
                        .replace(/^```\w*\r?\n/, '')
                        .replace(/\r?\n```$/, '')
                        .replace(/^```/, '');

                    // Apply edit to editor range
                    await editor.edit((editBuilder) => {
                        editBuilder.replace(targetRange, replacement);
                    });

                    // Calculate decorations for diff review
                    const hunks = diffLines(originalText, replacement);
                    const decorations: vscode.DecorationOptions[] = [];
                    
                    // Track shifting line indexes in the modified editor content
                    let lineOffset = targetRange.start.line;
                    let runningOffset = 0;

                    for (const hunk of hunks) {
                        const hunkStartLine = lineOffset + hunk.start + runningOffset;
                        if (hunk.add.length > 0) {
                            for (let i = 0; i < hunk.add.length; i++) {
                                const currentLine = hunkStartLine + i;
                                const lineRange = document.lineAt(currentLine).range;
                                decorations.push({ range: lineRange });
                            }
                        }
                        // Update line offset based on added vs removed lines
                        runningOffset += (hunk.add.length - hunk.remove.length);
                    }

                    // Highlight the inserted lines
                    editor.setDecorations(this.addedLineDecoration, decorations);

                    // Show quick pick choice menu
                    const acceptOptions = [
                        { label: '$(check) Accept Changes', description: 'Apply changes and clear decorations', action: 'accept' },
                        { label: '$(pencil) Edit Again', description: 'Provide further instructions', action: 'edit' },
                        { label: '$(x) Reject Changes', description: 'Revert to original code', action: 'reject' }
                    ];

                    const choice = await vscode.window.showQuickPick(acceptOptions, {
                        placeHolder: 'Inline Edit Review',
                        ignoreFocusOut: true
                    });

                    // Clear decorations
                    editor.setDecorations(this.addedLineDecoration, []);

                    if (!choice || choice.action === 'reject') {
                        // Revert changes
                        await editor.edit((editBuilder) => {
                            const currentRange = new vscode.Range(
                                targetRange.start,
                                targetRange.start.translate(0, replacement.length)
                            );
                            // Best effort revert: re-insert original text
                            const fullDocText = document.getText();
                            const currentEndOffset = document.offsetAt(targetRange.start) + replacement.length;
                            const newEndPosition = document.positionAt(currentEndOffset);
                            const updatedRange = new vscode.Range(targetRange.start, newEndPosition);
                            editBuilder.replace(updatedRange, originalText);
                        });
                        loop = false;
                    } else if (choice.action === 'accept') {
                        loop = false;
                    } else if (choice.action === 'edit') {
                        // Revert changes first before re-prompter runs
                        await editor.edit((editBuilder) => {
                            const currentEndOffset = document.offsetAt(targetRange.start) + replacement.length;
                            const newEndPosition = document.positionAt(currentEndOffset);
                            const updatedRange = new vscode.Range(targetRange.start, newEndPosition);
                            editBuilder.replace(updatedRange, originalText);
                        });
                        // continues loop
                    }

                } catch (err: any) {
                    if (err.name === 'AbortError') {
                        vscode.window.showInformationMessage('Inline edit cancelled.');
                    } else {
                        vscode.window.showErrorMessage(`Inline edit failed: ${err.message}`);
                    }
                    loop = false;
                }
            });
        }
    }
}
