import { accessSync, constants, mkdirSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { storagePaths } from '../config/env.ts';
import { appRoot } from '../lib/paths.ts';
import type { Studio } from '../app/studio.ts';
import { classify, GPU_STATE_LABEL, PROFILE_LABEL, type HardwareStatus } from './hardware.ts';
import {
  findPython,
  probeTorch,
  pythonSupported,
  torchWheelFor,
  type PythonRuntime,
} from './python-runtime.ts';

/**
 * Start-up / on-demand health check (System Health page). Each check says what
 * was found, whether it blocks anything, and how to fix it — in plain words.
 * Nothing here changes the system; installing is always a separate, confirmed action.
 */
export type HealthLevel = 'ok' | 'warn' | 'fail' | 'unknown' | 'info';

export interface HealthCheck {
  key: string;
  label: string;
  level: HealthLevel;
  detail: string;
  fix?: string;
}

export interface HealthReport {
  at: string;
  checks: HealthCheck[];
  hardware: HardwareStatus;
  python: PythonRuntime | null;
  overall: HealthLevel;
}

const MIN_NODE = [22, 18];

function nodeOk(version: string): boolean {
  const [maj, min] = version.replace(/^v/, '').split('.').map(Number) as [number, number];
  return maj > MIN_NODE[0]! || (maj === MIN_NODE[0] && min >= MIN_NODE[1]!);
}

export function freeGb(path: string): number | null {
  try {
    mkdirSync(path, { recursive: true });
    const s = statfsSync(path);
    return Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    return null;
  }
}

function writable(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Largest minimum-VRAM requirement of the models selected for LOCAL GPU (0 when none are selected). */
export type RequiredVram = () => number;

export async function runHealthCheck(
  s: Studio,
  opts: { probeTorch?: boolean; refreshGpu?: boolean } = {},
): Promise<HealthReport> {
  const checks: HealthCheck[] = [];
  const add = (c: HealthCheck): void => {
    checks.push(c);
  };
  const workerDir = join(appRoot(), 'worker');

  add(
    nodeOk(process.version)
      ? { key: 'node', label: 'Node.js', level: 'ok', detail: process.version }
      : {
          key: 'node',
          label: 'Node.js',
          level: 'fail',
          detail: `${process.version} is too old`,
          fix: 'Install Node.js 22.18 or newer (the setup program does this).',
        },
  );

  const python = await findPython(workerDir);
  add(
    python
      ? {
          key: 'python',
          label: 'Python (local worker)',
          level: pythonSupported(python.version) ? 'ok' : 'fail',
          detail: `Python ${python.version} (${python.source === 'venv' ? 'worker environment' : python.source}: ${python.path})`,
          ...(pythonSupported(python.version)
            ? {}
            : { fix: 'Install Python 3.10 or newer (3.11 recommended).' }),
        }
      : {
          key: 'python',
          label: 'Python (local worker)',
          level: 'warn',
          detail: 'not found',
          fix: 'Needed only for LOCAL GPU mode. Run the setup program again, or install Python 3.11.',
        },
  );

  add(
    s.ffmpeg
      ? { key: 'ffmpeg', label: 'FFmpeg / FFprobe', level: 'ok', detail: s.ffmpeg.version }
      : {
          key: 'ffmpeg',
          label: 'FFmpeg / FFprobe',
          level: s.env.assemblyMode === 'mock' ? 'info' : 'fail',
          detail:
            s.env.assemblyMode === 'mock'
              ? 'not used (ASSEMBLY_MODE=mock)'
              : 'not found: BUILD FINAL cannot encode MP4 files',
          fix: 'Install FFmpeg (the setup program does this), or set FFMPEG_PATH and FFPROBE_PATH in .env.',
        },
  );

  // Database: integrity and schema version.
  try {
    const quick = s.db.scalar<string>('PRAGMA quick_check') ?? 'unknown';
    const version = s.db.scalar<number>('SELECT COALESCE(MAX(version), 0) FROM schema_migrations') ?? 0;
    let size = '';
    try {
      size = `, ${(statSync(s.db.path).size / 1024 / 1024).toFixed(1)} MB`;
    } catch {
      size = '';
    }
    add({
      key: 'database',
      label: 'Database',
      level: quick === 'ok' ? 'ok' : 'fail',
      detail: `integrity ${quick}, schema version ${version}${size}`,
      ...(quick === 'ok'
        ? {}
        : { fix: 'Restore the latest backup from data\\backups (see TROUBLESHOOTING_WINDOWS.md).' }),
    });
  } catch (err) {
    add({ key: 'database', label: 'Database', level: 'fail', detail: (err as Error).message });
  }

  // Folders and free disk space.
  const paths = storagePaths(s.env);
  const dirs: Array<[string, string]> = [
    ['Data folder', s.env.dataDir],
    ['Generated media', paths.generatedAssets],
    ['Render temp', paths.tempRender],
    ['Model cache', paths.modelCache],
  ];
  const unwritable = dirs.filter(([, p]) => !writable(p));
  add(
    unwritable.length
      ? {
          key: 'folders',
          label: 'Required folders',
          level: 'fail',
          detail: `not writable: ${unwritable.map(([n, p]) => `${n} (${p})`).join(', ')}`,
          fix: 'Check the folder permissions, or change the path in .env.',
        }
      : { key: 'folders', label: 'Required folders', level: 'ok', detail: 'all writable' },
  );
  for (const [name, path] of [
    ['Disk (data)', s.env.dataDir],
    ['Disk (models)', paths.modelCache],
  ] as const) {
    const free = freeGb(path);
    add({
      key: `disk_${name}`,
      label: name,
      level: free === null ? 'unknown' : free < 5 ? 'fail' : free < 30 ? 'warn' : 'ok',
      detail: free === null ? `could not read free space for ${path}` : `${free} GB free on ${path}`,
      ...(free !== null && free < 30
        ? {
            fix:
              name === 'Disk (models)'
                ? 'Video models need 20–40 GB each. Point MODEL_CACHE_PATH at a bigger drive (e.g. your SSD).'
                : 'Free up space or move GENERATED_ASSETS_PATH to a bigger drive.',
          }
        : {}),
    });
  }

  // GPU / driver / CUDA / PyTorch.
  const nvidia = await s.hardware.nvidia(opts.refreshGpu);
  let torch = s.hardware.torch;
  if (opts.probeTorch && python) {
    torch = await probeTorch(python);
    s.hardware.torch = torch;
  }
  const hw = classify(nvidia, torch, {
    maxVramPercent: s.settings.get('execution').maxVramPercent,
    localWorkerRunning: s.worker !== null,
    cloudAvailable: s.cloud.canProvision(),
  });
  const dev = hw.device;
  add({
    key: 'gpu',
    label: 'NVIDIA GPU',
    level: dev ? (hw.primary === 'GPU_READY' ? 'ok' : 'warn') : 'warn',
    detail: dev
      ? `${dev.name}, ${(dev.vramTotalMb / 1024).toFixed(1)} GB VRAM (${PROFILE_LABEL[hw.profile]}) — ${GPU_STATE_LABEL[hw.primary]}`
      : `${GPU_STATE_LABEL[hw.primary]}: ${nvidia.error ?? 'no GPU'}`,
    ...(dev
      ? {}
      : { fix: 'LOCAL GPU mode needs an NVIDIA GPU. Use MOCK mode, or CLOUD GPU for real generation.' }),
  });
  if (dev) {
    const wheel = torchWheelFor(nvidia.cudaDriverVersion, dev.computeCapability);
    add({
      key: 'driver',
      label: 'NVIDIA driver / CUDA',
      level: wheel ? 'ok' : 'fail',
      detail: `driver ${nvidia.driverVersion ?? '?'}, supports CUDA up to ${nvidia.cudaDriverVersion ?? '?'}`,
      ...(wheel
        ? {}
        : { fix: 'Update the NVIDIA driver (GeForce Experience / nvidia.com/drivers), then restart.' }),
    });
  }
  add(
    torch === null
      ? {
          key: 'torch',
          label: 'PyTorch (CUDA)',
          level: 'unknown',
          detail: 'not checked yet (takes a few seconds)',
          fix: 'Press "Check PyTorch".',
        }
      : !torch.installed
        ? {
            key: 'torch',
            label: 'PyTorch (CUDA)',
            level: dev ? 'warn' : 'info',
            detail: torch.error ?? 'not installed in the worker environment',
            fix: dev
              ? 'Press "Install GPU runtime" (downloads about 3 GB).'
              : 'Not needed without an NVIDIA GPU.',
          }
        : {
            key: 'torch',
            label: 'PyTorch (CUDA)',
            level: torch.cudaAvailable ? 'ok' : dev ? 'fail' : 'info',
            detail: `PyTorch ${torch.version ?? '?'}${torch.cudaRuntime ? ` (CUDA ${torch.cudaRuntime})` : ' (CPU-only build)'}${torch.cudaAvailable ? `, using ${torch.device}` : ', CUDA not available'}`,
            ...(torch.cudaAvailable || !dev
              ? {}
              : {
                  fix: 'Reinstall the GPU runtime (System Health → Install GPU runtime) or update the driver.',
                }),
          },
  );

  add(
    s.worker
      ? {
          key: 'worker',
          label: 'Python worker',
          level: 'ok',
          detail: `connected: ${s.worker.url}, version ${s.worker.version}, ${s.worker.models.length} model(s)${s.worker.models.every((m) => m.mock) ? ' (all mock)' : ''}`,
        }
      : {
          key: 'worker',
          label: 'Python worker',
          level: 'info',
          detail: 'not running (not needed in MOCK mode)',
        },
  );

  const rank: Record<HealthLevel, number> = { fail: 3, warn: 2, unknown: 1, info: 0, ok: 0 };
  const worst = checks.reduce((m, c) => Math.max(m, rank[c.level]), 0);
  return {
    at: new Date().toISOString(),
    checks,
    hardware: hw,
    python,
    overall: worst === 3 ? 'fail' : worst === 2 ? 'warn' : 'ok',
  };
}
