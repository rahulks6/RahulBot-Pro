import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Studio } from '../app/studio.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import { parseJson } from '../lib/json.ts';
import { appRoot } from '../lib/paths.ts';

/**
 * The AI Engine as Simple Mode sees it: RunPod connected or not, and anything that stops real
 * generation, each with one plain fix. No GPU names, CUDA versions or pod ids here.
 *
 * Real AI on RunPod is the product. The only other engines are LOCAL GPU (Advanced) and the
 * developer test mode (MOCK_GENERATION=true in .env: labelled placeholders for automated tests),
 * which Simple Mode shows as a problem to fix, never as a way to make videos.
 */
export type EngineState = 'READY' | 'NEEDS_ATTENTION' | 'DEVELOPER_TEST_MODE';

export interface EngineIssue {
  message: string;
  fix: string;
  /** Page to open, or a POST action (`action`) the Simple UI offers as a button. */
  href: string;
  action?: 'switch-to-real' | 'turn-on';
}

export interface EngineTest {
  ok: boolean;
  at: string;
  detail: string;
  /** Can RunPod pull the AI worker image? */
  imageOk: boolean;
  imageDetail: string;
}

export interface EngineStatus {
  state: EngineState;
  engine: 'runpod' | 'local_gpu' | 'developer_test';
  headline: string;
  issues: EngineIssue[];
  runpod: {
    connected: boolean;
    masked: string;
    source: 'env' | 'store' | 'none';
    lastTest: EngineTest | null;
  };
  /** How saved keys are protected on this computer. */
  keyProtection: 'dpapi' | 'file';
}

const TEST_KEY = 'engine.lastTest';

export class EngineService {
  private readonly s: Studio;
  readonly envFile: string;

  constructor(s: Studio, opts: { envFile?: string } = {}) {
    this.s = s;
    this.envFile = opts.envFile ?? join(appRoot(), '.env');
  }

  lastTest(): EngineTest | null {
    const row = this.s.db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', TEST_KEY);
    return row ? parseJson<EngineTest | null>(row.value, null) : null;
  }

  /** The key changed elsewhere (Advanced → Cloud GPU): the old test result no longer applies. */
  forgetTest(): void {
    this.saveTest(null);
  }

  private saveTest(t: EngineTest | null): void {
    if (!t) {
      this.s.db.run('DELETE FROM app_meta WHERE key = ?', TEST_KEY);
      return;
    }
    this.s.db.run(
      'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      TEST_KEY,
      JSON.stringify(t),
    );
  }

  status(): EngineStatus {
    const { env, secrets, settings } = this.s;
    const source = secrets.source('runpodApiKey');
    const lastTest = this.lastTest();
    const runpod = {
      connected: source !== 'none' && lastTest?.ok === true,
      masked: secrets.masked('runpodApiKey'),
      source,
      lastTest,
    };
    const base = { runpod, keyProtection: secrets.protection };
    if (env.mockGeneration)
      return {
        ...base,
        state: 'DEVELOPER_TEST_MODE',
        engine: 'developer_test',
        headline: 'Developer test mode — videos would contain placeholders, not real AI',
        issues: [
          {
            message:
              'The .env file turns on developer test mode (MOCK_GENERATION=true). Nothing real is generated.',
            fix: 'Switch to real AI',
            href: '/settings/ai-engine',
            action: 'switch-to-real',
          },
        ],
      };
    const mode = settings.get('execution').mode;
    if (mode === 'local_gpu') {
      const st = this.s.router.status();
      return {
        ...base,
        state: st.ready ? 'READY' : 'NEEDS_ATTENTION',
        engine: 'local_gpu',
        headline: st.ready ? 'AI Engine ready (this computer’s GPU)' : 'AI Engine needs attention',
        issues: st.problems.map((p) => ({ message: p, fix: 'Open GPU settings', href: '/gpu' })),
      };
    }
    const issues: EngineIssue[] = [];
    if (!env.enableCloudGpu)
      issues.push({
        message: 'Cloud GPUs are switched off in the .env file (ENABLE_CLOUD_GPU=false).',
        fix: 'Switch to real AI',
        href: '/settings/ai-engine',
        action: 'switch-to-real',
      });
    if (source === 'none')
      issues.push({
        message: 'RunPod is not connected yet.',
        fix: 'Connect RunPod',
        href: '/settings/ai-engine',
      });
    else if (lastTest && !lastTest.ok)
      issues.push({
        message: `RunPod connection failed: ${lastTest.detail}`,
        fix: 'Check the RunPod key',
        href: '/settings/ai-engine',
      });
    else if (!lastTest)
      issues.push({
        message: 'The RunPod connection has not been tested yet.',
        fix: 'Test the connection',
        href: '/settings/ai-engine',
      });
    else if (!lastTest.imageOk)
      issues.push({
        message: `RunPod cannot download the AI worker yet: ${lastTest.imageDetail}`,
        fix: 'See how to publish the AI worker',
        href: '/settings/ai-engine#worker',
      });
    const cloud = settings.get('cloud');
    if (mode !== 'cloud_gpu' || !cloud.cloudEnabled || !cloud.realGeneration)
      issues.push({
        message: 'Real generation on RunPod is switched off in the Advanced settings.',
        fix: 'Turn real generation on',
        href: '/settings/ai-engine',
        action: 'turn-on',
      });
    return {
      ...base,
      state: issues.length ? 'NEEDS_ATTENTION' : 'READY',
      engine: 'runpod',
      headline: issues.length ? 'AI Engine needs attention' : 'AI Engine ready',
      issues,
    };
  }

