import { User, maskEmail, isStaff } from '../models/user';
import { pool } from '../repositories/db';

export interface AuditEntry {
    actorId: string;
    action: string;
    subjectType: 'order' | 'user' | 'invoice' | 'subscription' | 'refund';
    subjectId: string;
    at: number;
    detail?: string;
}

/**
 * Append-only record of who did what to whom.
 *
 * The table is insert-only and the writer role has no UPDATE or DELETE grant — an
 * audit log an operator can edit is a log nobody can rely on. Email addresses are
 * masked on the way in; the raw address is already in `users` and does not need a
 * second copy in a table that is retained for seven years.
 */
export async function record(actor: User, action: string, subject: { type: AuditEntry['subjectType']; id: string }, detail?: string): Promise<void> {
    await pool.query(
        `INSERT INTO audit_log (actor_id, action, subject_type, subject_id, at, detail)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [actor.id, action, subject.type, subject.id, Date.now(), detail ?? null],
    );
}

export async function recordStaffAction(actor: User, action: string, target: User): Promise<void> {
    if (!isStaff(actor)) throw new Error('only staff actions are audited through this path');
    await record(actor, action, { type: 'user', id: target.id }, `target=${maskEmail(target.email)}`);
}

export async function forSubject(type: AuditEntry['subjectType'], id: string, limit = 100): Promise<AuditEntry[]> {
    return pool.query<AuditEntry>(
        `SELECT * FROM audit_log WHERE subject_type = $1 AND subject_id = $2
         ORDER BY at DESC LIMIT $3`,
        [type, id, limit],
    );
}

/** Renders one entry for the support console. Never includes a full address. */
export function renderEntry(entry: AuditEntry, actor: User): string {
    return `${new Date(entry.at).toISOString()} ${maskEmail(actor.email)} ${entry.action} ${entry.subjectType}:${entry.subjectId}`;
}
