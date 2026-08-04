import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentMode, LLMConfigEntry, ChatMessage } from '@blackide/agent-core/core/types';
import { SecretManager } from '@blackide/agent-core/core/secret-manager';
import { CheckpointManager } from './checkpoint-manager';
import { ModeLoader } from './mode-loader';
import { SessionManager } from './session-manager';
import { ChatSession } from './chat-session';
import { HistoryStore } from '../memory/history-store';
import { PlanningEngine } from '../agent/planning-engine';
import { performFetchModels } from '../agent/model-fetcher';
import { PromptLibrary } from './prompt-library-loader';
import { parseSlashInvocation, expandPrompt, resolveWorkflow } from '@blackide/agent-core/core/prompt-library';
import { Rule } from '@blackide/agent-core/core/rules';
import { ContextProviderRegistry } from './context-providers';
import { advertisedTools, applyToggle, toolPanelEntries } from '@blackide/agent-core/core/tool-toggles';
import { compactSession } from './compact-session';

/**
 * Router for messages arriving from the chat webview.
 *
 * Extracted from `BlackIdeChatProvider.resolveWebviewView` (Phase 0, M2 follow-up),
 * where a 340-line `switch` sat inside the view-resolution method. Its dependency
 * list is wide because that is what a router *is* — its whole job is dispatching UI
 * intents onto the provider's operations. Naming them in `WebviewMessageHost` makes
 * the coupling explicit and, for the first time, testable: a suite can assert that
 * message X invokes operation Y without standing up an extension host.
 *
 * `session` is shared by reference with the provider and the chat task, so a
 * reassignment made mid-task is visible here — see core/chat-session.ts.
 */
export interface WebviewMessageHost {
    readonly session: ChatSession;
    readonly view: vscode.WebviewView | undefined;
    readonly context: vscode.ExtensionContext;
    readonly secretManager: SecretManager;
    readonly historyStore: HistoryStore;
    readonly checkpoints: CheckpointManager;
    readonly modeLoader: ModeLoader;
    readonly sessions: SessionManager;
    readonly onOpenSettings?: () => void;
    /** User-defined slash commands (Phase 2, M12). */
    readonly promptLibrary: PromptLibrary;
    /** Discovered rules, for the session panel's toggle handling (Phase 2, M10). */
    readonly rules: Rule[];
    /** `@`-mention providers (Phase 3, M19). */
    readonly contextProviders: ContextProviderRegistry;

    getHtmlForWebview(webview: vscode.Webview, viewType: 'chat' | 'settings' | 'manager'): string;
    getActiveEditorSelectionContext(): Promise<string>;
    postCheckpoints(webview: vscode.Webview): void;
    reportUndo(result: { restored: string[]; conflicted: string[] }, webview: vscode.Webview): void;
    refreshTelemetryEnabled(): Promise<void>;
    runAgentTask(userPrompt: string, modelId: string, attachments?: any[], mode?: string): Promise<void>;
    /** Parameter order matches the provider's method exactly — the call sites are verbatim. */
    runAgentTaskExecution(originalPrompt: string, modelId: string, planContent: string, taskContent: string, attachments?: any[], mode?: string): Promise<void>;
    runPipeline(userPrompt: string, modelId: string): Promise<void>;
    exportDiagnostics(): Promise<void>;
}

