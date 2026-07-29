import React, { useState } from 'react';
import { request, ApiError } from '../lib/api-client';

/**
 * Email + password sign-in.
 *
 * The failure message is identical for "no such account" and "wrong password" —
 * distinguishing them turns the login form into an account-enumeration oracle.
 * The delay on failure is also constant for the same reason.
 */
export function LoginForm({ onSignedIn }: { onSignedIn: () => void }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        try {
            await request('/sessions', { method: 'POST', body: { email, password } });
            onSignedIn();
        } catch (err) {
            setError(err instanceof ApiError && err.status === 429
                ? 'Too many attempts. Try again in a minute.'
                : 'That email and password do not match.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={submit}>
            <label>Email<input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></label>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
            {error && <p role="alert">{error}</p>}
            <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
    );
}
