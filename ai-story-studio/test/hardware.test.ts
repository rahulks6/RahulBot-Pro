import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classify,
  compareVersions,
  detectNvidia,
  parseCudaVersion,
  parseSmiCsv,
  vramProfile,
  type ExecFn,
  type NvidiaReport,
  type TorchReport,
} from '../src/services/hardware.ts';
import { findPython, probeTorch, pythonSupported, torchWheelFor } from '../src/services/python-runtime.ts';

/** GPU / CUDA detection without a GPU: nvidia-smi output is replayed from real driver formats. */
const RTX4070 = '0, NVIDIA GeForce RTX 4070, GPU-1234, 566.14, 12282, 1034, 11028, 7, 41, 8.9\n';
const BANNER = `+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 566.14                 Driver Version: 566.14         CUDA Version: 12.7     |
|-----------------------------------------+------------------------+----------------------+`;

const smi =
  (csv: string, banner = BANNER, opts: { noComputeCap?: boolean } = {}): ExecFn =>
  async (_bin, args) => {
    if (args.length === 0) return { stdout: banner, stderr: '' };
    if (opts.noComputeCap && args[0]!.includes('compute_cap'))
      throw Object.assign(new Error('Command failed'), {
        stderr: 'Field "compute_cap" is not a valid field to query.',
      });
    return { stdout: csv, stderr: '' };
  };

const report = (over: Partial<NvidiaReport> = {}): NvidiaReport => ({
  found: true,
  smiPath: 'nvidia-smi',
  driverVersion: '566.14',
  cudaDriverVersion: '12.7',
  gpus: parseSmiCsv(RTX4070),
  error: null,
  checkedAt: 'now',
  ...over,
});
const torchOk: TorchReport = {
  installed: true,
  version: '2.7.1+cu126',
  cudaAvailable: true,
  cudaRuntime: '12.6',
  device: 'NVIDIA GeForce RTX 4070',
};

describe('nvidia-smi parsing', () => {
  it('reads model, driver, VRAM total/used/free, utilization, temperature and compute capability', () => {
    const [g] = parseSmiCsv(RTX4070);
    assert.deepEqual(g, {
      index: 0,
      name: 'NVIDIA GeForce RTX 4070',
      uuid: 'GPU-1234',
      driverVersion: '566.14',
      vramTotalMb: 12282,
      vramUsedMb: 1034,
      vramFreeMb: 11028,
      utilizationPct: 7,
      temperatureC: 41,
      computeCapability: '8.9',
    });
    assert.equal(parseCudaVersion(BANNER), '12.7');
    assert.equal(parseCudaVersion('no banner'), null);
  });

  it('laptop GPUs that report [N/A] still parse; junk lines are ignored', () => {
    const [g] = parseSmiCsv(
      '0, RTX 3050 Laptop, [N/A], 551.23, 4096, 5, [N/A], [N/A], [Not Supported], 8.6\nxx\n',
    );
    assert.equal(g!.utilizationPct, null);
    assert.equal(g!.temperatureC, null);
    assert.equal(g!.vramFreeMb, 4091);
    assert.equal(g!.uuid, null);
  });

  it('detects through nvidia-smi, and falls back when the driver does not know compute_cap', async () => {
    const r = await detectNvidia({ exec: smi(RTX4070), env: {} });
    assert.equal(r.found, true);
    assert.equal(r.cudaDriverVersion, '12.7');
    const old = await detectNvidia({
      exec: smi('0, Old GPU, GPU-9, 470.1, 8192, 0, 8192, 0, 30\n', BANNER, { noComputeCap: true }),
      env: {},
    });
    assert.equal(old.found, true);
    assert.equal(old.gpus[0]!.computeCapability, null);
  });

  it('no NVIDIA driver or a broken driver is a reported state, never a crash', async () => {
    const missing: ExecFn = async () => {
      throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
    };
    const none = await detectNvidia({ exec: missing, env: {}, platform: 'linux' });
    assert.equal(none.found, false);
    assert.match(none.error!, /not found/);
    const broken: ExecFn = async () => {
      throw Object.assign(new Error('Command failed'), {
        stderr:
          "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.",
      });
    };
    const b = await detectNvidia({ exec: broken, env: {}, platform: 'linux' });
    assert.equal(b.found, false);
    assert.match(b.error!, /driver is not working/);
  });
});

