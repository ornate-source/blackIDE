export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export interface InvoiceLine {
    description: string;
    quantity: number;
    amountMinor: number;
}

export interface Invoice {
    id: string;
    customerId: string;
    lines: InvoiceLine[];
    currency: string;
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
    status: InvoiceStatus;
    issuedAt: number;
    paidAt?: number;
    paymentIntentId?: string;
    voidReason?: string;
}

/**
 * The authoritative total. Recomputed from the frozen line amounts rather than
 * trusting the stored `totalMinor`, so a bad write shows up as a mismatch instead
 * of quietly becoming the truth.
 */
export function invoiceTotalMinor(invoice: Invoice): number {
    const subtotal = invoice.lines.reduce((sum, l) => sum + l.amountMinor * l.quantity, 0);
    return subtotal + invoice.taxMinor;
}

export function isSettled(invoice: Invoice): boolean {
    return invoice.status === 'paid' || invoice.status === 'void';
}

export function outstandingMinor(invoice: Invoice): number {
    return isSettled(invoice) ? 0 : invoiceTotalMinor(invoice);
}
