import { newId } from '../../lib/ids.ts';
import type { GPUProvider, GpuOffer, ProviderInstance } from '../types.ts';
import { ProviderError } from '../types.ts';

export interface MockGpuOptions {
  offers?: GpuOffer[];
  startupSeconds?: number;
  /** Next N provision calls fail (to test failure cleanup). */
  failNextProvisions?: number;
  /** Next N terminate calls fail (to test retrying termination / watchdog). */
  failNextTerminations?: number;
}

/** Simulated price list. Values are illustrative only; real prices come from the provider API. */
export const MOCK_GPU_OFFERS: GpuOffer[] = [
  {
    offerId: 'mock-l4',
    gpuModel: 'NVIDIA L4 (simulated)',
    vramGb: 24,
    hourlyRateInr: 38,
    available: true,
    region: 'mock',
  },
  {
    offerId: 'mock-4090',
    gpuModel: 'RTX 4090 (simulated)',
    vramGb: 24,
    hourlyRateInr: 46,
    available: true,
    region: 'mock',
  },
  {
    offerId: 'mock-a6000',
    gpuModel: 'RTX A6000 (simulated)',
    vramGb: 48,
    hourlyRateInr: 72,
    available: true,
    region: 'mock',
  },
  {
    offerId: 'mock-a100',
    gpuModel: 'A100 80GB (simulated)',
    vramGb: 80,
    hourlyRateInr: 165,
    available: true,
    region: 'mock',
  },
];

/**
 * MockGPUProvider — in-memory stand-in for a cloud GPU account. Nothing is
 * provisioned and nothing is billed. Supports failure injection and "foreign"
 * instances so the watchdog and kill switch can be tested.
 */
export class MockGPUProvider implements GPUProvider {
  readonly id = 'mock';
  readonly isMock: boolean = true;
  /** Simulates a paid cloud provider, but never bills anything. */
  readonly paid: boolean = false;
  readonly local: boolean = false;
  private readonly instances = new Map<string, ProviderInstance>();
  private readonly opts: MockGpuOptions;
  failNextProvisions: number;
  failNextTerminations: number;

  constructor(opts: MockGpuOptions = {}) {
    this.opts = opts;
    this.failNextProvisions = opts.failNextProvisions ?? 0;
    this.failNextTerminations = opts.failNextTerminations ?? 0;
  }

  async listOffers(minVramGb: number): Promise<GpuOffer[]> {
    return (this.opts.offers ?? MOCK_GPU_OFFERS).filter((o) => o.vramGb >= minVramGb);
  }

  async provision(
    offer: GpuOffer,
    tags: string[],
  ): Promise<{ providerInstanceId: string; startupSeconds: number }> {
    if (this.failNextProvisions > 0) {
      this.failNextProvisions--;
      throw new ProviderError('PROVISION_FAILED', 'Simulated provisioning failure');
    }
    if (!offer.available) throw new ProviderError('GPU_UNAVAILABLE', `${offer.gpuModel} unavailable`);
    const providerInstanceId = newId('mockvm');
    this.instances.set(providerInstanceId, {
      providerInstanceId,
      tags: [...tags],
      status: 'running',
      gpuModel: offer.gpuModel,
      hourlyRateInr: offer.hourlyRateInr,
      createdAt: new Date().toISOString(),
    });
    return { providerInstanceId, startupSeconds: this.opts.startupSeconds ?? 75 };
  }

  async terminate(providerInstanceId: string): Promise<void> {
    if (this.failNextTerminations > 0) {
      this.failNextTerminations--;
      throw new ProviderError('NETWORK_FAILURE', 'Simulated termination failure');
    }
    const inst = this.instances.get(providerInstanceId);
    if (inst) inst.status = 'terminated';
  }

  async listInstances(): Promise<ProviderInstance[]> {
    return [...this.instances.values()].map((i) => ({ ...i, tags: [...i.tags] }));
  }

  /** Test helper: create an instance the studio does not know about (orphan or foreign). */
  injectInstance(tags: string[], gpuModel = 'RTX 4090 (simulated)'): string {
    const providerInstanceId = newId('mockvm');
    this.instances.set(providerInstanceId, {
      providerInstanceId,
      tags,
      status: 'running',
      gpuModel,
      hourlyRateInr: 46,
      createdAt: new Date().toISOString(),
    });
    return providerInstanceId;
  }

  activeCount(tag?: string): number {
    return [...this.instances.values()].filter(
      (i) => i.status !== 'terminated' && (tag === undefined || i.tags.includes(tag)),
    ).length;
  }
}
