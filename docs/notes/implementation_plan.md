# The Agent Office — design record and implementation plan

**Owns:** *where the user watches and steers concurrent agent work, and what the IDE shows them.*
**Supersedes:** the "Agent Swarm Operations & Telemetry Dashboard" revision of this file (§0).
**Audited against the tree:** 2026-08-04 — every claim below about existing data was re-checked in
code, with the file and line named. Nothing here is read off the previous revision.

This is a **design record with a plan attached**, in the sense `plan.md` is one: it explains why the
surface is shaped this way, so that a later reader can tell an intentional constraint from an
oversight. It is not a status document — open work lives in
[`pending-tasks.md`](./pending-tasks.md), and the capability inventory lives in
[`features.md`](./features.md). Where this file and those disagree, they are right.

---

## Preview — the Agent Office at a glance

Three surfaces, one model. The **Front Desk** in the sidebar answers *"does anything need me?"* and is
always one click away; the **Floor** in an editor tab answers *"what is everything doing?"* and is
opened deliberately; the **status bar item** answers both in eight characters and costs nothing.

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ● ● ●     blackIDE — ornate_source                                                                       │
├───┬──────────────────────────────────────┬────────────────────────────────────────────────────────────────┤
│ ▣ │ ▾ AGENT OFFICE               ④  ⟳    │  NavHeader.tsx  ×  │  ✦ Agent Office  ×                        │
│ ⌕ ├──────────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ ⑂ │ ── NEEDS YOU ──────────────── 3 ──   │ Floor │ Front Desk ③ │ Records ⑦ │ Memory ④    ⟳               │
│ ▷ │ ┌────────────────────────────────┐   │┌ slots ────┐┌ spend ────┐┌ tokens ───┐┌ needs you ──┐          │
│ ⚙ │ │ ⏸ PARKED · waiting 41 min      │   ││ 3 of 4    ││ 16% spent ││ 148 200   ││ 1 ⏸   1 ✔   │          │
│───│ │ Add OAuth refresh to the auth… │   ││ 1 free    ││ $0.82/$5  ││ over 4 run││ 1 ✖         │          │
│ ✦ │ │ pipeline · plan ready          │   │└───────────┘└───────────┘└───────────┘└─────────────┘          │
│ ▲ │ │ [Read plan] [Approve] [Reject] │   │ WORK                              lane: all ▾                  │
│ │ │ └────────────────────────────────┘   │┌────────────────────────────────────────────────────┐          │
│ │ │ ┌────────────────────────────────┐   ││ ● RUNNING   task  ta_m4x1  Frontend · Sonnet 4.5   │          │
│ │ │ │ ✔ READY · finished 3 min ago   │   ││ Rebuild the navigation header so it collapses at…  │          │
│ │ │ │ Extract the retry helper out…  │   ││ branch  blackide/agent/ta_m4x1                     │          │
│ │ │ │ task · 6 files  +142 / −18     │   ││ ▸ edit_file  src/components/NavHeader.tsx   1.4 s  │          │
│ │ │ │ ✔ verified · 14/14 passing     │   ││ turn [#######-----] 7/25   ctx [#######---] 72%    │          │
│ │ │ │ [Apply] [Diff]      [Discard]  │   ││ [ Steer ]  [ Diff ]  [ Worktree ]        [ Stop ]  │          │
│ │ │ └────────────────────────────────┘   │└────────────────────────────────────────────────────┘          │
│ │ │ ┌────────────────────────────────┐   │┌────────────────────────────────────────────────────┐          │
│ │ │ │ ✖ FAILED · 12 min ago          │   ││ ⏸ NEEDS YOU  pipe  pr_88f  Sr Architect · Sonnet   │          │
│ │ │ │ Migrate the settings store to… │   ││ Ship the settings redesign · waiting 41 min        │          │
│ │ │ │ branch blackide/agent/ta_m3w7  │   ││ HLD ▸ LLD ▸ Plan ▸ Design ▸ Backend ▸ Frontend ▸ T │          │
│ │ │ │ [Open branch]       [Dismiss]  │   ││                    ▲ waiting · runs in sequence    │          │
│ │ │ └────────────────────────────────┘   ││ [ Read plan ]  [ Approve ]             [ Reject ]  │          │
│ │ ├──────────────────────────────────────┤└────────────────────────────────────────────────────┘          │
│ │ │ ── ON THE FLOOR ───────────── 3/4 ─  │┌────────────────────────────────────────────────────┐          │
│ │ │ ● ta_m4x1 task nav header  turn 7/25 ││ ✔ READY     task  ta_m3z9      Agent · Sonnet 4.5  │          │
│ └─│ ● ta_m4x2 task auth mw     turn 3/25 ││ Extract the retry helper out of tool-runner        │          │
│   │ ● pr_88f  pipe Frontend    phase 5/7 ││ 6 files +142/−18 · verified 14/14 · test-report.md │          │
│   │ ○ dm_0142 dmon done 02:14     [seen] ││ [ Apply ]  [ Diff ]  [ Worktree ]     [ Discard ]  │          │
├───┴──────────────────────────────────────┴────────────────────────────────────────────────────────────────┤
│ git dev*   ⊘ 0  ⚠ 2        ◆ Office 3▸ 1!          Ln 42, Col 8   TypeScript   UTF-8                      │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| What you are looking at | Detail |
|---|---|
| **Front Desk** — `buildInbox`'s output, unchanged and un-re-sorted: parked, then ready, then failed. Each card leads with what happened and ends with the transitions that actually exist | §4.3 |
| **`READY` carries the same weight as a failure.** Nothing is wrong, nothing is on a timer, and the work quietly never lands — the case the inbox was built for | `agent-inbox.ts:112` |
| **ON THE FLOOR** — one line per live item, four lanes (`task` · `pipe` · `chat` · `dmon`) in one roster, keyed by real ids you can paste into `git` | §2.1 |
| **Every header tile sources from `GovernorSnapshot`** — which the code already computes and today throws away | `agent-governor.ts:166` |
| **`turn 7/25` and `ctx 72%`** replace the token-rate sparkline: an agent about to run out of loop, or about to compact, is something you can act on | §2.4 |
| **`runs in sequence`** printed on the pipeline card. Parallel wave execution was deleted in Phase 6, so the strip is a position indicator and says so | §2.3 R3 |
| **The branch appears on every card that has one** — it is the recovery path, not metadata | §2.3 R5 |
| **Status bar** `◆ Office 3▸ 1!` — three running, one waiting. The only always-visible surface, and the answer to what is left of F16 | §4.2 |

Nothing above is drawn from a field that does not exist; the audit of what does and does not is §1.
The wireframes for each surface on its own — sidebar, Floor, Desk, empty and budget-exhausted states —
are §4.

---

## 0. Verdict on the previous revision

The previous revision proposed a dark "Agent Swarm Monitor" — five telemetry tiles, per-node cards
with AST targets and token-rate sparklines, a live event trace and a dependency-wave graph — and
closed with:

> **Total: Zero backend changes required. All data already streams via `EventBus` and `ManagerPanel`
> props.**

That sentence is false, and it is false in the specific way that makes a UI plan dangerous rather
than merely optimistic: **six of the seven numbers in the mockup have no source in the running
system.** A dashboard built to that spec compiles, renders, demos beautifully, and shows invented
values. §1 is the audit.

Three things are wrong beyond the missing data, and they are the reason this is a rewrite rather
than an amendment:

1. **It renders execution topology the engine does not have.** The "DEPENDENCY GRAPH & WAVE
   SCHEDULER" strip draws `[Design Wave]` and `[Backend Wave]` executing in parallel. Parallel wave
   execution is **M35, and it was deleted on the merits in Phase 6** (`enhancement.md` §610:
   *"removed. Unverified for six phases…"*). `selectExecutionWaves` survives only to render
   `dependency_graph.md`, which describes which phases *could* be independent
   (`agent/pipeline-orchestrator.ts:48-62`). Drawing it as a live scheduler re-advertises a
   capability the owner decided to delete.

2. **It hard-codes a dark theme into a themed surface.** Every colour token in
   `webview/tailwind.config.js` resolves to `var(--vscode-*)`. `#09090b` and `border-zinc-800` do
   not. On a light theme the Office would be a black rectangle in the middle of the editor, and no
   amount of "enterprise density" survives that.

3. **It designs one lane and calls it the swarm.** `NODE-01: FE_EXECUTOR` and `NODE-03:
   ARCHITECT_PLANNER` are *pipeline phases*; `NODE-02` with a worktree branch is a *task agent*.
   They are different units with different verbs — a phase has no worktree to halt, an agent has no
   plan to approve — and the mockup gives them one card with one button row. Meanwhile chat
   subagents and the incoming daemon (`core/daemon-protocol.ts`, P11-3) appear nowhere.

**What survives from it:** the instinct that the current panel is under-built, the preference for
density over decoration, the event trace, and the refusal of toy metaphors. All four are kept.

**The one framing change.** The old design optimises entirely for *"what is everything doing?"* —
a question the user asks perhaps twice a day, and which is genuinely fun to look at. The question
they ask twenty times a day is *"does anything need me?"*, and the system **already computes the
answer** (`core/agent-inbox.ts`, graded ✅🟢 as feature #9) and then buries it behind a badge in a
panel you have to summon from the command palette. The Office inverts that: the front desk is
always visible, the floor is a deliberate visit.

---

## 1. Data audit — what the mockup renders vs. what exists

| Mockup element | Real source today | Verdict |
|---|---|---|
| `Mode` · `Model` · `branch` · `rootPath` | `TaskAgentSummary` (`core/task-agents.ts:38-91`) | ✅ exists |
| `Diff: +142 / −18` | `diffStat` runs **once, after the final commit** (`agent/task-agent-registry.ts:318`) | ⚠️ exists but only *after* the run ends — the live value in the mockup does not |
| Verification `14/14 passing` | `summary.verification` (`task-agents.ts:78-84`) | ✅ exists |
| `Active Tool: replace_file_content (124ms)` | `currentAction` holds the tool **name only**; the registry reads `ToolCallStarted.name` and nothing else (`task-agent-registry.ts:355-359`) | ⚠️ name only — no duration, no start time |
| `AST Target: src/components/NavigationHeader.tsx` | nothing. The task lane never forwards tool *arguments* | ❌ absent |
| `Sparkline: token rate 420 t/s` | `tokens` is a **running total**, incremented in `onUsage` (`task-agent-registry.ts:307-314`). No time series is retained anywhere | ❌ absent |
| `Context Capacity 72% (18/25)` | `ContextManager` is constructed **inside** `runTask` and never reported out (`agent/task-agent-entry.ts:146`) | ❌ absent |
| `[Turn 18/25]` | `maxLoops` is known (`task-agent-entry.ts:144`); the current turn is not published | ❌ absent |
| `GIT MUTEX QUEUE — STATUS: OK` | `GitMutex` is a private promise chain with no observable depth (`agent/git-mutex.ts:11`) | ❌ absent |
| `TOTAL TOKENS` · `BURN RATE` · `ACTIVE LANES 3/4` | **`GovernorSnapshot` computes all of it already** — `active`, `maxConcurrent`, `tokensSpent`, `tokenBudget`, `costSpent`, `costBudget`, `exhausted` (`core/agent-governor.ts:54-63, 166`) — and it is **never sent to any webview** | 🎁 exists, unwired. The cheapest real win in this document |
| Per-node event trace | Task agents **do not publish to the `EventBus` at all.** They use a private `params.emit` carrying three event types, of which the registry reads one (`task-agent-entry.ts:155-159`, `task-agent-registry.ts:355`) | ❌ absent for the task lane; ✅ present for the pipeline lane, which already streams `pipelineRunEvent` into `agentReducer` |
| Dependency wave graph | `selectExecutionWaves` describes the plan's shape. **No parallel executor exists** — M35 deleted | ❌ would misrepresent the runtime |

### 1.1 The delivery mechanism is the other half of the problem

`TaskAgentRegistry.update()` — called for *every* field change including per-turn token charges —
persists the whole history to `globalState`, then re-pushes **the entire agent array** to the panel,
then triggers an inbox recompute (`task-agent-registry.ts:363-374` → `task-agent-lane.ts:52-56`).

Today that drives a six-field card and nobody notices. A twenty-field card with progress bars and a
sparkline, re-rendered from a whole-array replacement at token cadence across four agents, is a jank
source and a battery cost. **Any dense view needs a patch channel before it needs a sparkline.**

---

## 2. The design — one model, four rooms

### 2.1 The unit: a work item

The Office has exactly **one row type**. Everything the user launched or the machine produced is a
*work item*, and the lane is a field on it rather than a different card:

| Field | Meaning | Lanes that populate it |
|---|---|---|
| `id` | the real handle — `ta_m4x1`, `pr_88f`, `sa_…`, `dm_0142`. Never a synthetic `NODE-01` | all |
| `lane` | `task` · `pipeline` · `chat` · `daemon` | — |
| `title` | the prompt, truncated the way `agent-inbox.ts:183` already truncates | all |
| `status` | the four-state vocabulary the two lanes already share | all |
| `mode` · `model` | who ran it and with what | task, pipeline, chat |
| `root` · `branch` | the recovery instruction. **Always rendered** (the reasoning is already in `ManagerPanel.tsx:431`) | task, chat, daemon |
| `action` | current tool + target + started-at | task, pipeline (needs §5) |
| `progress` | turn *n* of *max*, context used of limit | task, pipeline (needs §5) |
| `evidence` | verification outcome, counts, report path, screenshot | task, pipeline |
| `delta` | files, insertions, deletions | task, daemon |
| `needs` | the inbox reason, when there is one | all |

**Why one row type.** A pipeline phase has no worktree, so it shows no worktree button — not a
greyed one. A daemon result has no live turn, so its progress cell reads `—`, not `0/25`. The lane
decides which cells have referents; it does not get its own card layout. Four card layouts is how
the three existing surfaces drifted apart in the first place.

### 2.2 The four rooms

| Room | The question | Where it lives | Built on |
|---|---|---|---|
| **Front Desk** | *Does anything need me?* | Sidebar view, always one click away | `buildInbox` / `inboxCounts` — **already shipped, ✅🟢** |
| **The Floor** | *What is everything doing?* | Editor tab, opened deliberately | the roster + trace |
| **A Desk** | *What is **this** one doing, and what do I do about it?* | Drill-in from either | per-item detail + steering + diff |
| **Records** | *What did they produce?* | Tabs on the Floor | `ArtifactReview.tsx`, `MemoryPanel.tsx` — **already shipped** |

Records is listed to make a point: the artifact review panel and the memory panel are finished, ✅🟢
features that today live behind tabs in a panel most users never open. Moving them into the Office
is most of their distribution problem solved, and costs no new code.

### 2.3 The five honesty rules

These are the spine of the design. Every one exists because §1 found the previous revision breaking
it.

- **R1 — No metric without a source.** Every number names the field it came from. A field that is
  absent renders `—`, never `0`, never a plausible-looking default. A missing measurement and a
  measured zero are different facts.
- **R2 — No affordance without a transition.** Buttons are rendered from `canApply` /
  `canCancel` / `canDiscard` / `holdsWorktree` / `liveIds()` — the predicates already exported by
  `core/task-agents.ts:114-136`. If the transition does not exist, the button does not render.
  Disabled buttons teach the user that the capability exists and they did something wrong.
- **R3 — No topology we do not execute.** The pipeline strip shows the seven phases **in sequence**,
  because that is how `pipeline-orchestrator.ts` runs them. If a parallel executor is ever built,
  the strip changes then.
- **R4 — Theme tokens only.** Every colour resolves through `var(--vscode-*)` via the existing
  Tailwind theme. The Office must be legible on a light theme, on a high-contrast theme, and on
  whatever the user actually uses.
- **R5 — The branch is always visible on anything that has one.** It is not metadata, it is how the
  user recovers work from an agent that failed. `reconcileInterruptedAgents` writes it into the
  error message for exactly this reason (`task-agents.ts:160`).

### 2.4 What to measure instead of a token-rate sparkline

Token rate is close to constant per model, so a sparkline of it is decoration that reads as
telemetry. Three things a user can actually act on, all of which are one field away:

- **Turn against the cap** — `maxLoops` defaults to 25 (`task-agent-entry.ts:144`). An agent on
  turn 22 of 25 is about to run out of loop, which is a reason to steer it *now*.
- **Context against the limit** — `ContextManager` already knows the model's window. An agent at 90%
  is about to compact, and compaction is when runs lose the thread.
- **Time since the last tool finished** — a stalled agent looks identical to a working one on every
  surface we have today. `⚠ 12.6 s` next to `run_command` is the single highest-value cell on
  the card.

And at the header: **spend against the governor's configured budget**, not a derived `$/min`.
`GovernorSnapshot` has both halves already.

---

## 3. Placement — how this appears in the IDE

Today the Manager is a `WebviewPanel` opened at `ViewColumn.Active`
(`core/manager-panel.ts:100-117`), reachable **only** from the command palette
(`core/command-registry.ts:103`). There is no sidebar presence, no status bar item, no menu entry,
no keybinding. The inbox notification's only action is a toast button that says *"Open Manager"*
(`agent/task-agent-lane.ts:180`) — which steals an editor column to answer a yes/no question.

That is the remaining shape of the F16 defect the inbox was built to close: *the state was always
right, nobody was ever told about it.* Three surfaces, sized to their questions:

| Surface | Cost to the user | Shows | Refresh |
|---|---|---|---|
| **Status bar item** | zero — always visible | running count · attention count | on inbox change |
| **Sidebar view** | one click, no editor column | Front Desk + compact roster | patch stream |
| **Editor tab (Floor)** | a column, deliberately | everything | patch stream |

### 3.1 Container decision

**Recommendation: a second view inside the existing `black-ide-chat` activity-bar container**, not
a new container.

- One icon in the activity bar keeps Black IDE at one entry, which matters on a fork where the
  activity bar is contested.
- The container badge aggregates its views' badges, so the Office's attention count shows on the
  activity bar even when the view is collapsed.
- **The trade-off, stated:** the chat view currently has `"name": ""`, so it renders as a bare
  webview filling the container. Adding a sibling gives both views a title bar. Chat gains a
  `▾ CHAT` header row it does not have today.

**Verify before building:** that the fork's API version exposes `WebviewView.badge`. If it does not,
the fallback is the status bar item carrying the count alone — which is why the status bar item is
M72 and not an afterthought.

### 3.2 Entry points to add

| Entry | Behaviour |
|---|---|
| Status bar item, right-aligned near priority 100 | click → reveal the sidebar view. Tooltip is `summarizeForNotification(items)` — already written (`agent-inbox.ts:171`) |
| `black-ide.openAgentOffice` | opens the Floor. `black-ide.openPipelineManager` **kept as an alias** — the id is in muscle memory and possibly in user keybindings |
| `global/activity` menu | alongside the existing Settings entry |
| Keybinding `ctrl+shift+a` / `cmd+shift+a` | **conflict-check against the fork's defaults first** |
| Inbox toast | its button becomes *"Show me"* → reveals the sidebar, not the editor tab. A toast that costs an editor column gets dismissed reflexively |

---

## 4. Screenshots

Wireframes at realistic proportions: sidebar drawn at ~46 columns (≈300 px at the webview's 11 px
mono), Floor at editor-column width.

### 4.1 The whole window — where each surface lives

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  ● ● ●              blackIDE — NavHeader.tsx                                       │
├───┬──────────────────────────┬─────────────────────────────────────────────────────┤
│ ▣ │ ✦ BLACK AGENT       ④   │  NavHeader.tsx  ×  │ ✦ Agent Office  ×              │
│ ⌕ ├──────────────────────────┼─────────────────────────────────────────────────────┤
│ ⑂ │ ▾ CHAT                   │                                                     │
│ ▷ │   …                      │                                                     │
│ ⚙ │                          │            THE FLOOR   (§4.4)                       │
│───│ ▾ AGENT OFFICE      ④   │            an editor tab, opened deliberately        │
│ ✦ │  ── NEEDS YOU ──         │                                                     │
│ ▲ │  ⏸ PARKED · 41 min       │                                                     │
│ │ │  Add OAuth refresh …     │                                                     │
│ │ │  ── ON THE FLOOR ── 3/4  │                                                     │
│ └─┤  ● ta_m4x1  nav header   │                                                     │
│   │  ● ta_m4x2  auth mw      │                                                     │
├───┴──────────────────────────┴─────────────────────────────────────────────────────┤
│ ⎇ dev*   ⊘ 0  ⚠ 2          ◆ Office 3▸ 1!         Ln 42, Col 8   TypeScript  UTF-8 │
└────────────────────────────────────────────────────────────────────────────────────┘
      ▲ activity bar          ▲ status bar item (§4.2)
        container badge ④
```

### 4.2 Status bar item — the always-on surface

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

The item never shows a number it cannot source. `3▸` comes from `GovernorSnapshot.active`; `1!`
from `inboxCounts().blocking + .failed`. When nothing is running and nothing is waiting, it is four
characters of ambient reassurance rather than a badge shouting zero.

### 4.3 The Front Desk — sidebar view

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
│ │ [ Open branch ] [ Retry ]     [ Dismiss ]│ │
│ └──────────────────────────────────────────┘ │
├──────────────────────────────────────────────┤
│ ── ON THE FLOOR ─────────────────────── 3/4 ─│
│ ● ta_m4x1  task   nav header      turn  7/25 │
│ ● ta_m4x2  task   auth middleware turn  3/25 │
│ ● pr_88f   pipe   Frontend Exec   phase 5/7  │
│ ○ dm_0142  daemon finished 02:14  ✔ reviewed │
├──────────────────────────────────────────────┤
│ $0.82 / $5.00 · 148.2k tok      [ Floor ▸ ]  │
└──────────────────────────────────────────────┘
```

Design notes worth writing down:

- **Ordering is `buildInbox`'s, unchanged.** Parked before blocked before failed before review, and
  *oldest first within the blocking states* because the oldest blocked run has wasted the most time
  (`agent-inbox.ts:54-61`). The panel does not re-sort; re-sorting would be a second opinion about
  urgency that nobody tested.
- **`READY` is the item the whole inbox exists for.** Nothing is wrong, nothing is on a timer, and
  the work quietly never lands (`agent-inbox.ts:112-121`). It gets the same visual weight as a
  failure.
- **The failed card leads with the branch**, because R5 — that line is the entire recovery path.
- **"ON THE FLOOR" is one line per item.** At 46 columns anything more is a truncation contest. The
  cells chosen are the ones §2.4 argues are actionable.

### 4.4 The Floor — editor tab

```
┌─ ✦ Agent Office ───────────────────────────────────────────────────────────────────────────────────┐
│  Floor    Front Desk ③    Records ⑦    Memory ④          3 of 4 running · $0.82 / $5.00 · ⟳       │
├────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌ slots ───────┐ ┌ spend ───────┐ ┌ tokens ──────┐ ┌ git queue ───┐ ┌ needs you ─────────────────┐ │
│ │ ███▌ 3 / 4   │ │ ▓▓░░░░  16%  │ │ 148 200      │ │ 0 waiting    │ │ 1 parked · 1 ready · 1 ✖   │ │
│ │ 1 slot free  │ │ $0.82/$5.00  │ │ over 4 runs  │ │ idle 2.1 s   │ │ oldest waiting: 41 min     │ │
│ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ └────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┬─────────────────────────────────────┤
│ WORK                       lane: all ▾   status: all ▾       │ TRACE     lane: all ▾  info ▾   ⏸  │
│                                                              │                                     │
│ ┌──────────────────────────────────────────────────────────┐ │ 12:30:14.201  ta_m4x1               │
│ │ ● RUNNING    task  ta_m4x1        Frontend · Sonnet 4.5  │ │   ▸ edit_file                       │
│ │ Rebuild the navigation header so it collapses under 720px│ │     src/components/NavHeader.tsx    │
│ │ ⎇ blackide/agent/ta_m4x1     ~/ornate_source/blackIDE    │ │                                     │
│ │ ▸ edit_file   src/components/NavHeader.tsx        1.4 s  │ │ 12:30:12.890  ta_m4x2               │
│ │ turn ███████░░░░░░░ 7/25   ctx ███████░░░ 72%  +142/−18  │ │   ✔ verified   14/14 passing        │
│ │ [ Steer ]  [ Diff ]  [ Worktree ]              [ Stop ]  │ │                                     │
│ └──────────────────────────────────────────────────────────┘ │ 12:30:05.112  pr_88f                │
│ ┌──────────────────────────────────────────────────────────┐ │   ▸ phase  Frontend Executor 5/7    │
│ │ ● RUNNING    task  ta_m4x2        Backend · GPT-5        │ │                                     │
│ │ Add refresh-token rotation to the auth middleware        │ │ 12:29:58.004  ta_m4x1               │
│ │ ⎇ blackide/agent/ta_m4x2     ~/ornate_source/blackIDE    │ │   ↯ steered                         │
│ │ ▸ run_command  npm test -- auth        12.6 s   ⚠ slow   │ │     "use the existing hook"         │
│ │ turn ███░░░░░░░░░░░ 3/25   ctx ███░░░░░░░ 28%   +61/−4   │ │                                     │
│ │ [ Steer ]  [ Diff ]  [ Worktree ]              [ Stop ]  │ │ 12:29:41.560  dm_0142               │
│ └──────────────────────────────────────────────────────────┘ │   ▸ daemon result written           │
│ ┌──────────────────────────────────────────────────────────┐ │                                     │
│ │ ⏸ NEEDS YOU  pipe  pr_88f      Sr Architect · Sonnet 4.5 │ │ 12:28:03.117  ta_m3z9               │
│ │ Ship the settings redesign                               │ │   ✔ completed  6 files              │
│ │ Plan ready · waiting 41 min                              │ │                                     │
│ │ HLD ▸ LLD ▸ Plan ▸ Design ▸ Backend ▸ Frontend ▸ Testing │ │                                     │
│ │                    ▲ waiting here                        │ │                                     │
│ │ phases run in sequence                                   │ │                                     │
│ │ [ Read plan ]  [ Approve ]                    [ Reject ] │ │                                     │
│ └──────────────────────────────────────────────────────────┘ │                                     │
│ ┌──────────────────────────────────────────────────────────┐ │                                     │
│ │ ✔ READY      task  ta_m3z9            Agent · Sonnet 4.5 │ │                                     │
│ │ Extract the retry helper out of tool-runner              │ │                                     │
│ │ ⎇ blackide/agent/ta_m3z9    6 files  +142 / −18          │ │                                     │
│ │ ✔ verified · 14/14 passing · test-report.md · screenshot │ │                                     │
│ │ [ Apply ]  [ Diff ]  [ Worktree ]           [ Discard ]  │ │                                     │
│ └──────────────────────────────────────────────────────────┘ │                                     │
└──────────────────────────────────────────────────────────────┴─────────────────────────────────────┘
```

Read the differences from the old mockup deliberately:

- **`phases run in sequence`** is printed on the card. R3. The strip is a position indicator, not a
  scheduler, and it says so in four words rather than implying otherwise in a graphic.
- **`⚠ slow`** next to a 12.6 s `run_command` — §2.4's stall signal, the one cell that turns
  "something is happening" into "something is stuck".
- **Ids are the real ones.** `ta_m4x1` is `newAgentId`'s output (`task-agents.ts:179`) and
  `blackide/agent/ta_m4x1` is `branchNameFor`'s. Both can be pasted into `git`. `NODE-01` could not.
- **The trace names the item, not a node number**, so a line in the trace and a card in the roster
  are obviously the same thing.
- **Records ⑦ and Memory ④ are tabs here**, not a separate panel. They are finished features with a
  distribution problem.

### 4.5 A Desk — drill-in on one item

```
┌─ ta_m4x1 ──────────────────────────────────────────────────────────────── ✕ ─┐
│ Rebuild the navigation header so it collapses under 720px                    │
│ ● RUNNING · 4 min 12 s     task · Frontend · Sonnet 4.5                      │
│ ⎇ blackide/agent/ta_m4x1  ←  ~/ornate_source/blackIDE @ a3f19c2              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Trace      Diff (6)      Evidence      Steering (2)                         │
├──────────────────────────────────────────────────────────────────────────────┤
│ turn    ███████░░░░░░░░░░  7 / 25          ctx  ███████░░░  72%  (18k/25k)   │
│ tokens  38 400              spend  $0.19                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ 12:30:14.201  ▸ edit_file      src/components/NavHeader.tsx        1.4 s     │
│ 12:30:09.882  ✔ read_file      src/components/NavHeader.tsx        0.2 s     │
│ 12:30:08.114  ✔ grep           "useBreakpoint"                     0.9 s     │
│ 12:29:58.004  ↯ steered        "use the existing hook"                       │
│ 12:29:41.101  ✔ list_directory src/components                      0.1 s     │
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌ Correct this agent — reaches the model on its next turn ─────────────────┐ │
│ │                                                                         │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ [ Send correction ]        [ Open worktree ]   [ Open diff ]   [ Stop ]      │
└──────────────────────────────────────────────────────────────────────────────┘
```

The steering box is the point of this room. Today steering is a `window.prompt()` — a modal, single
line, no history, no artifact reference (`ManagerPanel.tsx:445-447`) — for a feature graded ✅🟢
that the design of `core/steering.ts` supports far better than that (it carries `artifactPath` and
`region`). A textarea with the last corrections visible above it is most of the gap.

### 4.6 Empty and degraded states

```
┌──────────────────────────────────────────────┐   ┌──────────────────────────────────────────────┐
│ ▾ AGENT OFFICE                            ⟳  │   │ ▾ AGENT OFFICE                        ⛔  ⟳ │
├──────────────────────────────────────────────┤   ├──────────────────────────────────────────────┤
│                                              │   │ ── BUDGET SPENT ─────────────────────────────│
│           Nothing is running.                │   │ The session budget of $5.00 is spent.        │
│                                              │   │ Nothing further will start until it is       │
│   Launch a task and it works in its own      │   │ raised or reset in Settings.                 │
│   git worktree — your workspace is not       │   │                                              │
│   touched until you apply the result.        │   │ 3 agents already running will finish.         │
│                                              │   │                                              │
│              [ New task ▸ ]                  │   │ [ Open settings ]         [ Reset spend ]    │
└──────────────────────────────────────────────┘   └──────────────────────────────────────────────┘
```

The empty state teaches the one property the whole task-agent design is built around — *untouched
until you apply* (`core/task-agents.ts:12-19`). The budget state is `GovernorSnapshot.exhausted`,
which today produces a refusal message at launch time and nothing else; a user whose launches are
being refused deserves to see why before they click.

### 4.7 Light theme

Not a separate design — the same wireframes with every token resolved through the existing Tailwind
theme. The mapping the Office uses, all of which already exist in `webview/tailwind.config.js`:

| Role | Token |
|---|---|
| surface / card | `panel` → `--vscode-editor-background` |
| rules and borders | `border` → `--vscode-sideBar-border` |
| primary text | `foreground` → `--vscode-sideBar-foreground` |
| secondary text | `muted` → `--vscode-descriptionForeground` |
| running / focus | `focusBorder` → `--vscode-focusBorder` |
| verified | `successGreen` | waiting | `warningAmber` | failed | `dangerRed` |

The three status colours are the only literals, they are already in the config, and they are the
three the existing panels already use — so the Office inherits whatever contrast decision was made
there rather than making a fourth one.

---

## 5. The telemetry contract

This is the work the previous revision claimed was unnecessary. Stated as a contract because the
constraint that matters is not "add fields" — it is **that watching must not change what runs.**

### 5.1 Budget

| Rule | Why |
|---|---|
| Telemetry never costs a model call | obvious, and worth writing down before someone proposes a summarising "what is this agent doing" line |
| Telemetry takes the git mutex **at most once per agent per 10 s** | `GitMutex` is process-global and is explicitly documented as a throughput ceiling on all parallel work (`git-mutex.ts:22-27`). A live diff polled per event would serialise four agents behind the UI |
| Nothing is computed when no surface is open | the panel already drops posts with no panel (`manager-panel.ts:84`); the *producers* must check too |
| Structural changes push a list; field changes push a patch | §1.1 |

### 5.2 Message channel

| Message | Carries | Cadence |
|---|---|---|
| `officeSync` | the full roster + governor snapshot + inbox | mount, and on launch/retire |
| `officePatch` | `{ id, changed fields }` for one item | coalesced, ≤ 4 Hz per item |
| `officeTrace` | append-only trace lines, capped ring | as events arrive, coalesced |
| `officeGovernor` | `GovernorSnapshot` | on change |

Coalescing lives on the **extension-host** side. A webview that throttles still pays the
`postMessage` serialisation cost for every dropped frame.

### 5.3 Per-lane work

| Lane | What is needed |
|---|---|
| **Task agents** | Publish to the shared `EventBus` with proper correlation meta (the agent id as `taskId`) instead of the private three-event `params.emit`. Forward `ToolStarted.arguments` so the action has a *target* — the bus type already carries `arguments?: any` (`event-bus.ts:23`), the task lane simply never fills it. Report turn index and context usage out of the loop. Throttled live `diffStat` against the worktree while running |
| **Pipeline runs** | Already streams `pipelineRunEvent` into `agentReducer`. Needs mapping onto the work-item shape and a phase-position field. **No new instrumentation** |
| **Chat subagents** | `SubagentStarted` / `Progress` / `Finished` exist and are posted **only to the chat webview** (`agent/chat-task.ts:537-641`). Route them to the bus so they appear in the Office as `lane: chat` |
| **Daemon** | `daemonInboxItems` already projects results into inbox items (`core/daemon-protocol.ts:137`). The Office needs to *read* that projection — which is the P11-3 gate clause ("a daemon run's results appear in the inbox") satisfied by an actual surface rather than by a data structure |
| **Governor** | Push `snapshot()`. It is computed and thrown away today |
| **Git mutex** | Add an observable pending count and in-flight-since. One counter, and it makes the "why is everything slow" question answerable |

### 5.4 Dead code this replaces

`ParallelSubagentsPanel` (`webview/src/ParallelSubagents.tsx`, 110 lines) reads
`state.subagents`, which the reducer populates from `SubagentStarted` events — a lane that reaches
the chat webview but not the Manager. It is mounted in `App.tsx:3450` and renders `null` in the
Manager surface always. Fold it into the Office's `chat` lane and delete it; a second, divergent
subagent card is how the two surfaces disagree.

---

## 6. Component architecture

| Component | Responsibility | Notes |
|---|---|---|
| `office-model.ts` (**core, pure**) | the work-item projection: four lane summaries → one ordered roster. Sorting, grouping, density selection | vscode-free, unit-tested like `agent-inbox.ts`. **This is where the design lives** |
| `office-telemetry.ts` (**core**) | coalescing, patch construction, the §5.1 budget | pure enough to test the coalescer without a webview |
| `OfficeView.tsx` | the shell: rooms, tabs, message listener | one listener for the whole surface, as `ManagerPanel.tsx:144` already does |
| `WorkItemRow.tsx` | **one** component, three densities driven by container width | `line` (sidebar) · `card` (narrow panel) · `full` (wide panel). Not a user preference — a width response |
| `FrontDesk.tsx` | inbox rendering + the per-reason action sets | consumes `buildInbox` output unchanged |
| `TraceFeed.tsx` | ring-buffered trace, filter by lane and level | |
| `AgentDesk.tsx` | the drill-in, including the real steering textarea | |
| `PhaseStrip.tsx` | sequential phase position for pipeline items | R3 — carries the "in sequence" label as part of the component, so it cannot be dropped by a later edit |
| *(reused unchanged)* | `ArtifactReview.tsx`, `MemoryPanel.tsx`, `PipelineLogPanel` | |

**Bundle note.** All three webview surfaces load one bundle (`core/webview-html.ts:5-7`). The Office
must be lazily mounted behind the `window.isManagerPanel` flag, or the chat sidebar pays for a
dashboard it never renders. Worth a measurement before and after.

---

## 7. Milestones

Numbering continues from M71, the highest currently allocated. Waves reflect dependency, not
priority.

| # | M | Wave | Task | Pri | Acceptance |
|:--:|:--:|:--:|---|:--:|---|
| O-1 | **M72** | 1 | **Header truth** — push `GovernorSnapshot` and `inboxCounts` to the panel; render slots, spend, tokens, attention | P1 | Every header number traces to a field that existed before this milestone. No new instrumentation |
| O-2 | **M73** | 1 | **Entry points** — status bar item, sidebar view registration, command alias, `global/activity` entry, toast → sidebar | P1 | The attention count is visible without opening any panel. Toast no longer opens an editor tab |
| O-3 | **M74** | 1 | **The work-item model** — `office-model.ts`, four lanes onto one ordered roster | P1 | Pure and unit-tested: a fixture of all four lanes produces one ordered roster; a lane with no worktree yields no worktree affordance |
| O-4 | **M75** | 2 | **Front Desk** — the sidebar view, built on M74 | P1 | Inbox ordering byte-identical to `buildInbox`. Every action row is derived from a `can*` predicate |
| O-5 | **M76** | 2 | **Telemetry contract** — task agents onto the `EventBus`; patch channel; action target; turn/context; throttled live diff; mutex depth | P1 | Message rate under four running agents stays inside the §5.1 budget, **measured**. Git mutex acquisitions attributable to telemetry ≤ 1 per agent per 10 s |
| O-6 | **M77** | 3 | **The Floor** — dense roster, trace feed, Records/Memory as tabs | P2 | Renders correctly at 320 px and at 1600 px. Every `—` cell is a field genuinely absent, asserted by a test over the fixture |
| O-7 | **M78** | 3 | **The Desk** — drill-in, real steering textarea with history and artifact reference | P2 | A correction sent from the Desk arrives via `core/steering.ts` and the surface reports which of *delivered* / *saved only* happened — the distinction `manager-panel.ts:250-264` already makes |
| O-8 | **M79** | 3 | **Honesty gates** — theme-token lint, `PhaseStrip` sequential label, delete `ParallelSubagents.tsx` and its reducer branch | P2 | A test fails on any hard-coded hex outside the three status literals. No surface renders a parallel wave scheduler |

**Wave 1 is shippable on its own** and is where most of the value is: it puts a real, sourced
attention count in front of the user without touching a single agent-execution path.

---

## 8. Verification plan

| Layer | Check |
|---|---|
| Purity | `office-model.ts` and `office-telemetry.ts` tested with no `vscode` import, as `agent-inbox.ts` and `task-agents.ts` already are |
| No invented data | A fixture roster with fields deliberately absent renders `—` in every corresponding cell. R1 as a test, not a convention |
| No orphan affordances | For every `(lane, status)` pair, the rendered action set equals the set of `can*` predicates that return true. R2 as a test |
| Theme | Snapshot the Office under light, dark and high-contrast token sets; assert no literal hex outside the three status colours |
| Density | Render the roster at 320 / 600 / 1600 px; assert no horizontal overflow and no clipped action row |
| Message budget | Drive four simulated agents at realistic tool cadence; assert posts/second and bytes/second stay inside §5.1 |
| Git pressure | Assert telemetry-attributable `GitMutex` acquisitions ≤ 1 per agent per 10 s |
| Existing gates | `tsc -b` clean · vitest suites green · `npm run lint:css` (the `css-quality` suite shells out to it) · `extension.ts` stays ≤ 700 lines — M73 adds wiring and that gate has already fired twice |
| Runtime | Launch four task agents, one pipeline run and one daemon result; confirm all six appear in one roster with correct lane affordances, and that applying one changes the live tree while the other five do not |

---

## 9. Deliberate non-features

Written down so a later revision does not quietly add them back.

- **No parallel wave scheduler graphic.** M35 was deleted on the merits. If a parallel executor is
  built, this is a two-hour change *at that point*.
- **No token-rate sparkline.** §2.4. Replaced by turn-against-cap, context-against-limit, and stall
  time, all of which a user can act on.
- **No derived `$/min` burn rate.** Spend against the governor's configured budget is the number
  that changes a decision.
- **No auto-apply, ever — including for a race winner.** `canApply` is the only path into the live
  tree and it is user-initiated (`task-agents.ts:104-116`); the race explicitly declines to apply
  its own winner. A dashboard must not become the exception.
- **No synthetic node identifiers.** Agent ids and branch names are real handles; a second
  identifier space with no referent makes the trace and the roster harder to reconcile, not easier.
- **No third notification channel.** The inbox already fires once per `(item, reason)` and prunes
  (`agent-inbox.ts:150-168`). The Office is a surface for that state, not a second notifier.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| **Telemetry slows the thing it watches** — the git mutex is process-global and already a documented throughput ceiling | §5.1 budget, enforced by the M76 acceptance test rather than by care |
| **`WebviewView.badge` may not exist in the fork's API version** | Verify in M73 before building. The status bar item carries the count regardless, which is why it ships in the same milestone |
| **Chat gains a title bar** when a second view joins the container | Stated in §3.1 as a trade-off rather than discovered in review. The alternative — a second activity-bar container — costs a permanent icon slot |
| **Bundle growth reaches the chat sidebar**, since all three surfaces share one bundle | Lazy-mount behind `window.isManagerPanel`; measure before and after |
| **Four lanes drift apart again** | The lane is a *field on one row type*, and `office-model.ts` is the only place that knows about lanes. A fifth lane is a case in one pure function |
| **The plan is done and the panel is still hard to find** | M73 ships before any of the dense work. If only wave 1 lands, the user still gets a visible, sourced attention count — which is the actual F16 residue |

---

## 11. Where this leaves the docs

Per [`README.md`](./README.md)'s one-inventory rule, when this work lands:

- `features.md` — row **#9** (agent inbox) gains its surface; a new row for the Office; row **#12**
  (background agents) moves off 📋 once the daemon's results are visible in it.
- `pending-tasks.md` — M72–M79 enter as a phase block with the §7 acceptance criteria.
- This file stays the **design record** — the *why* behind the shape — and does not restate status.
