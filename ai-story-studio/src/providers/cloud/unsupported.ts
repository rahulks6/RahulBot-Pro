import { AppError } from '../../lib/errors.ts';
import type { CloudGpuApi, CloudGpuType, CloudPod, CloudProviderId, ContractReport } from './types.ts';

const NAMES: Record<CloudProviderId, string> = {
  runpod: 'RunPod',
  vast: 'Vast.ai',
  tensordock: 'TensorDock',
};

/**
 * Explicit placeholder for providers that are planned but NOT implemented
 * (Vast.ai, TensorDock). Every call refuses with NOT_SUPPORTED, so selecting
 * one can never provision anything or pretend to work.
 */
export class UnsupportedCloudApi implements CloudGpuApi {
  readonly id: CloudProviderId;
  readonly displayName: string;
  readonly supported = false;

  constructor(id: CloudProviderId) {
    this.id = id;
    this.displayName = NAMES[id];
  }

  private error(): AppError {
    return new AppError(
      'NOT_SUPPORTED',
      `${this.displayName} is not supported yet. Only RunPod is implemented.`,
    );
  }

  testConnection(): Promise<{ ok: true; detail: string }> {
    return Promise.reject(this.error());
  }
  listGpuTypes(): Promise<CloudGpuType[]> {
    return Promise.reject(this.error());
  }
  createPod(): Promise<CloudPod> {
    return Promise.reject(this.error());
  }
  getPod(): Promise<CloudPod | null> {
    return Promise.reject(this.error());
  }
  listPods(): Promise<CloudPod[]> {
    return Promise.reject(this.error());
  }
  stopPod(): Promise<void> {
    return Promise.reject(this.error());
  }
  terminatePod(): Promise<void> {
    return Promise.reject(this.error());
  }
  workerUrl(): string {
    throw this.error();
  }
  checkContract(): Promise<ContractReport> {
    return Promise.reject(this.error());
  }
}
