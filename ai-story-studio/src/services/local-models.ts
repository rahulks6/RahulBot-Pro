import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppEnv } from '../config/env.ts';
import { storagePaths } from '../config/env.ts';
import type { Database } from '../db/database.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import type { Logger } from '../lib/logger.ts';
import { appRoot } from '../lib/paths.ts';
import type { ModelManager, ModelState } from './model-manager.ts';
import { repoFolder, repoState, requiredFiles, type RepoSpec, type RepoState } from './model-store.ts';
import { findPython } from './python-runtime.ts';
import type { SecretStore } from './secrets.ts';
import { freeGb } from './system-health.ts';

/**
 * LOCAL GPU Model Manager: install state, VRAM fit, confirmed and resumable
 * downloads, explicit deletion. Nothing is downloaded without the user pressing
 * Install on a confirmation page that shows the size and destination; generation
 * itself never downloads. Downloads run `python -m ais_worker.download`
 * (huggingface_hub, which resumes interrupted files) as a child process.
 */
export type LocalModelStatus =
  | 'READY'
  | 'INSTALLED'
  | 'NOT INSTALLED'
  | 'DOWNLOADING'
  | 'BROKEN'
  | 'BUILT IN';
export type VramFit = 'fits' | 'offload' | 'too_big' | 'cpu' | 'no_gpu';

export interface DownloadRecord {
  id: string;
  model_id: string;
  repo: string;
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  bytes_expected: number;
  bytes_done: number;
  error_kind: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface LocalModelView extends ModelState {
  status: LocalModelStatus;
  repos: RepoState[];
  diskBytes: number;
  location: string;
  fit: VramFit;
  fitText: string;
  lastDownload: DownloadRecord | null;
}

const GB = 1024 ** 3;

export interface LocalModelDeps {
  db: Database;
  env: AppEnv;
  logger: Logger;
  catalog: ModelManager;
  secrets: SecretStore;
  /** Tests: replace the download process. */
  spawnFn?: typeof spawn;
  workerDir?: string;
  progressMs?: number;
  /** Called after a download finishes (e.g. restart the local worker so it sees the new model). */
  onInstalled?: (modelId: string) => void;
}

export class LocalModelService {
  private readonly d: LocalModelDeps;
  private readonly running = new Map<string, ChildProcess>();

  constructor(deps: LocalModelDeps) {
    this.d = deps;
    // Downloads interrupted by an app restart: kept on disk, resumed by the next Install.
    deps.db.run(
      `UPDATE model_downloads SET status = 'failed', error_kind = 'interrupted',
         error_message = 'Interrupted (the app was closed). Press Install to resume.', finished_at = ?
       WHERE status = 'running'`,
      new Date().toISOString(),
    );
  }

  get cacheDir(): string {
    return storagePaths(this.d.env).modelCache;
  }

  specs(m: ModelState): RepoSpec[] {
    if (!m.repo) return [];
    return [
      {
        repo: m.repo,
        revision: m.revision === 'n/a' ? 'main' : m.revision,
        ...m.download,
        required: requiredFiles(m.backend, m.params),
      },
      ...m.extraDownloads.map((x) => ({ ...x, revision: 'main' })),
    ];
  }

  lastDownload(modelId: string): DownloadRecord | null {
    return (
      this.d.db.get<DownloadRecord>(
        'SELECT * FROM model_downloads WHERE model_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
        modelId,
      ) ?? null
    );
  }

  /** How a model fits the GPU: usable VRAM from the hardware check (0 = no NVIDIA GPU). */
  static fit(m: ModelState, usableVramGb: number, hasGpu: boolean): { fit: VramFit; text: string } {
    if (m.minVramGb === 0) return { fit: 'cpu', text: 'runs on the CPU (no GPU needed)' };
    if (!hasGpu) return { fit: 'no_gpu', text: `needs an NVIDIA GPU (${m.minVramGb} GB+)` };
    if (usableVramGb >= m.minVramGb)
      return {
        fit: 'fits',
        text:
          usableVramGb >= m.recommendedVramGb
            ? `fits (${usableVramGb} GB usable, ${m.recommendedVramGb} GB recommended)`
            : `fits with memory savings (${usableVramGb} GB usable, ${m.recommendedVramGb} GB recommended)`,
      };
    if (m.offloadMinVramGb > 0 && usableVramGb >= m.offloadMinVramGb)
      return {
        fit: 'offload',
        text: `only with sequential CPU offload (slow): needs ${m.minVramGb} GB, ${usableVramGb} GB usable`,
      };
    return {
      fit: 'too_big',
      text: `too big for this GPU: needs ${m.minVramGb} GB, ${usableVramGb} GB usable`,
    };
  }

