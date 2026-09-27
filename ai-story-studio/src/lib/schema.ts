import type { FieldError } from './errors.ts';
import { AppError } from './errors.ts';

/**
 * Tiny dependency-free schema validator with static type inference.
 *
 * Used for Story Package import, form input, settings, backups and (in Phase 2)
 * worker requests. Every schema reports *all* problems with a JSON-path-like
 * location so the UI can display useful validation errors.
 */
export interface Schema<T> {
  readonly kind: string;
  parse(value: unknown, path: string, issues: FieldError[]): T | undefined;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

interface StringOpts {
  min?: number;
  max?: number;
  pattern?: RegExp;
  patternMessage?: string;
  trim?: boolean;
}

export function string(opts: StringOpts = {}): Schema<string> {
  const max = opts.max ?? 20_000;
  return {
    kind: 'string',
    parse(value, path, issues) {
      if (typeof value !== 'string') {
        issues.push({ path, message: 'must be a string' });
        return undefined;
      }
      const v = opts.trim === false ? value : value.trim();
      if (opts.min !== undefined && v.length < opts.min) {
        issues.push({
          path,
          message: opts.min === 1 ? 'is required' : `must be at least ${opts.min} characters`,
        });
        return undefined;
      }
      if (v.length > max) {
        issues.push({ path, message: `must be at most ${max} characters` });
        return undefined;
      }
      if (opts.pattern && !opts.pattern.test(v)) {
        issues.push({ path, message: opts.patternMessage ?? `has an invalid format` });
        return undefined;
      }
      return v;
    },
  };
}

interface NumberOpts {
  min?: number;
  max?: number;
  int?: boolean;
}

export function number(opts: NumberOpts = {}): Schema<number> {
  return {
    kind: 'number',
    parse(value, path, issues) {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        issues.push({ path, message: 'must be a number' });
        return undefined;
      }
      if (opts.int && !Number.isInteger(n)) {
        issues.push({ path, message: 'must be a whole number' });
        return undefined;
      }
      if (opts.min !== undefined && n < opts.min) {
        issues.push({ path, message: `must be ≥ ${opts.min}` });
        return undefined;
      }
      if (opts.max !== undefined && n > opts.max) {
        issues.push({ path, message: `must be ≤ ${opts.max}` });
        return undefined;
      }
      return n;
    },
  };
}

/** A number restricted to an explicit set (e.g. frame rates 24 / 30). */
export function oneOfNumbers<const T extends readonly number[]>(values: T): Schema<T[number]> {
  const base = number();
  return {
    kind: 'number-enum',
    parse(value, path, issues) {
      const n = base.parse(value, path, issues);
      if (n === undefined) return undefined;
      if (!(values as readonly number[]).includes(n)) {
        issues.push({ path, message: `must be one of: ${values.join(', ')}` });
        return undefined;
      }
      return n as T[number];
    },
  };
}

export function boolean(): Schema<boolean> {
  return {
    kind: 'boolean',
    parse(value, path, issues) {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 0) return value === 1; // SQLite stores booleans as 0/1
      if (value === 'true' || value === 'on' || value === '1') return true;
      if (value === 'false' || value === 'off' || value === '0') return false;
      issues.push({ path, message: 'must be true or false' });
      return undefined;
    },
  };
}

export function enumOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return {
    kind: 'enum',
    parse(value, path, issues) {
      if (typeof value === 'string' && (values as readonly string[]).includes(value))
        return value as T[number];
      issues.push({ path, message: `must be one of: ${values.join(', ')}` });
      return undefined;
    },
  };
}

export function array<T>(item: Schema<T>, opts: { min?: number; max?: number } = {}): Schema<T[]> {
  const max = opts.max ?? 1000;
  return {
    kind: 'array',
    parse(value, path, issues) {
      if (!Array.isArray(value)) {
        issues.push({ path, message: 'must be a list' });
        return undefined;
      }
      if (opts.min !== undefined && value.length < opts.min) {
        issues.push({ path, message: `must contain at least ${opts.min} item(s)` });
        return undefined;
      }
      if (value.length > max) {
        issues.push({ path, message: `must contain at most ${max} items` });
        return undefined;
      }
      const out: T[] = [];
      let ok = true;
      value.forEach((v, i) => {
        const parsed = item.parse(v, `${path}[${i}]`, issues);
        if (parsed === undefined) ok = false;
        else out.push(parsed);
      });
      return ok ? out : undefined;
    },
  };
}

