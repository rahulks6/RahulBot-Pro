import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogLevel } from '../config/env.ts';

/**
 * Structured JSON-lines logger (spec §67). Context fields such as project,
 * story, scene, shot, job, provider, gpu, model, status, cost and cleanup
 * result are passed as structured data. Secrets are redacted before writing.
 */
export type LogFields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|credential|cookie|private[-_]?key)/i;
const SECRET_VALUE = [
  /\b(sk|rk|pk)[-_][A-Za-z0-9_-]{12,}\b/g, // provider-style API keys
  /\brpa_[A-Za-z0-9]{12,}\b/g, // RunPod API keys
  /\bhf_[A-Za-z0-9]{12,}\b/g, // Hugging Face tokens
  /\baisw_[A-Za-z0-9]{12,}\b/g, // per-session cloud worker tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT-like
];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') {
    let out = value;
    for (const re of SECRET_VALUE) out = out.replace(re, '[REDACTED]');
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LogSink {
  write(line: string): void;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly sinks: LogSink[];
  private readonly base: LogFields;

  constructor(level: LogLevel, sinks: LogSink[], base: LogFields = {}) {
    this.level = level;
    this.sinks = sinks;
    this.base = base;
  }

  child(fields: LogFields): Logger {
    return new Logger(this.level, this.sinks, { ...this.base, ...fields });
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields: LogFields = {}): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields: LogFields = {}): void {
    this.log('error', msg, fields);
  }

  private log(level: LogLevel, msg: string, fields: LogFields): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const record = redact({ ts: new Date().toISOString(), level, msg, ...this.base, ...fields });
    const line = JSON.stringify(record);
    for (const sink of this.sinks) sink.write(line);
  }
}

export function fileSink(path: string): LogSink {
  mkdirSync(dirname(path), { recursive: true });
  return { write: (line) => appendFileSync(path, line + '\n') };
}

export const stdoutSink: LogSink = { write: (line) => process.stdout.write(line + '\n') };

export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
}

export const silentLogger = new Logger('error', []);