  views(hw: { usableVramGb: number; hasGpu: boolean }): LocalModelView[] {
    return this.d.catalog.states().map((m) => {
      const repos = this.specs(m).map((spec) => repoState(this.cacheDir, spec));
      const dl = this.lastDownload(m.id);
      const downloading = dl?.status === 'running' && this.running.has(m.id);
      const installed = repos.length > 0 && repos.every((r) => r.state === 'installed');
      const any = repos.some((r) => r.state !== 'not_installed');
      const status: LocalModelStatus = !m.repo
        ? 'BUILT IN'
        : downloading
          ? 'DOWNLOADING'
          : installed
            ? m.usable
              ? 'READY'
              : 'INSTALLED'
            : any
              ? 'BROKEN'
              : 'NOT INSTALLED';
      const { fit, text } = LocalModelService.fit(m, hw.usableVramGb, hw.hasGpu);
      return {
        ...m,
        status,
        repos,
        diskBytes: repos.reduce((a, r) => a + r.bytes, 0),
        location: repos[0]?.path ?? '— (no files)',
        fit,
        fitText: text,
        lastDownload: dl,
      };
    });
  }

  /** Installed (or built-in) model ids: only these are offered to the local worker. */
  installedIds(): Set<string> {
    return new Set(
      this.views({ usableVramGb: 0, hasGpu: false })
        .filter((v) => v.status === 'READY' || v.status === 'INSTALLED' || v.status === 'BUILT IN')
        .map((v) => v.id),
    );
  }

  /** What the confirmation page shows before anything is downloaded. */
  plan(modelId: string): {
    model: ModelState;
    repos: RepoSpec[];
    expectedBytes: number;
    alreadyBytes: number;
    freeGb: number | null;
    cacheDir: string;
    enoughSpace: boolean;
    gated: boolean;
  } {
    const model = this.model(modelId);
    const repos = this.specs(model);
    if (!repos.length) throw new AppError('PRECONDITION_FAILED', `${model.name} has no files to download.`);
    const expectedBytes = Math.round(model.storageGb * GB);
    const alreadyBytes = repos.reduce((a, r) => a + repoState(this.cacheDir, r).bytes, 0);
    const free = freeGb(this.cacheDir);
    const remainingGb = Math.max(0, expectedBytes - alreadyBytes) / GB;
    return {
      model,
      repos,
      expectedBytes,
      alreadyBytes,
      freeGb: free,
      cacheDir: this.cacheDir,
      enoughSpace: free === null || free >= remainingGb * 1.1 + 1,
      gated: /gated/i.test(model.licenseNotes),
    };
  }

  private model(modelId: string): ModelState {
    const m = this.d.catalog.states().find((x) => x.id === modelId);
    if (!m) throw new AppError('NOT_FOUND', `Unknown model ${modelId}`);
    return m;
  }

  /** Start (or resume) an install. Call only after the user confirmed the plan. */
  async install(modelId: string): Promise<DownloadRecord> {
    const p = this.plan(modelId);
    if (this.running.has(modelId)) throw new AppError('CONFLICT', `${p.model.name} is already downloading.`);
    if (p.model.commercialUse === 'non_commercial' || p.model.commercialUse === 'unknown')
      throw new AppError(
        'FORBIDDEN',
        `${p.model.name} cannot be installed: its licence does not allow our videos.`,
      );
    if (!p.enoughSpace)
      throw new AppError(
        'PRECONDITION_FAILED',
        `Not enough free space: ${p.model.name} needs about ${p.model.storageGb} GB and ${p.freeGb} GB is free in ${p.cacheDir}. Point MODEL_CACHE_PATH at a bigger drive (docs/MODEL_SETUP.md).`,
      );
    const workerDir = this.d.workerDir ?? join(appRoot(), 'worker');
    const python = await findPython(workerDir);
    if (!python)
      throw new AppError(
        'PRECONDITION_FAILED',
        'Python was not found. Run the setup program again (it installs the worker environment).',
      );
    const id = newId('mdl');
    this.d.db.insert('model_downloads', {
      id,
      model_id: modelId,
      repo: p.model.repo,
      status: 'running',
      bytes_expected: p.expectedBytes,
      bytes_done: p.alreadyBytes,
      started_at: new Date().toISOString(),
    });
    this.d.logger.info('model download started', {
      model: modelId,
      repo: p.model.repo,
      expectedGb: p.model.storageGb,
      cache: this.cacheDir,
    });
    void this.runRepos(id, modelId, p.repos, python.path, python.args, workerDir);
    return this.lastDownload(modelId)!;
  }

