import type { GpuOffer } from '../providers/types.ts';

/**
 * Which cloud GPU to rent for a batch. Not cheapest-first: the order is
 *
 *   1. compatibility  — enough VRAM for the models, in stock, within the hourly price cap
 *   2. VRAM           — meets the models' RECOMMENDED VRAM (no CPU offload, no quality reduction)
 *   3. success        — how often this GPU type started and worked for this installation
 *   4. reliability    — the provider's stock level (High > Medium > Low)
 *   5. speed          — GPU class
 *   6. price          — only as the final tie-breaker
 *
 * The first choice's alternatives are the next compatible offers, used when RunPod has no
 * capacity for the first one or its worker does not start (see GpuSupervisor.start).
 */
export interface SelectionContext {
  needVramGb: number;
  recommendedVramGb: number;
  maxHourlyRateInr: number;
  /** gpu model → sessions that became ready / failed to start. */
  history: Map<string, { ok: number; failed: number }>;
}

export interface RankedOffer extends GpuOffer {
  reasons: string[];
}

const STOCK_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** Rough speed class for diffusion work (higher is faster). Unknown GPUs sit in the middle. */
export function speedTier(gpuModel: string): number {
  const m = gpuModel.toUpperCase();
  if (/B200|H200|H100/.test(m)) return 6;
  if (/A100|L40S|RTX PRO 6000|6000 ADA|5090/.test(m)) return 5;
  if (/4090|L40\b|L40$|A6000|RTX 6000/.test(m)) return 4;
  if (/3090|4080|A5000|A40\b|A40$|L4\b|L4$|5080/.test(m)) return 3;
  if (/A4500|A4000|4070|3080|T4|2080/.test(m)) return 2;
  return 3;
}

function stockOf(o: GpuOffer): number {
  const m = /stock (\w+)/i.exec(o.region);
  return m ? (STOCK_RANK[m[1]!.toLowerCase()] ?? 0) : 0;
}

/** Laplace-smoothed start-up success rate, in steps of 10% so small differences do not dominate. */
function successOf(o: GpuOffer, history: SelectionContext['history']): number {
  const h = history.get(o.gpuModel) ?? { ok: 0, failed: 0 };
  return Math.round(((h.ok + 1) / (h.ok + h.failed + 2)) * 10) / 10;
}

export function rankOffers(offers: GpuOffer[], ctx: SelectionContext): RankedOffer[] {
  const compatible = offers.filter(
    (o) => o.available && o.vramGb >= ctx.needVramGb && o.hourlyRateInr <= ctx.maxHourlyRateInr,
  );
  const key = (o: GpuOffer): number[] => [
    o.vramGb >= ctx.recommendedVramGb ? 1 : 0,
    successOf(o, ctx.history),
    stockOf(o),
    speedTier(o.gpuModel),
    -o.hourlyRateInr,
  ];
  return compatible
    .map((o) => ({ o, k: key(o) }))
    .sort((a, b) => {
      for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return b.k[i]! - a.k[i]!;
      return a.o.gpuModel.localeCompare(b.o.gpuModel);
    })
    .map(({ o }) => {
      const h = ctx.history.get(o.gpuModel);
      const reasons = [
        `${o.vramGb} GB VRAM${o.vramGb >= ctx.recommendedVramGb ? ' (meets the recommended amount)' : ` (minimum ${ctx.needVramGb} GB met; below the recommended ${ctx.recommendedVramGb} GB)`}`,
        h ? `${h.ok} good start(s), ${h.failed} failed start(s) before` : 'not used before',
        stockOf(o) ? `stock ${['', 'low', 'medium', 'high'][stockOf(o)]}` : 'stock not reported',
      ];
      return { ...o, reasons };
    });
}
