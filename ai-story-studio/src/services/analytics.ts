import type { StudioCore } from '../app/studio.ts';

export interface CostBreakdown {
  simulated: boolean;
  totalInr: number;
  gpuHours: number;
  byCategory: Array<{ category: string; seconds: number; costInr: number }>;
  byModel: Array<{ model: string; seconds: number; costInr: number }>;
  byGpu: Array<{ gpu: string; seconds: number; costInr: number }>;
  byProvider: Array<{ provider: string; costInr: number }>;
}

export interface ProductionStats {
  videosProduced: number;
  finishedMinutes: number;
  shotsGenerated: number;
  approvedShots: number;
  attempts: number;
  approvalRate: number;
  attemptsPerApprovedShot: number;
  costPerApprovedShotInr: number;
  costPerEpisodeInr: number;
  costPerFinishedMinuteInr: number;
  assetReuseRate: number;
  audioReuse: { generated: number; reusedJobs: number };
  similarityWarnings: number;
  qualityStatus: Record<string, number>;
}

/**
 * Cost tracking and production analytics (spec §46, §71). All numbers come
 * from recorded usage/attempt rows. In mock mode they are SIMULATED and are
 * labelled as such everywhere they are shown.
 */
export class AnalyticsService {
  private readonly s: StudioCore;

  constructor(core: StudioCore) {
    this.s = core;
  }

  costs(simulated: boolean, projectId?: string): CostBreakdown {
    const where = `is_mock = ?${projectId ? ' AND project_id = ?' : ''}`;
    const params: Array<string | number> = [simulated ? 1 : 0, ...(projectId ? [projectId] : [])];
    const group = (col: string) =>
      this.s.db.all<{ k: string; seconds: number; cost: number }>(
        `SELECT ${col} AS k, SUM(seconds) AS seconds, SUM(cost_inr) AS cost FROM usage_records WHERE ${where} GROUP BY ${col} ORDER BY cost DESC`,
        ...params,
      );
    const total = this.s.db.get<{ seconds: number; cost: number }>(
      `SELECT COALESCE(SUM(seconds), 0) AS seconds, COALESCE(SUM(cost_inr), 0) AS cost FROM usage_records WHERE ${where}`,
      ...params,
    ) ?? { seconds: 0, cost: 0 };
    return {
      simulated,
      totalInr: r2(total.cost),
      gpuHours: Math.round((total.seconds / 3600) * 1000) / 1000,
      byCategory: group('category').map((r) => ({
        category: r.k,
        seconds: r1(r.seconds),
        costInr: r2(r.cost),
      })),
      byModel: group('model').map((r) => ({
        model: r.k || '(session overhead)',
        seconds: r1(r.seconds),
        costInr: r2(r.cost),
      })),
      byGpu: group('gpu_model').map((r) => ({ gpu: r.k, seconds: r1(r.seconds), costInr: r2(r.cost) })),
      byProvider: group('provider').map((r) => ({ provider: r.k, costInr: r2(r.cost) })),
    };
  }

  /** Cost of one story: attempts for its shots + session overhead attributed by story. */
  storyCost(
    storyId: string,
    simulated: boolean,
  ): {
    totalInr: number;
    approvedClipsInr: number;
    perScene: Array<{ sceneId: string; title: string; costInr: number }>;
  } {
    const flag = simulated ? 1 : 0;
    const total =
      this.s.db.scalar<number>(
        `SELECT COALESCE(SUM(u.cost_inr), 0) FROM usage_records u WHERE u.is_mock = ? AND (u.story_id = ? OR u.shot_id IN (SELECT s.id FROM shots s JOIN scenes sc ON sc.id = s.scene_id WHERE sc.story_id = ?))`,
        flag,
        storyId,
        storyId,
      ) ?? 0;
    const approved =
      this.s.db.scalar<number>(
        `SELECT COALESCE(SUM(a.estimated_cost_inr), 0) FROM generation_attempts a JOIN shots s ON s.id = a.shot_id JOIN scenes sc ON sc.id = s.scene_id
         WHERE sc.story_id = ? AND a.is_mock = ? AND a.approval = 'approved'`,
        storyId,
        flag,
      ) ?? 0;
    const perScene = this.s.db.all<{ sceneId: string; title: string; costInr: number }>(
      `SELECT sc.id AS sceneId, sc.title AS title, COALESCE(SUM(u.cost_inr), 0) AS costInr
       FROM scenes sc LEFT JOIN shots s ON s.scene_id = sc.id LEFT JOIN usage_records u ON u.shot_id = s.id AND u.is_mock = ?
       WHERE sc.story_id = ? GROUP BY sc.id ORDER BY sc.position`,
      flag,
      storyId,
    );
    return {
      totalInr: r2(total),
      approvedClipsInr: r2(approved),
      perScene: perScene.map((p) => ({ ...p, costInr: r2(p.costInr) })),
    };
  }

