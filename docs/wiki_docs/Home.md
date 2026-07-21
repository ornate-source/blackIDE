# Welcome to the Black IDE Wiki

Welcome to the documentation wiki for **Black IDE**—a custom, telemetry-free distribution of VS Code built on VSCodium, featuring a built-in AI coding assistant and agentic loop engine natively integrated in the activity bar.

---

## 💡 About Black IDE

Black IDE provides a clean, privacy-respecting development environment with a powerful, persistent AI agent that works in a continuous loop to solve your tasks.

### Core Features

1. **Telemetry-Free by Default**: Built-in telemetry, tracking, and reporting endpoints are completely patched out of the codebase.
2. **Integrated AI Agent (`Black IDE Chat`)**: An autonomous agent that reads, writes, audits, and executes commands inside a sandboxed loop.
3. **Multi-Agent Pipeline**: From-scratch builds route through 7 specialized agents with a plan-approval gate, executing inside an isolated git worktree.
4. **Surgical Undo System**: The checkpoint manager calculates atomic git-style diffs for all AI edits, letting you revert changes easily.
5. **Isolated Parallel Subagents**: Spawn multiple subagents safely using automated Git worktrees to prevent index locks or conflicts.
6. **Inline Editor Chat (`Cmd+I`)**: Fast, editor-native inline refactoring with line offset tracking and visual change highlights.
7. **Command Safety Policy**: Every shell command is gated by an allow/deny policy with an unconditional hard-deny list for destructive operations.
8. **Durable Project Memory**: Architecture notes, ADRs, and feature status accrue as human-readable Markdown under `.blackIDE/knowledge/`.

---

## 📖 Table of Contents

* **Getting Started**
  * [[Getting Started|Getting-Started]] - Download, installation, and first steps.
  * [[Usage Guide|Usage]] - Portability settings, hotkeys, and opening Black IDE from the terminal.
* **Core Privacy & Features**
  * [[AI Agent|AI-Agent]] - Providers, commands, slash commands, modes, safety policy, and project configuration.
  * [[Telemetry-Free Design|Telemetry]] - How Black IDE strips telemetry and safeguards your privacy.
  * [[Extensions & Marketplace|Extensions]] - Using the Open VSX Registry and installing third-party extensions.
  * [[Extensions Compatibility|Extensions-Compatibility]] - Compatible alternatives for proprietary Microsoft extensions.
  * [[GitHub Copilot|Ext-GitHub-Copilot]] - Setting up Copilot on a non-Microsoft build.
  * [[Accounts Authentication|Accounts-Authentication]] - Signing in to accounts and authentication providers.
* **Developer Guides**
  * [[Building from Source|How-to-Build]] - Compiling and packaging Black IDE locally, and working on the agent extension.
  * [[Development Workflow|Development-Workflow]] - Branches, CI gates, test layers, publishing, and contributing.
  * [[Migration Guide|Migration-Guide]] - Transitioning your settings and extensions from VS Code or VSCodium.
  * [[Troubleshooting]] - Common issues, rendering fixes, and system configuration workarounds.
  * [[Patches]] - How the patch set is organized and the enterprise policy registry path.
  * [[Other Resources|Other-Resources]] - What the `reh` and `reh-web` archives are.
* **Architecture & Technical Documentation**
  * [[Architecture & KT Guide|Architecture-and-KT-Guide]] - Detailed guide covering the event bus, agent loop, checkpoints, worktrees, and more.
  * [[Bengali KT Guide (বাংলা)|Bengali-KT-Guide]] - Bengali translation of the comprehensive technical guide.
