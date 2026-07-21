# Black IDE: Deep Technical Architecture & Connectivity Specs

This document explores the granular technical implementation details, connectivity patterns, and performance considerations that bind the Black IDE components together.

## 🔌 1. The PostMessage IPC Bridge (Webview ↔ Extension Host)

VS Code strictly enforces an Inter-Process Communication (IPC) barrier between the webview rendering layer (Chromium/React) and the Extension Host (Node.js backend). 

### Transport Layer Implementation
- **Direction A: Webview ➔ Host**
  - Triggered via `acquireVsCodeApi().postMessage(data)`.
  - In `extension.ts`, this is caught by `webviewView.webview.onDidReceiveMessage(async (data: any) => {...})`.
  - The payload structure is strictly typed: `{ type: string, value?: any }`.
  - Complex tasks (like `startAgentTask`) bundle configuration, prompts, file attachments, and user intents in this single JSON blob.

- **Direction B: Host ➔ Webview**
  - The Host publishes to the webview using `webview.postMessage(data)`.
  - In `App.tsx`, this is subscribed to via `window.addEventListener('message', event => {...})`.
  - To prevent tight coupling, the host wraps almost all tool and loop actions into the internal `EventBus`.

### The EventBus Abstraction
Instead of passing `webview.postMessage` explicitly deep into the `ToolRegistry` or `CheckpointManager`, the host uses a centralized `EventBus` (an EventEmitter wrapper).
```typescript
// Any subsystem can broadcast:
this._bus.emit({ type: 'ToolFinished', result, durationMs });

// extension.ts pipes everything to the UI transparently:
this._bus.onAny((event) => {
    this._view?.webview.postMessage({ type: 'agentEvent', value: event });
});
```
This decoupling enables headless execution (e.g. running the agent from the CLI or a test suite) because subsystems have no dependency on the VS Code Webview object.

## 📦 2. State Management & Hydration Architecture

Black IDE maintains three heavily isolated state pools. Keeping them synchronized across failures, reloads, and thread switches requires defensive hydration logic.

### 2.1 The React Reducer (`agent-store.ts`)
The Webview uses a complex `useReducer` to convert the raw event stream into a normalized UI.
```typescript
const [agentState, dispatchAgent] = useReducer(agentReducer, initialAgentState);
```
When `agentEvent` messages arrive over the bridge, they are pushed directly into `dispatchAgent()`. 
- `ToolStarted` adds a new item to `state.activity` (marked as `status: 'running'`).
- `ToolFinished` scans `state.activity` for the matching ID, marks it as `done`, and injects the output string (truncated for DOM performance).

**UI Hydration (vscode.getState)**:
To survive window reloads, the React app hooks into VS Code's internal webview state cache:
```typescript
const state = vscode.getState();
// Hydrate the conversation messages
const [messages, setMessages] = useState(state?.messages || []);
// Persist whenever it changes
useEffect(() => vscode.setState({ messages }), [messages]);
```

### 2.2 Host Conversation State (`history-store.ts`)
The Extension Host maintains the "Truth" of the LLM conversation window (the `ChatMessage[]` array passed into `agent-loop.ts`).
- It uses `vscode.Memento` (a global key-value store built into VS Code) rather than flat files. This prevents JSON corruption if VS Code force-quits during a disk write.
- **Pruning Strategy**: Before serializing to Memento, `_pruneForPersistence()` runs. It scans all `toolResults`, completely strips Base64 images, and truncates text outputs to 500 characters. Without this, a single `read_file` of a 2MB log file would exceed Memento's storage quotas and crash the extension on reload.

### 2.3 Host File Checkpoints (`checkpoint-manager.ts`)
Unlike git, which snapshots directories, the CheckpointManager is a surgical reverse-patch engine.
- When `replace_file_content` runs, the manager reads the target file *before* the modification.
- After modification, it computes the differential `Hunk[]` (added/removed lines) and serializes ONLY the patch to disk.
- When `undo(checkpointId)` is called, it reads the target file on disk, mathematically applies the reverse hunks, and writes it back. If the file was manually modified by the user in the meantime (causing line drifts), the patch application fails, and the file is marked as `conflicted` to prevent destructive overwrites.

## 🧠 3. Advanced Subsystem Connectivity

### 3.1 CodebaseIndex (Semantic Search)
The indexing engine integrates with the agent via the `grep_search` and internal retrieve tools.
- It leverages a local SQLite DB paired with a fast embedding model (typically small models like `all-MiniLM-L6-v2` run via ONNX Runtime or offloaded to the LLM provider API).
- Files are chunked using AST-aware splitters (chunking by function/class bounds rather than raw character counts) to preserve semantic integrity.

