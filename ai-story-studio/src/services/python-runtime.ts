import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TorchReport } from './hardware.ts';

/**
 * The Python used by the local AI worker: `WORKER_PYTHON`, else the installer's
 * virtual environment (worker/.venv), else python/python3/py on the PATH.
 */
export interface PythonRuntime {
  path: string;
  /** Extra leading arguments (the Windows launcher needs `-3`). */
  args: string[];
  version: string;
  source: 'WORKER_PYTHON' | 'venv' | 'PATH';
}

type Exec = (bin: string, args: string[], timeoutMs: number) => Promise<string>;

const run: Exec = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) =>
        err ? reject(Object.assign(err, { stderr: String(stderr ?? '') })) : resolve(`${stdout}${stderr}`),
    );
  });

export function venvPython(workerDir: string, platform = process.platform): string {
  return platform === 'win32'
    ? join(workerDir, '.venv', 'Scripts', 'python.exe')
    : join(workerDir, '.venv', 'bin', 'python');
}

export async function findPython(
  workerDir: string,
  opts: { env?: NodeJS.ProcessEnv; exec?: Exec; platform?: NodeJS.Platform } = {},
): Promise<PythonRuntime | null> {
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? run;
  const platform = opts.platform ?? process.platform;
  const candidates: Array<Omit<PythonRuntime, 'version'>> = [];
  if (env['WORKER_PYTHON'])
    candidates.push({ path: env['WORKER_PYTHON'], args: [], source: 'WORKER_PYTHON' });
  const venv = venvPython(workerDir, platform);
  if (existsSync(venv)) candidates.push({ path: venv, args: [], source: 'venv' });
  for (const p of platform === 'win32' ? ['python', 'py'] : ['python3', 'python'])
    candidates.push({ path: p, args: p === 'py' ? ['-3'] : [], source: 'PATH' });
  for (const c of candidates) {
    try {
      const out = await exec(c.path, [...c.args, '--version'], 10_000);
      const version = /Python\s+(\d+\.\d+\.\d+)/.exec(out)?.[1];
      // The Microsoft Store "python" stub prints nothing useful: skip it.
      if (version) return { ...c, version };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Python ≥ 3.10 is needed by the worker. */
export function pythonSupported(version: string): boolean {
  const [maj, min] = version.split('.').map(Number);
  return (maj ?? 0) > 3 || ((maj ?? 0) === 3 && (min ?? 0) >= 10);
}

const TORCH_PROBE = `
import json, importlib.util
r = {"installed": False, "version": None, "cudaAvailable": False, "cudaRuntime": None, "device": None, "error": None}
if importlib.util.find_spec("torch") is not None:
    r["installed"] = True
    try:
        import torch
        r["version"] = str(torch.__version__)
        r["cudaRuntime"] = str(torch.version.cuda) if torch.version.cuda else None
        r["cudaAvailable"] = bool(torch.cuda.is_available())
        if r["cudaAvailable"]:
            r["device"] = torch.cuda.get_device_name(0)
    except Exception as e:
        r["error"] = str(e)[:300]
print("TORCHJSON" + json.dumps(r))
`;

/** Ask the worker's Python whether PyTorch is installed and can use CUDA (importing torch takes seconds). */
export async function probeTorch(py: PythonRuntime, exec: Exec = run): Promise<TorchReport> {
  try {
    const out = await exec(py.path, [...py.args, '-c', TORCH_PROBE], 180_000);
    const line = out.split(/\r?\n/).find((l) => l.startsWith('TORCHJSON'));
    if (!line) throw new Error('no result');
    return JSON.parse(line.slice('TORCHJSON'.length)) as TorchReport;
  } catch (err) {
    return {
      installed: false,
      version: null,
      cudaAvailable: false,
      cudaRuntime: null,
      device: null,
      error: `PyTorch check failed: ${String((err as { stderr?: string }).stderr || (err as Error).message)
        .split('\n')
        .filter(Boolean)
        .pop()
        ?.slice(0, 200)}`,
    };
  }
}

/**
 * The PyTorch CUDA wheel matching the driver (torch 2.7.1 ships cu118, cu126 and cu128 builds).
 * RTX 50-series (compute capability 12.x) needs cu128. Null = the driver is too old.
 */
export function torchWheelFor(
  cudaDriverVersion: string | null,
  computeCapability: string | null,
): { tag: 'cu128' | 'cu126' | 'cu118'; indexUrl: string } | null {
  if (!cudaDriverVersion) return null;
  const [maj, min] = cudaDriverVersion.split('.').map(Number) as [number, number];
  const v = maj * 100 + (min ?? 0);
  const blackwell = computeCapability ? Number(computeCapability.split('.')[0]) >= 12 : false;
  const tag = v >= 1208 ? 'cu128' : blackwell ? null : v >= 1206 ? 'cu126' : v >= 1108 ? 'cu118' : null;
  return tag ? { tag, indexUrl: `https://download.pytorch.org/whl/${tag}` } : null;
}
