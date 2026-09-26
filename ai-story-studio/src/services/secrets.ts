import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '../lib/errors.ts';

/**
 * Local secret store: the RunPod API key, an optional Hugging Face token, YouTube (Google OAuth)
 * credentials and the per-session cloud worker tokens (needed to reconnect after a restart).
 *
 * - Values are encrypted at rest (AES-256-GCM). On Windows the encryption key itself is protected
 *   with DPAPI for the current Windows user, so a copied file cannot be read by another user or
 *   on another PC. Elsewhere the key file is readable by the owner only (chmod 600).
 * - Both files live in DATA_DIR (git-ignored, inside your user profile), never in the repository,
 *   and are not part of project backups or exports.
 * - Values never go to the browser: the UI only ever sees `masked()`.
 * - An environment variable (e.g. RUNPOD_API_KEY in .env) takes precedence and
 *   is reported as coming from the environment.
 */
export type SecretName = 'runpodApiKey' | 'hfToken' | 'youtubeClient' | 'youtubeToken';

interface SecretFile {
  version: 2;
  protection: Protection;
  values: Partial<Record<SecretName, string>>;
  workerTokens: Record<string, string>;
}

type Protection = 'dpapi' | 'file';

const ENV_NAMES: Partial<Record<SecretName, string>> = {
  runpodApiKey: 'RUNPOD_API_KEY',
  hfToken: 'HF_TOKEN',
};

/** Protects the 32-byte encryption key. */
export interface KeyProtector {
  kind: Protection;
  protect(key: Buffer): Buffer;
  unprotect(blob: Buffer): Buffer;
}

const DPAPI_SCRIPT = (op: 'Protect' | 'Unprotect'): string =>
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
  `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser'))`;

/** Windows DPAPI (current user) through PowerShell; the key travels on stdin, never on a command line. */
export const dpapiProtector: KeyProtector = {
  kind: 'dpapi',
  protect: (key) => runDpapi('Protect', key),
  unprotect: (blob) => runDpapi('Unprotect', blob),
};

function runDpapi(op: 'Protect' | 'Unprotect', data: Buffer): Buffer {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT(op)], {
    input: data.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0 || !/^[A-Za-z0-9+/=]+$/.test(out))
    throw new AppError(
      'STORAGE_FAILED',
      `Windows could not ${op === 'Protect' ? 'protect' : 'unlock'} the saved keys (DPAPI): ${(r.stderr || r.error?.message || 'no output').toString().trim().slice(0, 200)}`,
    );
  return Buffer.from(out, 'base64');
}

/** Key file readable by the owner only (non-Windows, and tests). */
export const fileProtector: KeyProtector = {
  kind: 'file',
  protect: (key) => Buffer.from(key),
  unprotect: (blob) => Buffer.from(blob),
};

export function defaultProtector(): KeyProtector {
  return process.platform === 'win32' ? dpapiProtector : fileProtector;
}

function writePrivate(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: permissions come from the user-profile folder ACLs (the installer restricts data/).
  }
}

