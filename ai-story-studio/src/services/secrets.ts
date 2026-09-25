import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '../lib/errors.ts';

/**
 * Local secret store for the cloud API key, an optional Hugging Face token and
 * the per-session cloud worker tokens (needed to reconnect after a restart).
 *
 * - The file lives in DATA_DIR (git-ignored, inside your user profile), not in
 *   the repository. It is written atomically and chmod 600 where the OS supports it.
 * - Values never go to the browser: the UI only ever sees `masked()`.
 * - An environment variable (e.g. RUNPOD_API_KEY in .env) takes precedence and
 *   is reported as coming from the environment.
 */
export type SecretName = 'runpodApiKey' | 'hfToken';

interface SecretFile {
  version: 1;
  values: Partial<Record<SecretName, string>>;
  workerTokens: Record<string, string>;
}

const ENV_NAMES: Record<SecretName, string> = { runpodApiKey: 'RUNPOD_API_KEY', hfToken: 'HF_TOKEN' };

export class SecretStore {
  readonly path: string;
  private readonly env: NodeJS.ProcessEnv;
  private cache: SecretFile | undefined;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.path = join(dataDir, 'secrets.json');
    this.env = env;
  }

  private read(): SecretFile {
    if (this.cache) return this.cache;
    let file: SecretFile = { version: 1, values: {}, workerTokens: {} };
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SecretFile>;
        file = { version: 1, values: raw.values ?? {}, workerTokens: raw.workerTokens ?? {} };
      } catch {
        throw new AppError(
          'STORAGE_FAILED',
          `The secret store ${this.path} is unreadable; fix or delete it.`,
        );
      }
    }
    this.cache = file;
    return file;
  }

  private write(file: SecretFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows: permissions come from the user-profile folder ACLs.
    }
    this.cache = file;
  }

  get(name: SecretName): string | undefined {
    const fromEnv = this.env[ENV_NAMES[name]]?.trim();
    if (fromEnv) return fromEnv;
    return this.read().values[name] || undefined;
  }

  source(name: SecretName): 'env' | 'store' | 'none' {
    if (this.env[ENV_NAMES[name]]?.trim()) return 'env';
    return this.read().values[name] ? 'store' : 'none';
  }

  set(name: SecretName, value: string): void {
    const v = value.trim();
    if (!v) throw new AppError('VALIDATION_FAILED', 'The value is empty');
    if (v.length > 512 || /\s/.test(v))
      throw new AppError('VALIDATION_FAILED', 'That does not look like a valid key');
    const file = this.read();
    this.write({ ...file, values: { ...file.values, [name]: v } });
  }

  delete(name: SecretName): void {
    const file = this.read();
    const values = { ...file.values };
    delete values[name];
    this.write({ ...file, values });
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
    this.write({ ...file, workerTokens: { ...file.workerTokens, [instanceKey]: token } });
  }

  workerToken(instanceKey: string): string | undefined {
    return this.read().workerTokens[instanceKey];
  }

  forgetWorkerToken(instanceKey: string): void {
    const file = this.read();
    if (!(instanceKey in file.workerTokens)) return;
    const workerTokens = { ...file.workerTokens };
    delete workerTokens[instanceKey];
    this.write({ ...file, workerTokens });
  }
}
