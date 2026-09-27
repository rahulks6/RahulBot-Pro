import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * NVIDIA GPU / CUDA detection for this computer (LOCAL GPU mode).
 *
 * Uses `nvidia-smi` (installed with every NVIDIA driver, on Windows and Linux).
 * Nothing here needs CUDA, PyTorch or the worker, and nothing throws: a missing
 * GPU or driver is a normal, reported state. PyTorch's view (can it actually use
 * CUDA?) comes from the worker or a Python probe and is merged in by `classify`.
 */
export interface GpuDevice {
  index: number;
  name: string;
  uuid: string | null;
  driverVersion: string | null;
  vramTotalMb: number;
  vramUsedMb: number;
  vramFreeMb: number;
  utilizationPct: number | null;
  temperatureC: number | null;
  computeCapability: string | null;
}

export interface NvidiaReport {
  found: boolean;
  smiPath: string | null;
  driverVersion: string | null;
  /** Highest CUDA version the installed DRIVER supports ("CUDA Version" in nvidia-smi). */
  cudaDriverVersion: string | null;
  gpus: GpuDevice[];
  /** Why no GPU was found, or what failed. */
  error: string | null;
  checkedAt: string;
}

/** PyTorch's view, from the worker's /system report or a Python probe. */
export interface TorchReport {
  installed: boolean;
  version: string | null;
  cudaAvailable: boolean;
  /** CUDA runtime PyTorch was BUILT for (e.g. "12.6"); null for CPU-only builds. */
  cudaRuntime: string | null;
  device: string | null;
  error?: string | null;
}

export type VramProfile = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

export type GpuState =
  | 'GPU_READY'
  | 'GPU_LIMITED'
  | 'GPU_BUSY'
  | 'GPU_OUT_OF_MEMORY'
  | 'CUDA_MISMATCH'
  | 'NO_NVIDIA_GPU'
  | 'CPU_FALLBACK'
  | 'CLOUD_GPU_AVAILABLE';

export const GPU_STATE_LABEL: Record<GpuState, string> = {
  GPU_READY: 'GPU READY',
  GPU_LIMITED: 'GPU LIMITED',
  GPU_BUSY: 'GPU BUSY',
  GPU_OUT_OF_MEMORY: 'GPU OUT OF MEMORY',
  CUDA_MISMATCH: 'CUDA MISMATCH',
  NO_NVIDIA_GPU: 'NO NVIDIA GPU',
  CPU_FALLBACK: 'CPU FALLBACK',
  CLOUD_GPU_AVAILABLE: 'CLOUD GPU AVAILABLE',
};

export const PROFILE_LABEL: Record<VramProfile, string> = {
  NONE: 'No NVIDIA GPU',
  LOW: 'LOW VRAM (under 8 GB)',
  MEDIUM: 'MEDIUM VRAM (8–15 GB)',
  HIGH: 'HIGH VRAM (16–23 GB)',
  VERY_HIGH: 'VERY HIGH VRAM (24 GB or more)',
};

export interface HardwareStatus {
  nvidia: NvidiaReport;
  torch: TorchReport | null;
  /** The GPU generation would use (the one with the most VRAM). */
  device: GpuDevice | null;
  profile: VramProfile;
  /** VRAM the studio may use: total × the "Max VRAM usage" setting. */
  usableVramGb: number;
  freeVramGb: number;
  primary: GpuState;
  states: GpuState[];
  /** Plain-language reasons and fixes, one per line. */
  notes: string[];
}

export interface ClassifyOptions {
  /** Settings → Max VRAM usage (percent of total). */
  maxVramPercent?: number;
  /** Largest VRAM requirement of the selected local models (GB); 0 = unknown. */
  requiredVramGb?: number;
  /** A local job failed with out-of-memory recently. */
  recentOom?: boolean;
  /** The local worker is running (it can at least run CPU models such as Kokoro TTS). */
  localWorkerRunning?: boolean;
  /** All cloud gates pass (a paid cloud GPU could be started with explicit confirmation). */
  cloudAvailable?: boolean;
}

