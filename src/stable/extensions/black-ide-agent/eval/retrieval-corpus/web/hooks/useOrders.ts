import { useCallback, useEffect, useState } from 'react';
import { request, ApiError } from '../lib/api-client';

export interface OrderRow {
    id: string;
    status: string;
    total: string;
    currency: string;
}

/**
 * Loads the signed-in customer's orders with cursor pagination.
 *
 * The in-flight request is aborted when the effect re-runs, so a slow first page
 * cannot land after a fast second one and overwrite it — the classic React data
 * race that shows the user stale rows.
 */
export function useOrders(pageSize = 20) {
    const [orders, setOrders] = useState<OrderRow[]>([]);
    const [cursor, setCursor] = useState<string | undefined>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        try {
            const query = new URLSearchParams({ limit: String(pageSize), ...(cursor ? { before: cursor } : {}) });
            const page = await request<OrderRow[]>(`/orders?${query}`, { signal });
            setOrders(prev => (cursor ? [...prev, ...page] : page));
            setError(undefined);
        } catch (err) {
            if ((err as Error).name !== 'AbortError') {
                setError(err instanceof ApiError ? err.message : 'Could not load orders');
            }
        } finally {
            setLoading(false);
        }
    }, [cursor, pageSize]);

    useEffect(() => {
        const controller = new AbortController();
        load(controller.signal);
        return () => controller.abort();
    }, [load]);

    return { orders, loading, error, loadMore: () => setCursor(orders[orders.length - 1]?.id) };
}
