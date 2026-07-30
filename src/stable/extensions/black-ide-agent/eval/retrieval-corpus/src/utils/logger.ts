type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT = /("(?:password|secret|token|api_key|authorization|card_number)"\s*:\s*)"[^"]*"/gi;

/**
 * Structured JSON logging with field redaction.
 *
 * Redaction happens at serialisation, not at every call site: a rule that depends
 * on each caller remembering it is a rule that leaks the first time somebody logs
 * a whole request body in a hurry.
 */
export class Logger {
    constructor(private readonly minimum: Level = 'info', private readonly base: Record<string, unknown> = {}) {}

    child(fields: Record<string, unknown>): Logger {
        return new Logger(this.minimum, { ...this.base, ...fields });
    }

    debug(msg: string, fields?: Record<string, unknown>) { this.write('debug', msg, fields); }
    info(msg: string, fields?: Record<string, unknown>) { this.write('info', msg, fields); }
    warn(msg: string, fields?: Record<string, unknown>) { this.write('warn', msg, fields); }
    error(msg: string, fields?: Record<string, unknown>) { this.write('error', msg, fields); }

    private write(level: Level, msg: string, fields?: Record<string, unknown>) {
        if (ORDER[level] < ORDER[this.minimum]) return;
        const line = JSON.stringify({ level, msg, at: new Date().toISOString(), ...this.base, ...fields });
        process.stdout.write(line.replace(REDACT, '$1"[redacted]"') + '\n');
    }
}

export const log = new Logger();
