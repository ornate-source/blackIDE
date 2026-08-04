// ─── @blackide/agent-core (Phase 11, M62) ───────────────────────────────────
//
// The vscode-free surface of the agent, declared as a barrel rather than assembled by
// moving eighty files into a new directory.
//
// ── Why a barrel and not a `git mv` ──────────────────────────────────────────
// The gate is `grep -r "vscode"` in the core package returning nothing, and there are two
// ways to get there. One is to move every clean module into `packages/agent-core/` in a
// single change — a diff touching most of the repository, which the harness cannot
// meaningfully verify (every import path changes, so "still green" mostly proves the
// imports were rewritten correctly) and which no reviewer can read.
//
// The other is to **name the boundary and enforce it**, then move modules across it when
// there is a reason to. That is this file plus `__tests__/agent-core-boundary.test.ts`,
// which walks the import graph transitively from here and fails if anything reachable
// touches `vscode`. The property the gate is really asking for — *the core does not depend
// on an editor* — is then true, checked on every commit, and true incrementally rather
// than after one enormous change.
//
// The physical package move becomes a mechanical follow-up once the boundary is known to
// hold. Doing it in the other order is how a "decoupling" ships as a directory rename.
//
// ── What is deliberately NOT exported here ──────────────────────────────────
// Anything that needs an editor: the webview panels, the inline-completion and next-edit
// providers, the command registry, the rules/prompt/mode *loaders* (they own file watchers
// and Problems-panel collections), and the pipeline/chat entry points that wire them
// together. Those are the extension. They consume this; they are not part of it.

// ── The host seam ───────────────────────────────────────────────────────────
export * from './host';
export { createNodeHost } from './node-host';
export type { NodeHostOptions } from './node-host';

// ── Running headlessly (M63) ────────────────────────────────────────────────
// Exported because they are the SDK's entry point as much as the CLI's: embedding the
// loop means embedding these, and a caller who has to reach past the barrel into
// `agent-core/headless-run` is a caller the barrel is not serving.
/*
 * Retrieval and artifacts, across the boundary (Phase 11, M62 · P11-1).
 *
 * Both took two lines of `vscode` — `findFiles`/`asRelativePath` in the index, an
 * `ExtensionContext` and a `showTextDocument` in the artifact manager — and those four
 * lines kept the entire retrieval stack out of a package that has to run in a terminal.
 * Both now take what they actually needed: a file source and a directory.
 *
 * `tool-executor.ts` is deliberately *not* here. Its last direct `vscode` reference is
 * gone too, but it still reaches the LSP bridge, the browser and the editor's tool runner
 * — because it is the *editor's* executor, and `host-executor.ts` above is its
 * boundary-crossing counterpart. Two implementations of a narrow interface is the answer
 * M63 already gave; dragging this one across would leave the CLI loading five hundred
 * lines of editor semantics it can never execute.
 */
export { CodebaseIndex, directoryFileSource } from '../core/codebase-index';
export type { IndexFileSource } from '../core/codebase-index';
export { ArtifactManager } from '../agent/artifact-manager';
export type { Artifact, ArtifactManagerOptions } from '../agent/artifact-manager';

/*
 * The daemon (M65) and the remote runner (M66) are SDK surface, not internals.
 *
 * Exported here as much for the boundary test as for consumers: a module that is not
 * reachable from this barrel is not walked, so it could acquire a `vscode` import and
 * nothing would object until somebody tried to run the CLI. Everything in `agent-core/`
 * belongs in the graph the test enforces.
 */
/*
 * The CLI's own entry, exported so an SDK consumer can invoke a run the way the binary
 * does — and so the boundary walk covers it. `bin/blackide` is a three-line shim over
 * this; a module the shim needs but the graph never reaches is one free to acquire a
 * `vscode` import with nothing to object until somebody runs the CLI.
 */
export { main } from './main';

export { runDaemon, readResults, markResultSeen, enqueue } from './daemon';
export type { DaemonOptions, DaemonRunSummary } from './daemon';
export { remoteProcess, withRemoteRunner, validateRunnerConfig, validateRemoteResponse } from './remote-runner';
export type { RemoteRunnerConfig, RemoteExecRequest, RemoteExecResponse } from './remote-runner';
export {
    DAEMON_DIR, QUEUE_DIR, RESULTS_DIR, parseRequest, daemonInboxItems, mergeInbox,
} from '../core/daemon-protocol';
export type { DaemonRequest, DaemonResult } from '../core/daemon-protocol';

export { createHostExecutor, headlessTools } from './host-executor';
export type { HostExecutor, HostExecutorDeps } from './host-executor';
export { runHeadless, modelFromEnv } from './headless-run';
export type { HeadlessDeps, HeadlessResult } from './headless-run';
export { EXIT, parseArgs, exitCodeFor, renderEvent, renderHuman } from './cli';
export type { CliEvent, CliExit, CliOptions } from './cli';

