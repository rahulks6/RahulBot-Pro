import type { AppEnv } from '../config/env.ts';
import type { Database } from '../db/database.ts';
import type { Clock } from '../lib/clock.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { parseJson } from '../lib/json.ts';
import type { Logger } from '../lib/logger.ts';
import type { ModelResult } from '../providers/types.ts';
import { sniffMime } from '../providers/worker/validate.ts';
import type { GpuRepository } from '../repositories/gpu.ts';
import type { StorageProvider } from '../storage/storage.ts';
import type { CloudService } from './cloud.ts';
import type { GpuPlan, GpuSupervisor } from './gpu-supervisor.ts';
import type { ModelManager } from './model-manager.ts';

export interface TestStep {
  n: number;
  name: string;
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  detail: string;
  at: string | null;
}

export interface CloudTestRecord {
  id: string;
  provider: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  gpu_instance_id: string | null;
  gpu_model: string | null;
  hourly_rate_inr: number | null;
  test_kind: string;
  steps_json: string;
  output_key: string | null;
  runtime_sec: number | null;
  cost_inr: number | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

const STEP_NAMES = [
  'Validate API key',
  'Find a compatible GPU',
  'Show GPU and current price',
  'Confirm provisioning',
  'Provision GPU',
  'Start worker',
  'Health check',
  'Generate one small test asset',
  'Download it',
  'Validate it',
  'Terminate GPU',
  'Report',
];

export interface PreparedTest {
  id: string;
  plan: GpuPlan;
  kind: 'tts' | 'image';
  model: string;
}

/**
 * Guided first real GPU test (Settings → Cloud GPU → Start Test GPU).
 * Steps 1–3 are free (API calls only); nothing is rented until the user
 * confirms step 4. The GPU is terminated in `finally`, whatever happens.
 */
export class CloudGpuTest {
  private readonly d: {
    db: Database;
    env: AppEnv;
    gpu: GpuSupervisor;
    gpuRepo: GpuRepository;
    cloud: CloudService;
    models: ModelManager;
    storage: StorageProvider;
    clock: Clock;
    logger: Logger;
  };
  private readonly prepared = new Map<string, PreparedTest>();
  private readonly aborts = new Map<string, AbortController>();
  /** The running test promise (tests await it). */
  running: Promise<CloudTestRecord> | null = null;

  constructor(deps: CloudGpuTest['d']) {
    this.d = deps;
  }

  get(id: string): CloudTestRecord {
    const r = this.d.db.get<CloudTestRecord>('SELECT * FROM cloud_tests WHERE id = ?', id);
    if (!r) throw new AppError('NOT_FOUND', 'Cloud test not found');
    return r;
  }

  list(limit = 10): CloudTestRecord[] {
    return this.d.db.all<CloudTestRecord>(
      'SELECT * FROM cloud_tests ORDER BY started_at DESC LIMIT ?',
      limit,
    );
  }

  steps(rec: CloudTestRecord): TestStep[] {
    return parseJson<TestStep[]>(rec.steps_json, []);
  }

  private setStep(id: string, n: number, status: TestStep['status'], detail: string): void {
    const rec = this.get(id);
    const steps = this.steps(rec);
    const step = steps.find((s) => s.n === n);
    if (step) Object.assign(step, { status, detail, at: this.d.clock.now().toISOString() });
    this.d.db.update('cloud_tests', id, { steps_json: JSON.stringify(steps) });
    this.d.logger.info('cloud test step', { test: id, step: n, status, detail });
  }

  private finish(
    id: string,
    status: CloudTestRecord['status'],
    extra: Partial<CloudTestRecord>,
  ): CloudTestRecord {
    this.d.db.update('cloud_tests', id, { status, finished_at: this.d.clock.now().toISOString(), ...extra });
    return this.get(id);
  }

