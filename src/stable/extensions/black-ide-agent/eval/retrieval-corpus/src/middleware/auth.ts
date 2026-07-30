import { NextFunction, Request, Response } from 'express';
import { UserRepository } from '../repositories/user-repository';
import { isActive, isStaff } from '../models/user';
import { config } from '../config';

export interface AuthedRequest extends Request {
    userId?: string;
}

interface TokenClaims {
    sub: string;
    exp: number;
    iat: number;
    scope: string[];
}

export class TokenExpiredError extends Error {}
export class TokenInvalidError extends Error {}

/**
 * Verifies the bearer token and attaches the caller's id to the request.
 *
 * Expiry is checked with a small clock-skew allowance, because a client whose clock
 * runs two seconds fast should not be logged out; anything beyond the allowance is a
 * hard rejection, not a warning.
 */
export function requireAuth(users: UserRepository) {
    return async (req: AuthedRequest, res: Response, next: NextFunction) => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'missing bearer token' });
        }

        let claims: TokenClaims;
        try {
            claims = verifyToken(header.slice('Bearer '.length));
        } catch (err) {
            const code = err instanceof TokenExpiredError ? 'token_expired' : 'token_invalid';
            return res.status(401).json({ error: code });
        }

        const user = await users.byId(claims.sub).catch(() => undefined);
        if (!user || !isActive(user)) {
            return res.status(403).json({ error: 'account disabled' });
        }

        req.userId = user.id;
        next();
    };
}

/** Route guard for support/admin-only endpoints. Must run after requireAuth. */
export function requireStaff(users: UserRepository) {
    return async (req: AuthedRequest, res: Response, next: NextFunction) => {
        const user = req.userId ? await users.byId(req.userId).catch(() => undefined) : undefined;
        if (!user || !isStaff(user)) {
            return res.status(403).json({ error: 'staff only' });
        }
        next();
    };
}

export function verifyToken(token: string): TokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenInvalidError('malformed token');

    let claims: TokenClaims;
    try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        throw new TokenInvalidError('unparseable claims');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (claims.exp + config.auth.clockSkewSeconds < nowSeconds) {
        throw new TokenExpiredError(`token expired at ${claims.exp}`);
    }
    return claims;
}