describe('GPU state and VRAM profile', () => {
  it('profiles by usable VRAM, not by GPU name', () => {
    assert.equal(vramProfile(0), 'NONE');
    assert.equal(vramProfile(6), 'LOW');
    assert.equal(vramProfile(11), 'MEDIUM');
    assert.equal(vramProfile(20), 'HIGH');
    assert.equal(vramProfile(24), 'VERY_HIGH');
    // A 12 GB card limited to 60% by the "Max VRAM usage" setting is LOW.
    assert.equal(classify(report(), torchOk, { maxVramPercent: 60 }).profile, 'LOW');
    assert.equal(classify(report(), torchOk, { maxVramPercent: 100 }).profile, 'MEDIUM');
  });

  it('GPU READY when the GPU, driver and PyTorch agree', () => {
    const h = classify(report(), torchOk, { requiredVramGb: 8 });
    assert.equal(h.primary, 'GPU_READY');
    assert.equal(h.device?.name, 'NVIDIA GeForce RTX 4070');
    assert.equal(h.usableVramGb, 10.8);
  });

  it('NO NVIDIA GPU, with CPU FALLBACK when the worker runs on the CPU', () => {
    const none = report({ found: false, gpus: [], error: 'nvidia-smi was not found' });
    assert.equal(classify(none, null).primary, 'NO_NVIDIA_GPU');
    const cpu = classify(none, null, { localWorkerRunning: true });
    assert.equal(cpu.primary, 'CPU_FALLBACK');
    assert.ok(cpu.states.includes('NO_NVIDIA_GPU'));
    assert.equal(cpu.profile, 'NONE');
  });

  it('CUDA MISMATCH: CPU-only PyTorch, or PyTorch newer than the driver supports', () => {
    const cpuBuild = classify(report(), { ...torchOk, cudaAvailable: false, cudaRuntime: null });
    assert.equal(cpuBuild.primary, 'CUDA_MISMATCH');
    assert.match(cpuBuild.notes.join(' '), /CPU-only build/);
    const tooNew = classify(report({ cudaDriverVersion: '12.4' }), { ...torchOk, cudaRuntime: '12.8' });
    assert.equal(tooNew.primary, 'CUDA_MISMATCH');
    assert.match(tooNew.notes.join(' '), /Update the NVIDIA driver/);
  });

  it('GPU BUSY, GPU OUT OF MEMORY and GPU LIMITED', () => {
    const busy = report({ gpus: parseSmiCsv('0, G, x, 1, 12282, 10000, 2282, 97, 80, 8.9\n') });
    assert.equal(classify(busy, torchOk).primary, 'GPU_BUSY');
    const full = report({ gpus: parseSmiCsv('0, G, x, 1, 12282, 11900, 382, 99, 80, 8.9\n') });
    assert.equal(classify(full, torchOk).primary, 'GPU_OUT_OF_MEMORY');
    assert.equal(classify(report(), torchOk, { recentOom: true }).primary, 'GPU_OUT_OF_MEMORY');
    const limited = classify(report(), torchOk, { requiredVramGb: 24 });
    assert.equal(limited.primary, 'GPU_LIMITED');
    assert.match(limited.notes.join(' '), /need about 24 GB/);
  });

  it('CLOUD GPU AVAILABLE is shown alongside the local state', () => {
    const h = classify(report(), torchOk, { cloudAvailable: true });
    assert.deepEqual(h.states, ['GPU_READY', 'CLOUD_GPU_AVAILABLE']);
  });
});

describe('Python runtime and PyTorch wheel choice', () => {
  it('finds a working Python, skipping stubs that print no version', async () => {
    const exec = async (bin: string) => {
      if (bin === 'python3') return '';
      if (bin === 'python') return 'Python 3.11.9';
      throw new Error('missing');
    };
    const py = await findPython('/nowhere', { exec, env: {}, platform: 'linux' });
    assert.deepEqual(py, { path: 'python', args: [], source: 'PATH', version: '3.11.9' });
    assert.equal(pythonSupported('3.11.9'), true);
    assert.equal(pythonSupported('3.8.10'), false);
    assert.equal(await findPython('/nowhere', { exec: async () => '', env: {}, platform: 'linux' }), null);
  });

  it('reads the PyTorch probe result, and reports a failed probe without throwing', async () => {
    const py = { path: 'python', args: [], version: '3.11.9', source: 'PATH' as const };
    const t = await probeTorch(
      py,
      async () =>
        'noise\nTORCHJSON{"installed": true, "version": "2.7.1+cu126", "cudaAvailable": true, "cudaRuntime": "12.6", "device": "RTX 4070", "error": null}\n',
    );
    assert.equal(t.cudaAvailable, true);
    const bad = await probeTorch(py, async () => {
      throw Object.assign(new Error('x'), { stderr: 'ImportError: DLL load failed' });
    });
    assert.equal(bad.installed, false);
    assert.match(bad.error!, /DLL load failed/);
  });

  it('picks the CUDA wheel the driver supports (RTX 50-series needs cu128)', () => {
    assert.equal(torchWheelFor('12.8', '8.9')?.tag, 'cu128');
    assert.equal(torchWheelFor('12.7', '8.9')?.tag, 'cu126');
    assert.equal(torchWheelFor('12.4', '8.6')?.tag, 'cu118');
    assert.equal(torchWheelFor('12.6', '12.0'), null, 'Blackwell on an old driver: update the driver');
    assert.equal(torchWheelFor('11.4', '7.5'), null);
    assert.equal(torchWheelFor(null, null), null);
    assert.ok(compareVersions('12.10', '12.9') > 0);
  });
});
