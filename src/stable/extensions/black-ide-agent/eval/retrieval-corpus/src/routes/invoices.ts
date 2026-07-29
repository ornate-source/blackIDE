import { Router } from 'express';
import { InvoiceService } from '../services/invoice-service';
import { InvoiceRepository, InvoiceNotFoundError } from '../repositories/invoice-repository';
import { UserRepository } from '../repositories/user-repository';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { formatMoney } from '../utils/currency';
import { outstandingMinor } from '../models/invoice';
import { requireCurrencyCode } from '../utils/validation';

export function invoiceRoutes(invoices: InvoiceRepository, users: UserRepository): Router {
    const router = Router();
    const service = new InvoiceService(invoices);

    router.use(requireAuth(users));

    router.post('/', async (req: AuthedRequest, res) => {
        const currency = requireCurrencyCode(req.body, 'currency');
        const invoice = await service.issue(req.userId!, req.body.lines ?? [], currency);
        res.status(201).json({ id: invoice.id, total: formatMoney(invoice.totalMinor, invoice.currency) });
    });

    router.get('/:id', async (req, res) => {
        try {
            const invoice = await invoices.byId(req.params.id);
            res.json({
                id: invoice.id,
                status: invoice.status,
                total: formatMoney(invoice.totalMinor, invoice.currency),
                outstanding: formatMoney(outstandingMinor(invoice), invoice.currency),
            });
        } catch (err) {
            if (err instanceof InvoiceNotFoundError) return res.status(404).json({ error: 'not_found' });
            throw err;
        }
    });

    router.get('/:id/text', async (req, res) => {
        res.type('text/plain').send(await service.renderPlainText(req.params.id));
    });

    return router;
}
