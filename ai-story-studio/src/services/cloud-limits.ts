import type { AppEnv } from '../config/env.ts';
import type { SettingsService } from './settings.ts';

export interface EffectiveLimits {
  maxHourlyRateInr: number;
  idleMinutes: number;
  maxLifetimeMinutes: number;
  /** null for simulated / local GPUs (no real spend). */
  sessionBudgetInr: number | null;
  maxConcurrent: number;
  /** Which values were lowered by a .env hard cap (shown in the UI). */
  cappedBy: string[];
}

/**
 * Cost limits in force right now: the lower of the Settings value and the
 * .env hard cap (MAX_GPU_HOURLY_RATE, SESSION_BUDGET, IDLE_SHUTDOWN_MINUTES,
 * MAX_GPU_LIFETIME_MINUTES, MAX_CONCURRENT_GPU_INSTANCES). Settings can lower
 * a cap but can never raise it.
 */
export function effectiveLimits(settings: SettingsService, env: AppEnv, paid: boolean): EffectiveLimits {
  const gpu = settings.get('gpu');
  const cloud = settings.get('cloud');
  const cappedBy: string[] = [];
  const low = (value: number, cap: number | undefined, name: string): number => {
    if (cap !== undefined && cap < value) {
      cappedBy.push(name);
      return cap;
    }
    return value;
  };
  return {
    maxHourlyRateInr: low(gpu.maxHourlyRateInr, env.caps.maxGpuHourlyRateInr, 'MAX_GPU_HOURLY_RATE'),
    idleMinutes: low(gpu.idleTimeoutMinutes, env.caps.idleShutdownMinutes, 'IDLE_SHUTDOWN_MINUTES'),
    maxLifetimeMinutes: low(
      gpu.maxLifetimeMinutes,
      env.caps.maxGpuLifetimeMinutes,
      'MAX_GPU_LIFETIME_MINUTES',
    ),
    sessionBudgetInr: paid ? low(cloud.sessionBudgetInr, env.caps.sessionBudgetInr, 'SESSION_BUDGET') : null,
    maxConcurrent: paid
      ? low(cloud.maxConcurrentInstances, env.caps.maxConcurrentGpuInstances, 'MAX_CONCURRENT_GPU_INSTANCES')
      : Number.POSITIVE_INFINITY,
    cappedBy,
  };
}
