import { Order } from '../models/order';
import { User, maskEmail } from '../models/user';
import { withRetry } from '../utils/retry';
import { config } from '../config';

type TemplateId = 'order_confirmed' | 'order_cancelled' | 'refund_issued' | 'low_stock_alert';

/**
 * Sends a transactional email. Delivery failures are retried, but only three times —
 * a stuck mailbox must not hold an order-placement request open.
 */
export async function sendEmail(to: User, template: TemplateId, vars: Record<string, string>): Promise<void> {
    await withRetry(
        () => post('/messages', { to: to.email, template, vars, locale: to.locale }),
        { attempts: 3, baseDelayMs: 200 },
    );
}

export async function notifyOrderConfirmed(order: Order): Promise<void> {
    await sendEmail(order.customer, 'order_confirmed', {
        order_id: order.id,
        total: String(order.totalMinor),
        currency: order.currency,
    });
}

export async function notifyRefundIssued(order: Order, amountMinor: number): Promise<void> {
    await sendEmail(order.customer, 'refund_issued', {
        order_id: order.id,
        amount: String(amountMinor),
    });
}

/** Audit lines never carry a full address — see maskEmail. */
export function auditLine(user: User, action: string): string {
    return `${new Date().toISOString()} ${action} ${maskEmail(user.email)}`;
}

async function post(pathname: string, body: unknown): Promise<void> {
    const res = await fetch(config.notifications.baseUrl + pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`notification service ${res.status}`);
}
