import type { Database } from '../db/database.ts';
import { parseJson } from '../lib/json.ts';
import { boolean, enumOf, number, object, parseOrThrow, type Infer } from '../lib/schema.ts';

/**
 * Persistent settings (spec §41–§45, §54, §69). Budgets are only ever changed
 * by the user through this service; nothing increases them automatically.
 */
export const budgetSchema = object({
  dailyInr: number({ min: 0, max: 1_000_000 }),
  monthlyInr: number({ min: 0, max: 10_000_000 }),
  warnPercent: number({ min: 1, max: 100 }),
  blockPercent: number({ min: 1, max: 100 }),
});
export type BudgetSettings = Infer<typeof budgetSchema>;

export const gpuSchema = object({
  preferredProvider: enumOf(['mock', 'local', 'runpod', 'tensordock', 'vast'] as const),
  maxHourlyRateInr: number({ min: 0, max: 100_000 }),
  minVramGb: number({ min: 0, max: 1024, int: true }),
  idleTimeoutMinutes: number({ min: 1, max: 240 }),
  maxLifetimeMinutes: number({ min: 5, max: 24 * 60 }),
  watchdogIntervalSeconds: number({ min: 10, max: 3600, int: true }),
  orphanPolicy: enumOf(['terminate', 'warn'] as const),
});
export type GpuSettings = Infer<typeof gpuSchema>;

export const generationSchema = object({
  maxAttempts: number({ min: 1, max: 5, int: true }),
  upscaleOptimizedOutput: boolean(),
  suggestReuseBeforeGeneration: boolean(),
});
export type GenerationSettings = Infer<typeof generationSchema>;

export const audioMixSchema = object({
  duckingEnabled: boolean(),
  duckDb: number({ min: -40, max: 0 }),
  duckAttackSec: number({ min: 0, max: 5 }),
  duckReleaseSec: number({ min: 0, max: 5 }),
  dialogueDb: number({ min: -30, max: 6 }),
  narrationDb: number({ min: -30, max: 6 }),
  musicDb: number({ min: -40, max: 6 }),
  sfxDb: number({ min: -40, max: 6 }),
  ambienceDb: number({ min: -40, max: 6 }),
  peakCeilingDb: number({ min: -12, max: 0 }),
});
export type AudioMixSettings = Infer<typeof audioMixSchema>;

/** Quality-check thresholds are configuration, not permanent truths (spec §54). */
export const qualitySchema = object({
  similarityWarnPercent: number({ min: 1, max: 100 }),
  similarityHighPercent: number({ min: 1, max: 100 }),
  maxClipReusePercent: number({ min: 0, max: 100 }),
  minClipSeconds: number({ min: 0, max: 10 }),
  maxLayerLevelDifferenceDb: number({ min: 1, max: 40 }),
  musicOverSpeechMarginDb: number({ min: 0, max: 30 }),
  durationTolerancePercent: number({ min: 1, max: 100 }),
});
export type QualitySettings = Infer<typeof qualitySchema>;

export interface AllSettings {
  budget: BudgetSettings;
  gpu: GpuSettings;
  generation: GenerationSettings;
  audioMix: AudioMixSettings;
  quality: QualitySettings;
}

export const DEFAULT_SETTINGS: AllSettings = {
  budget: { dailyInr: 200, monthlyInr: 1500, warnPercent: 80, blockPercent: 100 },
  gpu: {
    preferredProvider: 'mock',
    maxHourlyRateInr: 80,
    minVramGb: 24,
    idleTimeoutMinutes: 10,
    maxLifetimeMinutes: 60,
    watchdogIntervalSeconds: 60,
    orphanPolicy: 'terminate',
  },
  generation: { maxAttempts: 2, upscaleOptimizedOutput: true, suggestReuseBeforeGeneration: true },
  audioMix: {
    duckingEnabled: true,
    duckDb: -12,
    duckAttackSec: 0.15,
    duckReleaseSec: 0.5,
    dialogueDb: 0,
    narrationDb: -1,
    musicDb: -8,
    sfxDb: -6,
    ambienceDb: -14,
    peakCeilingDb: -1,
  },
  quality: {
    similarityWarnPercent: 60,
    similarityHighPercent: 80,
    maxClipReusePercent: 30,
    minClipSeconds: 0.75,
    maxLayerLevelDifferenceDb: 10,
    musicOverSpeechMarginDb: 3,
    durationTolerancePercent: 35,
  },
};

const SCHEMAS = {
  budget: budgetSchema,
  gpu: gpuSchema,
  generation: generationSchema,
  audioMix: audioMixSchema,
  quality: qualitySchema,
} as const;

export type SettingsKey = keyof AllSettings;

export class SettingsService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  get<K extends SettingsKey>(key: K): AllSettings[K] {
    const row = this.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key);
    const stored = parseJson<Partial<AllSettings[K]>>(row?.value_json, {});
    return { ...DEFAULT_SETTINGS[key], ...stored };
  }

  all(): AllSettings {
    return {
      budget: this.get('budget'),
      gpu: this.get('gpu'),
      generation: this.get('generation'),
      audioMix: this.get('audioMix'),
      quality: this.get('quality'),
    };
  }

  /** Validate and store a full settings section (input usually comes from a form). */
  set<K extends SettingsKey>(key: K, input: unknown): AllSettings[K] {
    const value = parseOrThrow(SCHEMAS[key] as never, input, `${key} settings`) as AllSettings[K];
    this.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      new Date().toISOString(),
    );
    return value;
  }
}