export class SecretStore {
  readonly path: string;
  readonly keyPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly protector: KeyProtector;
  private cache: SecretFile | undefined;
  private key: Buffer | undefined;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env, protector = defaultProtector()) {
    this.path = join(dataDir, 'secrets.json');
    this.keyPath = join(dataDir, 'secrets.key');
    this.env = env;
    this.protector = protector;
  }

  /** How saved values are protected ('dpapi' = Windows user encryption). */
  get protection(): Protection {
    return this.protector.kind;
  }

  private encKey(create: boolean): Buffer {
    if (this.key) return this.key;
    if (existsSync(this.keyPath)) {
      try {
        const blob = Buffer.from(readFileSync(this.keyPath, 'utf8').trim(), 'base64');
        this.key = this.protector.unprotect(blob);
      } catch (err) {
        throw new AppError(
          'STORAGE_FAILED',
          `The saved keys cannot be unlocked (${(err as Error).message}). They may belong to another Windows user. Open Settings → AI Engine and press "Forget saved keys", then enter your keys again.`,
        );
      }
      if (this.key.length !== 32) throw new AppError('STORAGE_FAILED', 'The key file is damaged.');
      return this.key;
    }
    if (!create) throw new AppError('STORAGE_FAILED', 'The key file is missing.');
    const key = randomBytes(32);
    writePrivate(this.keyPath, this.protector.protect(key).toString('base64'));
    this.key = key;
    return key;
  }

  private seal(value: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.encKey(true), iv);
    const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return `v2:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }

  private open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split(':');
    if (v !== 'v2' || !iv || !tag || ct === undefined)
      throw new AppError('STORAGE_FAILED', 'A saved key is damaged.');
    try {
      const d = createDecipheriv('aes-256-gcm', this.encKey(false), Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        'STORAGE_FAILED',
        'A saved key cannot be decrypted. Open Settings → AI Engine, press "Forget saved keys" and enter it again.',
      );
    }
  }

  private read(): SecretFile {
    if (this.cache) return this.cache;
    let file: SecretFile = { version: 2, protection: this.protector.kind, values: {}, workerTokens: {} };
    if (existsSync(this.path)) {
      let raw: { version?: number; values?: Record<string, string>; workerTokens?: Record<string, string> };
      try {
        raw = JSON.parse(readFileSync(this.path, 'utf8')) as typeof raw;
      } catch {
        throw new AppError(
          'STORAGE_FAILED',
          `The secret store ${this.path} is unreadable; fix or delete it.`,
        );
      }
      if (raw.version === 2) {
        file = {
          version: 2,
          protection: this.protector.kind,
          values: raw.values ?? {},
          workerTokens: raw.workerTokens ?? {},
        };
      } else {
        // v1 kept values in plain text: encrypt them now and rewrite the file.
        const seal = (o: Record<string, string> = {}) =>
          Object.fromEntries(Object.entries(o).map(([k, v]) => [k, this.seal(v)]));
        file = {
          version: 2,
          protection: this.protector.kind,
          values: seal(raw.values),
          workerTokens: seal(raw.workerTokens),
        };
        this.write(file);
      }
    }
    this.cache = file;
    return file;
  }

  private write(file: SecretFile): void {
    writePrivate(this.path, JSON.stringify(file, null, 2));
    this.cache = file;
  }

  private envValue(name: SecretName): string | undefined {
    const n = ENV_NAMES[name];
    return n ? this.env[n]?.trim() || undefined : undefined;
  }

  get(name: SecretName): string | undefined {
    const fromEnv = this.envValue(name);
    if (fromEnv) return fromEnv;
    const sealed = this.read().values[name];
    return sealed ? this.open(sealed) : undefined;
  }

  source(name: SecretName): 'env' | 'store' | 'none' {
    if (this.envValue(name)) return 'env';
    return this.read().values[name] ? 'store' : 'none';
  }

  set(name: SecretName, value: string): void {
    const v = value.trim();
    if (!v) throw new AppError('VALIDATION_FAILED', 'The value is empty');
    if (v.length > 512 || /\s/.test(v))
      throw new AppError('VALIDATION_FAILED', 'That does not look like a valid key');
    this.setRaw(name, v);
  }

  /** Structured secrets (OAuth tokens and client credentials) as JSON. */
  setJson(name: SecretName, value: unknown): void {
    const v = JSON.stringify(value);
    if (v.length > 16_384) throw new AppError('VALIDATION_FAILED', 'That value is too large');
    this.setRaw(name, v);
  }

  getJson<T>(name: SecretName): T | undefined {
    const v = this.get(name);
    if (!v) return undefined;
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  }

  private setRaw(name: SecretName, v: string): void {
    const file = this.read();
    this.write({ ...file, values: { ...file.values, [name]: this.seal(v) } });
  }

  delete(name: SecretName): void {
    const file = this.read();
    const values = { ...file.values };
    delete values[name];
    this.write({ ...file, values });
  }

  /** Remove every saved secret and the key (used when saved keys can no longer be unlocked). */
  forgetAll(): void {
    rmSync(this.path, { force: true });
    rmSync(this.keyPath, { force: true });
    this.cache = undefined;
    this.key = undefined;
  }

  /** Safe to display: the last four characters only. */
  masked(name: SecretName): string {
    const v = this.get(name);
    if (!v) return 'not set';
    return `••••••••${v.slice(-4)}`;
  }

  // --- per-session worker tokens -----------------------------------------------------

  /** A new random worker token: 256 bits, prefixed so logs can redact it. */
  static newWorkerToken(): string {
    return `aisw_${randomBytes(32).toString('hex')}`;
  }

  saveWorkerToken(instanceKey: string, token: string): void {
    const file = this.read();
    this.write({ ...file, workerTokens: { ...file.workerTokens, [instanceKey]: this.seal(token) } });
  }

  workerToken(instanceKey: string): string | undefined {
    const sealed = this.read().workerTokens[instanceKey];
    return sealed ? this.open(sealed) : undefined;
  }

  forgetWorkerToken(instanceKey: string): void {
    const file = this.read();
    if (!(instanceKey in file.workerTokens)) return;
    const workerTokens = { ...file.workerTokens };
    delete workerTokens[instanceKey];
    this.write({ ...file, workerTokens });
  }
}