  production(simulated: boolean): ProductionStats {
    const flag = simulated ? 1 : 0;
    const one = (sql: string, ...p: Array<string | number>) => this.s.db.scalar<number>(sql, ...p) ?? 0;
    const videos = one(
      "SELECT COUNT(DISTINCT story_id) FROM exports WHERE status = 'complete' AND is_mock = ?",
      flag,
    );
    const minutes = one(
      "SELECT COALESCE(SUM(duration_sec), 0) / 60.0 FROM exports WHERE status = 'complete' AND is_mock = ?",
      flag,
    );
    const shotsGenerated = one(
      "SELECT COUNT(DISTINCT shot_id) FROM generation_attempts WHERE kind = 'video' AND status = 'succeeded' AND is_mock = ?",
      flag,
    );
    const approvedShots = one("SELECT COUNT(*) FROM shots WHERE approval_state = 'approved'");
    const attempts = one(
      "SELECT COUNT(*) FROM generation_attempts WHERE kind IN ('image', 'video') AND is_mock = ?",
      flag,
    );
    const approvedAttempts = one(
      "SELECT COUNT(*) FROM generation_attempts WHERE kind IN ('image', 'video') AND approval = 'approved' AND is_mock = ?",
      flag,
    );
    const reviewed = one(
      "SELECT COUNT(*) FROM generation_attempts WHERE kind IN ('image', 'video') AND approval != 'pending' AND is_mock = ?",
      flag,
    );
    const total = one('SELECT COALESCE(SUM(cost_inr), 0) FROM usage_records WHERE is_mock = ?', flag);
    const approvedAssets = one(
      "SELECT COUNT(*) FROM generated_assets WHERE approval = 'approved' AND kind IN ('video', 'upscaled_video', 'image')",
    );
    const reusedAssets = one(
      "SELECT COUNT(*) FROM (SELECT asset_id FROM asset_usages GROUP BY asset_id HAVING COUNT(DISTINCT COALESCE(story_id, '')) > 1)",
    );
    const reusedJobs = one(
      "SELECT COUNT(*) FROM generation_jobs WHERE kind IN ('tts','music','sfx','ambience') AND status = 'complete' AND log_json LIKE '%reused cached audio%'",
    );
    const generatedAudio = one('SELECT COUNT(*) FROM audio_assets');
    const simWarnings = this.s.db
      .all<{ findings_json: string }>('SELECT findings_json FROM similarity_reports')
      .reduce(
        (n, r) =>
          n +
          (JSON.parse(r.findings_json) as Array<{ severity: string }>).filter((f) => f.severity === 'warn')
            .length,
        0,
      );
    const qs = this.s.db.all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM quality_reports q WHERE kind = 'youtube' AND rowid = (SELECT MAX(rowid) FROM quality_reports q2 WHERE q2.story_id = q.story_id AND q2.kind = 'youtube') GROUP BY status`,
    );
    return {
      videosProduced: videos,
      finishedMinutes: Math.round(minutes * 100) / 100,
      shotsGenerated,
      approvedShots,
      attempts,
      approvalRate: reviewed ? Math.round((approvedAttempts / reviewed) * 1000) / 10 : 0,
      attemptsPerApprovedShot: approvedShots ? Math.round((attempts / approvedShots) * 100) / 100 : 0,
      costPerApprovedShotInr: approvedShots ? r2(total / approvedShots) : 0,
      costPerEpisodeInr: videos ? r2(total / videos) : 0,
      costPerFinishedMinuteInr: minutes > 0 ? r2(total / minutes) : 0,
      assetReuseRate: approvedAssets ? Math.round((reusedAssets / approvedAssets) * 1000) / 10 : 0,
      audioReuse: { generated: generatedAudio, reusedJobs },
      similarityWarnings: simWarnings,
      qualityStatus: Object.fromEntries(qs.map((q) => [q.status, q.n])),
    };
  }
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
