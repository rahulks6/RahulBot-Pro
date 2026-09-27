/** Injectable clock so GPU-safety timers and budgets are testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceSeconds(seconds: number): void {
    this.current += seconds * 1000;
  }

  set(date: Date | string): void {
    this.current = new Date(date).getTime();
  }
}

export function iso(date: Date): string {
  return date.toISOString();
}
