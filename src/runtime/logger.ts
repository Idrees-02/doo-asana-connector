/**
 * Structured logging.
 *
 * Two properties this module must guarantee:
 *
 * 1. NOTHING IS WRITTEN TO STDOUT. The MCP adapter speaks JSON-RPC over stdio,
 *    where stdout *is* the protocol channel. A stray `console.log` anywhere in
 *    the connector would inject garbage into the stream and break the MCP
 *    session in a way that is genuinely hard to diagnose. Everything goes to
 *    stderr, which MCP clients treat as diagnostics.
 *
 * 2. Every value is redacted before it is written. Log calls take structured
 *    fields rather than pre-formatted strings specifically so this can be
 *    enforced — a caller cannot smuggle a token in by concatenating it.
 */

import { redactValue } from './redact.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  child(context: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  /** Emit JSON lines rather than human-readable text. Default in production. */
  readonly json?: boolean;
  /** Injectable for tests. Always stderr in real use. */
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

class StructuredLogger implements Logger {
  private readonly level: LogLevel;
  private readonly json: boolean;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  constructor(
    private readonly context: LogFields,
    options: LoggerOptions = {},
  ) {
    this.level = options.level ?? 'info';
    this.json = options.json ?? false;
    // stderr, never stdout — see the module comment.
    this.write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
    this.options = options;
  }

  private readonly options: LoggerOptions;

  private log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.level]) return;

    const merged = { ...this.context, ...fields };
    const safe = redactValue(merged) as Record<string, unknown>;
    const timestamp = this.now().toISOString();

    if (this.json) {
      this.write(JSON.stringify({ level, time: timestamp, msg: message, ...safe }));
      return;
    }

    const suffix = Object.keys(safe).length > 0 ? ` ${formatFields(safe)}` : '';
    this.write(`${timestamp} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`);
  }

  error(message: string, fields?: LogFields): void {
    this.log('error', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.log('warn', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.log('info', message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.log('debug', message, fields);
  }

  child(context: LogFields): Logger {
    return new StructuredLogger({ ...this.context, ...context }, this.options);
  }
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger({}, options);
}

/** A logger that discards everything. Used in tests and by the MCP adapter at rest. */
export const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};