  /** Steps 1–3: validate the key, find a compatible GPU, show GPU and price. Rents nothing. */
  async prepare(kind: 'tts' | 'image'): Promise<{ record: CloudTestRecord; prepared: PreparedTest | null }> {
    const id = newId('ctest');
    const steps: TestStep[] = STEP_NAMES.map((name, i) => ({
      n: i + 1,
      name,
      status: 'pending',
      detail: '',
      at: null,
    }));
    this.d.db.insert('cloud_tests', {
      id,
      provider: this.d.cloud.provider.id,
      status: 'running',
      test_kind: kind,
      steps_json: JSON.stringify(steps),
      started_at: this.d.clock.now().toISOString(),
    });
    try {
      this.d.cloud.assertCanProvision();
      if (this.d.gpu.currentProvider !== this.d.cloud.provider) this.d.cloud.refresh();
      const conn = await this.d.cloud.testConnection();
      if (!conn.ok) throw new AppError('CLOUD_AUTH_FAILED', conn.detail);
      this.setStep(id, 1, 'ok', conn.detail);
      const model = this.d.models.selected(kind);
      if (!model)
        throw new AppError(
          'PRECONDITION_FAILED',
          `No ${kind === 'tts' ? 'text-to-speech' : 'image'} model is enabled for the cloud.`,
        );
      const image = await this.d.cloud.assertImagePullable();
      const plan = await this.d.gpu.plan(model.minVramGb, kind === 'tts' ? 600 : 900);
      this.setStep(
        id,
        2,
        'ok',
        `${plan.offer.gpuModel} (${plan.offer.vramGb} GB VRAM) · worker image ${image.registry}/${image.repository}:${image.reference} is public`,
      );
      this.setStep(
        id,
        3,
        'ok',
        `₹${plan.offer.hourlyRateInr}/h · estimated test cost ₹${plan.estimatedCostInr.toFixed(2)} (worst case ₹${plan.estimatedMaxCostInr.toFixed(2)}, capped by the session budget and max lifetime)`,
      );
      this.setStep(id, 4, 'running', 'waiting for your confirmation — nothing has been rented yet');
      const prepared: PreparedTest = { id, plan, kind, model: model.id };
      this.prepared.set(id, prepared);
      this.d.db.update('cloud_tests', id, {
        gpu_model: plan.offer.gpuModel,
        hourly_rate_inr: plan.offer.hourlyRateInr,
      });
      return { record: this.get(id), prepared };
    } catch (err) {
      const e = toAppError(err);
      const rec = this.get(id);
      const current = this.steps(rec).find((s) => s.status === 'pending' || s.status === 'running');
      if (current) this.setStep(id, current.n, 'failed', e.message);
      return { record: this.finish(id, 'failed', { error_message: e.message }), prepared: null };
    }
  }

  cancel(id: string): void {
    this.prepared.delete(id);
    this.aborts.get(id)?.abort();
    const rec = this.get(id);
    if (rec.status === 'running' && !this.aborts.has(id))
      this.finish(id, 'cancelled', { error_message: 'cancelled before anything was rented' });
  }

  /** Step 4 confirmed: run steps 5–12 in the background. */
  confirm(id: string): Promise<CloudTestRecord> {
    const prepared = this.prepared.get(id);
    if (!prepared)
      throw new AppError(
        'PRECONDITION_FAILED',
        'This test was not prepared (or already ran). Start a new test.',
      );
    if (this.running) throw new AppError('CONFLICT', 'A GPU test is already running.');
    this.prepared.delete(id);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    this.setStep(id, 4, 'ok', 'confirmed by you');
    this.running = this.execute(prepared, abort.signal).finally(() => {
      this.running = null;
      this.aborts.delete(id);
    });
    return this.running;
  }

