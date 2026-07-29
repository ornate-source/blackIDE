export interface Page<T> {
    items: T[];
    nextCursor?: string;
    hasMore: boolean;
}

export interface CursorOptions {
    limit: number;
    cursor?: string;
    maxLimit?: number;
}

/**
 * Keyset (cursor) pagination helpers.
 *
 * OFFSET pagination is not offered here on purpose: it gets linearly slower as
 * the offset grows, and it silently skips or repeats rows when the underlying
 * list changes between pages — which for an orders list it always does.
 */
export function decodeCursor(cursor?: string): number | undefined {
    if (!cursor) return undefined;
    const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isFinite(decoded) ? decoded : undefined;
}

export function encodeCursor(value: number): string {
    return Buffer.from(String(value)).toString('base64url');
}

export function clampLimit(requested: unknown, fallback = 20, max = 100): number {
    const n = Number(requested);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
}

/** Fetches limit+1 rows so `hasMore` is known without a second COUNT query. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => number): Page<T> {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
        items,
        hasMore,
        nextCursor: hasMore ? encodeCursor(cursorOf(items[items.length - 1])) : undefined,
    };
}