const QUERY_FIELDS = [
  'index',
  'name',
  'uuid',
  'driver_version',
  'memory.total',
  'memory.used',
  'memory.free',
  'utilization.gpu',
  'temperature.gpu',
  'compute_cap',
];

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const t = v.trim();
  if (!t || /^\[?(n\/a|not supported|unknown error|insufficient permissions)\]?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const str = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  return !t || /^\[.*\]$/.test(t) || /^n\/a$/i.test(t) ? null : t;
};

/** Parse `nvidia-smi --query-gpu=<fields> --format=csv,noheader,nounits`. Unsupported values become null. */
export function parseSmiCsv(stdout: string, fields: string[] = QUERY_FIELDS): GpuDevice[] {
  const gpus: GpuDevice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split(',').map((c) => c.trim());
    const get = (f: string): string | undefined => {
      const i = fields.indexOf(f);
      return i >= 0 ? cols[i] : undefined;
    };
    const total = num(get('memory.total'));
    const name = str(get('name'));
    if (!name || total === null) continue;
    const used = num(get('memory.used')) ?? 0;
    gpus.push({
      index: num(get('index')) ?? gpus.length,
      name,
      uuid: str(get('uuid')),
      driverVersion: str(get('driver_version')),
      vramTotalMb: total,
      vramUsedMb: used,
      vramFreeMb: num(get('memory.free')) ?? Math.max(0, total - used),
      utilizationPct: num(get('utilization.gpu')),
      temperatureC: num(get('temperature.gpu')),
      computeCapability: str(get('compute_cap')),
    });
  }
  return gpus;
}

/** "CUDA Version: 12.6" from the plain `nvidia-smi` banner (the driver's maximum CUDA version). */
export function parseCudaVersion(stdout: string): string | null {
  return /CUDA Version\s*:\s*(\d+\.\d+)/.exec(stdout)?.[1] ?? null;
}

