export interface WebhookEndpoint {
    id: string;
    customerId: string;
    url: string;
    secret: string;
    events: string[];
    disabledAt?: number;
    disabledReason?: string;
}

export interface WebhookDelivery {
    id?: string;
    endpointId: string;
    event: string;
    status: 'delivered' | 'failed' | 'exhausted';
    attempts: number;
    at?: number;
}

export function subscribesTo(endpoint: WebhookEndpoint, event: string): boolean {
    if (endpoint.disabledAt) return false;
    return endpoint.events.includes('*') || endpoint.events.includes(event);
}

/** Endpoints must be https and must not point at the internal network. */
export function isAcceptableUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        return !/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(parsed.hostname);
    } catch {
        return false;
    }
}
