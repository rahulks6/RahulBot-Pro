import type { Database } from '../db/database.ts';
import type { Approval, JobKind, JobStatus, QualityMode } from '../domain/enums.ts';
import { TERMINAL_JOB_STATUSES } from '../domain/enums.ts';
import type { GenerationAttempt, GenerationJob } from '../domain/types.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { parseJson } from '../lib/json.ts';
import { flag, nowIso, requireRow } from './base.ts';

export interface NewJob {
  projectId: string;
  storyId?: string | null;
  shotId?: string | null;
  kind: JobKind;
  targetType: string;
  targetId: string;
  mode?: QualityMode;
  params?: Record<string, unknown>;
  maxAttempts: number;
}

export interface JobLogEntry {
  at: string;
  status: JobStatus;
  message: string;
}

export type NewAttempt = Omit<GenerationAttempt, 'id' | 'created_at' | 'approval' | 'is_mock'> & {
  is_mock: boolean;
};

export class JobRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(j: NewJob): GenerationJob {
    const id = newId('job');
    const now = nowIso();
    this.db.insert('generation_jobs', {
      id,
      project_id: j.projectId,
      story_id: j.storyId ?? null,
      shot_id: j.shotId ?? null,
      kind: j.kind,
      target_type: j.targetType,
      target_id: j.targetId,
      status: 'waiting',
      mode: j.mode ?? 'optimized',
      params_json: JSON.stringify(j.params ?? {}),
      max_attempts: j.maxAttempts,
      log_json: JSON.stringify([{ at: now, status: 'waiting', message: 'queued' }]),
      created_at: now,
    });
    return this.get(id);
  }

  get(id: string): GenerationJob {
    return requireRow<GenerationJob>(this.db, 'generation_jobs', id, 'Job');
  }

  list(filter: { status?: string; projectId?: string; limit?: number } = {}): GenerationJob[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.status === 'active') where.push("status NOT IN ('complete', 'failed', 'cancelled')");
    else if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    params.push(Math.min(1000, filter.limit ?? 200));
    return this.db.all<GenerationJob>(
      `SELECT * FROM generation_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
      ...params,
    );
  }

  waiting(): GenerationJob[] {
    return this.db.all<GenerationJob>(
      "SELECT * FROM generation_jobs WHERE status = 'waiting' ORDER BY created_at",
    );
  }

  /** Existing non-terminal job for the same target and kind (prevents duplicate queueing). */
  findActive(kind: JobKind, targetId: string): GenerationJob | undefined {
    return this.db.get<GenerationJob>(
      "SELECT * FROM generation_jobs WHERE kind = ? AND target_id = ? AND status NOT IN ('complete', 'failed', 'cancelled')",
      kind,
      targetId,
    );
  }

  setStatus(id: string, status: JobStatus, message = '', extra: Partial<GenerationJob> = {}): void {
    const job = this.get(id);
    const log = parseJson<JobLogEntry[]>(job.log_json, []);
    const at = nowIso();
    log.push({ at, status, message });
    this.db.update('generation_jobs', id, {
      status,
      log_json: JSON.stringify(log.slice(-200)),
      started_at: job.started_at ?? (status !== 'waiting' ? at : null),
      finished_at: TERMINAL_JOB_STATUSES.has(status) ? at : null,
      // A new step starts without progress; a finished job is complete.
      ...(status !== job.status ? { progress: status === 'complete' ? 1 : 0, status_detail: '' } : {}),
      ...extra,
    });
  }

  /** Live progress of the running step (not logged: it changes every poll). */
  setProgress(id: string, progress: number, detail: string): void {
    this.db.run(
      'UPDATE generation_jobs SET progress = ?, status_detail = ? WHERE id = ?',
      Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)),
      detail.slice(0, 200),
      id,
    );
  }

  /** Remember the remote (worker) job so a restart re-polls it instead of generating again. */
  setRemote(id: string, remote: { remoteJobId: string; gpuInstanceId: string | null; at: string }): void {
    this.db.run(
      'UPDATE generation_jobs SET remote_job_id = ?, gpu_instance_id = ?, remote_submitted_at = ? WHERE id = ?',
      remote.remoteJobId,
      remote.gpuInstanceId,
      remote.at,
      id,
    );
  }

  clearRemote(id: string): void {
    this.db.run(
      'UPDATE generation_jobs SET remote_job_id = NULL, gpu_instance_id = NULL, remote_submitted_at = NULL WHERE id = ?',
      id,
    );
  }

  /**
   * After a crash or restart, jobs that were mid-flight go back to `waiting`.
   * Their remote job id is kept: if the same cloud worker is still running,
   * the next run re-polls that job and downloads its result instead of paying
   * for the same generation twice.
   */
  recoverInterrupted(): number {
    const stuck = this.db.all<GenerationJob>(
      "SELECT * FROM generation_jobs WHERE status NOT IN ('waiting', 'complete', 'failed', 'cancelled')",
    );
    for (const job of stuck)
      this.setStatus(
        job.id,
        'waiting',
        job.remote_job_id
          ? `recovered after restart (remote job ${job.remote_job_id} will be re-checked, not re-run)`
          : 'recovered after restart',
      );
    return stuck.length;
  }

  assignBatch(ids: string[], batchId: string): void {
    for (const id of ids) this.db.run('UPDATE generation_jobs SET batch_id = ? WHERE id = ?', batchId, id);
  }

  cancel(id: string): GenerationJob {
    const job = this.get(id);
    if (TERMINAL_JOB_STATUSES.has(job.status)) throw new AppError('CONFLICT', `Job already ${job.status}`);
    this.setStatus(id, 'cancelled', 'cancelled by user', {
      error_code: 'CANCELLED',
      error_message: 'Cancelled by user',
    });
    return this.get(id);
  }

  incrementAttempts(id: string): number {
    this.db.run('UPDATE generation_jobs SET attempt_count = attempt_count + 1 WHERE id = ?', id);
    return this.get(id).attempt_count;
  }

  log(job: GenerationJob): JobLogEntry[] {
    return parseJson<JobLogEntry[]>(job.log_json, []);
  }

  // --- Attempts: immutable generation history --------------------------------------

  createAttempt(a: NewAttempt): GenerationAttempt {
    const id = newId('att');
    this.db.insert('generation_attempts', {
      id,
      ...a,
      is_mock: flag(a.is_mock),
      approval: 'pending',
      created_at: nowIso(),
    });
    return this.getAttempt(id);
  }

  getAttempt(id: string): GenerationAttempt {
    return requireRow<GenerationAttempt>(this.db, 'generation_attempts', id, 'Attempt');
  }

  attemptsForShot(shotId: string, kind?: JobKind): GenerationAttempt[] {
    return kind
      ? this.db.all<GenerationAttempt>(
          'SELECT * FROM generation_attempts WHERE shot_id = ? AND kind = ? ORDER BY created_at DESC',
          shotId,
          kind,
        )
      : this.db.all<GenerationAttempt>(
          'SELECT * FROM generation_attempts WHERE shot_id = ? ORDER BY created_at DESC',
          shotId,
        );
  }

  attemptsForJob(jobId: string): GenerationAttempt[] {
    return this.db.all<GenerationAttempt>(
      'SELECT * FROM generation_attempts WHERE job_id = ? ORDER BY attempt_number',
      jobId,
    );
  }

  recentAttempts(limit = 20): GenerationAttempt[] {
    return this.db.all<GenerationAttempt>(
      'SELECT * FROM generation_attempts ORDER BY created_at DESC LIMIT ?',
      limit,
    );
  }

  /** Only the approval flag of an attempt may change; its recorded facts never do. */
  setAttemptApproval(id: string, approval: Approval): void {
    this.db.run('UPDATE generation_attempts SET approval = ? WHERE id = ?', approval, id);
  }
}
