export class ValidationError extends Error {
    name = 'ValidationError';
    constructor(public readonly field: string, message: string) {
        super(`${field}: ${message}`);
    }
}

export function requireString(body: Record<string, unknown>, field: string, opts: { max?: number } = {}): string {
    const value = body[field];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ValidationError(field, 'must be a non-empty string');
    }
    if (opts.max && value.length > opts.max) {
        throw new ValidationError(field, `must be at most ${opts.max} characters`);
    }
    return value;
}

export function requireInt(body: Record<string, unknown>, field: string, opts: { min?: number; max?: number } = {}): number {
    const value = Number(body[field]);
    if (!Number.isInteger(value)) throw new ValidationError(field, 'must be an integer');
    if (opts.min !== undefined && value < opts.min) throw new ValidationError(field, `must be at least ${opts.min}`);
    if (opts.max !== undefined && value > opts.max) throw new ValidationError(field, `must be at most ${opts.max}`);
    return value;
}

/** ISO 4217 shape only — the currency table is the authority on which exist. */
export function requireCurrencyCode(body: Record<string, unknown>, field: string): string {
    const value = String(body[field] ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(value)) throw new ValidationError(field, 'must be a three-letter currency code');
    return value;
}

export function requireEmail(body: Record<string, unknown>, field: string): string {
    const value = String(body[field] ?? '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new ValidationError(field, 'must be an email address');
    return value.toLowerCase();
}
