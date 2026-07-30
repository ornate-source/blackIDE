import { convertMinor, formatMoney, sumMinor } from '../utils/currency';
import { InvoiceRepository } from '../repositories/invoice-repository';
import { Invoice, InvoiceLine, invoiceTotalMinor } from '../models/invoice';
import { config } from '../config';

/**
 * Invoice rendering and totalling. Every amount on an invoice is frozen at issue
 * time — an invoice that silently re-converts when exchange rates move is a
 * finance incident, not a feature.
 */
export class InvoiceService {
    constructor(private readonly invoices: InvoiceRepository) {}

    async issue(customerId: string, lines: InvoiceLine[], currency: string): Promise<Invoice> {
        const subtotalMinor = sumMinor(lines.map(l => l.amountMinor * l.quantity));
        const taxMinor = Math.round(subtotalMinor * config.billing.taxRate);
        const totalMinor = convertMinor(subtotalMinor + taxMinor, config.baseCurrency, currency);

        return this.invoices.create({
            customerId,
            lines,
            currency,
            subtotalMinor,
            taxMinor,
            totalMinor,
            issuedAt: Date.now(),
            status: 'open',
        });
    }

    /** Human-readable rendering. Uses the invoice's own frozen currency, never the user's current one. */
    async renderPlainText(invoiceId: string): Promise<string> {
        const invoice = await this.invoices.byId(invoiceId);
        const rows = invoice.lines.map(l =>
            `${String(l.quantity).padStart(4)} × ${l.description.padEnd(30)} ${formatMoney(l.amountMinor, invoice.currency)}`
        );
        return [
            `Invoice ${invoice.id}`,
            ...rows,
            `Subtotal ${formatMoney(invoice.subtotalMinor, invoice.currency)}`,
            `Tax      ${formatMoney(invoice.taxMinor, invoice.currency)}`,
            `Total    ${formatMoney(invoiceTotalMinor(invoice), invoice.currency)}`,
        ].join('\n');
    }

    async markPaid(invoiceId: string, paymentIntentId: string): Promise<Invoice> {
        return this.invoices.update(invoiceId, { status: 'paid', paymentIntentId, paidAt: Date.now() });
    }

    async void(invoiceId: string, reason: string): Promise<Invoice> {
        return this.invoices.update(invoiceId, { status: 'void', voidReason: reason });
    }
}