/** Compare "12.6" style versions: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function vramProfile(totalGb: number): VramProfile {
  if (totalGb <= 0) return 'NONE';
  if (totalGb < 8) return 'LOW';
  if (totalGb < 16) return 'MEDIUM';
  if (totalGb < 24) return 'HIGH';
  return 'VERY_HIGH';
}

const gb = (mb: number): number => Math.round((mb / 1024) * 10) / 10;

/** Turn raw reports into the states the UI shows, with reasons and fixes. */
export function classify(
  nvidia: NvidiaReport,
  torch: TorchReport | null,
  opts: ClassifyOptions = {},
): HardwareStatus {
  const states: GpuState[] = [];
  const notes: string[] = [];
  const device = [...nvidia.gpus].sort((a, b) => b.vramTotalMb - a.vramTotalMb)[0] ?? null;
  const percent = Math.min(100, Math.max(10, opts.maxVramPercent ?? 90));
  const usableVramGb = device ? Math.round(gb(device.vramTotalMb) * percent) / 100 : 0;
  const freeVramGb = device ? gb(device.vramFreeMb) : 0;
  const profile = device ? vramProfile(usableVramGb) : 'NONE';

  if (!device) {
    states.push('NO_NVIDIA_GPU');
    notes.push(
      nvidia.error ??
        'No NVIDIA GPU was found. LOCAL GPU image and video generation needs an NVIDIA graphics card with a current driver.',
    );
    if (opts.localWorkerRunning) {
      states.push('CPU_FALLBACK');
      notes.push(
        'The local worker runs on the CPU: light models (e.g. Kokoro TTS) work, image and video models are far too slow or refuse to run.',
      );
    }
  } else {
    if (torch && torch.installed && !torch.cudaAvailable) {
      states.push('CUDA_MISMATCH');
      notes.push(
        torch.cudaRuntime === null
          ? `PyTorch ${torch.version ?? ''} is the CPU-only build. Install the CUDA build (System Health → Install GPU runtime).`
          : `PyTorch (built for CUDA ${torch.cudaRuntime}) cannot use the GPU${torch.error ? `: ${torch.error}` : ''}. Update the NVIDIA driver or reinstall the GPU runtime.`,
      );
    } else if (
      torch?.cudaRuntime &&
      nvidia.cudaDriverVersion &&
      compareVersions(torch.cudaRuntime, nvidia.cudaDriverVersion) > 0
    ) {
      states.push('CUDA_MISMATCH');
      notes.push(
        `PyTorch needs CUDA ${torch.cudaRuntime} but the NVIDIA driver supports up to CUDA ${nvidia.cudaDriverVersion}. Update the NVIDIA driver.`,
      );
    }
    if (device.vramFreeMb < 512 || opts.recentOom) {
      states.push('GPU_OUT_OF_MEMORY');
      notes.push(
        opts.recentOom
          ? 'A recent job ran out of GPU memory. Use a lower quality preset, enable CPU offload, or close other GPU programs.'
          : `Only ${device.vramFreeMb} MB of GPU memory is free. Close other programs that use the GPU (games, browsers with hardware acceleration).`,
      );
    } else if ((device.utilizationPct ?? 0) >= 90 || device.vramFreeMb < device.vramTotalMb * 0.3) {
      states.push('GPU_BUSY');
      notes.push(
        `The GPU is busy (${device.utilizationPct ?? '?'}% used, ${gb(device.vramFreeMb)} GB of ${gb(device.vramTotalMb)} GB free). Generation will wait or run slower.`,
      );
    }
    const required = opts.requiredVramGb ?? 0;
    if (profile === 'LOW' || (required > 0 && usableVramGb < required)) {
      states.push('GPU_LIMITED');
      notes.push(
        required > 0 && usableVramGb < required
          ? `The selected models need about ${required} GB of VRAM; this GPU allows ${usableVramGb} GB. Pick lighter models, enable CPU offload, or use Cloud GPU.`
          : `${device.name} has ${gb(device.vramTotalMb)} GB of VRAM (LOW profile): only small models run, with CPU offload.`,
      );
    }
    const blocking = states.some((s) => s === 'CUDA_MISMATCH' || s === 'GPU_OUT_OF_MEMORY');
    if (!blocking) {
      states.unshift('GPU_READY');
      if (!torch)
        notes.push(
          'PyTorch has not been checked yet (System Health → Check PyTorch); the GPU itself is working.',
        );
      else if (!torch.installed)
        notes.push(
          'PyTorch is not installed for the local worker yet (System Health → Install GPU runtime).',
        );
    }
  }
  if (opts.cloudAvailable) states.push('CLOUD_GPU_AVAILABLE');
  const order: GpuState[] = [
    'NO_NVIDIA_GPU',
    'CUDA_MISMATCH',
    'GPU_OUT_OF_MEMORY',
    'GPU_BUSY',
    'GPU_LIMITED',
    'GPU_READY',
    'CPU_FALLBACK',
    'CLOUD_GPU_AVAILABLE',
  ];
  const primary =
    (!device && states.includes('CPU_FALLBACK') ? 'CPU_FALLBACK' : undefined) ??
    order.find((s) => states.includes(s)) ??
    'NO_NVIDIA_GPU';
  return { nvidia, torch, device, profile, usableVramGb, freeVramGb, primary, states, notes };
}

export type ExecFn = (
  bin: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) =>
      err
        ? reject(Object.assign(err, { stderr: String(stderr ?? '') }))
        : resolve({ stdout: String(stdout), stderr: String(stderr) }),
    );
  });

/** Where nvidia-smi may live: NVIDIA_SMI_PATH, the PATH, then the Windows driver folders. */
export function smiCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const list: string[] = [];
  if (env['NVIDIA_SMI_PATH']) list.push(env['NVIDIA_SMI_PATH']);
  list.push('nvidia-smi');
  if (platform === 'win32') {
    const sys = env['SystemRoot'] ?? 'C:\\Windows';
    const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
    list.push(`${sys}\\System32\\nvidia-smi.exe`, `${pf}\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe`);
  }
  return list;
}

