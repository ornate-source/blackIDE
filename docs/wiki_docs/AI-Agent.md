# The Black IDE AI Agent

Black IDE ships with `black-ide-agent`, an autonomous coding agent built into the editor
rather than bolted on as a third-party extension. This page is the user-facing guide; for
how it works internally see the [[Architecture & KT Guide|Architecture-and-KT-Guide]].

---

## 🚀 Getting Started

1. Open the **Black IDE Chat** view from the Activity Bar.
2. Run **✦ Black IDE Settings** from the Command Palette and add an API key for your
   provider. Keys are stored in the OS keychain via VS Code's `SecretStorage` — never in
   `settings.json`.
3. Type a request.

### Supported Providers

| Provider | Notes |
|---|---|
| `anthropic` | Claude models |
| `openai` | OpenAI models |
| `google` | Gemini models |
| `openrouter` | Aggregator, many models behind one key |
| `ollama` | Local models; can be auto-detected |

Embeddings for codebase search are configured separately — OpenAI
(`text-embedding-3-small`) or Ollama (`nomic-embed-text`). Search still works without an
embeddings provider, falling back to keyword ranking.

---

## ⌨️ Commands

| Command | What it does |
|---|---|
| **✦ Black IDE Settings** | Provider keys, models, approval policy, pipeline settings |
| **Black IDE: Inline Edit** (`Cmd+I` / `Ctrl+I`) | Editor-native refactor of the selection or current line |
| **Generate Commit Message** | Writes a commit message from the staged diff |
| **✦ Black IDE: Pipeline Manager** | Launch and monitor multi-agent pipeline runs |
| **✦ Black IDE: Export Agent Diagnostics** | Dump diagnostics for a bug report |

---

## 💬 Slash Commands

| Command | Effect |
|---|---|
| `/plan` | Force planning mode |
| `/orchestrate` | Force the multi-agent pipeline |
| `/single` | Force the single-agent path, even for build-shaped requests |
| `/explain` | Explain the selection or referenced code |
| `/fix` | Fix the problem at hand |
| `/refactor` | Refactor the selection |
| `/test` | Generate or run tests |
| `/docs` (`/d`) | Write documentation |
| `/search` (`/s`) | Search the codebase |
| `/commit` (`/c`) | Generate a commit |
| `/compact` | Compact the conversation to reclaim context budget |

Short prompts (≤5 words with no planning keyword) and slash commands skip the planning gate
so quick questions stay fast.

---

## 🔁 How a Request Is Handled

Black IDE picks one of three paths:

1. **Direct** — greetings, short questions, and slash commands run immediately.
2. **Plan → Approve → Execute** — any substantive request first runs a read-only planning
   pass that produces an implementation plan and task list. You approve or reject before
   anything is written. The pending approval survives a window reload or crash.
3. **Multi-agent pipeline** — from-scratch, multi-domain builds ("Build a CRM with contact
   management and deal tracking") are routed through 7 sequential agents: Architect → Sr
   Engineer → Planner → *your approval* → Design → Backend → Frontend → Testing.

Pipeline execution runs inside an **isolated git worktree**, so a failed or cancelled run
never leaves partial changes in your workspace. Its undo path is git — not the chat
checkpoint system.

---

## ↩️ Undo and Review

Every file the agent touches in chat is checkpointed as a reverse diff, linked to the
message that caused it.

* Restore a single file, or roll back an entire message's changes.
* Each edit is tracked as `pending`, `kept`, or `restored`.
* Checkpoints persist to disk, so undo history survives reloads and crashes.

---

## 🛡️ Command Safety

The agent runs a real shell. Every `run_command` is checked against a policy that resolves
to allow, deny, or ask:

* A **hard deny list** blocks catastrophic commands (`rm -rf /`, `mkfs`, `dd if=`, fork
  bombs, `shutdown`/`reboot`, raw disk writes) — no setting overrides it.
* Your own **allow / deny** regex lists take effect next.
* **Auto-approve** settings (`autoApproveTerminal`, `autoApproveFileEdits`,
  `autoApproveFileCreate`) apply to interactive chat only. Pipeline runs are unattended and
  deliberately ignore auto-approve — anything that would have prompted is refused and
  logged.

---

## 📁 Project Configuration

Black IDE reads per-project configuration from `.blackide/` and writes its working
artifacts to `.blackIDE/`.

**Configuration you author** (`.blackide/`, or `~/.blackide/` for global):

| Path | Purpose |
|---|---|
| `.blackide/AGENTS.md` | Standing project rules injected into the system prompt |
| `.blackide/modes/*.md` | Custom agent modes (YAML frontmatter + prompt body) |
| `.blackide/skills/` | Skill packs with trigger patterns |
| `.blackide/mcp.json` | MCP server definitions (`.vscode/mcp.json` also works) |

Custom modes also load from `.agents/modes/` in nested project directories, and are
hot-reloaded when edited — configuration errors surface as inline diagnostics.

**Artifacts the agent writes** (`.blackIDE/`):

| Path | Purpose |
|---|---|
| `features_plan.md` | Pipeline plan you approve before execution |
| `overview.md` | Post-run summary: phase timing, file changes |
| `mindmap/project_mindmap.md` | Shared architecture snapshot across phases |
| `knowledge/` | Durable project memory: architecture, ADRs, feature status, tech debt, glossary, roadmap |

The `knowledge/` files are plain Markdown meant to be read and edited by humans too — they
are how project understanding carries across sessions instead of being re-derived each run.

Consider adding `.blackIDE/` to `.gitignore` if you don't want generated plans and run
summaries in version control, or commit `knowledge/` deliberately if you want the project
memory shared across the team.

---

## 🎭 Agent Modes

Eight modes are selectable in chat — **Ask**, **Plan**, **Agent**, **Frontend**,
**Backend**, **DevOps**, **Manager**, and **Sr Architect** — each with its own prompt, tool
allowlist, and iteration budget. Seven more are pipeline phase roles driven by the
orchestrator. See the [KT guide](Architecture-and-KT-Guide#42-specialized-multi-agent-roles-built-in-modes)
for the full table.

### Defining a Custom Mode

Drop a Markdown file in `.blackide/modes/`:

```markdown
---
name: Security Auditor
description: Audits code changes for security vulnerabilities
tools: [read_file, grep_search, complete_task]
maxIterations: 15
icon: shield
---
You are a Senior Security Auditor. Evaluate the code changes in the active selection for
common vulnerabilities like injection, memory leaks, and dependency issues. Write a report
and do not modify any files.
```

`name` is required and cannot shadow a built-in mode. `tools`, `model`, `maxIterations`
(1–500), `description`, and `icon` are optional; omitting `tools` grants all of them.

---

## 🔌 MCP Servers

Black IDE is an MCP client. Servers declared in `.blackide/mcp.json` or `.vscode/mcp.json`
are spawned over stdio at startup, their tools discovered via `tools/list`, and registered
alongside the built-in tools so the model can call them transparently.

MCP tools are refused inside unattended pipeline runs.
