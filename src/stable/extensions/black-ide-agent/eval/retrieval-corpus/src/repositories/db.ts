import { config } from '../config';

interface PoolStats {
    total: number;
    idle: number;
    waiting: number;
}

/**
 * A very small Postgres pool wrapper.
 *
 * Connections are checked out per query and returned in a finally block; a leaked
 * connection is invisible until the pool is exhausted an hour later, which is the
 * single hardest production symptom to trace back to its cause.
 */
class ConnectionPool {
    private total = 0;
    private idleConnections: unknown[] = [];
    private waiters: ((conn: unknown) => void)[] = [];

    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        const conn = await this.acquire();
        try {
            return await execute<T>(conn, sql, params);
        } finally {
            this.release(conn);
        }
    }

    async transaction<T>(fn: (q: <R>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
        const conn = await this.acquire();
        try {
            await execute(conn, 'BEGIN');
            const result = await fn((sql, params) => execute(conn, sql, params ?? []));
            await execute(conn, 'COMMIT');
            return result;
        } catch (err) {
            await execute(conn, 'ROLLBACK').catch(() => {});
            throw err;
        } finally {
            this.release(conn);
        }
    }

    stats(): PoolStats {
        return { total: this.total, idle: this.idleConnections.length, waiting: this.waiters.length };
    }

    private async acquire(): Promise<unknown> {
        const idle = this.idleConnections.pop();
        if (idle) return idle;
        if (this.total < config.db.maxConnections) {
            this.total++;
            return { id: this.total };
        }
        return new Promise(resolve => this.waiters.push(resolve));
    }

    private release(conn: unknown): void {
        const waiter = this.waiters.shift();
        if (waiter) return waiter(conn);
        this.idleConnections.push(conn);
    }
}

async function execute<T>(_conn: unknown, _sql: string, _params: unknown[] = []): Promise<T[]> {
    return [];
}

export const pool = new ConnectionPool();