  /**
   * TEST CONNECTION: checks the key (the one typed in, or the saved one) with read-only RunPod
   * calls and checks that RunPod can download the AI worker. Nothing is rented. The key itself
   * is never stored by a test and never logged.
   */
  async test(candidateKey?: string): Promise<EngineTest> {
    const key = candidateKey?.trim();
    if (candidateKey !== undefined && (!key || key.length > 512 || /\s/.test(key)))
      throw new AppError('VALIDATION_FAILED', 'Paste the RunPod API key (it has no spaces).');
    if (!key && this.s.secrets.source('runpodApiKey') === 'none')
      throw new AppError('VALIDATION_FAILED', 'Paste your RunPod API key first.');
    const conn = await this.s.cloud.testConnection(key);
    let imageOk = false;
    let imageDetail = 'not checked (the key did not work)';
    if (conn.ok) {
      try {
        const img = await this.s.cloud.checkImage(this.s.cloud.workerImage());
        imageOk = img.ok === true;
        imageDetail = img.detail;
      } catch (err) {
        imageDetail = toAppError(err).message;
      }
    }
    const t: EngineTest = {
      ok: conn.ok,
      at: this.s.clock.now().toISOString(),
      detail: conn.ok ? 'RunPod accepted the key.' : conn.detail,
      imageOk,
      imageDetail,
    };
    this.s.logger.info('ai engine connection tested', { ok: t.ok, imageOk });
    return t;
  }

  /** SAVE: test the key, store it encrypted, and switch real generation on. */
  async connect(key: string): Promise<EngineTest> {
    const t = await this.test(key);
    if (!t.ok) {
      this.saveTest(null);
      throw new AppError('CLOUD_AUTH_FAILED', `Not saved: ${t.detail}`);
    }
    this.s.secrets.set('runpodApiKey', key);
    this.saveTest(t);
    await this.turnOn();
    this.s.logger.info('ai engine connected', { provider: 'runpod' });
    return t;
  }

  /** Re-test the saved key and remember the result. */
  async retest(): Promise<EngineTest> {
    const t = await this.test();
    this.saveTest(t);
    return t;
  }

  /** Real generation on RunPod: execution mode CLOUD GPU and both in-app switches on. */
  async turnOn(): Promise<void> {
    this.assertNoGpuRunning('changing the AI engine');
    this.s.settings.set('cloud', {
      ...this.s.settings.get('cloud'),
      cloudEnabled: true,
      realGeneration: true,
    });
    this.s.settings.set('execution', { ...this.s.settings.get('execution'), mode: 'cloud_gpu' });
    await this.s.router.apply();
  }

  /** DELETE KEY: forget the saved key; generation stops until a key is connected again. */
  async disconnect(): Promise<void> {
    this.assertNoGpuRunning('removing the RunPod key');
    this.s.secrets.delete('runpodApiKey');
    this.saveTest(null);
    await this.s.router.apply();
    this.s.logger.info('ai engine disconnected', { provider: 'runpod' });
  }

  /** The saved keys cannot be unlocked (another Windows user, damaged file): start again. */
  forgetSavedKeys(): void {
    this.assertNoGpuRunning('removing saved keys');
    this.s.secrets.forgetAll();
    this.saveTest(null);
  }

  /**
   * Leave developer test mode: set MOCK_GENERATION=false and ENABLE_CLOUD_GPU=true in .env (a
   * copy of the old file is kept next to it) and apply it now, without a restart.
   */
  async switchToRealAi(): Promise<{ backup: string | null }> {
    this.assertNoGpuRunning('changing the AI engine');
    let backup: string | null = null;
    let text = '';
    if (existsSync(this.envFile)) {
      text = readFileSync(this.envFile, 'utf8');
      backup = `${this.envFile}.backup-${this.s.clock.now().toISOString().replace(/[:.]/g, '-')}`;
      copyFileSync(this.envFile, backup);
    }
    const setLine = (src: string, name: string, value: string): string => {
      const re = new RegExp(`^\\s*${name}\\s*=.*$`, 'm');
      return re.test(src)
        ? src.replace(re, `${name}=${value}`)
        : `${src.replace(/\n?$/, '\n')}${name}=${value}\n`;
    };
    text = setLine(setLine(text, 'MOCK_GENERATION', 'false'), 'ENABLE_CLOUD_GPU', 'true');
    writeFileSync(this.envFile, text);
    this.s.env.mockGeneration = false;
    this.s.env.enableCloudGpu = true;
    await this.turnOn();
    this.s.logger.info('switched to real AI', { backup: backup ?? 'none' });
    return { backup };
  }

  private assertNoGpuRunning(what: string): void {
    if (this.s.gpuRepo.active().some((i) => i.is_mock === 0))
      throw new AppError(
        'CONFLICT',
        `A cloud GPU is still running. Wait for the current video to finish (or stop it) before ${what}.`,
      );
  }
}