  private async runRepos(
    id: string,
    modelId: string,
    repos: RepoSpec[],
    py: string,
    pyArgs: string[],
    workerDir: string,
  ): Promise<void> {
    const timer = setInterval(() => {
      const done = repos.reduce((a, r) => a + repoState(this.cacheDir, r).bytes, 0);
      this.d.db.run('UPDATE model_downloads SET bytes_done = ? WHERE id = ?', done, id);
    }, this.d.progressMs ?? 2000);
    try {
      for (const spec of repos) {
        const result = await this.runOne(modelId, spec, py, pyArgs, workerDir);
        if (!result.ok) {
          this.finish(id, result.kind === 'cancelled' ? 'cancelled' : 'failed', result.kind, result.message);
          return;
        }
      }
      this.finish(id, 'complete', null, null);
      this.d.onInstalled?.(modelId);
    } finally {
      clearInterval(timer);
      this.running.delete(modelId);
    }
  }

  private runOne(
    modelId: string,
    spec: RepoSpec,
    py: string,
    pyArgs: string[],
    workerDir: string,
  ): Promise<{ ok: boolean; kind: string | null; message: string | null }> {
    const args = [
      ...pyArgs,
      '-m',
      'ais_worker.download',
      '--repo',
      spec.repo,
      '--cache',
      this.cacheDir,
      '--revision',
      spec.revision || 'main',
      ...(spec.allowPatterns ?? []).flatMap((a) => ['--allow', a]),
      ...(spec.ignorePatterns ?? []).flatMap((a) => ['--ignore', a]),
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HF_HUB_DISABLE_TELEMETRY: '1',
      PYTHONIOENCODING: 'utf-8',
    };
    delete env['RUNPOD_API_KEY'];
    const token = this.d.secrets.get('hfToken');
    if (token) env['HF_TOKEN'] = token;
    return new Promise((resolve) => {
      const child = (this.d.spawnFn ?? spawn)(py, args, {
        cwd: workerDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.running.set(modelId, child);
      let out = '';
      let err = '';
      child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
      child.stderr?.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-4000)));
      child.on('error', (e) =>
        resolve({ ok: false, kind: 'error', message: `Could not start Python: ${e.message}` }),
      );
      child.on('exit', (code, signal) => {
        if ((child as ChildProcess & { cancelled?: boolean }).cancelled || signal === 'SIGTERM')
          return resolve({ ok: false, kind: 'cancelled', message: 'Cancelled. Press Install to resume.' });
        const line = out.trim().split(/\r?\n/).pop() ?? '';
        try {
          const r = JSON.parse(line) as { ok: boolean; kind?: string; message?: string };
          resolve({ ok: r.ok, kind: r.kind ?? null, message: r.message ?? null });
        } catch {
          resolve({
            ok: code === 0,
            kind: code === 0 ? null : 'error',
            message:
              code === 0
                ? null
                : `Download failed (exit ${code}): ${err.split('\n').filter(Boolean).pop() ?? ''}`,
          });
        }
      });
    });
  }

  private finish(
    id: string,
    status: DownloadRecord['status'],
    kind: string | null,
    message: string | null,
  ): void {
    this.d.db.run(
      'UPDATE model_downloads SET status = ?, error_kind = ?, error_message = ?, finished_at = ? WHERE id = ?',
      status,
      kind,
      message,
      new Date().toISOString(),
      id,
    );
    const rec = this.d.db.get<DownloadRecord>('SELECT * FROM model_downloads WHERE id = ?', id)!;
    this.d.logger[status === 'complete' ? 'info' : 'warn']('model download finished', {
      model: rec.model_id,
      status,
      kind,
      error: message,
    });
  }

  cancel(modelId: string): void {
    const child = this.running.get(modelId);
    if (!child) throw new AppError('NOT_FOUND', 'No download is running for this model.');
    (child as ChildProcess & { cancelled?: boolean }).cancelled = true;
    child.kill('SIGTERM');
  }

  /** Delete a model's files (explicit, confirmed action). Refused while downloading or loaded. */
  remove(modelId: string, opts: { workerRunning: boolean }): number {
    const m = this.model(modelId);
    if (this.running.has(modelId)) throw new AppError('CONFLICT', 'Cancel the download first.');
    if (opts.workerRunning)
      throw new AppError('CONFLICT', 'Stop the local worker first (it may have the model loaded).');
    let freed = 0;
    // Only the model's own repository folders inside the model folder are ever removed.
    for (const spec of this.specs(m)) {
      const st = repoState(this.cacheDir, spec);
      const shared = this.d.catalog
        .states()
        .some(
          (o) =>
            o.id !== m.id &&
            this.specs(o).some((x) => x.repo === spec.repo) &&
            this.views({ usableVramGb: 0, hasGpu: false }).find((v) => v.id === o.id)?.status !==
              'NOT INSTALLED',
        );
      if (shared && spec.repo !== m.repo) continue; // e.g. IP-Adapter files used by another model
      freed += st.bytes;
      rmSync(repoFolder(this.cacheDir, spec.repo), { recursive: true, force: true });
    }
    this.d.logger.info('model files deleted', { model: modelId, freedBytes: freed });
    return freed;
  }
}
