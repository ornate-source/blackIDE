import { AgentMode, ToolDefinition } from './types';
import { toolsForMode } from './tools';

// ─── Session tool toggles (Phase 2, M10) ────────────────────────────────────
//
// The session panel shipped with rule toggles; the phase text asked for
// "toggle rules/**tools**". This is the tools half.
//
// ── Why this is enforced rather than advisory ────────────────────────────────
// The obvious implementation is to drop the tool from the advertised list and stop
// there. That is what "advisory" means, and Phase 2 already found out what it costs:
// per-mode allowlists were advertising-only, so a mode whose prompt said it must not
// write code would still have *executed* a `write_file` the model emitted anyway
// (the B4 finding). A user who switches `run_command` off is making a safety
// decision, not a UI preference, so a toggle rides the same executor gate the mode
// allowlist rides — see `deniedTools` in `agent/tool-executor.ts`.
//
// Both halves matter and they are not redundant. Unadvertising stops the model
// wasting a turn on a call that would be refused; the gate is what makes the switch
// true even when the model calls the tool from memory of an earlier turn, which
// models do.
//
// ── Session-scoped, never persisted ─────────────────────────────────────────
// Same reasoning as rule toggles: a toggle is a decision about *this* conversation.
// Persisting it would silently change how the agent behaves days later, which is the
// invisible state the rules files exist to avoid.

/**
 * Tools a session toggle may not switch off.
 *
 * `complete_task` is how the agent loop terminates. Disabling it does not make the
 * agent safer, it makes it unable to stop — it would iterate to the loop cap and
 * report as a failure, which reads to the user as a broken agent rather than as the
 * consequence of a switch they flipped. A toggle that can wedge the thing it
 * controls is a defect, not a capability.
 */
export const UNDISABLABLE_TOOLS: readonly string[] = ['complete_task'];

export function isDisablable(name: string): boolean {
    return !UNDISABLABLE_TOOLS.includes(name);
}

/** Case-insensitive membership, so a toggle from a stale webview still matches. */
function has(list: readonly string[], name: string): boolean {
    return list.some(n => n.toLowerCase() === name.toLowerCase());
}

/**
 * Applies one toggle, returning a new list. `enabled: true` removes the tool from
 * the disabled set; `enabled: false` adds it.
 *
 * Idempotent in both directions, and a request to disable an undisablable tool is
 * ignored rather than rejected — the caller is a UI message, and the panel does not
 * offer the control, so this only fires for a stale webview.
 */
export function applyToggle(disabled: readonly string[], name: string, enabled: boolean): string[] {
    if (!name) return [...disabled];
    const without = disabled.filter(n => n.toLowerCase() !== name.toLowerCase());
    if (enabled || !isDisablable(name)) return without;
    return [...without, name];
}

/** Removes every disabled tool from an advertised list. */
export function applyToolToggles(tools: ToolDefinition[], disabled: readonly string[]): ToolDefinition[] {
    if (!disabled.length) return tools;
    return tools.filter(t => !has(disabled, t.name) || !isDisablable(t.name));
}

/**
 * The executor gate's predicate.
 *
 * MCP tools are discovered at runtime as `mcp_<serverTool>` and never appear in the
 * advertised list the panel is built from, so they cannot be toggled individually.
 * Switching off `mcp_call` switches off all of them — the same relationship
 * `isAllowedByMode` already uses, so a user who turns MCP off does not find that one
 * dynamically-named server tool stayed reachable.
 */
export function isDeniedByUser(name: string, disabled: readonly string[]): boolean {
    if (!isDisablable(name)) return false;
    if (name.startsWith('mcp_')) return has(disabled, 'mcp_call') || has(disabled, name);
    return has(disabled, name);
}

/**
 * The tools a mode advertises: the coarse sandbox list, narrowed by the acting mode's
 * declared allowlist if it has one.
 *
 * Shared by the panel's pre-turn view and asserted against the per-turn list in
 * `__tests__/tool-toggles.test.ts`, because two independent constructions of "what
 * this mode offers" is exactly how a panel starts lying about the prompt — the same
 * failure `rules-panel-fidelity.test.ts` exists to prevent on the rules side.
 */
export function advertisedTools(mode: AgentMode, modeTools?: string[]): ToolDefinition[] {
    const tools = toolsForMode(mode);
    return modeTools?.length ? tools.filter(t => modeTools.includes(t.name)) : tools;
}

export interface ToolPanelEntry {
    name: string;
    description: string;
    risk: ToolDefinition['risk'];
    /** False when the user has switched it off for this session. */
    enabled: boolean;
    /** False for `complete_task`: shown, but with no control. */
    disablable: boolean;
}

/**
 * What the session panel renders.
 *
 * Built from the tools *actually advertised this turn*, not from `BASE_TOOLS`. The
 * panel must not offer a switch for a tool the acting mode never had: flipping it
 * would appear to do nothing (it was already unavailable), and flipping it back on
 * would appear to grant a capability the mode forbids. Both readings are wrong, and
 * a control whose effect the user cannot predict is worse than no control.
 */
export function toolPanelEntries(advertised: ToolDefinition[], disabled: readonly string[]): ToolPanelEntry[] {
    return advertised.map(t => ({
        name: t.name,
        description: t.description,
        risk: t.risk,
        enabled: !has(disabled, t.name),
        disablable: isDisablable(t.name),
    }));
}
