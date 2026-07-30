import { randomBytes, createHash } from 'crypto';
import { Session } from '../models/session';
import { config } from '../config';

const sessions = new Map<string, Session>();

/**
 * Opaque session tokens for the web dashboard, alongside (not instead of) the
 * bearer JWTs the API accepts.
 *
 * Only a hash of the token is stored, so a leaked session table cannot be replayed.
 * Expiry here is absolute *and* idle: a tab left open for a week must not stay
 * authenticated because the user twitched the mouse.
 */
export function issueSession(userId: string): { token: string; session: Session } {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const session: Session = {
        id: hash(token),
        userId,
        issuedAt: now,
        absoluteExpiryAt: now + config.auth.sessionMaxLifetimeMs,
        idleExpiryAt: now + config.auth.sessionIdleTimeoutMs,
    };
    sessions.set(session.id, session);
    return { token, session };
}

export function resolveSession(token: string): Session | undefined {
    const session = sessions.get(hash(token));
    if (!session) return undefined;

    const now = Date.now();
    if (now > session.absoluteExpiryAt || now > session.idleExpiryAt) {
        sessions.delete(session.id);
        return undefined;
    }

    session.idleExpiryAt = now + config.auth.sessionIdleTimeoutMs;
    return session;
}

export function revokeSession(token: string): void {
    sessions.delete(hash(token));
}

/** Revokes every session for a user — password change, support action, breach. */
export function revokeAllForUser(userId: string): number {
    let revoked = 0;
    for (const [id, session] of sessions) {
        if (session.userId === userId) { sessions.delete(id); revoked++; }
    }
    return revoked;
}

function hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
