// ─── Skill distribution (Phase 10, M60) ─────────────────────────────────────
//
// `plan.md` marked distribution out of scope; F11 records that competitors have since made
// it table stakes, and E9 reversed the call. So a pack can now come from somewhere other
// than this repository — which changes the threat model completely, and that is what most
// of this module is about.
//
// ── The rule, restated from E9's note ────────────────────────────────────────
// "Third-party skills are untrusted prompt text. They must never be able to widen a tool
// allowlist or auto-approve a command — enforce at load, test it."
//
// This is the load-time enforcement. It matters because a skill pack is *injected into the
// system prompt*, which is the most trusted position in the context window: a pack that
// could also declare `tools:` or `autoApprove:` would be handing an arbitrary git URL the
// ability to grant itself capabilities. Phase 9's M56 established that content cannot reach
// the capability gates; this keeps that true for content that arrives as *configuration*
// rather than as a tool result.
//
// The enforcement is a **deny list of frontmatter keys**, not an allowlist of values,
// because the failure to avoid is a future field: someone adds `permissions:` to the mode
// loader, forgets that packs share the parser, and a pack silently gains it. A key that is
// not understood is dropped either way; a key that looks like a capability grant is a
// *rejection*, so the pack's author finds out rather than the pack quietly half-working.

/** Frontmatter keys a third-party pack may never carry. */
export const FORBIDDEN_PACK_KEYS = [
    'tools', 'allowedtools', 'tool', 'permissions', 'capabilities',
    'autoapprove', 'auto_approve', 'approve', 'policy', 'commandallowlist',
    'commanddenylist', 'allow', 'deny', 'sandbox', 'unsafe', 'trusted',
    'maxiterations', 'model', 'systemprompt',
] as const;

export interface PackViolation {
    key: string;
    reason: string;
}

/**
 * Check a pack's frontmatter for capability grants.
 *
 * Case- and separator-insensitive, because `autoApprove`, `auto_approve` and `AUTO-APPROVE`
 * are the same intent and a check that caught one of the three would be worse than none —
 * it would look like the rule was enforced.
 */
export function findPackViolations(frontmatter: Record<string, unknown>): PackViolation[] {
    const violations: PackViolation[] = [];
    for (const rawKey of Object.keys(frontmatter || {})) {
        const key = rawKey.toLowerCase().replace(/[_\-\s]/g, '');
        if ((FORBIDDEN_PACK_KEYS as readonly string[]).includes(key)) {
            violations.push({
                key: rawKey,
                reason: `"${rawKey}" would change what the agent is allowed to do. Skill packs describe *how* to work, `
                    + 'not what is permitted — permissions come from the mode and from your settings, never from a pack.',
            });
        }
    }
    return violations;
}

export interface RegistryEntry {
    name: string;
    description: string;
    /** Git URL or a path relative to the registry file. */
    source: string;
    /** A tag or commit SHA. A moving ref is refused — see `validateEntry`. */
    ref: string;
    /** SHA-256 of the pack's SKILL.md, hex. */
    checksum: string;
    stacks?: string[];
    roles?: string[];
}

export interface Registry {
    version: number;
    packs: RegistryEntry[];
}

/** Branch names that move. Pinning to one means installing something different tomorrow. */
const MOVING_REFS = /^(?:main|master|latest|head|develop|dev|trunk)$/i;

export type EntryCheck = { ok: true } | { ok: false; error: string };

/**
 * Validate one registry entry before anything is fetched.
 *
 * The ref check is the one worth arguing for. Pinning to `main` is the natural thing to
 * write and it means "whatever that repository contains at the moment I install" — which
 * makes the checksum meaningless, since the content it pins is expected to change. A tag or
 * a SHA is a thing that can be verified twice and give the same answer.
 */
export function validateEntry(entry: Partial<RegistryEntry>): EntryCheck {
    if (!entry?.name?.trim()) return { ok: false, error: 'A registry entry needs a name.' };
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name)) {
        return { ok: false, error: `"${entry.name}" is not a usable pack name — use lowercase letters, digits and hyphens.` };
    }
    if (!entry.source?.trim()) return { ok: false, error: `"${entry.name}" has no source.` };
    if (!entry.ref?.trim()) {
        return { ok: false, error: `"${entry.name}" has no ref. Pin a tag or a commit SHA so the same install gives the same pack.` };
    }
    if (MOVING_REFS.test(entry.ref.trim())) {
        return {
            ok: false,
            error: `"${entry.name}" pins "${entry.ref}", which moves. Its checksum could not mean anything — `
                + 'use a tag or a commit SHA.',
        };
    }
    if (!entry.checksum || !/^[a-f0-9]{64}$/i.test(entry.checksum)) {
        return { ok: false, error: `"${entry.name}" has no valid SHA-256 checksum.` };
    }
    return { ok: true };
}

export function parseRegistry(text: string): { registry: Registry; problems: string[] } {
    const problems: string[] = [];
    let parsed: any;
    try {
        parsed = JSON.parse(String(text || '{}'));
    } catch (err: any) {
        return { registry: { version: 1, packs: [] }, problems: [`The registry is not valid JSON: ${err?.message || err}`] };
    }

    const packs: RegistryEntry[] = [];
    for (const entry of Array.isArray(parsed?.packs) ? parsed.packs : []) {
        const check = validateEntry(entry);
        if (check.ok) packs.push(entry as RegistryEntry);
        else problems.push(check.error);
    }
    return { registry: { version: Number(parsed?.version) || 1, packs }, problems };
}

export type InstallVerdict =
    | { ok: true; name: string }
    | { ok: false; error: string; kind: 'checksum' | 'forbidden' | 'invalid' };

/**
 * The final gate before a downloaded pack is written to disk.
 *
 * Checksum **first**: a pack whose content does not match what the registry promised is not
 * examined further, because everything after this point reasons about the content, and
 * reasoning about content you have already established is not the content you expected is
 * how a check becomes decorative.
 */
export function admitPack(
    entry: RegistryEntry,
    content: string,
    frontmatter: Record<string, unknown>,
    sha256: (text: string) => string,
): InstallVerdict {
    const actual = sha256(content).toLowerCase();
    if (actual !== entry.checksum.toLowerCase()) {
        return {
            ok: false,
            kind: 'checksum',
            error: `"${entry.name}" does not match its registry checksum. Expected ${entry.checksum.slice(0, 12)}…, `
                + `got ${actual.slice(0, 12)}…. Nothing was installed.`,
        };
    }

    const violations = findPackViolations(frontmatter);
    if (violations.length) {
        return {
            ok: false,
            kind: 'forbidden',
            error: `"${entry.name}" was rejected: ${violations.map(v => v.reason).join(' ')}`,
        };
    }

    return { ok: true, name: entry.name };
}

/**
 * Where an installed pack lands, and why that is the right place.
 *
 * `.blackide/skills/` in the workspace — the same directory `installSkillPacks` already
 * uses for bundled packs. That is what makes a remote pack **shadowable**: precedence is
 * bundled → global → workspace, so a same-named local pack wins, and a user who dislikes
 * one thing a remote pack says can copy it and edit rather than choosing between the whole
 * pack and none of it.
 */
export function installPathFor(name: string): string {
    const safe = String(name).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64) || 'pack';
    return `.blackide/skills/${safe}/SKILL.md`;
}
