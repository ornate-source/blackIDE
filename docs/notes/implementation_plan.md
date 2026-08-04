# The Agent Office — design record and implementation plan

**Owns:** *where the user watches and steers concurrent agent work, what the IDE shows them, and
what it writes down.*
**Supersedes:** the "Agent Office" revision of 2026-08-04 (§0.1), which supersedes the "Agent Swarm
Operations & Telemetry Dashboard" revision (§0.2).
**Audited against the tree:** 2026-08-04 — every claim below about existing data was re-checked in
code, with the file and line named. Nothing here is read off a previous revision.

> **Partly built.** M72, M74, M76, M77, M82, M83 and M84 landed on 2026-08-04; the two P0 defect
> milestones (**M80**, **M81**) and the entry-point work (**M73**, **M75**, **M78**, **M79**) have
> not. `pending-tasks.md` §1 and §1b are canonical for which is which — this file stays the *why*
> and is not updated to track status. Where §2's audit says a field is ❌ absent, check there
> first: several of those rows were the work.

This is a **design record with a plan attached**, in the sense `plan.md` is one: it explains why the
surface is shaped this way, so a later reader can tell an intentional constraint from an oversight.
It is not a status document — open work lives in [`pending-tasks.md`](./pending-tasks.md), the
capability inventory lives in [`features.md`](./features.md). Where this file and those disagree,
they are right.

---

## 0. What changed in this revision, and why

The previous revision built one surface — a dense roster answering *"what is everything doing?"* —
and treated the event trace as a side panel of it. Two things forced a rewrite.

**The first is that "what is it doing" and "what did it do" are different questions with different
storage.** A roster is a *projection of now*: it holds the last value of each field and forgets
everything else. A trace is a *record of then*: it must survive the panel closing, the window
reloading, and the run finishing, because the moment you actually need it is an hour later when
something is wrong. The previous design's `officeTrace` was a capped in-memory ring in a webview.
Close the tab and the evidence is gone. That is not a log; it is a spinner with timestamps.

**The second is the defect in §9.** A user asks the agent to do something, waits, and watches
`Agent is thinking...` for a minute while nothing happens. The state was *always right* — the
extension host was logging index progress, MCP connection results and skill resolution the entire
time — and every one of those lines went into a collapsed panel that renders **the last two**
(`App.tsx:3346`). The same failure shape as F16, one layer down: correct state, no surface. A
dashboard that does not fix this ships a prettier version of the same silence.

So the Office is now **two surfaces behind one tab strip**:

| Tab | Question | Shape | Lifetime |
|---|---|---|---|
| **Office** | *Who is working, on what, right now?* | graphical — desks, roles, files, progress | live only; reconstructed from state on mount |
| **Logs** | *What exactly happened, and what happened an hour ago?* | textual — depth-controlled, timestamped, searchable | **durable on disk**, readable by the user *and by an agent* |

They are not two views of the same data at different densities. The Office reads a projection; the
Logs read a file. That separation is the design.

### 0.1 What survives from the previous revision

Everything in it that was about honesty. The five rules (§3), the data audit (§2), the one-row-type
work item (§4.1), the refusal of a parallel-wave graphic and a token-rate sparkline, the placement
decisions (§7), and the milestone spine. The Office tab *is* the previous revision's Floor, made
graphical. Nothing is deleted on taste.

### 0.2 What was already rejected, restated so it stays rejected

The revision before that proposed a dark "Agent Swarm Monitor" with five telemetry tiles, AST
targets, token-rate sparklines and a dependency-wave graph, and closed with *"Total: Zero backend
changes required."* Six of its seven numbers had no source in the running system; it hard-coded a
dark theme into a themed surface; it drew a parallel wave scheduler that was **deleted on the merits
in Phase 6** (M35, `enhancement.md` §610). §2 and §3 exist because of it.

---

## 1. Preview — the two tabs

### 1.1 Office (graphical)