const OPTIONAL = Symbol('optional');

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly [OPTIONAL]: true;
}

/** Optional field; `fallback` is used when the value is missing/null. */
export function optional<T>(schema: Schema<T>): OptionalSchema<T>;
export function optional<T>(schema: Schema<T>, fallback: T): Schema<T>;
export function optional<T>(schema: Schema<T>, fallback?: T): Schema<T | undefined> {
  return {
    kind: `optional<${schema.kind}>`,
    [OPTIONAL]: true,
    parse(value, path, issues) {
      if (value === undefined || value === null) return fallback;
      return schema.parse(value, path, issues);
    },
  } as OptionalSchema<T>;
}

/** Arbitrary JSON object (for model-specific configuration). Size-limited. */
export function record(opts: { maxBytes?: number } = {}): Schema<Record<string, unknown>> {
  const maxBytes = opts.maxBytes ?? 16_384;
  return {
    kind: 'record',
    parse(value, path, issues) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ path, message: 'must be an object' });
        return undefined;
      }
      if (JSON.stringify(value).length > maxBytes) {
        issues.push({ path, message: `must be smaller than ${maxBytes} bytes` });
        return undefined;
      }
      return value as Record<string, unknown>;
    },
  };
}

type Shape = Record<string, Schema<unknown>>;

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;

export type ObjectOf<S extends Shape> = { [K in RequiredKeys<S>]: Infer<S[K]> } & {
  [K in OptionalKeys<S>]?: Infer<S[K]>;
};

export interface ObjectSchema<T> extends Schema<T> {
  readonly keys: readonly string[];
}

export function object<S extends Shape>(
  shape: S,
  opts: { allowUnknown?: boolean } = {},
): ObjectSchema<ObjectOf<S>> {
  return {
    kind: 'object',
    keys: Object.keys(shape),
    parse(value, path, issues) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ path, message: 'must be an object' });
        return undefined;
      }
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      let ok = true;
      for (const [key, schema] of Object.entries(shape)) {
        const childPath = path ? `${path}.${key}` : key;
        if (!(key in input) || input[key] === undefined || input[key] === null) {
          if (OPTIONAL in schema) {
            const fallback = schema.parse(undefined, childPath, issues);
            if (fallback !== undefined) out[key] = fallback;
            continue;
          }
          issues.push({ path: childPath, message: 'is required' });
          ok = false;
          continue;
        }
        const parsed = schema.parse(input[key], childPath, issues);
        if (parsed === undefined) ok = false;
        else out[key] = parsed;
      }
      if (!opts.allowUnknown) {
        for (const key of Object.keys(input)) {
          if (!(key in shape)) {
            issues.push({ path: path ? `${path}.${key}` : key, message: 'is not a recognised field' });
            ok = false;
          }
        }
      }
      return ok ? (out as ObjectOf<S>) : undefined;
    },
  };
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

export function validate<T>(schema: Schema<T>, value: unknown): ValidationResult<T> {
  const issues: FieldError[] = [];
  const parsed = schema.parse(value, '', issues);
  if (issues.length > 0 || parsed === undefined) {
    return { ok: false, errors: issues.length ? issues : [{ path: '', message: 'invalid value' }] };
  }
  return { ok: true, value: parsed };
}

/** Validate or throw an AppError(VALIDATION_FAILED) carrying every field error. */
export function parseOrThrow<T>(schema: Schema<T>, value: unknown, what = 'input'): T {
  const result = validate(schema, value);
  if (!result.ok) throw new AppError('VALIDATION_FAILED', `Invalid ${what}`, result.errors);
  return result.value;
}

/** Keep only the keys an object schema knows about (used when merging a DB row with a patch). */
export function pickKnown(
  schema: ObjectSchema<unknown>,
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of schema.keys) if (k in obj) out[k] = obj[k];
  return out;
}
