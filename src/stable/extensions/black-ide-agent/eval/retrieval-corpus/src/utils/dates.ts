const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Date helpers that all take an explicit instant.
 *
 * Nothing here reads the clock implicitly: a function that calls `Date.now()`
 * internally cannot be tested for the boundary cases that actually break — month
 * ends, DST transitions, the second either side of midnight.
 */
export function startOfUtcDay(at: number): number {
    const d = new Date(at);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function addDays(at: number, days: number): number {
    return at + days * DAY_MS;
}

export function daysBetween(a: number, b: number): number {
    return Math.round((startOfUtcDay(b) - startOfUtcDay(a)) / DAY_MS);
}

/** Month-end safe: 31 Jan + 1 month is 28/29 Feb, not 3 March. */
export function addMonths(at: number, months: number): number {
    const d = new Date(at);
    const targetMonth = d.getUTCMonth() + months;
    const lastDayOfTarget = new Date(Date.UTC(d.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
    return Date.UTC(
        d.getUTCFullYear(),
        targetMonth,
        Math.min(d.getUTCDate(), lastDayOfTarget),
        d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
    );
}

export function isoDay(at: number): string {
    return new Date(startOfUtcDay(at)).toISOString().slice(0, 10);
}