/** Query every NVIDIA GPU. Never throws. */
export async function detectNvidia(
  opts: { env?: NodeJS.ProcessEnv; exec?: ExecFn; platform?: NodeJS.Platform } = {},
): Promise<NvidiaReport> {
  const exec = opts.exec ?? defaultExec;
  const checkedAt = new Date().toISOString();
  let lastError = 'nvidia-smi was not found (no NVIDIA driver installed, or no NVIDIA GPU).';
  for (const bin of smiCandidates(opts.env, opts.platform)) {
    if (bin.includes('\\') && !existsSync(bin)) continue;
    let fields = QUERY_FIELDS;
    let csv: string;
    try {
      csv = (await exec(bin, [`--query-gpu=${fields.join(',')}`, '--format=csv,noheader,nounits'], 8000))
        .stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === 'ENOENT') continue;
      // Older drivers do not know compute_cap: retry without it.
      if (/not a valid field|compute_cap/i.test(`${e.stderr ?? ''}${e.message}`)) {
        fields = QUERY_FIELDS.filter((f) => f !== 'compute_cap');
        try {
          csv = (await exec(bin, [`--query-gpu=${fields.join(',')}`, '--format=csv,noheader,nounits'], 8000))
            .stdout;
        } catch (err2) {
          lastError = `nvidia-smi failed: ${firstLine(err2)}`;
          continue;
        }
      } else {
        lastError = /couldn't communicate|failed/i.test(`${e.stderr ?? ''}${e.message}`)
          ? `The NVIDIA driver is not working (nvidia-smi: ${firstLine(err)}). Reinstall or update the NVIDIA driver, then restart the computer.`
          : `nvidia-smi failed: ${firstLine(err)}`;
        continue;
      }
    }
    const gpus = parseSmiCsv(csv, fields);
    let cudaDriverVersion: string | null = null;
    try {
      cudaDriverVersion = parseCudaVersion((await exec(bin, [], 8000)).stdout);
    } catch {
      cudaDriverVersion = null; // the banner is optional information
    }
    return {
      found: gpus.length > 0,
      smiPath: bin,
      driverVersion: gpus[0]?.driverVersion ?? null,
      cudaDriverVersion,
      gpus,
      error: gpus.length ? null : 'nvidia-smi reported no GPUs.',
      checkedAt,
    };
  }
  return {
    found: false,
    smiPath: null,
    driverVersion: null,
    cudaDriverVersion: null,
    gpus: [],
    error: lastError,
    checkedAt,
  };
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).split('\n')[0]!.slice(0, 200);
}

/** Cached detection (nvidia-smi takes ~0.1–1 s); `refresh` forces a new query. */
export class HardwareService {
  /** Latest PyTorch report (from the local worker or an explicit probe); null = not checked. */
  torch: TorchReport | null = null;
  /** A local job ran out of GPU memory within the last 15 minutes. */
  lastOomAt = 0;
  private cache: { at: number; report: NvidiaReport } | null = null;
  private readonly ttlMs: number;
  private readonly detect: () => Promise<NvidiaReport>;

  constructor(opts: { ttlMs?: number; detect?: () => Promise<NvidiaReport> } = {}) {
    this.ttlMs = opts.ttlMs ?? 10_000;
    this.detect = opts.detect ?? (() => detectNvidia());
  }

  async nvidia(refresh = false): Promise<NvidiaReport> {
    if (!refresh && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.report;
    const report = await this.detect();
    this.cache = { at: Date.now(), report };
    return report;
  }

  recentOom(now = Date.now()): boolean {
    return now - this.lastOomAt < 15 * 60_000;
  }

  /** Last result without querying (null before the first detection). */
  last(): NvidiaReport | null {
    return this.cache?.report ?? null;
  }
}
