import { NextFunction, Request, Response } from 'express';
import { TracedRequest } from './request-id';

/**
 * Terminal error handler. The response body carries the request id and nothing
 * else — an error message can contain a row, a query, or a connection string, and
 * "helpful" 500 bodies are a reliable way to leak all three.
 */
export function errorHandler() {
    return (err: Error, req: TracedRequest, res: Response, _next: NextFunction) => {
        const status = statusFor(err);
        if (status >= 500) {
            console.error(`[${req.requestId}] ${err.stack}`);
        }
        res.status(status).json({ error: status >= 500 ? 'internal_error' : err.message, requestId: req.requestId });
    };
}

function statusFor(err: Error & { status?: number }): number {
    if (typeof err.status === 'number') return err.status;
    if (err.name === 'ValidationError') return 400;
    if (err.name === 'NotFoundError') return 404;
    return 500;
}

/** 404 handler, registered after every route. */
export function notFound() {
    return (_req: Request, res: Response) => res.status(404).json({ error: 'not_found' });
}