### 3.2 MCP Client (Model Context Protocol)
The agent can delegate capabilities to external servers.
- `extension.ts` initializes an `mcpClient`.
- When the LLM requests a tool not found in the local `ToolRegistry`, the request is bridged via TCP/Stdio to an external MCP server (e.g. a database querying server, a remote API bridge).
- The result flows back through the exact same `EventBus` pathway as native tools.

### 3.3 The Context Budgeter (`ContextManager`)
Before every LLM API call, the `ContextManager.fit()` routine runs.
- It calculates token approximations for the current conversation.
- If the budget (e.g., 200,000 tokens for Gemini Flash) is exceeded, it implements a sliding-window Least Recently Used (LRU) algorithm.
- It strips content from the *oldest* tool outputs first (replacing them with `[Truncated to fit context window]`), preserving the system prompt, user requests, and the most recent tool executions.

### 3.4 WorktreeManager (Git Worktrees)
To run subagents in parallel safely without filesystem conflicts, `WorktreeManager` allocates an isolated checkout folder.
- **Branch Creation**: When spawning a subagent, `WorktreeManager` checks out a new branch off current HEAD to `~/.blackide/worktrees/<hash>/<branchName>`. The `<hash>` is computed using the first 8 characters of the MD5 of the workspace root to isolate distinct open projects.
- **Sandbox Execution**: The subagent's filesystem and terminal commands are executed with their working directory pointing inside this worktree folder.
- **Git Mutex**: All Git processes are serialized through `gitMutex`, a *process-global* promise queue that prevents `index.lock` clashes across every concurrent run. It retries lock errors with exponential backoff, and bounds each operation with a timeout (default 120s) — without that, one hung `git` subprocess would stall the queue, and therefore every git operation in the extension, forever.
- **Reintegration is a delta, not a merge**: the worktree's baseline commit deliberately mirrors the live workspace's own *uncommitted* state, so a whole-branch `git merge` would spuriously conflict on every file the user had already modified before the run started. Instead `applyDelta(baseline→execution)` carries only what the pipeline actually changed.
- **On conflict the worktree is PRESERVED, not pruned.** The agent's work is real and must not be silently discarded: the error names the branch, the worktree path, the baseline SHA, and the exact `git worktree remove --force` command to discard it manually.

### 3.5 PlanningEngine (Antigravity Plan-First Flow)
Substantive user tasks go through a Plan-First gate to structure complex implementations.
- **Evaluation Gate**: `PlanningEngine.shouldPlan` parses the prompt. If it contains planning keywords (like `build`, `implement`, `refactor`) and is longer than 5 words, it flags a planning run.
- **Artifact Generation**: Under plan mode, the agent is restricted to read-only and artifact creation tools. It must output `implementation_plan` and `task_list` markdown artifacts, then halt.
- **Approval Lock**: The UI blocks further input and renders plan approval controls. Once approved, the task launches in execution mode, injecting the plan details into the system context.

### 3.6 InlineChatController (Cmd+I Editor Chat)
Provides fast, inline, editor-focused refactoring.
- **Snapshot Capture**: Saves a text snapshot of the active selection (or current line) and its original range.
- **Real-time Replacement**: Queries the LLM (instructing it to return only raw code without markdown backticks) and replaces the target range in the editor.
- **Visual Highlight**: Compares the original and modified snippets via `diffLines` and overlays a light-green background decoration (`addedLineDecoration`) dynamically tracking line offsets. A QuickPick prompt lets the user accept, reject (reverting to snapshot), or refine the instructions.

### 3.7 ModeLoader (Custom Agent Modes)
Loads and watches agent modes.
- **Mode Merging**: Loads built-in roles, then recursively walks global config (`~/.blackide/modes/`), workspace config (`.blackide/modes/`), and nested project config (`.agents/modes/`).
- **Parsing & Validation**: Parses markdown files with YAML frontmatter. Checks field schemas (validating list structures, ranges, name overrides), producing VS Code diagnostics on error. Files are hot-reloaded dynamically on change using file watchers.


### 3.8 PipelineOrchestrator (Multi-Agent Runs)
Substantial requests are routed by `PlanningEngine.classifyRequest` into a phased pipeline rather than a single agent turn.
- **Phase sequence**: Sr Architect (HLD) → Sr Engineer (LLD) → Planner → **approval gate** → dependency-ordered execution (Design / Backend / Frontend / Testing).
- **Dependency-driven, not hardcoded**: `EXECUTION_PHASE_GRAPH` declares each phase's tag and prerequisites. `selectExecutionPhases` filters to the phases the approved plan actually calls for (a plan with no `[backend]` tasks skips that executor entirely) and orders them via `scheduleTasks`. `selectExecutionWaves` groups them by dependency depth into parallelizable waves.
- **Per-phase model routing**: `resolveModelForPhase` lets a user route cheap scaffolding (HLD/LLD) to a fast model and execution to a stronger one, falling back to the pipeline-wide model when an override is unset or unresolvable.
- **Budget interlock**: `isOverTokenBudget` is evaluated on every usage callback; tripping it aborts the run via the same `AbortController` a user cancellation uses, then reports it as a failure rather than a silent stop.
- **Retries**: each phase retries up to twice before failing the run.

