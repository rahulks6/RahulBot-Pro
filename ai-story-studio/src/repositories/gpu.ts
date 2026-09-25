import type { Database } from '../db/database.ts';
import type { GpuStatus, UsageCategory } from '../domain/enums.ts';
import type { GpuEvent, GpuInstance, UsageRecord } from '../domain/types.ts';
import { newId } from '../lib/ids.ts';
import { flag, requireRow } from './base.ts';

export interface NewUsage {
  gpuInstanceId?: string | null;
  jobId?: string | null;
  attemptId?: string | null;
  projectId?: string | null;
  storyId?: string | null;
  shotId?: string | null;
  category: UsageCategory;
  seconds: number;
  hourlyRateInr: number;
  provider: string;
  gpuModel?: string;
  model?: string;
  isMock: boolean;
  recordedAt: string;
}

export function costFor(seconds: number, hourlyRateInr: number): number {
  return Math.round((seconds / 3600) * hourlyRateInr * 10_000) / 10_000;
}

export class GpuRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  createInstance(values: Omit<GpuInstance, 'id'>): GpuInstance {
    const id = newId('gpu');
    this.db.insert('gpu_instances', { id, ...values });
    return this.get(id);
  }

  get(id: string): GpuInstance {
    return requireRow<GpuInstance>(this.db, 'gpu_instances', id, 'GPU instance');
  }

  byProviderId(provider: string, providerInstanceId: string): GpuInstance | undefined {
    return this.db.get<GpuInstance>(
      'SELECT * FROM gpu_instances WHERE provider = ? AND provider_instance_id = ?',
      provider,
      providerInstanceId,
    );
  }

  active(): GpuInstance[] {
    return this.db.all<GpuInstance>(
      "SELECT * FROM gpu_instances WHERE status IN ('provisioning', 'running', 'terminating')",
    );
  }

  list(limit = 50): GpuInstance[] {
    return this.db.all<GpuInstance>('SELECT * FROM gpu_instances ORDER BY created_at DESC LIMIT ?', limit);
  }

  update(id: string, values: Partial<Omit<GpuInstance, 'id'>> & { status?: GpuStatus }): void {
    this.db.update('gpu_instances', id, values);
  }

  event(e: {
    gpuInstanceId?: string | null;
    provider: string;
    event: string;
    detail?: string;
    isMock: boolean;
    at: string;
  }): void {
    this.db.insert('gpu_events', {
      id: newId('gev'),
      gpu_instance_id: e.gpuInstanceId ?? null,
      provider: e.provider,
      event: e.event,
      detail: e.detail ?? '',
      is_mock: flag(e.isMock),
      created_at: e.at,
    });
  }

  events(limit = 100): GpuEvent[] {
    return this.db.all<GpuEvent>(
      'SELECT * FROM gpu_events ORDER BY created_at DESC, rowid DESC LIMIT ?',
      limit,
    );
  }

  recordUsage(u: NewUsage): UsageRecord {
    const id = newId('usg');
    this.db.insert('usage_records', {
      id,
      gpu_instance_id: u.gpuInstanceId ?? null,
      job_id: u.jobId ?? null,
      attempt_id: u.attemptId ?? null,
      project_id: u.projectId ?? null,
      story_id: u.storyId ?? null,
      shot_id: u.shotId ?? null,
      category: u.category,
      seconds: u.seconds,
      hourly_rate_inr: u.hourlyRateInr,
      cost_inr: costFor(u.seconds, u.hourlyRateInr),
      provider: u.provider,
      gpu_model: u.gpuModel ?? '',
      model: u.model ?? '',
      is_mock: flag(u.isMock),
      recorded_at: u.recordedAt,
    });
    return requireRow<UsageRecord>(this.db, 'usage_records', id);
  }

  /** Spend in [fromIso, toIso) for real or simulated records. */
  spend(fromIso: string, toIso: string, isMock: boolean): number {
    return (
      this.db.scalar<number>(
        'SELECT COALESCE(SUM(cost_inr), 0) FROM usage_records WHERE recorded_at >= ? AND recorded_at < ? AND is_mock = ?',
        fromIso,
        toIso,
        flag(isMock),
      ) ?? 0
    );
  }

  /** Total recorded cost of one GPU session (startup, model loading, generation, …). */
  sessionCost(gpuInstanceId: string): number {
    return (
      this.db.scalar<number>(
        'SELECT COALESCE(SUM(cost_inr), 0) FROM usage_records WHERE gpu_instance_id = ?',
        gpuInstanceId,
      ) ?? 0
    );
  }

  /** Seconds already recorded against a session (used to reconcile real wall-clock billing). */
  sessionSeconds(gpuInstanceId: string): number {
    return (
      this.db.scalar<number>(
        'SELECT COALESCE(SUM(seconds), 0) FROM usage_records WHERE gpu_instance_id = ?',
        gpuInstanceId,
      ) ?? 0
    );
  }

  usage(limit = 200): UsageRecord[] {
    return this.db.all<UsageRecord>('SELECT * FROM usage_records ORDER BY recorded_at DESC LIMIT ?', limit);
  }
}
