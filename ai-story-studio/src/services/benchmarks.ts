import { createHash } from 'node:crypto';
import type { Studio } from '../app/studio.ts';
import type { Database } from '../db/database.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { parseJson } from '../lib/json.ts';
import type { WorkerOutput } from '../providers/worker/client.ts';
import { nowIso } from '../repositories/base.ts';

/**
 * Model benchmarks (spec §82). The worker runs the suite and measures speed,
 * VRAM, reliability and technical checks; this service imports the results,
 * stores the outputs locally (verified), collects HUMAN ratings for quality
 * and consistency, and records which model a human selects per kind. It
 * never picks a model automatically.
 */
export const MODEL_KINDS = ['image', 'video', 'tts', 'music', 'sfx', 'lipsync', 'upscale'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export interface BenchmarkRun {
  id: string;
  worker_job_id: string;
  worker_url: string;
  suite: string;
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  include_mock: number;
  hourly_rate_inr: number;
  models_json: string;
  gpu_json: string;
  summary_json: string;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface BenchmarkResult {
  id: string;
  run_id: string;
  model_id: string;
  kind: string;
  case_key: string;
  seed: number | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  load_seconds: number | null;
  run_seconds: number | null;
  peak_vram_mb: number | null;
  storage_key: string | null;
  mime: string | null;
  sha256: string | null;
  checks_json: string;
  created_at: string;
}

export interface RunModel {
  id: string;
  kind: ModelKind;
  display_name: string;
  version: string;
  license: string;
  commercial_use: string;
  license_url: string;
  mock: boolean;
  min_vram_gb: number;
}

export interface ModelAggregate {
  model: RunModel;
  runs: number;
  succeeded: number;
  successRate: number;
  loadSeconds: number | null;
  meanRunSeconds: number | null;
  p95RunSeconds: number | null;
  peakVramMb: number | null;
  reproducible: boolean | null;
  estCostPerOutputInr: number | null;
  ratedOutputs: number;
  avgQuality: number | null;
  avgConsistency: number | null;
  errors: string[];
}

export interface ModelSelection {
  id: string;
  kind: ModelKind;
  model_id: string;
  benchmark_run_id: string | null;
  license: string;
  commercial_use: string;
  license_acknowledged: number;
  rationale: string;
  active: number;
  decided_at: string;
}

interface WorkerSummary {
  runs: number;
  succeeded: number;
  success_rate: number;
  load_seconds: number | null;
  mean_run_seconds: number | null;
  p95_run_seconds: number | null;
  peak_vram_mb: number | null;
  reproducible_same_seed: boolean | null;
  errors: string[];
}

interface WorkerReport {
  suite: string;
  gpu: unknown;
  models: RunModel[];
  summary: Record<string, WorkerSummary>;
  results: Array<{
    model: string;
    kind: string;
    case: string;
    seed: number | null;
    status: string;
    error_code: string | null;
    error_message: string | null;
    load_seconds: number | null;
    run_seconds: number | null;
    peak_vram_mb: number | null;
    output: string | null;
    sha256: string | null;
    checks: Record<string, unknown>;
  }>;
}

/** Active human-selected model per kind (used when connecting to the worker). */
export function activeSelections(db: Database): Map<string, string> {
  return new Map(
    db
      .all<{ kind: string; model_id: string }>('SELECT kind, model_id FROM model_selections WHERE active = 1')
      .map((r) => [r.kind, r.model_id]),
  );
}

export class BenchmarkService {
  private readonly s: Studio;

  constructor(studio: Studio) {
    this.s = studio;
  }

  private worker() {
    if (!this.s.worker)
      throw new AppError(
        'WORKER_UNAVAILABLE',
        'Connect the local AI worker first (Settings → Local AI worker).',
      );
    return this.s.worker;
  }

  runs(): BenchmarkRun[] {
    return this.s.db.all<BenchmarkRun>('SELECT * FROM benchmark_runs ORDER BY started_at DESC');
  }

  get(id: string): BenchmarkRun {
    const run = this.s.db.get<BenchmarkRun>('SELECT * FROM benchmark_runs WHERE id = ?', id);
    if (!run) throw new AppError('NOT_FOUND', `Benchmark not found: ${id}`);
    return run;
  }

  results(
    runId: string,
  ): Array<BenchmarkResult & { quality: number | null; consistency: number | null; notes: string | null }> {
    return this.s.db.all(
      `SELECT r.*, b.quality, b.consistency, b.notes FROM benchmark_results r LEFT JOIN benchmark_ratings b ON b.result_id = r.id
       WHERE r.run_id = ? ORDER BY r.kind, r.case_key, r.seed, r.model_id`,
      runId,
    );
  }

  /**
   * Start a benchmark on the connected worker. Real (non-mock) models are
   * only benchmarked with MOCK_GENERATION=false — the same gate as production.
   */
  async start(opts: {
    models: string[];
    includeMock: boolean;
    hourlyRateInr: number;
    sourceImage?: Buffer;
    suite?: unknown;
  }): Promise<BenchmarkRun> {
    const w = this.worker();
    const known = new Map(w.models.map((m) => [m.id, m]));
    const unknown = opts.models.filter((id) => !known.has(id));
    if (unknown.length) throw new AppError('VALIDATION_FAILED', `Not on the worker: ${unknown.join(', ')}`);
    const chosen = opts.models.length
      ? opts.models.map((id) => known.get(id)!)
      : w.models.filter((m) => opts.includeMock || !m.mock);
    if (chosen.some((m) => !m.mock) && this.s.env.mockGeneration) {
      throw new AppError(
        'MOCK_MODE_REQUIRED',
        'Benchmarking real models needs MOCK_GENERATION=false (local worker only; cloud GPUs stay disabled).',
      );
    }
    if (!Number.isFinite(opts.hourlyRateInr) || opts.hourlyRateInr < 0 || opts.hourlyRateInr > 100_000) {
      throw new AppError('VALIDATION_FAILED', 'Hourly rate must be between 0 and 100000');
    }
    const body: Record<string, unknown> = { models: opts.models, include_mock: opts.includeMock };
    if (opts.sourceImage) body['source_image'] = opts.sourceImage.toString('base64');
    if (opts.suite) body['suite'] = opts.suite;
    const job = await w.client.submitBenchmark(body);
    const id = newId('bench');
    this.s.db.insert('benchmark_runs', {
      id,
      worker_job_id: job.id,
      worker_url: w.url,
      suite: String((job as unknown as { request?: { suite?: string } }).request?.suite ?? 'default'),
      status: 'running',
      include_mock: opts.includeMock ? 1 : 0,
      hourly_rate_inr: opts.hourlyRateInr,
      started_at: nowIso(),
    });
    this.s.logger.info('benchmark started', { benchmark: id, workerJob: job.id, models: opts.models });
    return this.get(id);
  }

  /** Poll the worker; when finished, import results and store every output locally (SHA-256 verified). */
  async refresh(runId: string): Promise<BenchmarkRun> {
    const run = this.get(runId);
    if (run.status !== 'running') return run;
    const w = this.worker();
    const job = await w.client.getJob(run.worker_job_id);
    if (job.status === 'failed' || job.status === 'cancelled') {
      this.s.db.update('benchmark_runs', runId, {
        status: job.status,
        error_message: job.error?.message ?? job.status,
        finished_at: nowIso(),
      });
      return this.get(runId);
    }
    if (job.status !== 'complete') return run;
    const reportMeta = job.outputs.find((o) => o.name === 'results.json');
    if (!reportMeta) throw new AppError('DOWNLOAD_FAILED', 'Benchmark finished without results.json');
    const report = JSON.parse((await w.client.download(job.id, reportMeta)).toString('utf8')) as WorkerReport;
    const files = new Map(job.outputs.map((o) => [o.name, o] as [string, WorkerOutput]));
    const stored = new Map<string, string>();
    for (const r of report.results) {
      if (!r.output) continue;
      const meta = files.get(r.output);
      if (!meta) continue;
      const data = await w.client.download(job.id, meta);
      if (r.sha256 && createHash('sha256').update(data).digest('hex') !== r.sha256)
        throw new AppError('DOWNLOAD_FAILED', `Checksum mismatch for ${r.output}`);
      const key = `benchmarks/${runId}/${r.output}`;
      await this.s.storage.put(key, data);
      stored.set(r.output, key);
    }
    this.s.db.transaction(() => {
      for (const r of report.results) {
        this.s.db.insert('benchmark_results', {
          id: newId('bres'),
          run_id: runId,
          model_id: r.model,
          kind: r.kind,
          case_key: r.case,
          seed: r.seed,
          status: r.status,
          error_code: r.error_code,
          error_message: r.error_message,
          load_seconds: r.load_seconds,
          run_seconds: r.run_seconds,
          peak_vram_mb: r.peak_vram_mb,
          storage_key: r.output ? (stored.get(r.output) ?? null) : null,
          mime: r.output ? (files.get(r.output)?.mime ?? null) : null,
          sha256: r.sha256,
          checks_json: JSON.stringify(r.checks ?? {}),
          created_at: nowIso(),
        });
      }
      this.s.db.update('benchmark_runs', runId, {
        status: 'complete',
        suite: report.suite,
        models_json: JSON.stringify(report.models),
        gpu_json: JSON.stringify(report.gpu ?? {}),
        summary_json: JSON.stringify(report.summary ?? {}),
        finished_at: nowIso(),
      });
    });
    this.s.logger.info('benchmark imported', { benchmark: runId, results: report.results.length });
    return this.get(runId);
  }

  async cancel(runId: string): Promise<void> {
    const run = this.get(runId);
    if (run.status === 'running') await this.worker().client.cancel(run.worker_job_id);
  }

  rate(resultId: string, input: { quality: number; consistency?: number | null; notes?: string }): void {
    const ok = (n: number | null | undefined) =>
      n === null || n === undefined || (Number.isInteger(n) && n >= 1 && n <= 5);
    if (!Number.isInteger(input.quality) || !ok(input.quality) || !ok(input.consistency)) {
      throw new AppError('VALIDATION_FAILED', 'Ratings must be whole numbers from 1 to 5');
    }
    const exists = this.s.db.get<{ status: string }>(
      'SELECT status FROM benchmark_results WHERE id = ?',
      resultId,
    );
    if (!exists) throw new AppError('NOT_FOUND', 'Benchmark result not found');
    if (exists.status !== 'complete')
      throw new AppError('PRECONDITION_FAILED', 'Only successful outputs can be rated');
    this.s.db.run(
      `INSERT INTO benchmark_ratings (result_id, quality, consistency, notes, rated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(result_id) DO UPDATE SET quality = excluded.quality, consistency = excluded.consistency, notes = excluded.notes, rated_at = excluded.rated_at`,
      resultId,
      input.quality,
      input.consistency ?? null,
      (input.notes ?? '').slice(0, 2000),
      nowIso(),
    );
  }

  models(run: BenchmarkRun): RunModel[] {
    return parseJson<RunModel[]>(run.models_json, []);
  }

  aggregate(runId: string): ModelAggregate[] {
    const run = this.get(runId);
    const summary = parseJson<Record<string, WorkerSummary>>(run.summary_json, {});
    const results = this.results(runId);
    return this.models(run).map((model) => {
      const s = summary[model.id];
      const rated = results.filter((r) => r.model_id === model.id && r.quality !== null);
      const cons = rated.filter((r) => r.consistency !== null);
      const avg = (xs: number[]) =>
        xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
      const mean = s?.mean_run_seconds ?? null;
      return {
        model,
        runs: s?.runs ?? 0,
        succeeded: s?.succeeded ?? 0,
        successRate: s?.success_rate ?? 0,
        loadSeconds: s?.load_seconds ?? null,
        meanRunSeconds: mean,
        p95RunSeconds: s?.p95_run_seconds ?? null,
        peakVramMb: s?.peak_vram_mb ?? null,
        reproducible: s?.reproducible_same_seed ?? null,
        // Rough cost of one output on a GPU rented at the entered rate (excludes start-up and model loading).
        estCostPerOutputInr:
          mean === null ? null : Math.round((mean / 3600) * run.hourly_rate_inr * 10_000) / 10_000,
        ratedOutputs: rated.length,
        avgQuality: avg(rated.map((r) => r.quality!)),
        avgConsistency: avg(cons.map((r) => r.consistency!)),
        errors: s?.errors ?? [],
      };
    });
  }

  selections(): ModelSelection[] {
    return this.s.db.all<ModelSelection>('SELECT * FROM model_selections ORDER BY decided_at DESC');
  }

  /**
   * Record a human decision: the model to use for one kind. Non-commercial
   * or unknown licences can never be selected for production; conditional
   * licences need an explicit acknowledgement. Mock models may only be
   * "selected" while MOCK_GENERATION=true (pipeline testing).
   */
  select(input: {
    runId: string;
    modelId: string;
    rationale: string;
    licenseAcknowledged: boolean;
  }): ModelSelection {
    const run = this.get(input.runId);
    if (run.status !== 'complete')
      throw new AppError('PRECONDITION_FAILED', 'Select from a completed benchmark');
    const model = this.models(run).find((m) => m.id === input.modelId);
    if (!model) throw new AppError('VALIDATION_FAILED', 'That model was not part of this benchmark');
    if (!input.rationale.trim())
      throw new AppError('VALIDATION_FAILED', 'Write down why this model was chosen');
    if (model.commercial_use === 'non_commercial' || model.commercial_use === 'unknown') {
      throw new AppError(
        'FORBIDDEN',
        `${model.id} cannot be selected for production: its licence (${model.license}) does not allow commercial use.`,
      );
    }
    if (model.commercial_use === 'conditional' && !input.licenseAcknowledged) {
      throw new AppError(
        'PRECONDITION_FAILED',
        `${model.id} has a conditional licence (${model.license}); confirm you have read and accept its terms.`,
      );
    }
    if (model.mock && !this.s.env.mockGeneration)
      throw new AppError('VALIDATION_FAILED', 'Mock models cannot be selected when MOCK_GENERATION=false');
    const id = newId('msel');
    this.s.db.transaction(() => {
      this.s.db.run('UPDATE model_selections SET active = 0 WHERE kind = ? AND active = 1', model.kind);
      this.s.db.insert('model_selections', {
        id,
        kind: model.kind,
        model_id: model.id,
        benchmark_run_id: run.id,
        license: model.license,
        commercial_use: model.commercial_use,
        license_acknowledged: input.licenseAcknowledged ? 1 : 0,
        rationale: input.rationale.trim().slice(0, 2000),
        active: 1,
        decided_at: nowIso(),
      });
    });
    this.s.logger.info('model selected', { kind: model.kind, model: model.id, benchmark: run.id });
    return this.s.db.get<ModelSelection>('SELECT * FROM model_selections WHERE id = ?', id)!;
  }
}