  private async execute(p: PreparedTest, signal: AbortSignal): Promise<CloudTestRecord> {
    const { id } = p;
    let instanceId: string | null = null;
    let status: CloudTestRecord['status'] = 'failed';
    let error: string | null = null;
    let outputKey: string | null = null;
    try {
      this.setStep(id, 5, 'running', `renting ${p.plan.offer.gpuModel}`);
      this.setStep(id, 6, 'running', 'booting the GPU and starting the AI worker');
      const session = await this.d.gpu.start(p.plan, { purpose: 'test', signal });
      instanceId = session.id;
      this.d.db.update('cloud_tests', id, { gpu_instance_id: instanceId });
      const inst = this.d.gpuRepo.get(instanceId);
      this.setStep(id, 5, 'ok', `pod ${inst.provider_instance_id}`);
      this.setStep(id, 6, 'ok', `worker at ${inst.worker_url ?? '?'}`);
      const client = this.d.cloud.bridge.client;
      if (!client) throw new AppError('WORKER_UNAVAILABLE', 'The worker was not bound after start-up.');
      const system = await client.system();
      const gpuName = system.gpu.gpus[0]?.name ?? 'no GPU reported';
      if (!system.gpu.available)
        throw new AppError(
          'CUDA_FAILURE',
          `The worker sees no CUDA GPU (${system.gpu.reason ?? 'unknown reason'}).`,
        );
      const g = system.gpu.gpus[0];
      this.setStep(
        id,
        7,
        'ok',
        `healthy · ${gpuName}${g ? `, ${Math.round(g.vram_total_mb / 1024)} GB VRAM` : ''}${system.gpu.cuda_version ? ` · CUDA ${system.gpu.cuda_version}` : ''} · worker ${system.worker_version}`,
      );
      this.setStep(
        id,
        8,
        'running',
        `${p.kind === 'tts' ? 'speaking one sentence' : 'drawing one 512×512 image'} with ${p.model} (first run downloads the model)`,
      );
      session.setState('GENERATING', 'test asset');
      const ctx = {
        attemptKey: `test:${id}`,
        signal,
        remote: { onDownloading: () => this.setStep(id, 9, 'running', 'downloading') },
      };
      const providers = this.d.cloud.bridge.providers();
      const result: ModelResult =
        p.kind === 'tts'
          ? await providers.tts.synthesize(
              {
                text: 'Hello from AI Story Studio. This is a short cloud GPU test.',
                language: 'en',
                emotion: 'neutral',
                speed: 1,
                voice: {
                  voiceModel: p.model,
                  voiceIdentity: '',
                  presentation: 'female',
                  pitch: 0,
                  speed: 1,
                  speakingStyle: '',
                },
              },
              ctx,
            )
          : await providers.image.generate(
              {
                mode: 'text_to_image',
                prompt:
                  'a friendly cartoon fox waving hello, simple pastel background, children’s book style',
                negativePrompt: '',
                seed: 7,
                width: 512,
                height: 512,
                quality: 'fast_preview',
                references: [],
                settings: {},
              },
              ctx,
            );
      this.setStep(
        id,
        8,
        'ok',
        `${result.model} ${result.modelVersion} in ${result.generationSeconds.toFixed(1)} s`,
      );
      this.setStep(id, 9, 'ok', `${result.file.data.byteLength} bytes (checksum verified)`);
      const kind = sniffMime(result.file.data);
      if (kind !== result.file.mime)
        throw new AppError('DOWNLOAD_FAILED', `The test asset is not a valid ${result.file.mime}.`);
      outputKey = `cloud-tests/${id}/test-output.${result.file.ext}`;
      await this.d.storage.put(outputKey, result.file.data);
      this.setStep(id, 10, 'ok', `${result.file.mime} · saved to ${this.d.storage.localPath(outputKey)}`);
      status = 'success';
    } catch (err) {
      const e = toAppError(err);
      error = e.message;
      status = e.code === 'CANCELLED' ? 'cancelled' : 'failed';
      const rec = this.get(id);
      const current = this.steps(rec).find((s) => s.status === 'running' || s.status === 'pending');
      if (current && current.n < 11) this.setStep(id, current.n, 'failed', e.message);
    } finally {
      if (instanceId) {
        this.setStep(id, 11, 'running', 'terminating');
        const ok = await this.d.gpu.terminate(
          instanceId,
          status === 'success' ? 'test_complete' : 'test_cleanup',
        );
        this.setStep(
          id,
          11,
          ok ? 'ok' : 'failed',
          ok
            ? 'GPU terminated — billing stopped'
            : 'termination failed: the watchdog keeps retrying; use EMERGENCY STOP GPU',
        );
        if (!ok) status = 'failed';
      } else {
        this.setStep(id, 11, 'skipped', 'no GPU was running');
      }
    }
    const inst = instanceId ? this.d.gpuRepo.get(instanceId) : null;
    const runtime = inst
      ? Math.round(
          (new Date(inst.terminated_at ?? this.d.clock.now().toISOString()).getTime() -
            new Date(inst.created_at).getTime()) /
            1000,
        )
      : 0;
    const cost = inst ? Math.round(this.d.gpu.sessionSpendInr(inst) * 100) / 100 : 0;
    this.setStep(
      id,
      12,
      status === 'success' ? 'ok' : 'failed',
      `${status.toUpperCase()} · ${inst?.gpu_model ?? 'no GPU'} · runtime ${runtime} s · estimated cost ₹${cost.toFixed(2)}${outputKey ? ` · output ${this.d.storage.localPath(outputKey)}` : ''}`,
    );
    this.d.logger.info('cloud test finished', { test: id, status, runtime, cost });
    return this.finish(id, status, {
      output_key: outputKey,
      runtime_sec: runtime,
      cost_inr: cost,
      error_message: error,
    });
  }
}