### 3.9 KnowledgeBase (Long-Term Project Memory)
A durable `.blackIDE/knowledge/` directory of plain markdown that persists project understanding across sessions, so it is not re-derived every run.
- **Files**: `architecture.md`, `decision_log.md` (ADRs, auto-numbered by `nextAdrId`), `feature_status.md` (an upserted table), `technical_debt.md`, `glossary.md`, `roadmap.md`.
- **Read side (`readContext`)**: builds a bounded digest for injection. The budget is allocated **per file** via `allocateBudget`, with slack from small files redistributed to large ones. Budgeting across the concatenation instead would let an append-only ADR log consume the whole allowance and starve every file after it.
- **ADR ordering**: `decision_log.md` is append-newest-last, so it is pruned **oldest-first** — the newest decisions are the ones a new run most needs. Pruning the other way makes memory grow staler as the project learns more.
- **First-run scan**: on activation, `summarizeRepoStructure` derives a starting `architecture.md` from the file tree and `package.json`. Guarded three ways — a `globalState` flag so it runs once per workspace, an `isArchitectureUnseeded` check so it can never overwrite human or agent edits, and a total try/catch so a scan failure cannot break activation.
- **Bounded growth**: `capKnowledgeFile` prunes only the append-only log. Curated files are never pruned — a human writes those and the oldest entry is not regenerable from git.

### 3.10 Output Routing & The Completion Doc Regime
What a finished run does with its work is a setting, not a hardcoded behaviour.
- **`apply` (default)**: reconcile onto the live working tree via `applyDelta`, then remove the worktree.
- **`pr`**: skip `applyDelta` entirely, keep the branch and worktree (they *are* the deliverable), and publish via `buildPrCommands` (`git push` + `gh pr create`) under `gitMutex`. Without `gh` installed it still pushes, then opens a `compareUrlFallback` URL — pushing matters most, since the compare URL would 404 against a local-only branch.
- **Safe degradation**: `resolveOutputMode` maps anything unrecognised — absent, misspelled, wrong type — to `apply`. The failure mode of guessing wrong must be "your changes landed as usual", never "the run silently did not touch the workspace and you cannot find your work".
- **Docs**: on completion in apply mode, `formatChangelogEntry` + `prependChangelogEntry` maintain `CHANGELOG.md`, inserting the newest entry beneath the header while preserving any hand-written preamble.

### 3.11 Durability, Telemetry & Concurrency
- **Run durability (`pipeline-runs.ts`)**: Manager runs are persisted to `globalState`. On activation `reconcileInterruptedRuns` flips anything a window reload interrupted into a terminal `failed` state, so stale rows do not linger as ghost "running" entries forever.
- **Telemetry (`telemetry-sink.ts`)**: a second `EventBus` subscriber alongside the webview, writing local JSONL. Privacy-safe **by construction** — `toTelemetryRecord` projects events down to metadata (mode, model, duration, error class) and drops content-bearing and streaming events entirely, so a prompt can never reach the log.
- **Concurrent runs**: the Manager panel supports up to 4 isolated pipeline runs. Each gets its own `AbortController` and its own run-local `CheckpointManager` — sharing one store meant a pipeline's worktree-path snapshots bled into the next chat task's commit, and concurrent runs swept each other's pending snapshots.

### 3.12 Test Architecture (Two Tiers)
- **Core harness (`test/harness.js`, 352 assertions)**: plain Node, no display, no Electron. Resolves the `vscode` module to a stub and drives the vscode-free core against a mock LLM over HTTP. Exits non-zero on any failure, so it is usable as a CI gate. Some sections drive **real git** in temp repositories (worktree lifecycle, delta reconciliation, parallel merge semantics).
- **Extension-host suite (`test/integration/`, 10 tests)**: `@vscode/test-electron` launches a real VS Code to cover what the stub structurally cannot — activation, command registration, the first-run workspace scan, and settings defaults. Needs a display; CI runs it under `xvfb-run`.
- **Operational note**: VS Code opens a unix domain socket under the user-data dir. The default path inside this deeply-nested extension exceeds the ~103-char `sockaddr_un` limit and fails startup with `EINVAL`, so the runner points `--user-data-dir` at a short tmpdir.
