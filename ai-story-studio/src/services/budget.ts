import type { Clock } from '../lib/clock.ts';
import { AppError } from '../lib/errors.ts';
import type { GpuRepository } from '../repositories/gpu.ts';
import type { BudgetSettings, SettingsService } from './settings.ts';

export type BudgetLevel = 'ok' | 'warn' | 'blocked';

export interface BudgetWindow {
  spentInr: number;
  limitInr: number;
  remainingInr: number;
  percent: number;
  level: BudgetLevel;
}

export interface BudgetStatus {
  simulated: boolean;
  daily: BudgetWindow;
  monthly: BudgetWindow;
  level: BudgetLevel;
  messages: string[];
}

/** Local-time day and month boundaries (the studio runs on the user's machine). */
export function periodBounds(now: Date): { dayStart: Date; dayEnd: Date; monthStart: Date; monthEnd: Date } {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { dayStart, dayEnd, monthStart, monthEnd };
}

export function evaluateWindow(spent: number, limit: number, settings: BudgetSettings): BudgetWindow {
  const percent = limit > 0 ? (spent / limit) * 100 : spent > 0 ? Infinity : 0;
  const level: BudgetLevel =
    limit <= 0 || percent >= settings.blockPercent
      ? 'blocked'
      : percent >= settings.warnPercent
        ? 'warn'
        : 'ok';
  return {
    spentInr: round2(spent),
    limitInr: limit,
    remainingInr: round2(Math.max(0, limit * (settings.blockPercent / 100) - spent)),
    percent: Number.isFinite(percent) ? Math.round(percent * 10) / 10 : 100,
    level,
  };
}

/**
 * GPU budget control (spec §45). 80 % → warning, 100 % → new cloud work is
 * blocked. Budgets are never raised automatically. Simulated (mock) spending
 * is tracked separately from real spending, so mock mode can exercise the
 * blocking logic without touching real numbers.
 */
export class BudgetService {
  private readonly gpu: GpuRepository;
  private readonly settings: SettingsService;
  private readonly clock: Clock;

  constructor(gpu: GpuRepository, settings: SettingsService, clock: Clock) {
    this.gpu = gpu;
    this.settings = settings;
    this.clock = clock;
  }

  status(simulated: boolean): BudgetStatus {
    const s = this.settings.get('budget');
    const now = this.clock.now();
    const b = periodBounds(now);
    const daily = evaluateWindow(
      this.gpu.spend(b.dayStart.toISOString(), b.dayEnd.toISOString(), simulated),
      s.dailyInr,
      s,
    );
    const monthly = evaluateWindow(
      this.gpu.spend(b.monthStart.toISOString(), b.monthEnd.toISOString(), simulated),
      s.monthlyInr,
      s,
    );
    const level: BudgetLevel =
      daily.level === 'blocked' || monthly.level === 'blocked'
        ? 'blocked'
        : daily.level === 'warn' || monthly.level === 'warn'
          ? 'warn'
          : 'ok';
    const messages: string[] = [];
    const label = simulated ? 'simulated ' : '';
    if (daily.level !== 'ok')
      messages.push(`Daily ${label}GPU spend ₹${daily.spentInr} is ${daily.percent}% of ₹${daily.limitInr}.`);
    if (monthly.level !== 'ok') {
      messages.push(
        `Monthly ${label}GPU spend ₹${monthly.spentInr} is ${monthly.percent}% of ₹${monthly.limitInr}.`,
      );
    }
    if (level === 'blocked')
      messages.push(
        'New cloud generations are blocked until the budget period resets or you raise the budget.',
      );
    return { simulated, daily, monthly, level, messages };
  }

  /**
   * Throw BUDGET_EXCEEDED if new cloud work must not start, including when the
   * worst-case cost of the planned session would push spending past the limit.
   */
  assertCanSpend(estimatedMaxCostInr: number, simulated: boolean): BudgetStatus {
    const st = this.status(simulated);
    if (st.level === 'blocked') throw new AppError('BUDGET_EXCEEDED', st.messages.join(' '));
    const tooMuch = [st.daily, st.monthly].find((w) => estimatedMaxCostInr > w.remainingInr);
    if (tooMuch) {
      throw new AppError(
        'BUDGET_EXCEEDED',
        `Estimated maximum cost ₹${round2(estimatedMaxCostInr)} exceeds the remaining budget ₹${tooMuch.remainingInr}.`,
      );
    }
    return st;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
