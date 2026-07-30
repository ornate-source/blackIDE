import { describe, expect, it } from 'vitest';
import { verifyToken, TokenExpiredError, TokenInvalidError } from '../src/middleware/auth';

function token(claims: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `header.${body}.signature`;
}

describe('verifyToken', () => {
    it('accepts a token inside its expiry', () => {
        const claims = verifyToken(token({ sub: 'u_1', exp: Math.floor(Date.now() / 1000) + 60, iat: 0, scope: [] }));
        expect(claims.sub).toBe('u_1');
    });

    it('tolerates a client clock that runs slightly fast', () => {
        const justExpired = Math.floor(Date.now() / 1000) - 5;
        expect(() => verifyToken(token({ sub: 'u_1', exp: justExpired, iat: 0, scope: [] }))).not.toThrow();
    });

    it('rejects a token past the skew allowance', () => {
        const longExpired = Math.floor(Date.now() / 1000) - 3600;
        expect(() => verifyToken(token({ sub: 'u_1', exp: longExpired, iat: 0, scope: [] })))
            .toThrow(TokenExpiredError);
    });

    it('rejects a malformed token without parsing claims', () => {
        expect(() => verifyToken('not-a-jwt')).toThrow(TokenInvalidError);
    });
});