/** Handle one message from the chat webview. Never throws into the message pump. */
export async function handleWebviewMessage(
    host: WebviewMessageHost,
    webview: vscode.Webview,
    data: any,
): Promise<void> {
    switch (data.type) {
        case 'openSettingsPanel':
            if (host.onOpenSettings) {
                host.onOpenSettings();
            }
            break;
        case 'showError':
            vscode.window.showErrorMessage(data.value);
            break;
        case 'showInfo':
            vscode.window.showInformationMessage(data.value);
            break;
        case 'loadLlmConfig':
            const config = await host.secretManager.getKey('llm-config');
            webview.postMessage({ type: 'setLlmConfig', value: config });
            break;
        case 'saveLlmConfig':
            await host.secretManager.saveKey('llm-config', data.value);
            vscode.window.showInformationMessage(`LLM Configuration saved successfully!`);
            webview.postMessage({ type: 'llmConfigSaved', success: true });
            break;
        case 'loadSettings':
            {
                const settingsJson = await host.secretManager.getKey('general-settings');
                webview.postMessage({
                    type: 'setSettings',
                    value: settingsJson
                });
            }
            break;
        case 'openEditorSettings':
            vscode.commands.executeCommand('workbench.action.openSettings');
            break;
        case 'openExtensions':
            vscode.commands.executeCommand('workbench.action.showExtensions');
            break;
        case 'saveSettings':
            await host.secretManager.saveKey('general-settings', data.value);
            // Pick up an anonymous-telemetry toggle without needing a restart.
            await host.refreshTelemetryEnabled();
            break;
        case 'exportDiagnostics':
            await host.exportDiagnostics();
            break;
        case 'installBrowserSupport':
            vscode.commands.executeCommand('black-ide.installBrowserSupport');
            break;
        case 'fetchModels':
            try {
                const fetched = await performFetchModels(data.value);
                webview.postMessage({
                    type: 'fetchedModelsResult',
                    success: true,
                    provider: data.value?.provider,
                    value: fetched
                });
            } catch (err: any) {
                webview.postMessage({
                    type: 'fetchedModelsResult',
                    success: false,
                    provider: data.value?.provider,
                    error: err.message || 'Discovery connection failed'
                });
            }
            break;
        case 'attachFile':
            const fileUris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Attach',
                filters: {
                    'All Files': ['*'],
                    'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
                    'Documents': ['md', 'txt', 'pdf', 'json', 'yaml', 'yml'],
                }
            });
            if (fileUris && fileUris.length > 0) {
                const uri = fileUris[0];
                const fileName = path.basename(uri.fsPath);
                const ext = path.extname(fileName).toLowerCase();
                const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext);
                webview.postMessage({
                    type: 'fileAttached',
                    value: {
                        name: fileName,
                        path: uri.fsPath,
                        type: isImage ? 'image' : 'file',
                    }
                });
            }
            break;
        case 'startAgentTask':
            // Guard: block new messages while a plan is pending review
            if (host.session.pendingApproval || host.session.pendingPipelineApproval) {
                vscode.window.showWarningMessage('A plan is pending review. Please approve or reject it before sending a new message.');
                break;
            }
            // Intercept slash commands — Feature 7: Enhanced slash commands
            let modifiedPrompt = data.prompt || '';
            if (modifiedPrompt.startsWith('/explain')) {
                const codeContext = await host.getActiveEditorSelectionContext();
                modifiedPrompt = `Explain the following code block:\n\n\`\`\`\n${codeContext}\n\`\`\`\n\nUser Question: ${modifiedPrompt.replace('/explain', '').trim()}`;
            } else if (modifiedPrompt.startsWith('/test')) {
                const codeContext = await host.getActiveEditorSelectionContext();
                modifiedPrompt = `Write comprehensive unit tests for the following code block:\n\n\`\`\`\n${codeContext}\n\`\`\`\n\nUser Request: ${modifiedPrompt.replace('/test', '').trim()}`;
            } else if (modifiedPrompt.startsWith('/fix')) {
                const codeContext = await host.getActiveEditorSelectionContext();
                modifiedPrompt = `Find bugs, issues, or compile errors in the following code block and suggest fixes:\n\n\`\`\`\n${codeContext}\n\`\`\`\n\nUser Request: ${modifiedPrompt.replace('/fix', '').trim()}`;
            } else if (modifiedPrompt.startsWith('/commit')) {
                await host.runAgentTask(`Generate a conventional commit message for the git diff.`, data.modelId, data.attachments, data.mode);
                return;
            } else if (modifiedPrompt.startsWith('/refactor')) {
                const codeContext = await host.getActiveEditorSelectionContext();
                modifiedPrompt = `Refactor the following code for better readability, performance, and maintainability:\n\n\`\`\`\n${codeContext}\n\`\`\`\n\nUser Request: ${modifiedPrompt.replace('/refactor', '').trim()}`;
            } else if (modifiedPrompt.startsWith('/docs')) {
                const codeContext = await host.getActiveEditorSelectionContext();
                modifiedPrompt = `Generate comprehensive documentation (JSDoc/docstrings/comments) for:\n\n\`\`\`\n${codeContext}\n\`\`\`\n\n${modifiedPrompt.replace('/docs', '').trim()}`;
            } else if (modifiedPrompt.startsWith('/search')) {
                modifiedPrompt = `Search the workspace for: ${modifiedPrompt.replace('/search', '').trim()}. Use the grep_search tool to find relevant code.`;
            } else if (modifiedPrompt.startsWith('/plan')) {
                modifiedPrompt = modifiedPrompt.replace('/plan', '').trim();
                // Planning mode will be auto-detected by PlanningEngine
            } else if (/^\/compact\b/.test(modifiedPrompt)) {
                // M30's manual override. Handled here and returned rather than falling
                // through, because the alternative — which is what shipped until now — is
                // that the literal string "/compact" is sent to the model as a task.
                const outcome = await compactSession({
                    session: host.session,
                    secretManager: host.secretManager,
                    historyStore: host.historyStore,
                    webview,
                });
                if (outcome.folded) {
                    vscode.window.showInformationMessage(`Compacted ${outcome.folded} earlier messages into a summary.`);
                } else if (outcome.reason) {
                    vscode.window.showWarningMessage(outcome.reason);
                }
                return;
            } else {
                // User-defined prompts (Phase 2, M12). Checked *after* every built-in, and
                // reserved names are refused at load time, so a user file can never shadow
                // `/plan` or `/commit` and silently change what those do.
                const invocation = parseSlashInvocation(modifiedPrompt);
                const userPrompt = invocation && host.promptLibrary.get(invocation.name);
                if (invocation && userPrompt) {
                    const workflow = resolveWorkflow(userPrompt, new Map(host.promptLibrary.getAll().map(p => [p.name, p])));
                    if (workflow.cycle) {
                        vscode.window.showErrorMessage(
                            `Prompt workflow "/${userPrompt.name}" refers back to itself (${workflow.cycle.join(' → ')}). Fix the "steps" chain.`,
                        );
                        break;
                    }
                    // A single prompt is just a one-step workflow, so both paths share this.
                    // Steps run sequentially: each is a full agent task, and the next starts
                    // only once the previous returns.
                    const mode = userPrompt.mode || data.mode;
                    for (const step of workflow.steps) {
                        const expanded = expandPrompt(step.template, invocation.args);
                        if (!expanded) continue;
                        await host.runAgentTask(expanded, data.modelId, data.attachments, step.mode || mode);
                    }
                    return;
                }
            }
            
            if (PlanningEngine.shouldOrchestrate(modifiedPrompt, data.mode)) {
                modifiedPrompt = modifiedPrompt.replace('/orchestrate', '').trim();
                await host.runPipeline(modifiedPrompt, data.modelId);
            } else {
                // Strip the /single opt-out marker so it never reaches the model.
                modifiedPrompt = modifiedPrompt.replace(/^\/single\b/, '').trim();
                await host.runAgentTask(modifiedPrompt, data.modelId, data.attachments, data.mode);
            }
            break;
        case 'toggleRule': {
            // Session-scoped rule toggles (Phase 2, M10). A team-scoped rule is not the
            // user's to switch off — selectRules enforces that, and the panel does not
            // offer the control, but the message could still arrive from a stale webview.
            const name = String(data.value?.name || '');
            const enable = !!data.value?.enabled;
            if (!name) break;

            const rule = host.rules.find(r => r.name.toLowerCase() === name.toLowerCase());
            if (rule?.scope === 'team' && !enable) {
                vscode.window.showWarningMessage(`"${rule.name}" is a team rule and cannot be disabled.`);
                break;
            }

            const drop = (xs: string[]) => xs.filter(x => x.toLowerCase() !== name.toLowerCase());
            if (rule?.activation === 'manual') {
                host.session.enabledRules = enable ? [...drop(host.session.enabledRules), name] : drop(host.session.enabledRules);
            } else {
                host.session.disabledRules = enable ? drop(host.session.disabledRules) : [...drop(host.session.disabledRules), name];
            }
            webview.postMessage({
                type: 'ruleTogglesChanged',
                value: { enabled: host.session.enabledRules, disabled: host.session.disabledRules },
            });
            break;
        }
        case 'toggleTool': {
            // Session-scoped tool toggles (Phase 2, M10) — the tools half of the panel.
            // `applyToggle` refuses to disable `complete_task` (the loop's terminator), so
            // a stale webview cannot wedge the agent through this message.
            const name = String(data.value?.name || '');
            if (!name) break;
            host.session.disabledTools = applyToggle(host.session.disabledTools, name, !!data.value?.enabled);
            webview.postMessage({ type: 'toolTogglesChanged', value: { disabled: host.session.disabledTools } });
            break;
        }
        case 'requestTools': {
            // The panel needs the toggleable set *before* the first turn, and it must be
            // the set for the mode the user is actually in — showing Agent's write tools
            // while Ask is selected would offer switches for capabilities the mode does
            // not have. Each turn re-posts the real list from `chat-task.ts`, which also
            // accounts for browser availability; this pre-turn view is mode-accurate and
            // says nothing about the browser it cannot check from here.
            webview.postMessage({
                type: 'toolsAvailable',
                value: toolPanelEntries(advertisedForMode(host, String(data.value || 'agent')), host.session.disabledTools),
            });
            break;
        }
        case 'openModeSelector':
            const allModes = host.modeLoader.getSelectableModes();
            const currentMode = data.value || 'agent';
            const items = allModes.map(m => ({
                label: `${m.icon ? `$(${m.icon}) ` : ''}${m.name}`,
                description: m.description,
                detail: `Source: ${m.source}`,
                modeName: m.name.toLowerCase()
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select Agent Mode',
                matchOnDescription: true
            });
            
            if (selected) {
                webview.postMessage({ type: 'setMode', value: selected.modeName });
            }
            break;
        case 'stopAgentTask':
            if (host.session.abortController) {
                host.session.abortController.abort();
                webview.postMessage({ type: 'log', value: '[Agent] Cancellation requested.' });
            }
            break;
        case 'restoreCheckpoint': {
            // Undo a whole task by id, or the most recent one if none is given.
            const target = data.value?.checkpointId || host.checkpoints.latest?.id;
            if (!target) { vscode.window.showInformationMessage('No checkpoint available to restore.'); break; }
            host.reportUndo(host.checkpoints.undo(target), webview);
            break;
        }
        case 'undoMessage': {
            // Per-message undo: revert exactly the files that one agent response changed.
            const cp = host.checkpoints.forMessage(data.value);
            if (!cp) { vscode.window.showInformationMessage('That response made no file changes.'); break; }
            host.reportUndo(host.checkpoints.undo(cp.id), webview);
            break;
        }
        case 'redoCheckpoint': {
            const r = host.checkpoints.redo(data.value?.checkpointId);
            vscode.window.showInformationMessage(`Re-applied ${r.restored.length} file(s).`);
            host.postCheckpoints(webview);
            break;
        }
        case 'keepFile':
            host.checkpoints.keepFile(data.value?.checkpointId, data.value?.path);
            host.postCheckpoints(webview);
            break;
        case 'restoreFile': {
            const r = host.checkpoints.restoreFile(data.value?.checkpointId, data.value?.path);
            host.reportUndo(r, webview);
            break;
        }
        case 'listCheckpoints':
            host.postCheckpoints(webview);
            break;
        case 'getCheckpointDiff': {
            const diffLines = host.checkpoints.getInlineDiffPreview(data.value?.checkpointId, data.value?.path);
            webview.postMessage({ 
                type: 'checkpointDiffResult', 
                value: { checkpointId: data.value?.checkpointId, path: data.value?.path, diff: diffLines } 
            });
            break;
        }
        case 'cancelSubagent': {
            const controller = host.session.subagentAbortControllers.get(data.value);
            if (controller) {
                controller.abort();
            }
            break;
        }
        case 'approvePlan': {
            if (host.session.pendingPipelineApproval) {
                const pending = host.session.pendingPipelineApproval;
                host.session.pendingPipelineApproval = null;
                pending.resolve(true);
                break;
            }
            if (!host.session.pendingApproval) {
                vscode.window.showErrorMessage('No pending plan to approve.');
                break;
            }
            const pending = host.session.pendingApproval;
            host.session.pendingApproval = null;
            // Clear persisted pending state
            await host.historyStore.clearConversationState(`pending-plan-${host.session.activeThreadId}`);
            // Run execution phase with the approved plan injected as context
            await host.runAgentTaskExecution(
                pending.originalPrompt,
                pending.modelId,
                pending.planContent,
                pending.taskContent,
                pending.attachments,
                pending.mode
            );
            break;
        }
        case 'rejectPlan': {
            const feedback = data.value?.feedback || '';
            if (host.session.pendingPipelineApproval) {
                const pending = host.session.pendingPipelineApproval;
                host.session.pendingPipelineApproval = null;
                pending.resolve(false);
                webview.postMessage({ type: 'planRejected', value: feedback });
                webview.postMessage({ type: 'taskComplete' });
                vscode.window.showInformationMessage('Pipeline plan rejected.');
                break;
            }
            host.session.pendingApproval = null;
            // Clear persisted pending state
            await host.historyStore.clearConversationState(`pending-plan-${host.session.activeThreadId}`);
            webview.postMessage({ type: 'planRejected', value: feedback });
            webview.postMessage({ type: 'taskComplete' });
            if (feedback) {
                vscode.window.showInformationMessage('Plan rejected. Send a new message with revised instructions.');
            } else {
                vscode.window.showInformationMessage('Plan rejected.');
            }
            break;
        }
        case 'newConversation':
            // A fresh thread starts with a clean memory, or the agent answers the
            // new question in terms of the old one.
            host.session.conversation = [];
            host.session.activeThreadId = data.value || `thread-${Date.now()}`;
            host.sessions.newConversation();
            await host.historyStore.clearConversationState(host.session.activeThreadId);
            break;
        case 'switchThread': {
            // Abort any in-flight generation to prevent cross-thread contamination
            if (host.session.isGenerating && host.session.abortController) {
                host.session.abortController.abort();
                host.session.isGenerating = false;
            }
            host.session.activeThreadId = data.value;
            host.session.conversation = host.historyStore.getConversationState(data.value) || [];
            host.sessions.newConversation(); // Reset session for the new thread
            // Clear any pending plan approval to prevent cross-thread contamination
            host.session.pendingApproval = null;
            // The pipeline's approval Promise isn't tied to _abortController — resolve
            // it as rejected so orchestrator.run() doesn't hang forever on an orphaned thread.
            if (host.session.pendingPipelineApproval) {
                host.session.pendingPipelineApproval.resolve(false);
                host.session.pendingPipelineApproval = null;
            }
            break;
        }
        case 'openArtifact':
            try {
                const doc = await vscode.workspace.openTextDocument(data.value);
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch (e: any) {
                vscode.window.showErrorMessage(`Could not open artifact: ${e.message}`);
            }
            break;
        case 'loadHistory':
            const threads = host.historyStore.getThreads();
            webview.postMessage({ type: 'setHistory', value: threads });
            break;
        case 'saveHistoryThread':
            const { id, title, messages } = data.value;
            await host.historyStore.saveThread(id, title, messages);
            webview.postMessage({ type: 'setHistory', value: host.historyStore.getThreads() });
            break;
        case 'deleteHistoryThread':
            await host.historyStore.deleteThread(data.value);
            webview.postMessage({ type: 'setHistory', value: host.historyStore.getThreads() });
            break;
        case 'clearHistory':
            await host.historyStore.clear();
            webview.postMessage({ type: 'setHistory', value: [] });
            break;
        case 'searchFiles': {
            // Legacy shape, kept working verbatim (Phase 3, M19). The webview's
            // dropdown now uses `contextSuggest` below; this remains because a
            // stale webview surviving an extension reload would otherwise get an
            // empty list with no error, which looks exactly like "no matches".
            const query = data.value || '';
            const groups = await host.contextProviders.suggest(query);
            const fileGroup = groups.find(g => g.provider === 'file');
            webview.postMessage({
                type: 'searchFilesResponse',
                value: (fileGroup?.items ?? []).map(i => i.id),
            });
            break;
        }
        case 'contextSuggest': {
            const groups = await host.contextProviders.suggest(String(data.value ?? ''));
            webview.postMessage({ type: 'contextSuggestResponse', value: groups });
            break;
        }
        case 'contextProviders':
            webview.postMessage({
                type: 'contextProvidersResponse',
                value: host.contextProviders.list().map(p => ({ id: p.id, title: p.title, description: p.description })),
            });
            break;
        case 'autoDetectOllama':
            try {
                const ollamaResponse = await fetch('http://localhost:11434/api/tags');
                if (ollamaResponse.ok) {
                    const ollamaData: any = await ollamaResponse.json();
                    if (ollamaData && Array.isArray(ollamaData.models)) {
                        const detectedModels = ollamaData.models.map((m: any) => ({
                            id: `ollama-${m.name}`,
                            name: `Ollama: ${m.name}`,
                            type: 'local',
                            url: 'http://localhost:11434/v1/chat/completions',
                            model: m.name,
                            enabled: true
                        }));
                        webview.postMessage({ type: 'ollamaDetected', value: detectedModels });
                        vscode.window.showInformationMessage(`Successfully auto-detected ${detectedModels.length} Ollama models!`);
                    } else {
                        vscode.window.showWarningMessage('Ollama responded but returned no models.');
                    }
                } else {
                    vscode.window.showErrorMessage('Ollama server returned an error.');
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Ollama server unreachable: ${e.message}`);
            }
            break;
    }
}

/**
 * The tool list for a mode name coming from the webview.
 *
 * Resolves the coarse sandbox the same way `chat-task.ts` does — only Ask and Plan are
 * distinct sandboxes, every other mode (custom or built-in) runs as `agent` and is
 * shaped by its declared `tools` array. Getting this wrong in either direction is a
 * lie in the panel, not a cosmetic issue.
 */
function advertisedForMode(host: WebviewMessageHost, modeName: string) {
    const def = host.modeLoader.getMode(modeName || 'agent');
    const lowered = def?.name.toLowerCase();
    const coarse: AgentMode = lowered === 'ask' || lowered === 'plan' ? lowered as AgentMode : 'agent';
    return advertisedTools(coarse, def?.tools);
}
