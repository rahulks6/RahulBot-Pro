import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GpuOffer } from '../src/providers/types.ts';
import { rankOffers, speedTier } from '../src/services/gpu-selection.ts';

const offer = (
  gpuModel: string,
  vramGb: number,
  hourlyRateInr: number,
  stock = 'HIGH',
  available = true,
): GpuOffer => ({
  offerId: gpuModel,
  gpuModel,
  vramGb,
  hourlyRateInr,
  available,
  region: `RunPod secure · stock ${stock}`,
});

describe('GPU selection (compatibility first, not cost first)', () => {
  const offers = [
    offer('RTX A5000', 24, 24),
    offer('RTX 4090', 24, 61),
    offer('L40S', 48, 90),
    offer('A100 80GB', 80, 150),
    offer('RTX A2000', 6, 10),
    offer('H100 SXM', 80, 250),
    offer('L4', 24, 38, 'HIGH', false),
  ];
  const ctx = { needVramGb: 24, recommendedVramGb: 48, maxHourlyRateInr: 200, history: new Map() };

  it('keeps only compatible GPUs: enough VRAM, in stock, within the hourly cap', () => {
    const names = rankOffers(offers, ctx).map((o) => o.gpuModel);
    assert.ok(!names.includes('RTX A2000'), 'too little VRAM');
    assert.ok(!names.includes('L4'), 'out of stock');
    assert.ok(!names.includes('H100 SXM'), 'above the hourly price cap');
  });

  it('prefers the recommended VRAM, then speed; price only breaks ties', () => {
    const names = rankOffers(offers, ctx).map((o) => o.gpuModel);
    // L40S and A100 both meet 48 GB and are in the same speed class: the cheaper one first.
    assert.deepEqual(names, ['L40S', 'A100 80GB', 'RTX 4090', 'RTX A5000']);
    const cheapTie = rankOffers([offer('RTX A5000', 24, 30), offer('RTX A5000 B', 24, 20)], {
      ...ctx,
      recommendedVramGb: 24,
    });
    assert.equal(cheapTie[0]!.gpuModel, 'RTX A5000 B', 'same class: the cheaper one');
  });

  it('a GPU type that failed to start before is ranked below one that worked', () => {
    const history = new Map([
      ['A100 80GB', { ok: 0, failed: 3 }],
      ['L40S', { ok: 4, failed: 0 }],
    ]);
    const ranked = rankOffers(offers, { ...ctx, history });
    assert.equal(ranked[0]!.gpuModel, 'L40S');
    assert.match(ranked[0]!.reasons.join(' '), /4 good start/);
  });

  it('stock level beats raw speed among equally suitable GPUs', () => {
    const ranked = rankOffers([offer('RTX 4090', 24, 61, 'LOW'), offer('RTX A5000', 24, 24, 'HIGH')], {
      ...ctx,
      recommendedVramGb: 24,
    });
    assert.equal(ranked[0]!.gpuModel, 'RTX A5000');
  });

  it('speed classes', () => {
    assert.ok(speedTier('H100 SXM') > speedTier('A100 80GB'));
    assert.ok(speedTier('A100 80GB') > speedTier('RTX 4090'));
    assert.ok(speedTier('RTX 4090') > speedTier('RTX A5000'));
  });
});
