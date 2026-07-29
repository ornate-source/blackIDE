import { useEffect, useState } from 'react';
import { request } from '../lib/api-client';

export interface SessionUser {
    id: string;
    email: string;
    displayName: string;
    role: 'customer' | 'support' | 'admin';
    preferredCurrency: string;
}

/**
 * Current-user state. The token itself lives in an httpOnly cookie the script
 * cannot read, so "am I signed in" is answered by asking the server, not by
 * inspecting storage — which also means an expired session is discovered on the
 * next request rather than trusted until a timer fires.
 */
export function useSession() {
    const [user, setUser] = useState<SessionUser | undefined>();
    const [checked, setChecked] = useState(false);

    useEffect(() => {
        let cancelled = false;
        request<SessionUser>('/users/me')
            .then(u => { if (!cancelled) setUser(u); })
            .catch(() => { if (!cancelled) setUser(undefined); })
            .finally(() => { if (!cancelled) setChecked(true); });
        return () => { cancelled = true; };
    }, []);

    return { user, signedIn: Boolean(user), checked };
}
