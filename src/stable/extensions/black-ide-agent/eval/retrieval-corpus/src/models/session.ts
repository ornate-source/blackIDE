export interface Session {
    /** SHA-256 of the opaque token. The token itself is never stored. */
    id: string;
    userId: string;
    issuedAt: number;
    absoluteExpiryAt: number;
    idleExpiryAt: number;
}

export function remainingMs(session: Session, now = Date.now()): number {
    return Math.max(0, Math.min(session.absoluteExpiryAt, session.idleExpiryAt) - now);
}

export function isExpired(session: Session, now = Date.now()): boolean {
    return remainingMs(session, now) === 0;
}
