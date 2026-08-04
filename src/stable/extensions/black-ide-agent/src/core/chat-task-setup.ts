import * as vscode from 'vscode';
import { AgentMode, LLMConfigEntry, ToolCall } from '@blackide/agent-core/core/types';
import { SecretManager } from '@blackide/agent-core/core/secret-manager';
import { CodebaseIndex } from '@blackide/agent-core/core/codebase-index';
import { ProjectProfile } from '@blackide/agent-core/core/project-profiler';
import { Rule } from '@blackide/agent-core/core/rules';
import { ChatTaskDeps } from '../agent/chat-task';
import { ArtifactStore } from '../agent/artifact-store';
import { MemoryTurn } from '../agent/memory-turn';
import { AgentScheduler } from '../agent/scheduler';
import { SkillDiagnostics } from '../agent/skill-diagnostics';
import { HistoryStore } from '../memory/history-store';
import { CheckpointManager } from './checkpoint-manager';
import { ChatSession } from './chat-session';
import { ContextProviderRegistry, TerminalHistory } from './context-providers';
import { ModeLoader } from './mode-loader';
import { SessionManager } from './session-manager';
import { generateConversationTitle } from './conversation-title';
import { OfficeHub } from './office-hub';

// ─── Assembling one chat turn's dependencies ────────────────────────────────
//
// `runAgentTask` takes eighteen explicit dependencies rather than a provider reference,
// deliberately — that is the shape the vscode-free `agent-core` extraction needs, and it
// is what stopped the chat task reading state the provider had already reassigned. The
// cost is an eighteen-line object literal, and `extension.ts` has a hard 700-line gate
// (G10) that it was sitting one line under.
//
// So the literal lives here. `extension.ts` keeps the *policy* — which turn runs, in which
// mode — and hands over the parts.

export interface ChatTaskParts {
    context: vscode.ExtensionContext;
    secretManager: SecretManager;
    historyStore: HistoryStore;
    checkpoints: CheckpointManager;
    codebaseIndex: CodebaseIndex;
    modeLoader: ModeLoader;
    sessions: SessionManager;
    scheduler: AgentScheduler;
    skillDiagnostics: SkillDiagnostics;
    bundledSkillsDir: string;
    session: ChatSession;
    rules: Rule[];
    terminalHistory: TerminalHistory;
    contextProviders: ContextProviderRegistry;
    view: vscode.WebviewView | undefined;
    artifacts: ArtifactStore;
    memoryTurn: MemoryTurn | undefined;
    /** The Office, for `read_run_log`. Absent before it is constructed. */
    office?: OfficeHub;
    getProjectProfile(): Promise<ProjectProfile>;
    scheduleAgentTask(tc: ToolCall, modelId: string, webview: vscode.Webview, mode: AgentMode): void;
}

export function buildChatTaskDeps(parts: ChatTaskParts): ChatTaskDeps {
    return {
        context: parts.context,
        secretManager: parts.secretManager,
        historyStore: parts.historyStore,
        checkpoints: parts.checkpoints,
        codebaseIndex: parts.codebaseIndex,
        modeLoader: parts.modeLoader,
        sessions: parts.sessions,
        scheduler: parts.scheduler,
        skillDiagnostics: parts.skillDiagnostics,
        bundledSkillsDir: parts.bundledSkillsDir,
        session: parts.session,
        rules: parts.rules,
        recordTerminal: (command, output) => parts.terminalHistory.record(command, output),
        contextProviders: parts.contextProviders,
        view: parts.view,
        getProjectProfile: parts.getProjectProfile,
        generateConversationTitle: (prompt: string, model: LLMConfigEntry) => generateConversationTitle(
            { historyStore: parts.historyStore, activeThreadId: parts.session.activeThreadId, view: parts.view },
            prompt, model),
        scheduleAgentTask: parts.scheduleAgentTask,
        artifacts: parts.artifacts,
        memoryTurn: parts.memoryTurn,
        /*
         * `read_run_log` (M84).
         *
         * Reaches the *journal*, not the live conversation: the point of the tool is that a
         * run can read what an earlier run did, including one that failed hours ago in a
         * window that has since been closed. Undefined when no Office is wired, which the
         * executor reports as a host configuration rather than as an empty log.
         */
        readRunLog: (params) => parts.office?.readLogForModel(params),
    };
}
