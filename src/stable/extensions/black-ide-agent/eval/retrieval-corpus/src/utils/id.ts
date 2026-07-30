import { randomBytes } from 'crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

/**
 * Sortable, prefixed identifiers (`ord_01HQ...`).
 *
 * Time-prefixed so ids sort by creation, which keeps the primary-key index from
 * fragmenting the way random UUIDs do. The prefix is not decoration: an id in a
 * log or a support ticket says what kind of thing it is without a lookup.
 */
export function newId(prefix: string): string {
    return `${prefix}_${encodeTime(Date.now())}${randomChars(10)}`;
}

export function prefixOf(id: string): string | undefined {
    const idx = id.indexOf('_');
    return idx === -1 ? undefined : id.slice(0, idx);
}

export function isId(value: string, prefix?: string): boolean {
    if (!/^[a-z]+_[0-9A-HJKMNP-TV-Z]{20,}$/.test(value)) return false;
    return prefix === undefined || prefixOf(value) === prefix;
}

function encodeTime(ms: number): string {
    let out = '';
    let remaining = ms;
    for (let i = 0; i < 10; i++) {
        out = ALPHABET[remaining % 32] + out;
        remaining = Math.floor(remaining / 32);
    }
    return out;
}

function randomChars(n: number): string {
    const bytes = randomBytes(n);
    return Array.from(bytes, b => ALPHABET[b % 32]).join('');
}