// ── The loop and its context ────────────────────────────────────────────────
export { runAgentLoop } from '../agent/agent-loop';
export type { LoopCallbacks, LoopResult, LoopFailover, RollingSummarizer, SteeringSource } from '../agent/agent-loop';
export { ContextManager } from '../core/context-manager';
export { PromptBuilder, estimateTokens } from '../core/prompt-builder';

// ── Models ──────────────────────────────────────────────────────────────────
export { ModelRouter, ProviderHealth, runWithFailover, MODEL_ROLES } from '../core/model-router';
export type { ModelRole, Resolution, Substitution, RouterSettings } from '../core/model-router';
export { LLMClient, isAbortError, supportsNativeTools } from '../core/llm-client';
export { authHeaders, endpointFor, isOpenAICompatible } from '../core/providers';
export { verifyFastApply, buildApplyPrompt, extractBlocks, changedFraction } from '../core/fast-apply';

// ── Tools (definitions; execution needs a host) ─────────────────────────────
export { BASE_TOOLS, toolsForMode, isToolAllowedInMode, renderToolDocs } from '../core/tools';
export { advertisedTools, applyToolToggles, toolPanelEntries } from '../core/tool-toggles';
export { CommandPolicy } from '../core/command-policy';
export type { PolicyDecision } from '../core/command-policy';
export { ToolBreaker } from '../core/tool-breaker';

// ── Retrieval ───────────────────────────────────────────────────────────────
export { CodeGraph, resolveSpecifier } from '../core/code-graph';
export type { SymbolRegion, ChunkerBackend } from '../core/symbol-chunker';
export { LexicalReranker } from '../core/reranker';
export { compactGrep, withRawPointer } from '../core/output-compact';

// ── Project understanding ───────────────────────────────────────────────────
export { detectProjectProfile, formatProfileLine, stackMindmapSection, MANIFEST_FILENAMES } from '../core/project-profiler';
export type { ProjectProfile } from '../core/project-profiler';
export { selectTestCommand, parseTestOutput, formatTestReport } from '../core/test-report';
export { parseMindmap, renderMindmapContext } from '../core/mindmap-readback';

// ── Rules, skills and prompts (the pure halves) ─────────────────────────────
export { selectRules, renderRules, renderRequestableRules } from '../core/rules';
export type { Rule, RuleActivationReason } from '../core/rules';
export { validateSkill, KNOWN_SKILL_ROLES } from '../agent/skills-manager';
export { findPackViolations, validateEntry, parseRegistry, admitPack } from '../core/skill-registry';
export { parseSlashInvocation, expandPrompt, resolveWorkflow } from '../core/prompt-library';

// ── Memory ──────────────────────────────────────────────────────────────────
export { createMemory, injectable, renderForPrompt, bandFor } from '../core/memory-model';
export type { MemoryEntry, MemoryTier, MemoryType } from '../core/memory-model';
export { parseMemoryMarkdown, renderMemoryMarkdown } from '../core/memory-markdown';
export { sortCandidates, decideWrite, findContradictions, applyDecay, consolidate } from '../core/memory-lifecycle';
export { selectForSummary, applySummary, buildSummaryPrompt } from '../core/rolling-summary';

// ── Concurrency, runs and review ────────────────────────────────────────────
export { AgentGovernor } from '../core/agent-governor';
export { TaskAgentRegistry } from '../agent/task-agent-registry';
export type { TaskAgentSummary } from '../core/task-agents';
export { buildInbox, inboxCounts } from '../core/agent-inbox';
export { planRace, rankCandidates, pickWinner } from '../core/model-race';
export { SteeringQueue, applySteering, renderSteering } from '../core/steering';
export { planVerification, evaluateVerification, renderVerificationReport } from '../core/verification';

// ── Multi-root and safety ───────────────────────────────────────────────────
export { rootFor, relativeToRoot, resolveAgainstRoot, groupByRoot, defaultRootFor } from '../core/workspace-roots';
export type { WorkspaceRoot } from '../core/workspace-roots';
export { guardPath } from '../core/workspace-guard';
export { redact, redactDeep, describeFindings } from '../core/redaction';
export { UNTRUSTED_CONTENT_POSTURE, scanForInjection, fenceUntrusted } from '../core/untrusted-content';
export { AuditTrail, parseAuditTrail, auditRelativePath } from '../core/audit-trail';

// ── Notebooks ───────────────────────────────────────────────────────────────
export { parseNotebook, serializeNotebook, editCell, renderNotebook, summarizeCells } from '../core/notebook';

// ── Editor-side prediction (pure half) ──────────────────────────────────────
export { buildNextEditPrompt, parseProposal, validateProposal, isStale } from '../core/next-edit';
export { EditHistory } from '../core/edit-history';
