import { TaskReference, TrackerKind } from './task-sources';

// ─── Per-tracker fetchers (Phase 12, M67 · P12-1) ──────────────────────────
//
// `task-sources.ts` finds issue references in a prompt and refuses to guess. This is the
// other half: given a reference it *did* recognise, go and read the issue.
//
// ── What "still refuses to guess a tracker from a bare key" protects ───────
// The acceptance clause carries that forward from M67's first half, and it constrains
// this file rather than merely describing it. A fetcher is selected by the `kind` on a
// `TaskReference`, and a reference only has a `kind` because a URL or an explicit `#n`
// said so. There is deliberately **no** "try each tracker until one answers" path: that
// is what turns a bare `ENG-45` into three requests to three vendors, each carrying the
// user's token, two of which are to companies they do not use.
//
// ── Reading is not posting, and the asymmetry is the design ────────────────
// These are GETs, triggered by the user typing a reference into a prompt. That is the
// read side of E8's rule and needs no per-action confirmation — the user asked for this
// issue, now, by naming it. Writing back is `task-sources.ts`'s `decideOutbound`, which
// cannot be granted in advance. Keeping the two in different files is deliberate: it
// makes "which of these needs a confirmation" answerable by looking at the import.

export interface FetchedTask {
    kind: TrackerKind;
    id: string;
    title: string;
    body: string;
    state?: string;
    url?: string;
    author?: string;
    labels?: string[];
}

export interface FetchFailure {
    kind: TrackerKind;
    id: string;
    /** Why, phrased for the user and for the model that has to continue without it. */
    reason: string;
}

export type FetchOutcome = { ok: true; task: FetchedTask } | { ok: false; failure: FetchFailure };

/** What a fetcher needs to reach its tracker. */
export interface TrackerCredentials {
    /** GitHub: a PAT or the `gh` token. Linear: an API key. Jira: an API token. */
    token?: string;
    /** Jira and Linear self-hosted: the instance base URL. */
    host?: string;
    /** Jira: the account email, which its basic auth pairs with the token. */
    email?: string;
    /** GitHub: `owner/repo`, when the reference was a bare `#123` with no repo in it. */
    repo?: string;
}

export interface FetchRequest {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
}

/**
 * Build the HTTP request for a reference, or explain why one cannot be built.
 *
 * Pure, and separated from the fetch for the reason every I/O boundary in this codebase
 * is: the part that has to be right is *which URL, with which credential, for which
 * tracker*, and that is exactly the part a test can pin without a network or a token.
 *
 * Every branch that returns a failure is a case where guessing would have produced a
 * request. A bare `#123` with no configured repository is the important one: GitHub's API
 * needs an `owner/repo`, and inferring it from the git remote would silently send a
 * request about somebody else's issue tracker when the user has two remotes.
 */
export function buildFetchRequest(
    reference: TaskReference,
    credentials: TrackerCredentials = {},
): { ok: true; request: FetchRequest } | { ok: false; failure: FetchFailure } {
    const fail = (reason: string) => ({ ok: false as const, failure: { kind: reference.kind, id: reference.id, reason } });

    switch (reference.kind) {
        case 'github': {
            if (!credentials.repo) {
                return fail(`${reference.raw} needs a repository. Set the GitHub repo in settings as "owner/name", `
                    + 'or paste the full issue URL — the remote is not guessed at, because a repository with two '
                    + 'remotes would send the request to whichever one happened to be first.');
            }
            if (!/^[\w.-]+\/[\w.-]+$/.test(credentials.repo)) {
                return fail(`"${credentials.repo}" is not an "owner/name" repository.`);
            }
            if (!credentials.token) return fail('No GitHub token is configured.');
            return {
                ok: true,
                request: {
                    method: 'GET',
                    url: `https://api.github.com/repos/${credentials.repo}/issues/${encodeURIComponent(reference.id)}`,
                    headers: {
                        authorization: `Bearer ${credentials.token}`,
                        accept: 'application/vnd.github+json',
                        'x-github-api-version': '2022-11-28',
                    },
                },
            };
        }

        case 'linear': {
            if (!credentials.token) return fail('No Linear API key is configured.');
            return {
                ok: true,
                request: {
                    method: 'GET',
                    // Linear is GraphQL-only, so the query travels in the URL for a read.
                    // Encoded, not interpolated: an issue id is user-supplied text.
                    url: `https://api.linear.app/graphql?query=${encodeURIComponent(linearQuery(reference.id))}`,
                    headers: { authorization: credentials.token, 'content-type': 'application/json' },
                },
            };
        }

        case 'jira': {
            if (!credentials.host) {
                return fail(`${reference.raw} needs your Jira host. Set it in settings, or paste the full issue URL.`);
            }
            if (!credentials.token || !credentials.email) {
                return fail('Jira needs both an account email and an API token.');
            }
            let base: URL;
            try { base = new URL(credentials.host); } catch { return fail(`"${credentials.host}" is not a valid URL.`); }
            if (base.protocol !== 'https:') {
                return fail('The Jira host must be https — an API token sent in plaintext is a leaked token.');
            }
            return {
                ok: true,
                request: {
                    method: 'GET',
                    url: `${base.origin}/rest/api/3/issue/${encodeURIComponent(reference.id)}`,
                    headers: {
                        // Jira Cloud's documented scheme: basic auth, email as the user.
                        authorization: `Basic ${base64(`${credentials.email}:${credentials.token}`)}`,
                        accept: 'application/json',
                    },
                },
            };
        }

        default:
            return fail(`No fetcher for tracker "${reference.kind}".`);
    }
}

