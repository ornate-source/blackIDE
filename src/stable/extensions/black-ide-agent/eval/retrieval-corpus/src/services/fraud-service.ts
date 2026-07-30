import { User } from '../models/user';
import { config } from '../config';

export interface RiskSignal {
    name: string;
    weight: number;
    detail?: string;
}

export interface RiskAssessment {
    score: number;
    decision: 'allow' | 'review' | 'block';
    signals: RiskSignal[];
}

/**
 * Pre-authorisation risk scoring. Runs *before* the card is charged so a blocked
 * attempt never reaches the gateway — repeated declines from one account are what
 * get a merchant's processing rate raised.
 */
export function assessCharge(user: User, amountMinor: number, currency: string, history: {
    declinesLastHour: number;
    chargesLastDay: number;
    distinctCardsLastWeek: number;
}): RiskAssessment {
    const signals: RiskSignal[] = [];

    if (history.declinesLastHour >= 3) {
        signals.push({ name: 'repeated_declines', weight: 40, detail: `${history.declinesLastHour} in the last hour` });
    }
    if (history.distinctCardsLastWeek >= 4) {
        signals.push({ name: 'card_testing', weight: 35, detail: `${history.distinctCardsLastWeek} cards this week` });
    }
    if (amountMinor > config.fraud.largeChargeMinor) {
        signals.push({ name: 'large_amount', weight: 20, detail: `${amountMinor} ${currency}` });
    }
    if (Date.now() - user.createdAt < 60 * 60 * 1000) {
        signals.push({ name: 'new_account', weight: 15 });
    }
    if (history.chargesLastDay > config.fraud.dailyChargeCeiling) {
        signals.push({ name: 'velocity', weight: 25 });
    }

    const score = signals.reduce((sum, s) => sum + s.weight, 0);
    return { score, decision: decide(score), signals };
}

function decide(score: number): RiskAssessment['decision'] {
    if (score >= config.fraud.blockThreshold) return 'block';
    if (score >= config.fraud.reviewThreshold) return 'review';
    return 'allow';
}

/** Human-readable reason string for the support console. */
export function explain(assessment: RiskAssessment): string {
    if (assessment.signals.length === 0) return 'No risk signals fired.';
    return assessment.signals
        .map(s => `${s.name} (+${s.weight})${s.detail ? ` — ${s.detail}` : ''}`)
        .join('; ');
}