```
┌─ ✦ Agent Office ───────────────────────────────────────────────────────────────────────────────┐
│  ▐ OFFICE ▌  LOGS ⑦        3 of 4 desks busy · $0.82 / $5.00 · 148.2k tok · 1 needs you   ⟳    │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                │
│   ┌───────────────────────────┐  ┌───────────────────────────┐  ┌───────────────────────────┐  │
│   │ ● Frontend      ta_m4x1   │  │ ● Backend       ta_m4x2   │  │ ⏸ Sr Architect   pr_88f   │  │
│   │   Sonnet 4.5              │  │   GPT-5                   │  │   Sonnet 4.5              │  │
│   │───────────────────────────│  │───────────────────────────│  │───────────────────────────│  │
│   │ Rebuild the nav header    │  │ Refresh-token rotation     │  │ Ship the settings redesign│  │
│   │                           │  │                           │  │                           │  │
│   │  opened                   │  │  running                  │  │  waiting for you          │  │
│   │  ▸ apiSlice.tsx           │  │  ▸ npm test -- auth        │  │  ▸ plan ready · 41 min    │  │
│   │    src/store/  · 1.4 s    │  │    12.6 s  ⚠ slow          │  │                           │  │
│   │                           │  │                           │  │  HLD▸LLD▸Plan▸Des▸Be▸Fe▸T │  │
│   │ turn ███████░░░░░  7/25   │  │ turn ███░░░░░░░░░  3/25   │  │           ▲ here          │  │
│   │ ctx  ███████░░░░  72%     │  │ ctx  ███░░░░░░░░  28%     │  │  runs in sequence         │  │
│   │ +142 / −18 · 6 files      │  │ +61 / −4 · 2 files        │  │                           │  │
│   │ ⎇ blackide/agent/ta_m4x1  │  │ ⎇ blackide/agent/ta_m4x2  │  │                           │  │
│   │ [Steer] [Diff] [Logs ▸]   │  │ [Steer] [Diff] [Logs ▸]   │  │ [Read plan] [✓] [✗]       │  │
│   └───────────────────────────┘  └───────────────────────────┘  └───────────────────────────┘  │
│   ┌───────────────────────────┐  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐                                  │
│   │ ✔ Agent         ta_m3z9   │  │        1 desk free        │                                  │
│   │   Sonnet 4.5              │  │      [ New task ▸ ]       │                                  │
│   │───────────────────────────│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘                                  │
│   │ Extract the retry helper  │                                                                 │
│   │  done · verified 14/14    │   ┌── FILES IN PLAY ──────────────────────────────────────────┐ │
│   │ +142 / −18 · 6 files      │   │ src/store/apiSlice.tsx        ta_m4x1  editing            │ │
│   │ [Apply] [Diff] [Discard]  │   │ src/components/NavHeader.tsx  ta_m4x1  edited  +38/−4     │ │
│   └───────────────────────────┘   │ src/auth/middleware.ts        ta_m4x2  edited  +61/−4     │ │
│                                   └───────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The sentence in the middle of each desk — **`opened` / `apiSlice.tsx` / `src/store/` / `1.4 s`** — is
the whole point of the graphical tab, and it is the thing that does not exist today. §5 is how it
gets a source.

### 1.2 Logs (in-depth)

```
┌─ ✦ Agent Office ───────────────────────────────────────────────────────────────────────────────┐
│  OFFICE   ▐ LOGS ▌         run: ta_m4x1 ▾   depth: verbose ▾   ⌕ apiSlice        ⏸ live  ⤓ ⟳  │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 12:29:38.004  ▸ run started      task ta_m4x1 · Frontend · claude-sonnet-4-5 · 25 turn cap     │
│ 12:29:38.107    worktree          blackide/agent/ta_m4x1 ← ~/ornate_source/blackIDE @ a3f19c2  │
│ 12:29:38.980    context           index 1,204 chunks (12 indexed, 1,192 reused, 0 removed) 870ms│
│ 12:29:39.111    skills            3 fired: react-conventions, testing-vitest, repo-structure    │
│ 12:29:39.240    rules             2 active: AGENTS.md (always), webview/*.tsx (glob)            │
│ 12:29:39.301    prompt            8,412 / 12,000 tokens · knowledge truncated                   │
│                                                                                                │
│ 12:29:41.101  ▸ turn 1 / 25                                                          ⌄ 4.2 s   │
│ 12:29:41.560    ✔ list_directory  src/components                                       0.1 s   │
│ 12:29:45.802    ✔ codebase_search "breakpoint hook usage"                    9 hits    0.9 s   │
│                   ⌄ src/hooks/useBreakpoint.ts:14 · src/components/NavHeader.tsx:8 · …          │
│                                                                                                │
│ 12:30:09.882  ▸ turn 2 / 25                                                                    │
│ 12:30:09.882    ✔ read_file       src/store/apiSlice.tsx                  184 lines    0.2 s   │
│ 12:30:14.201    ▸ edit_file       src/components/NavHeader.tsx            +38 / −4     1.4 s   │
│                   ⌄ replaced 2 blocks · "useBreakpoint(720)" · saved                            │
│ 12:30:15.640    ⚠ get_diagnostics src/components/NavHeader.tsx        1 error          0.3 s   │
│                   ⌄ TS2304: Cannot find name 'useBreakpoint'.                                   │
│                                                                                                │
│ 12:30:18.004  ↯ steered           "use the existing hook"                     from you         │
│ 12:30:52.117  ✔ verification      14 / 14 passing · test-report.md · screenshot.png            │
│ 12:30:52.900  ■ run finished      completed · 7 turns · 3 m 14 s · 38,400 tok · $0.19          │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 2,418 lines · 412 KB on disk · retained 14 days   [ Open as file ]  [ Export ]  [ Copy trace ] │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Read what this is *not*: it is not the reasoning stream, and it is not the chat transcript. It is the
**mechanical record of the run** — every tool with its arguments, its result shape, its duration; the
pre-flight steps that today happen in silence; every steering note; every failover; every retry.
Depth `trace` adds raw tool output and terminal chunks. Depth `summary` collapses to one line per
turn.

---

## 2. Data audit — what the two tabs need vs. what exists

Extends the previous revision's audit with the rows the graphical view and the log store add. The
`Verdict` column is the honest one; §5 and §6 are the work the ❌ rows imply.

| Element | Real source today | Verdict |
|---|---|---|
| `mode` · `model` · `branch` · `rootPath` | `TaskAgentSummary` (`task-agents.ts:38-91`) | ✅ exists |
| Desk **role label** ("Frontend", "Sr Architect") | task lane: `summary.mode`, the mode name from `ModeLoader`. Pipeline lane: the phase name — `'Frontend Executor'` etc. is literal in `EXECUTION_PHASE_GRAPH` (`pipeline-orchestrator.ts:27-31`) | ✅ exists, unrendered |
| Desk **verb** ("opened", "running", "searching") | nothing. Derived from the tool name, which needs a table — §5.2 | ❌ absent (pure, cheap) |
| Desk **target** (`apiSlice.tsx`) | **chat lane:** `ToolStarted.arguments` is populated (`chat-task.ts:733-739`) and the bus type carries it (`event-bus.ts:23`). **task lane:** `params.emit({type:'ToolCallStarted', name})` forwards *the name only* (`task-agent-entry.ts:155`), and the registry reads only that (`task-agent-registry.ts:355-359`) | ⚠️ half exists — the graphical tab is blocked on the task lane |
| Tool **duration** on a live row | chat lane measures it at `onToolResult` (`chat-task.ts:747`) — i.e. **after** it finishes. Nothing publishes a started-at that a `⚠ slow` badge could read | ❌ absent |
| `turn n / max` | `maxLoops` is known (`task-agent-entry.ts:144`), `onTurn` fires in the chat lane only. The task lane passes no `onTurn` callback at all | ❌ absent for the task lane |
| `ctx 72%` | `ContextManager` is constructed **inside** `runTask` and never reported out (`task-agent-entry.ts:146`) | ❌ absent |
| `+142 / −18` live | `diffStat` runs **once, after the final commit** (`task-agent-registry.ts:318`) | ⚠️ post-hoc only |
| Verification `14/14` | `summary.verification` (`task-agents.ts:78-84`) | ✅ exists |
| `FILES IN PLAY` panel | `FileChanged` events exist and carry `path` + `kind` (`event-bus.ts:26`); the chat lane emits them (`chat-task.ts:497`). The task lane collects them into a private `touched` Set and emits nothing (`task-agent-entry.ts:129`) | ⚠️ half exists |
| Header tiles: slots, spend, tokens, exhausted | **`GovernorSnapshot` computes all of it already** (`agent-governor.ts:54-63, 166`) and is **never sent to any webview** | 🎁 exists, unwired. Still the cheapest real win here |
| Attention count | `buildInbox` / `inboxCounts` (`agent-inbox.ts`), graded ✅🟢, pushed to the Manager only when it is open | 🎁 exists, under-distributed |
| **Durable run log** | **nothing.** `TelemetrySink` writes JSONL but is privacy-scrubbed *by design*: its allow-list drops prompts, tool arguments, tool output, terminal chunks, file paths and `Log` lines (`telemetry-sink.ts:38-62`). It is the wrong file and must stay the wrong file | ❌ absent — §6 |
| **Live event delivery** | `bus.onAny(e => this._view?.webview.postMessage(...))` (`extension.ts:216-217`) — one subscriber, fire-and-forget, to the chat sidebar only. Nothing replays; nothing persists | ⚠️ exists but lossy |
| Pipeline lane trace | already streams `pipelineRunEvent` into `agentReducer` | ✅ exists |
| Chat subagents | `SubagentStarted/Progress/Finished` are posted **straight to the chat webview**, never onto the bus (`chat-task.ts:535-643`) | ⚠️ off-bus |
| Daemon results | `daemonInboxItems` projects results into inbox items (`daemon-protocol.ts:137`); nothing reads the projection into a surface | ⚠️ unwired |
| Dependency wave graph | `selectExecutionWaves` describes the plan's shape; **no parallel executor exists** — M35 deleted | ❌ would misrepresent the runtime |

### 2.1 The delivery mechanism is still the other half of the problem

`TaskAgentRegistry.update()` — called for *every* field change including per-turn token charges —
persists the whole history to `globalState`, then re-pushes **the entire agent array** to the panel,
then triggers an inbox recompute (`task-agent-registry.ts:363-374` → `task-agent-lane.ts:52-56`).

Today that drives a six-field card and nobody notices. Four desks with progress bars, a live verb,
a files-in-play table and a streaming log, re-rendered from a whole-array replacement at token
cadence, is a jank source and a battery cost. **Any dense view needs a patch channel before it needs
a graphic.**

---

## 3. The five honesty rules

The spine of the design. Every one exists because the audit found a previous revision breaking it.

- **R1 — No metric without a source.** Every number names the field it came from. An absent field
  renders `—`, never `0`, never a plausible default. A missing measurement and a measured zero are
  different facts.
- **R2 — No affordance without a transition.** Buttons render from `canApply` / `canCancel` /
  `canDiscard` / `holdsWorktree` / `liveIds()` — the predicates already exported by
  `task-agents.ts:114-136`. If the transition does not exist, the button does not render. Disabled
  buttons teach the user that a capability exists and they did something wrong.
- **R3 — No topology we do not execute.** The pipeline strip shows the seven phases **in sequence**,
  because that is how `pipeline-orchestrator.ts` runs them.
- **R4 — Theme tokens only.** Every colour resolves through `var(--vscode-*)` via the existing
  Tailwind theme. The Office must be legible on light, dark and high-contrast.
- **R5 — The branch is always visible on anything that has one.** It is not metadata, it is how the
  user recovers work from an agent that failed. `reconcileInterruptedAgents` writes it into the
  error message for exactly this reason (`task-agents.ts:160`).

**R6 is new, and it is the log tab's rule:**

- **R6 — Silence is a bug.** Any interval longer than **2 seconds** in which the system is working
  and the surface says nothing new is a defect, not a loading state. Every such interval must either
  publish an event or be given one. §9 is the first application of this rule; the pre-flight it
  covers is currently the worst offender in the product.

---

## 4. The model

### 4.1 One row type, one projection

The Office has exactly **one work-item shape**. Everything the user launched or the machine produced
is a work item, and the lane is a field rather than a different card:

| Field | Meaning | Lanes that populate it |
|---|---|---|
| `id` | the real handle — `ta_m4x1`, `pr_88f`, `sa_…`, `dm_0142`. Never a synthetic `NODE-01` | all |
| `lane` | `task` · `pipeline` · `chat` · `daemon` | — |
| `role` | the desk's occupant: mode name or phase name | task, pipeline, chat |
| `title` | the prompt, truncated the way `agent-inbox.ts:183` already truncates | all |
| `status` | the four-state vocabulary the lanes already share | all |
| `model` | what is answering, after failover | task, pipeline, chat |
| `root` · `branch` | the recovery instruction. **Always rendered** (R5) | task, chat, daemon |
| `activity` | `{ verb, target, dir, startedAt, tool }` — the sentence on the desk | task, pipeline (needs §5) |
| `progress` | turn *n* of *max*, context used of limit | task, pipeline (needs §5) |
| `delta` | files, insertions, deletions | task, daemon |
| `evidence` | verification outcome, counts, report path, screenshot | task, pipeline |
| `needs` | the inbox reason, when there is one | all |
| `journal` | the run's log id — the "Logs ▸" button's target | all |

**Why one row type.** A pipeline phase has no worktree, so it shows no worktree button — not a greyed
one. A daemon result has no live turn, so its progress cell reads `—`, not `0/25`. The lane decides
which cells have referents; it does not get its own card layout. Four card layouts is how the three
existing surfaces drifted apart in the first place.

### 4.2 Where each surface lives

| Surface | Cost to the user | Shows | Refresh |
|---|---|---|---|
| **Status bar item** | zero — always visible | running count · attention count | on inbox change |
| **Sidebar view (Front Desk)** | one click, no editor column | *does anything need me?* + compact roster | patch stream |
| **Editor tab — Office** | a column, deliberately | the desks | patch stream |
| **Editor tab — Logs** | the same column, one click | the journal | tail stream + file reads |

Today the Manager is a `WebviewPanel` at `ViewColumn.Active` (`manager-panel.ts:100-117`), reachable
**only** from the command palette (`command-registry.ts:103`). No sidebar presence, no status bar
item, no menu entry, no keybinding. The inbox notification's only action is a toast button saying
*"Open Manager"* (`task-agent-lane.ts:180`) — which steals an editor column to answer a yes/no
question. That is the remaining shape of F16.

**Container decision: a second view inside the existing `black-ide-chat` activity-bar container**,
not a new container. One icon keeps Black IDE at one activity-bar entry; the container badge
aggregates its views' badges, so the attention count shows even when the view is collapsed. **The
trade-off, stated:** the chat view currently has `"name": ""` and renders as a bare webview filling
the container; adding a sibling gives both views a title bar, so chat gains a `▾ CHAT` header row it
does not have today. **Verify before building** that the fork's API version exposes
`WebviewView.badge`; if not, the status bar item carries the count alone, which is why it is M73 and
not an afterthought.

---

## 5. The Office tab — end to end

### 5.1 The pipeline, stated once

```
  runtime                    extension host                          webview
  ───────                    ──────────────                          ───────
  agent-loop
    onTurn        ─┐
    onToolCall     ├──▶  TaskEmitter.emit()  ──▶  EventBus
    onToolResult  ─┘                               │
  executor                                         ├─▶ RunJournal      (§6, disk)
    onFileChanged ────────────────────────────────▶├─▶ TelemetrySink   (privacy-scrubbed, unchanged)
                                                   │
                                                   └─▶ OfficeTelemetry ──▶ officePatch  ──▶ office-model.ts
  registry.update() ─────────────────────────────────▶ (coalescer)    ──▶ officeSync   ──▶  desks
  governor.snapshot() ───────────────────────────────▶                ──▶ officeGovernor ─▶ header tiles
```

Three properties this shape buys, and each is a decision:

1. **The journal subscribes to the bus, not to the webview.** So the log is complete whether or not
   any panel is open, and a window reload loses nothing.
2. **The coalescer lives on the extension-host side.** A webview that throttles still pays the
   `postMessage` serialisation cost for every dropped frame.
3. **`office-model.ts` is pure and vscode-free.** Four lane summaries in, one ordered roster out. It
   is where the design lives, and it is unit-tested the way `agent-inbox.ts` already is.

### 5.2 The desk sentence — how "opened apiSlice.tsx" is produced

Three pure functions over one event, in `core/office-narrate.ts`:

```ts
// tool name → what a person would call it. The table is closed: an unlisted tool
// renders its own name rather than a guessed verb, because a wrong verb about a
// destructive tool is worse than an unfamiliar one.
const VERBS: Record<string, { verb: string; arg: string }> = {
  read_file:       { verb: 'opened',        arg: 'path' },
  edit_file:       { verb: 'editing',       arg: 'path' },
  write_file:      { verb: 'writing',       arg: 'path' },
  list_directory:  { verb: 'listing',       arg: 'path' },
  grep_search:     { verb: 'searching for', arg: 'query' },
  codebase_search: { verb: 'searching for', arg: 'query' },
  run_command:     { verb: 'running',       arg: 'command' },
  run_tests:       { verb: 'running tests', arg: 'path' },
  get_diagnostics: { verb: 'checking',      arg: 'path' },
  find_references: { verb: 'tracing uses of', arg: 'symbol' },
  go_to_definition:{ verb: 'looking up',    arg: 'symbol' },
  rename_symbol:   { verb: 'renaming',      arg: 'symbol' },
  browser_open:    { verb: 'opening',       arg: 'url' },
  spawn_subagent:  { verb: 'delegating to', arg: 'name' },
  // …one row per tool in tools.ts. `complete_task` is not here: it is not an activity.
};

export function narrate(e: { name: string; arguments?: any }): Activity | undefined
export function splitTarget(value: string): { label: string; dir?: string }  // 'src/store/apiSlice.tsx' → { label:'apiSlice.tsx', dir:'src/store/' }
export function staleness(startedAt: number, now: number): 'ok' | 'slow' | 'stalled'  // >8s, >30s
```

R1 applies inside `narrate`: **an event with no `arguments` returns `{ verb, target: undefined }`**,
and the desk renders `editing —`, not `editing something`. That is the case the task lane is in today
and will stay in until M76 lands, so the graphical tab must be correct in it.

`staleness` is §4's stall signal and the highest-value cell on the desk: a stalled agent looks
identical to a working one on every surface we have today.

### 5.3 What each lane must publish

| Lane | Work |
|---|---|
| **Task agents** | Publish to the shared `EventBus` with correlation meta (the agent id as `taskId`) instead of the private three-event `params.emit`. Forward `ToolStarted.arguments` — the bus type already carries `arguments?: any` (`event-bus.ts:23`), the lane simply never fills it. Pass `onTurn` through to report turn index. Report context usage out of the loop. Emit `FileChanged` from the `touched` collector (`task-agent-entry.ts:129`). Throttled live `diffStat` against the worktree while running |
| **Pipeline runs** | Already streams `pipelineRunEvent` into `agentReducer`. Needs mapping onto the work-item shape and a phase-position field. **No new instrumentation** |
| **Chat subagents** | `SubagentStarted/Progress/Finished` exist and reach the chat webview only. Route them onto the bus so they appear as `lane: chat` and land in the journal |
| **Daemon** | `daemonInboxItems` already projects results (`daemon-protocol.ts:137`). The Office needs to *read* that projection — the P11-3 gate clause ("a daemon run's results appear in the inbox") satisfied by an actual surface rather than by a data structure |
| **Governor** | Push `snapshot()`. It is computed and thrown away today |
| **Git mutex** | Add an observable pending count and in-flight-since. One counter, and "why is everything slow" becomes answerable |

### 5.4 The telemetry budget — watching must not change what runs

| Rule | Why |
|---|---|
| Telemetry never costs a model call | worth writing down before someone proposes a summarising "what is this agent doing" line |
| Telemetry takes the git mutex **at most once per agent per 10 s** | `GitMutex` is process-global and documented as a throughput ceiling on all parallel work (`git-mutex.ts:22-27`). A live diff polled per event would serialise four agents behind the UI |
| Nothing is computed for a surface that is not open | the panel already drops posts with no panel (`manager-panel.ts:84`); the **producers** must check too. The journal is the deliberate exception — it writes whether or not anyone is watching, which is its entire job |
| Structural changes push a list; field changes push a patch | §2.1 |

| Message | Carries | Cadence |
|---|---|---|
| `officeSync` | full roster + governor snapshot + inbox | mount, and on launch/retire |
| `officePatch` | `{ id, changed fields }` for one item | coalesced, ≤ 4 Hz per item |
| `officeGovernor` | `GovernorSnapshot` | on change |
| `journalTail` | new journal lines for the selected run | coalesced, ≤ 4 Hz, capped 200 lines/post |
| `journalPage` | a page of a historical run's log | on request only |

### 5.5 Desk layout rules

- **A desk is a fixed-height card in a responsive grid**: 1 column under 520 px, 2 under 900 px, 3
  above. Fixed height because desks appearing and disappearing must not reflow the ones the user is
  reading.
- **Empty desks are drawn** up to `governor.maxConcurrent`, dashed, carrying `[ New task ▸ ]`. A
  capacity of four with three busy is a fact the user can act on; an implicit one is not.
- **`FILES IN PLAY`** is a flat table, not a tree: it answers "is anything touching the file I have
  open?", and a tree buries that under expansion state. Sourced from `FileChanged` plus the live
  `activity.target`. Rows for the file in the active editor are marked.
- **No animation on the desk beyond the running pulse.** The verb changing every 1.4 s is already
  motion; anything more makes four desks unreadable.

---

## 6. The Logs tab — end to end

### 6.1 Why a second store, when `TelemetrySink` already writes JSONL

Because `TelemetrySink` is *correctly* built to throw away exactly what a log needs. Its allow-list
(`telemetry-sink.ts:38-62`) passes counts, durations, coarse error classes and bundled skill names,
and drops prompts, tool arguments, tool output, terminal chunks, file paths, reasoning and `Log`
lines — with the reasoning written in the file. Widening it would destroy a privacy property that was
deliberately designed. **Two sinks, two postures:**

| | `TelemetrySink` (exists) | `RunJournal` (new) |
|---|---|---|
| Contains | aggregates | the run, in full |
| Content-bearing | never | yes — that is the point |
| Leaves the machine | possible, if the user opts in | **never.** No export path, no remote sink, no setting that would add one |
| Retention | 2 MiB rotating, one generation | per-run files, age- and size-capped (§6.4) |
| Redacted | n/a — carries nothing to redact | yes, on write (§6.3) |

### 6.2 Producer and format

`core/run-journal.ts` (**pure**) turns an `Envelope` into zero or more journal lines;
`agent/journal-store.ts` (**extension**) owns the file handles. One `bus.onAny` subscriber, added
beside the two that exist at `extension.ts:216`.

One JSONL record per line, one file per run at
`globalStorage/journal/<yyyy-mm-dd>/<taskId>.jsonl`:

```jsonc
{ "ts": 1754305814201, "seq": 148, "lane": "task", "id": "ta_m4x1",
  "kind": "tool",                  // run | turn | tool | file | steer | model | context | verify | log | end
  "level": "info",                 // info | warn | error
  "depth": "normal",               // summary | normal | verbose  — the reader's filter, decided at write time
  "verb": "editing", "target": "src/components/NavHeader.tsx",
  "detail": { "blocks": 2, "insertions": 38, "deletions": 4 },
  "durationMs": 1402,
  "payloadRef": "p_148"            // large bodies live beside the file, never inline (§6.4)
}
```

`depth` is assigned by the producer rather than chosen by the reader, because the producer is the only
thing that knows whether a given `Log` line is a heading or a detail. The reader filters `<=` its
selected depth. Three levels, and the mapping is fixed:

| Depth | Contains |
|---|---|
| `summary` | run start/end, turn boundaries, errors, steering, verification, approvals |
| `normal` | + every tool call with verb, target, duration, result shape (counts, hit counts, diff stat) |
| `verbose` | + tool arguments in full, tool output (capped), terminal chunks, prompt assembly, index/skills/rules/MCP pre-flight, failover and retry events, context compaction |

**Every line the pre-flight already logs becomes a `verbose` journal line** — the index build, the
skill resolution, the rule activation, the MCP connection results, the prompt budget. They are
already computed and already passed to `log()` (`chat-task.ts:271, 284, 300, 366, 440`). Today they
land in a two-line collapsed strip. §9 is the same fix seen from the UI side.

### 6.3 Redaction on write, not on read

`redactDeep` already exists (`redaction.ts:255`) and is entropy- plus pattern-based. Every `detail`
and every payload passes through it before the line is written. On write, because:

- a journal that is clean only when rendered is a journal that leaks the moment someone opens the
  file, which the tab's own `[ Open as file ]` button invites them to do;
- redaction on read costs CPU on every scroll of a 400 KB file.

The cost is that a false positive is unrecoverable. That is the right trade for a local diagnostic
file, and it is the same trade `RawOutputStore` (`output-compact.ts:158`) already makes.

### 6.4 Size, retention, and the thing that will go wrong

The failure mode of a verbose log is that it eats the user's disk. Four bounds, all enforced in the
store, none of them advisory:

| Bound | Value | Enforced |
|---|---|---|
| Inline `detail` | 2 KB | truncated with `"truncated": true` |
| Payload body (tool output, terminal) | 64 KB per record | spilled to `<taskId>.payloads/p_<seq>.txt`, referenced by `payloadRef` |
| One run's directory | 8 MiB | `verbose` records stop being written; a single `level:"warn"` line says so, and `normal` continues |
| Total journal directory | 512 MiB **or** 14 days, whichever first | oldest run-days deleted whole, never partially |

Retention is configurable down to `0` (off entirely) in Settings. **A run that is still live is never
pruned**, whatever its age — pruning the log of a running agent is how you lose the one trace you
needed.

### 6.5 Reader

`core/journal-reader.ts` (**pure over an injected line source**, so it is testable without a disk):

```ts
listRuns(opts): RunIndexEntry[]                      // id, lane, role, title, status, started, ended, bytes, lines
readPage(runId, { depth, after, limit, filter }): { lines: JournalLine[]; nextCursor?: string }
search(runId | 'all', query, { depth, limit }): JournalHit[]
```

Paged and cursored, never "read the file into the webview". A 400 KB run at 200 lines a page is 12
posts, and the tab is virtualised over them.

**Live tail:** while a run is running, the store pushes `journalTail` as it writes, and the tab
appends. Switching to a finished run switches to `journalPage`. The `⏸ live` control freezes the tail
without stopping the writes — scrolling up in a log that keeps jumping to the bottom is the single
most common complaint about log viewers, and it is a two-line fix if you build it in.

### 6.6 The agent-readable half

*"so users or agent can read them later"* — the second half is a tool, and it is the more interesting
one:

```
read_run_log(runId?, { depth?, filter?, turns?, tail? }) → the same lines the reader returns
```

Registered in `tools.ts` beside `expand_output` (`tools.ts:416`), which is the closest existing
precedent: a tool whose purpose is to fetch detail the model chose not to carry. Constraints, all of
them load-bearing:

- **Read-only, and scoped to this workspace's runs.** A run log can contain file contents; a tool
  that could read *any* run's log is a cross-workspace read.
- **Defaults to `summary` depth and the caller's own run.** The common case is "what did I already
  try?" after a compaction, and returning 2,000 verbose lines into a context window solves nothing.
- **Output goes through `compactListing`** (`output-compact.ts:134`) with a raw pointer, so a model
  that wants more calls `expand_output` — the mechanism that already exists for exactly this.
- ~~**Advertised in `agent` mode only.**~~ **Reversed on implementation.** It ships as
  `risk: 'safe'`, so Ask and Plan get it too. *"Why did that run fail?"* is an Ask-mode question,
  the tool is read-only, and Ask can already read the files the log quotes — the prompt-budget
  argument did not survive contact with the actual use.

The payoff is concrete: a failed agent's successor can read why the first one failed, and a user can
ask "why did the last run take nine minutes?" and have the agent answer from the record rather than
from a guess.

### 6.7 The migration that is not a migration

`ParallelSubagentsPanel` (`webview/src/ParallelSubagents.tsx`, 110 lines) reads `state.subagents`,
which the reducer populates from `SubagentStarted` events — a lane that reaches the chat webview but
not the Manager. It is mounted at `App.tsx:3450` and renders `null` in the Manager surface always.
Fold it into the Office's `chat` lane and delete it. A second, divergent subagent card is how two
surfaces come to disagree.

---

## 7. Wireframes at real proportions

### 7.1 Status bar item — the always-on surface

```
   … ⎇ dev*   ⊘ 0  ⚠ 2            ◆ Office 3▸ 1!            Ln 42, Col 8 …
                                  └────────────┘
                                   │       │  └─ 1 item needs you  (blocking + parked + failed)
                                   │       └──── 3 running         (governor.active)
                                   └──────────── click → reveal the Front Desk

   idle, nothing running:          ◆ Office
   running, nothing waiting:       ◆ Office 3▸
   budget exhausted:               ◆ Office ⛔ budget          ← governor.exhausted
```

`3▸` is `GovernorSnapshot.active`; `1!` is `inboxCounts().blocking + .failed`. It never shows a number
it cannot source, and when nothing is running it is four characters of ambient reassurance rather than
a badge shouting zero.

### 7.2 Front Desk — sidebar view, ~46 columns

```
┌──────────────────────────────────────────────┐
│ ▾ AGENT OFFICE                        ④  ⟳  │
├──────────────────────────────────────────────┤
│ ── NEEDS YOU ─────────────────────────── 3 ──│
│ ┌──────────────────────────────────────────┐ │
│ │ ⏸ PARKED · waiting 41 min                │ │
│ │ Add OAuth refresh to the auth middlewa…  │ │
│ │ pipeline · plan ready for review         │ │
│ │ [ Read plan ]  [ Approve ]     [ Reject ]│ │
│ └──────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────┐ │
│ │ ✔ READY · finished 3 min ago             │ │
│ │ Extract the retry helper out of tool-r…  │ │
│ │ task · 6 files  +142 / −18               │ │
│ │ verified · 14/14 passing                 │ │
│ │ [ Apply ]  [ Diff ]           [ Discard ]│ │
│ └──────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────┐ │
│ │ ✖ FAILED · 12 min ago                    │ │
│ │ Migrate the settings store to the new…   │ │
│ │ task · work kept on                      │ │
│ │ ⎇ blackide/agent/ta_m3w7                 │ │
│ │ [ Open branch ] [ Logs ]      [ Dismiss ]│ │
│ └──────────────────────────────────────────┘ │
├──────────────────────────────────────────────┤
│ ── ON THE FLOOR ─────────────────────── 3/4 ─│
│ ● ta_m4x1 Frontend  opened apiSlice…    7/25 │
│ ● ta_m4x2 Backend   running npm test    3/25 │
│ ● pr_88f  Sr Arch   phase 5/7  waiting  41m  │
│ ○ dm_0142 daemon    finished 02:14  ✔ seen   │
├──────────────────────────────────────────────┤
│ $0.82 / $5.00 · 148.2k tok      [ Office ▸ ] │
└──────────────────────────────────────────────┘
```

- **Ordering is `buildInbox`'s, unchanged** — parked, blocked, failed, review, *oldest first within
  the blocking states* because the oldest blocked run has wasted the most time
  (`agent-inbox.ts:54-61`). The panel does not re-sort; re-sorting is a second opinion about urgency
  that nobody tested.
- **`READY` is the item the whole inbox exists for.** Nothing is wrong, nothing is on a timer, and
  the work quietly never lands (`agent-inbox.ts:112-121`). Same visual weight as a failure.
- **The failed card leads with the branch** (R5) and now carries **`[ Logs ]`** — the failure is the
  moment the journal earns its existence.
- **The roster line now carries the verb**, which is the sidebar's share of §5.2.

### 7.3 A Desk — drill-in on one item

```
┌─ ta_m4x1 ──────────────────────────────────────────────────────────────── ✕ ─┐
│ Rebuild the navigation header so it collapses under 720px                    │
│ ● RUNNING · 4 min 12 s     task · Frontend · Sonnet 4.5                      │
│ ⎇ blackide/agent/ta_m4x1  ←  ~/ornate_source/blackIDE @ a3f19c2              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Log      Diff (6)      Evidence      Steering (2)                           │
├──────────────────────────────────────────────────────────────────────────────┤
│ turn    ███████░░░░░░░░░░  7 / 25          ctx  ███████░░░  72%  (18k/25k)   │
│ tokens  38 400              spend  $0.19                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ 12:30:14.201  ▸ edit_file      src/components/NavHeader.tsx        1.4 s     │
│ 12:30:09.882  ✔ read_file      src/store/apiSlice.tsx              0.2 s     │
│ 12:30:08.114  ✔ codebase_search "useBreakpoint"                    0.9 s     │
│ 12:29:58.004  ↯ steered        "use the existing hook"                       │
│ 12:29:41.101  ✔ list_directory src/components                      0.1 s     │
│                                                    [ Full log in Logs tab ▸ ]│
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌ Correct this agent — reaches the model on its next turn ─────────────────┐ │
│ │                                                                         │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ [ Send correction ]        [ Open worktree ]   [ Open diff ]   [ Stop ]      │
└──────────────────────────────────────────────────────────────────────────────┘
```

The steering box is the point of this room. Today steering is a `window.prompt()` — modal, single
line, no history, no artifact reference (`ManagerPanel.tsx:445-447`) — for a feature graded ✅🟢 that
`core/steering.ts` supports far better than that (it carries `artifactPath` and `region`). A textarea
with the last corrections visible above it is most of the gap.

### 7.4 Empty and degraded states

```
┌──────────────────────────────────────────────┐   ┌──────────────────────────────────────────────┐
│ ▾ AGENT OFFICE                            ⟳  │   │ ▾ AGENT OFFICE                        ⛔  ⟳ │
├──────────────────────────────────────────────┤   ├──────────────────────────────────────────────┤
│                                              │   │ ── BUDGET SPENT ─────────────────────────────│
│           Nothing is running.                │   │ The session budget of $5.00 is spent.        │
│                                              │   │ Nothing further will start until it is       │
│   Launch a task and it works in its own      │   │ raised or reset in Settings.                 │
│   git worktree — your workspace is not       │   │                                              │
│   touched until you apply the result.        │   │ 3 agents already running will finish.        │
│                                              │   │                                              │
│              [ New task ▸ ]                  │   │ [ Open settings ]         [ Reset spend ]    │
└──────────────────────────────────────────────┘   └──────────────────────────────────────────────┘
```

The empty state teaches the one property the whole task-agent design is built around — *untouched
until you apply* (`task-agents.ts:12-19`). The budget state is `GovernorSnapshot.exhausted`, which
today produces a refusal message at launch time and nothing else; a user whose launches are being
refused deserves to see why before they click.

### 7.5 Theme

Not a separate design — the same wireframes with every token resolved through the existing Tailwind
theme:

| Role | Token |
|---|---|
| surface / card | `panel` → `--vscode-editor-background` |
| rules and borders | `border` → `--vscode-sideBar-border` |
| primary text | `foreground` → `--vscode-sideBar-foreground` |
| secondary text | `muted` → `--vscode-descriptionForeground` |
| running / focus | `focusBorder` → `--vscode-focusBorder` |
| verified / waiting / failed | `successGreen` · `warningAmber` · `dangerRed` |

The three status colours are the only literals, they are already in `webview/tailwind.config.js`, and
they are the three the existing panels already use — so the Office inherits whatever contrast
decision was made there rather than making a fourth one.

---

## 8. Component architecture

| Component | Responsibility | Notes |
|---|---|---|
| `office-model.ts` (**core, pure**) | the work-item projection: four lane summaries → one ordered roster | vscode-free, unit-tested like `agent-inbox.ts`. **This is where the design lives** |
| `office-narrate.ts` (**core, pure**) | §5.2 — verb table, target split, staleness | one table, one test per row. Trivially the highest value-per-line in this plan |
| `office-telemetry.ts` (**core**) | coalescing, patch construction, the §5.4 budget | pure enough to test the coalescer without a webview |
| `run-journal.ts` (**core, pure**) | `Envelope` → journal lines, depth assignment, redaction call, truncation | pure; the store injects the writer |
| `journal-reader.ts` (**core, pure**) | list / page / search over an injected line source | testable with an array of strings |
| `journal-store.ts` (**extension**) | file handles, spill files, retention sweep, live tail | the only part that touches `fs` |
| `OfficeView.tsx` | the shell: the two tabs, message listener | one listener for the whole surface, as `ManagerPanel.tsx:144` already does |
| `DeskCard.tsx` | **one** component, three densities driven by container width | `line` (sidebar) · `card` (narrow) · `desk` (wide). Not a preference — a width response |
| `FilesInPlay.tsx` | the flat file table | |
| `LogsTab.tsx` | virtualised list, depth control, filter, live-tail pause | |
| `FrontDesk.tsx` | inbox rendering + per-reason action sets | consumes `buildInbox` output unchanged |
| `PhaseStrip.tsx` | sequential phase position for pipeline items | R3 — carries the "in sequence" label as part of the component, so a later edit cannot drop it |
| *(reused unchanged)* | `ArtifactReview.tsx`, `MemoryPanel.tsx`, `PipelineLogPanel` | |
| *(deleted)* | `ParallelSubagents.tsx` and its reducer branch | §6.7 |

**Bundle note.** All three webview surfaces load one bundle (`webview-html.ts:5-7`). The Office must
be lazily mounted behind the `window.isManagerPanel` flag, or the chat sidebar pays for a dashboard
and a log viewer it never renders. Worth a measurement before and after.

---

## 9. The defect: "thinking, but doing nothing"

**Symptom.** The user sends a prompt. Within a second the chat shows three bouncing dots and *"Agent
is thinking..."*. It stays there — ten seconds, sometimes minutes — with no tool call, no text, no
progress, no error. Eventually it either starts working or ends.

This is not one bug. It is **one missing surface and three unbounded waits**, and they compound.

### 9.1 The missing surface — why nothing is shown

`runAgentTask` calls `deps.sessions.beginTask()` at `chat-task.ts:260`, which emits `TaskStarted`.
The webview's reducer sets `phase: 'planning'`, and the message bubble renders the placeholder at
`App.tsx:3275-3284` — *any* agent message with empty `text` while `isGenerating` shows the dots.
`phaseLabel` (`agent-store.ts:429-443`) has a real answer for every phase and **is not rendered in
that placeholder at all.**

Then, *after* `beginTask` and *before* `runAgentLoop`, the following are awaited in order:

| `chat-task.ts` | Step | Logged? | Bounded? |
|---|---|---|---|
| :265-272 | rerank setup, **codebase index build** | `[Index] …` | ❌ see §9.2 |
| :276-285 | skills discovery, diagnostics publish, project profile, skill resolution | `[Skills] …` | ~ |
| :291-306 | **MCP `connectAll`** | `[MCP] …` per server | ⚠️ see §9.3 |
| :308-346 | hooks, knowledge context, memory injection, mindmap read | `[Memory] …` | ~ |
| :356-382 | rule selection | `[Rules] …` | ~ |
| :397-441 | prompt assembly | `[Prompt] …` | ~ |
| :449-460 | attachments, `@`-mention resolution | `[Context] …` | ~ |

**Every one of those steps logs.** And every log goes through `log()` (`chat-task.ts:174-177`), which
— because `task` now exists — emits `{type:'Log'}` onto the bus, is forwarded at
`extension.ts:216-217`, is appended to `agentLogs` at `App.tsx:990-992`… and is rendered **only**
inside the Reasoning panel, **only when the user has expanded it**, and **only as
`agentLogs.slice(-2)`** (`App.tsx:3343-3349`).

So: the system knows exactly what it is doing, says so seven times, and shows the user two of those
lines behind a disclosure triangle that is closed by default. **R6 violated by the widest margin in
the product.**

### 9.2 Unbounded wait #1 — the index build fetches embeddings one HTTP call at a time

`CodebaseIndex.build` (`codebase-index.ts:188-261`) walks up to **800 files**, and for each changed
file, for each chunk of it:

```ts
for (const chunk of chunks) {
    chunk.embedding = await EmbeddingsClient.getEmbedding(chunk.text, this.embeddingsConfig);
}
```

Sequential. Per chunk. Over the network when an embeddings provider is configured. No batching, no
concurrency, **no `AbortSignal`**, no progress callback, no time budget. A cold index on a real repo
is hundreds to thousands of round trips before the first token of the first turn.

This is the primary cause of a multi-minute "thinking". It is also why the symptom is
*intermittent* — a warm index reuses everything and returns in under a second, so the same prompt is
instant the second time.

### 9.3 Unbounded wait #2 — MCP connection

`connectAll` (`mcp-client.ts:155-164`) connects servers in parallel, which is right. But each server
then does `initialize`, `tools/list`, `resources/list` and `prompts/list` **sequentially**, each with
a 10 s request timeout (`mcp-client.ts:468-469`). A server that accepts a connection and answers
nothing costs ~40 s before it is declared dead — and the user sees three dots for all of it.

### 9.4 Unbounded wait #3 — the model call itself has no deadline

`fetchWithRetry` (`llm-client.ts:22-44`) passes the `AbortSignal` and nothing else. There is **no
connect timeout and no idle-stream deadline.** A provider that accepts the TCP connection, returns
200, and then sends no bytes leaves `readSSE` awaiting forever. `runWithFailover` cannot help: it
fails over on a thrown error, and nothing throws.

The 429 path is a second, quieter version of the same problem: it sleeps `5000 ms` (or the provider's
`retryDelay`) up to three times — **silently**. No event, no log, no UI. Up to ~15 s of "thinking"
that is really "waiting out a rate limit", and the user cannot tell those apart.

### 9.5 Contributing: Stop does not stop the pre-flight

`stopAgentTask` aborts the controller (`webview-message-handler.ts:309-313`). The signal is honoured
inside `runAgentLoop` and inside `fetch`. **None of the §9.1 pre-flight awaits observe it** — not the
index build, not `connectAll`, not the profile or mention resolution. So during the exact window
where the user is most likely to press Stop, pressing it does nothing visible; the run ends only when
the pre-flight finishes and the loop's first `signal?.aborted` check fires.

### 9.6 Contributing: an empty final turn renders an empty bubble

If a turn returns no text and no tool calls, `runAgentLoop` sets `completed = true` with
`finalText = ''` (`agent-loop.ts:226-230`). `chat-task.ts:914` posts `finalResponse` with the empty
string, and `App.tsx:3267` then renders an empty bubble — the dots stop, and nothing replaces them.
A rarer flavour of the same complaint, and worth fixing in the same pass.

### 9.7 The fix, in four parts

**Part A — make the pre-flight speak (M80).** A `Progress` event on the bus, and a *status line*
under the dots that renders `phaseLabel(state)` plus the newest `agentLogs` entry — not the last two,
behind a triangle:

```
   ●●●  Indexing the workspace…  1,204 files · 812 done            12s   [ Stop ]
   ●●●  Connecting MCP server "github"…                             4s   [ Stop ]
   ●●●  Thinking…                                          turn 1/25 · 3s [ Stop ]
```

The elapsed counter is not decoration: it is the difference between "this is slow" and "this is
stuck", and it is the only thing on this list a user can act on without reading a log. The Reasoning
panel keeps its detail; the *heading* stops being optional.

**Part B — bound every wait (M81).**

| Wait | Bound |
|---|---|
| Embeddings per chunk | batch (provider batch endpoint where available), cap concurrency at 4, honour `signal`, and **stop embedding after a per-build budget** — an index without embeddings still works, `applyRerank` already degrades gracefully (`codebase-index.ts:283-293`) |
| Index build overall | soft deadline; past it, return what is built and finish in the background. **The first turn must not wait on a cache warm-up** |
| MCP `connectAll` | overall deadline, not just per-request; servers that miss it are reported unreachable and the turn proceeds |
| LLM connect | connect timeout |
| LLM stream | **idle deadline** — no bytes for N seconds throws, so `runWithFailover` can do its job |
| 429 backoff | emit a `Log`/`Progress` line per retry with the wait; silence during a rate limit is indistinguishable from a hang |

Every one of these is user-configurable with a sane default, and every default is stated in
Settings — a timeout the user cannot see is a timeout they will blame the model for.

**Part C — make Stop mean stop (M81).** Thread `signal` through the pre-flight and check it between
steps. Post `taskComplete` immediately on abort rather than at the end of the pre-flight.

**Part D — write it all down (M82).** Every step above is already a `log()` call; the journal (§6)
captures them at `verbose`. Once it exists, "it hung and I closed the window" stops destroying the
evidence, which is what makes the *next* report of this actionable rather than anecdotal.

### 9.8 Acceptance

- With embeddings configured and a cold index, the status line updates **at least every 2 seconds**
  from prompt submit to first token. Asserted by a test that drives the pre-flight with a stubbed
  slow embeddings client and records the gaps between webview posts. **This is R6 as a test.**
- A provider stub that accepts the connection and sends nothing produces a failover or an error
  within the idle deadline — never an indefinite wait.
- Stop pressed during the index build ends the run within 1 second.
- A run whose final turn is empty renders a stated outcome, never an empty bubble.
- The journal of a cold-start run contains the index, skills, rules, MCP and prompt lines at
  `verbose`, in order, with durations.

---

## 10. Milestones

Numbering continues from M71, the highest currently allocated. Waves reflect dependency, not
priority.

| # | M | Wave | Task | Pri | Acceptance |
|:--:|:--:|:--:|---|:--:|---|
| O-1 | **M72** | 1 | **Header truth** — push `GovernorSnapshot` and `inboxCounts` to the panel; render slots, spend, tokens, attention | P1 | Every header number traces to a field that existed before this milestone. No new instrumentation |
| O-2 | **M73** | 1 | **Entry points** — status bar item, sidebar view registration, command alias, `global/activity` entry, toast → sidebar | P1 | The attention count is visible without opening any panel. Toast no longer opens an editor tab |
| O-3 | **M74** | 1 | **The work-item model** — `office-model.ts` + `office-narrate.ts` | P1 | Pure and unit-tested: a fixture of all four lanes produces one ordered roster; a lane with no worktree yields no worktree affordance; an event with no `arguments` narrates to a `—` target, never a guess |
| **O-B1** | **M80** | **1** | **§9 Part A — the pre-flight speaks.** `Progress` event; status line with `phaseLabel` + newest log + elapsed | **P0** | No gap over 2 s between webview posts from submit to first token, asserted against a stubbed slow pre-flight |
| **O-B2** | **M81** | **1** | **§9 Parts B & C — bound every wait, make Stop stop** | **P0** | Each bound in §9.7B has a default, a setting, and a test. Stop during pre-flight ends the run in ≤ 1 s |
| O-4 | **M75** | 2 | **Front Desk** — the sidebar view, built on M74 | P1 | Inbox ordering byte-identical to `buildInbox`. Every action row derived from a `can*` predicate |
| O-5 | **M76** | 2 | **Telemetry contract** — task agents onto the `EventBus`; `arguments` forwarded; `onTurn` and context reported; `FileChanged` emitted; patch channel; throttled live diff; mutex depth | P1 | Message rate under four running agents stays inside §5.4, **measured**. Telemetry-attributable `GitMutex` acquisitions ≤ 1 per agent per 10 s |
| **O-6** | **M82** | **2** | **The journal** — `run-journal.ts`, `journal-store.ts`, bus subscriber, redaction, retention, spill files | **P1** | A run's log is complete with no panel ever opened. Killing the window mid-run leaves a readable partial log. Retention bounds enforced by test, including "a live run is never pruned" |
| O-7 | **M77** | 3 | **The Office tab** — desks, files-in-play, empty desks, Records/Memory as tabs | P2 | Renders correctly at 320 px and 1600 px. Every `—` cell is a genuinely absent field, asserted over the fixture |
| **O-8** | **M83** | **3** | **The Logs tab** — `journal-reader.ts`, virtualised list, depth control, filter, live tail with pause, export | P2 | A 10 MB run log scrolls without dropping frames and without loading whole into the webview. Depth `summary` on a 2,400-line run yields ≤ 40 lines |
| **O-9** | **M84** | **3** | **`read_run_log` tool** — agent-readable logs | P2 | Advertised in `agent` mode only; defaults to the caller's run at `summary`; output compacted with a raw pointer; cannot read another workspace's runs |
| O-10 | **M78** | 3 | **The Desk** — drill-in, real steering textarea with history and artifact reference | P2 | A correction sent from the Desk arrives via `core/steering.ts`, and the surface reports which of *delivered* / *saved only* happened — the distinction `manager-panel.ts:250-264` already makes |
| O-11 | **M79** | 4 | **Honesty gates** — theme-token lint, `PhaseStrip` sequential label, delete `ParallelSubagents.tsx` and its reducer branch | P2 | A test fails on any hard-coded hex outside the three status literals. No surface renders a parallel wave scheduler |
| **O-12** | **M85** | **4** | **§9 Part D residue** — empty-final-turn outcome text; 429 backoff visibility | P3 | An empty final turn renders a stated outcome. A rate-limited run says so while it waits |

**Wave 1 is shippable on its own, and it now contains both P0s.** M80 and M81 are placed ahead of
every dashboard milestone deliberately: the defect in §9 costs a user something on every single
prompt, and no amount of Office polish is worth more than that. M72 and M73 ride along because they
are the cheapest real wins in the document and touch no execution path.

---

## 11. Verification plan

| Layer | Check |
|---|---|
| Purity | `office-model.ts`, `office-narrate.ts`, `office-telemetry.ts`, `run-journal.ts`, `journal-reader.ts` tested with no `vscode` import, as `agent-inbox.ts` and `task-agents.ts` already are |
| No invented data | A fixture roster with fields deliberately absent renders `—` in every corresponding cell. R1 as a test |
| No orphan affordances | For every `(lane, status)` pair, the rendered action set equals the set of `can*` predicates returning true. R2 as a test |
| **No silence** | **R6 as a test: drive a cold start with a stubbed slow embeddings client and assert no gap over 2 s between webview posts** |
| Narration | One test per `VERBS` row; one test asserting an unlisted tool renders its own name; one asserting a missing `arguments` yields `—` |
| Theme | Snapshot the Office and Logs under light, dark and high-contrast token sets; assert no literal hex outside the three status colours |
| Density | Render at 320 / 600 / 1600 px; assert no horizontal overflow and no clipped action row |
| Message budget | Drive four simulated agents at realistic tool cadence; assert posts/second and bytes/second stay inside §5.4 |
| Git pressure | Assert telemetry-attributable `GitMutex` acquisitions ≤ 1 per agent per 10 s |
| Journal integrity | Kill the extension host mid-run; assert the partial file parses line-by-line and the reader renders it. Assert retention never prunes a live run. Assert a seeded secret never appears in a written line |
| Journal scale | Generate a 10 MB log; assert `readPage` is O(page) and the tab never receives the whole file |
| Existing gates | `tsc -b` clean · vitest suites green · `npm run lint:css` · `extension.ts` stays ≤ 700 lines — M73 and M82 both add wiring and that gate has already fired twice |
| Runtime | Launch four task agents, one pipeline run and one daemon result; confirm all six appear as desks with correct affordances, that each has a readable log, and that applying one changes the live tree while the other five do not |

---

## 12. Deliberate non-features

Written down so a later revision does not quietly add them back.

- **No parallel wave scheduler graphic.** M35 was deleted on the merits. If a parallel executor is
  built, this becomes a two-hour change *at that point*.
- **No token-rate sparkline.** Token rate is near-constant per model; a sparkline of it is decoration
  that reads as telemetry. Replaced by turn-against-cap, context-against-limit, and stall time — all
  three actionable.
- **No derived `$/min` burn rate.** Spend against the governor's configured budget is the number that
  changes a decision.
- **No auto-apply, ever — including for a race winner.** `canApply` is the only path into the live
  tree and it is user-initiated (`task-agents.ts:104-116`); the race explicitly declines to apply its
  own winner. A dashboard must not become the exception.
- **No synthetic node identifiers.** Agent ids and branch names are real handles; a second identifier
  space with no referent makes the log and the roster harder to reconcile, not easier.
- **No third notification channel.** The inbox already fires once per `(item, reason)` and prunes
  (`agent-inbox.ts:150-168`). The Office is a surface for that state, not a second notifier.
- **The journal never leaves the machine.** No export-to-cloud, no remote sink, no "share this run"
  button, and no setting that would add one. It carries file contents and command output by design,
  and the moment it has a network path it becomes a different feature with a different review.
- **No "explain what this agent is doing" model call.** §5.4. The verb table is deterministic and
  free; a summarising call is a per-tool-call model charge for a sentence a lookup can produce.
- **No log-driven UI state.** The Office reads the projection, never the journal. A surface that
  re-derives live state by parsing its own log is a surface that disagrees with itself.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| **The verbose journal eats the disk** | Four hard bounds in the store (§6.4), enforced by test, not by care. Retention configurable to off |
| **Redaction false-positives destroy the evidence** | Accepted, and stated: the alternative leaks on `[ Open as file ]`. `describeFindings` records what was redacted so a user can see *that* something was |
| **Telemetry slows the thing it watches** — the git mutex is process-global and already a documented throughput ceiling | §5.4 budget, enforced by the M76 acceptance test |
| **The §9 fixes change agent behaviour** — a bounded index build means fewer embeddings on the first turn | Deliberate, and the degradation path already exists: `applyRerank` falls back to fused ranking (`codebase-index.ts:283-293`). Search quality on turn 1 of a cold repo is worth less than the run starting |
| **`WebviewView.badge` may not exist in the fork's API version** | Verify in M73 before building. The status bar item carries the count regardless |
| **Chat gains a title bar** when a second view joins the container | Stated in §4.2 as a trade-off rather than discovered in review |
| **Bundle growth reaches the chat sidebar**, since all three surfaces share one bundle | Lazy-mount behind `window.isManagerPanel`; measure before and after. The log viewer is the biggest new component and must not be in the chat bundle |
| **Four lanes drift apart again** | The lane is a *field on one row type*, and `office-model.ts` is the only place that knows about lanes. A fifth lane is a case in one pure function |
| **The plan is done and the panel is still hard to find** | M73 ships before any dense work. If only wave 1 lands, the user gets a visible sourced attention count *and* the §9 fix — which is the actual value |

---

## 14. Where this leaves the docs

Per [`README.md`](./README.md)'s one-inventory rule, when this work lands:

- `features.md` — row **#9** (agent inbox) gains its surface; new rows for the Office, the Logs tab
  and the run journal; row **#12** (background agents) moves off 📋 once the daemon's results are
  visible in the Office.
- `pending-tasks.md` — M72–M85 enter as a phase block with the §10 acceptance criteria. **M80 and
  M81 enter as P0 defect work, not as feature work**, and should be listed as such.
- `enhancement.md` — §6 gains a revision-log line for this rewrite.
- This file stays the **design record** — the *why* behind the shape — and does not restate status.
