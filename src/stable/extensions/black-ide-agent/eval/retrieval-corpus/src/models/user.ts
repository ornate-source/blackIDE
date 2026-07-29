export type UserRole = 'customer' | 'support' | 'admin';

export interface User {
    id: string;
    email: string;
    displayName: string;
    role: UserRole;
    preferredCurrency: string;
    locale: string;
    createdAt: number;
    disabledAt?: number;
}

export function isStaff(user: User): boolean {
    return user.role === 'support' || user.role === 'admin';
}

export function isActive(user: User): boolean {
    return user.disabledAt === undefined;
}

/** Support and admin accounts may act on behalf of a customer; customers may not. */
export function canImpersonate(actor: User, target: User): boolean {
    if (!isStaff(actor) || !isActive(actor)) return false;
    return target.role === 'customer';
}

export function maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const head = local.slice(0, 1);
    return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}
