/**
 * Cloud GPU provider abstraction (Phase 5).
 *
 *   CloudGpuApi
 *     ├── RunPodApi          (implemented: RunPod REST API v2)
 *     ├── UnsupportedCloudApi('vast')        (placeholder, refuses every call)
 *     └── UnsupportedCloudApi('tensordock')  (placeholder, refuses every call)
 *
 * `CloudGpuProvider` (gpu-provider.ts) adapts any CloudGpuApi to the studio's
 * existing GPUProvider interface, so the GPU supervisor's price, budget,
 * lifetime, idle, watchdog and kill-switch safeguards apply unchanged.
 */
export type CloudProviderId = 'runpod' | 'vast' | 'tensordock';

export interface CloudGpuType {
  id: string;
  displayName: string;
  vramGb: number;
  /** On-demand price per GPU-hour in USD, or null when the provider did not report one. */
  hourlyUsd: number | null;
  /** true only when the provider reports stock for pods right now; false = none; null = not reported. */
  available: boolean | null;
  stock: string | null;
  /** Offered on the requested cloud at all (null = not reported). */
  offered?: boolean | null;
}

export type CloudVolume =
  | { kind: 'persistent'; sizeGb: number; path: string }
  | { kind: 'network'; volumeId: string; path: string };

export interface CloudPodSpec {
  name: string;
  image: string;
  gpuTypeId: string;
  gpuCount: number;
  cloud: 'SECURE' | 'COMMUNITY';
  env: Record<string, string>;
  ports: string[];
  containerDiskGb: number;
  volume?: CloudVolume;
  registryAuthId?: string;
  /** Lowest host CUDA version the worker image needs (major.minor). */
  minCudaVersion?: string;
}

export type CloudPodState = 'starting' | 'running' | 'stopped' | 'terminated' | 'unknown';

export interface CloudPod {
  id: string;
  name: string;
  state: CloudPodState;
  /** Raw provider status string, for display and diagnostics. */
  rawStatus: string;
  hourlyUsd: number | null;
  gpuName: string | null;
  createdAt: string | null;
}

export interface ContractReport {
  checked: boolean;
  ok: boolean;
  source: string;
  missingPaths: string[];
  missingCreateFields: string[];
  createFields: string[];
  notes: string[];
}

export interface CloudGpuApi {
  readonly id: CloudProviderId;
  readonly displayName: string;
  /** false for placeholders: every call throws NOT_SUPPORTED. */
  readonly supported: boolean;
  /** Authenticated no-op call. Throws CLOUD_AUTH_FAILED for a bad key. */
  testConnection(): Promise<{ ok: true; detail: string }>;
  listGpuTypes(cloud?: 'SECURE' | 'COMMUNITY', opts?: { minCudaVersion?: string }): Promise<CloudGpuType[]>;
  /** NOT retried after an ambiguous failure: a lost response must never duplicate a billed pod. */
  createPod(spec: CloudPodSpec): Promise<CloudPod>;
  /** null when the pod no longer exists. */
  getPod(id: string): Promise<CloudPod | null>;
  listPods(): Promise<CloudPod[]>;
  stopPod(id: string): Promise<void>;
  /** Idempotent: an already-deleted pod counts as terminated. */
  terminatePod(id: string): Promise<void>;
  /** HTTPS URL of a port exposed by the pod (e.g. through the provider's proxy). */
  workerUrl(podId: string, port: number): string;
  /** Compare the provider's published API description with what this adapter uses. */
  checkContract(): Promise<ContractReport>;
}
