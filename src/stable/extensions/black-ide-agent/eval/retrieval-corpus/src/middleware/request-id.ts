import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

export interface TracedRequest extends Request {
    requestId?: string;
}

/**
 * Attaches a request id, trusting an inbound one only from the load balancer.
 * Accepting any client-supplied id would let a caller collide their requests with
 * somebody else's in the logs.
 */
export function requestId(trustInbound = false) {
    return (req: TracedRequest, res: Response, next: NextFunction) => {
        const inbound = req.headers['x-request-id'];
        req.requestId = trustInbound && typeof inbound === 'string' && /^[\w-]{8,64}$/.test(inbound)
            ? inbound
            : randomUUID();
        res.setHeader('x-request-id', req.requestId);
        next();
    };
}
