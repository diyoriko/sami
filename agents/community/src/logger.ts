/**
 * Structured logger with correlation ID support.
 *
 * Output: [timestamp] [correlationId] [module] LEVEL message {meta}
 * When no correlationId: [timestamp] [module] LEVEL message {meta}
 *
 * Correlation IDs trace full flows: search -> approval -> download -> publish.
 */

import { randomBytes } from 'crypto';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogContext {
  module: string;
  correlationId?: string;
}

function formatMessage(ctx: LogContext, level: LogLevel, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const cid = ctx.correlationId ? ` [${ctx.correlationId}]` : '';
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  return `[${ts}]${cid} [${ctx.module}] ${level.toUpperCase()} ${msg}${metaStr}`;
}

export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  child: (childModule: string) => Logger;
  withCorrelation: (id?: string) => Logger;
  correlationId?: string;
}

export function createLogger(module: string, correlationId?: string): Logger {
  const ctx: LogContext = { module, correlationId };
  return {
    info: (msg: string, meta?: Record<string, unknown>) => console.log(formatMessage(ctx, 'info', msg, meta)),
    warn: (msg: string, meta?: Record<string, unknown>) => console.warn(formatMessage(ctx, 'warn', msg, meta)),
    error: (msg: string, meta?: Record<string, unknown>) => console.error(formatMessage(ctx, 'error', msg, meta)),
    debug: (msg: string, meta?: Record<string, unknown>) => {
      if (process.env.LOG_LEVEL === 'debug') console.log(formatMessage(ctx, 'debug', msg, meta));
    },
    child: (childModule: string) => createLogger(childModule, ctx.correlationId),
    withCorrelation: (id?: string) => createLogger(module, id ?? generateCorrelationId()),
    correlationId: ctx.correlationId,
  };
}

export function generateCorrelationId(): string {
  return randomBytes(4).toString('hex');
}