function linearQuery(id: string): string {
    return `query { issue(id: ${JSON.stringify(id)}) { identifier title description state { name } url `
        + 'creator { name } labels { nodes { name } } } }';
}

function base64(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * Turn a tracker's response into a `FetchedTask`.
 *
 * Each tracker's shape is different enough that a shared parser would be a pile of
 * optional chaining, and the failure mode of that pile is silent: a renamed field
 * produces an issue with an empty body, which reads to the agent as an issue that says
 * nothing rather than as a parse failure. Each branch below asserts the one field that
 * must exist.
 */
export function parseFetchedTask(kind: TrackerKind, id: string, body: unknown): FetchOutcome {
    const fail = (reason: string): FetchOutcome => ({ ok: false, failure: { kind, id, reason } });
    if (!body || typeof body !== 'object') return fail('the tracker returned something that was not an object');
    const json = body as Record<string, any>;

    if (kind === 'github') {
        if (typeof json.title !== 'string') return fail(json.message || 'the issue has no title — it may not exist');
        return {
            ok: true,
            task: {
                kind, id,
                title: json.title,
                body: String(json.body ?? ''),
                state: json.state,
                url: json.html_url,
                author: json.user?.login,
                labels: Array.isArray(json.labels) ? json.labels.map((l: any) => l?.name).filter(Boolean) : undefined,
            },
        };
    }

    if (kind === 'linear') {
        const issue = json.data?.issue;
        if (!issue?.title) {
            // GraphQL answers 200 with an `errors` array, so a status check alone would
            // treat a failed query as a successful empty issue.
            const message = Array.isArray(json.errors) ? json.errors.map((e: any) => e?.message).join('; ') : '';
            return fail(message || 'the issue was not found');
        }
        return {
            ok: true,
            task: {
                kind, id,
                title: issue.title,
                body: String(issue.description ?? ''),
                state: issue.state?.name,
                url: issue.url,
                author: issue.creator?.name,
                labels: issue.labels?.nodes?.map((l: any) => l?.name).filter(Boolean),
            },
        };
    }

    if (kind === 'jira') {
        const fields = json.fields;
        if (!fields?.summary) {
            return fail(Array.isArray(json.errorMessages) ? json.errorMessages.join('; ') : 'the issue was not found');
        }
        return {
            ok: true,
            task: {
                kind, id,
                title: String(fields.summary),
                // Jira Cloud returns Atlassian Document Format, not text.
                body: flattenAdf(fields.description),
                state: fields.status?.name,
                url: json.self,
                author: fields.reporter?.displayName,
                labels: Array.isArray(fields.labels) ? fields.labels.map(String) : undefined,
            },
        };
    }

    return fail(`No parser for tracker "${kind}".`);
}

/**
 * Flatten Atlassian Document Format into text.
 *
 * Jira Cloud returns a nested document rather than a string, and `String(description)`
 * on it produces `[object Object]` — which is what an agent would then be asked to
 * implement. Deliberately lossy: paragraphs become newlines and everything else becomes
 * its text, because a description's *content* is what the agent needs and its formatting
 * is not.
 */
export function flattenAdf(node: unknown): string {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(flattenAdf).join('');

    const record = node as Record<string, any>;
    if (typeof record.text === 'string') return record.text;

    const inner = flattenAdf(record.content);
    // Block-level nodes get a break after them; inline ones do not, or every word in a
    // sentence ends up on its own line.
    return ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(record.type)
        ? `${inner}\n`
        : inner;
}

/** Render a fetched task for injection into a prompt. */
export function renderFetchedTask(task: FetchedTask): string {
    return [
        `--- ${task.kind} ${task.id}: ${task.title} ---`,
        task.state ? `State: ${task.state}` : '',
        task.author ? `Reported by: ${task.author}` : '',
        task.labels?.length ? `Labels: ${task.labels.join(', ')}` : '',
        task.url ? `URL: ${task.url}` : '',
        '',
        task.body.trim() || '(no description)',
        '--- end ---',
    ].filter(line => line !== '').join('\n');
}

/**
 * What the agent is told when a fetch fails.
 *
 * Named as a refusal with a cause, not an empty context block. An agent handed nothing
 * concludes the issue is empty and implements its own idea of what `#123` meant, which is
 * a worse outcome than being told it could not read it.
 */
export function renderFetchFailure(failure: FetchFailure): string {
    return `--- ${failure.kind} ${failure.id} could not be read ---\n${failure.reason}\n`
        + 'Do not guess at what this issue says. Ask, or work from what the user told you directly.\n--- end ---';
}
