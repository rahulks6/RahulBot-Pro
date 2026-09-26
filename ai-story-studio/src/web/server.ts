import { createServer } from 'node:http';
import { createStudio } from '../app/studio.ts';
import { connectWorker } from '../providers/worker/connect.ts';
import { createWebApp } from './app.ts';

/**
 * AI Story Studio local server. Binds to 127.0.0.1 by default (private,
 * single-user tool). A GPU watchdog runs on an interval, and on shutdown any
 * GPU still tracked as active is terminated.
 */
let studio: ReturnType<typeof createStudio>;
try {
  studio = createStudio();
} catch (err) {
  // E.g. a storage drive from .env that is not connected: a plain message, not a stack trace.
  console.error(`AI Story Studio could not start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const { handle } = createWebApp(studio);
const url = `http://${studio.env.host}:${studio.env.port}/`;

// Requests wait until start-up recovery is done, so nothing runs against half-recovered state.
let markReady!: () => void;
const ready = new Promise<void>((r) => (markReady = r));
const server = createServer((req, res) => {
  ready
    .then(() => handle(req, res))
    .catch((err: unknown) => {
      studio.logger.error('unhandled request error', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal error');
    });
});

// Claim the port FIRST. A second copy (Start double-clicked twice) must stop here, before its
// start-up recovery could requeue the running copy's jobs or stop its cloud GPU.
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(studio.env.port, studio.env.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'EADDRINUSE') {
    console.error(
      `AI Story Studio seems to be already running at ${url}\n` +
        'Open that address in your browser, or close the other AI Story Studio window first.\n' +
        '(If a different program uses this port, set PORT=3001 in .env.) Nothing was changed.',
    );
  } else {
    console.error(`AI Story Studio could not start its web server at ${url}: ${err.message}`);
  }
  studio.logger.error('web server could not start', { code: err.code ?? '', error: err.message });
  studio.close();
  process.exit(1);
}

if (studio.env.workerUrl) {
  try {
    await connectWorker(studio);
  } catch (err) {
    // Keep running on the in-process mock providers; the Settings page shows the error and can reconnect.
    studio.logger.error('worker connection failed; using in-process mock providers', {
      error: (err as Error).message,
    });
  }
}

// Crash recovery: requeue interrupted jobs and find cloud GPUs left running by a previous session.
try {
  const r = await studio.cloud.recoverOnStartup();
  if (r.jobsRecovered || r.terminated.length || r.reattachable.length || r.warnings.length)
    console.log(
      `Recovery: ${r.jobsRecovered} job(s) requeued, ${r.terminated.length} leftover GPU(s) terminated, ${r.reattachable.length} kept (idle timer running)${r.warnings.length ? `; ${r.warnings.join(' ')}` : ''}`,
    );
} catch (err) {
  studio.logger.error('start-up recovery failed', { error: (err as Error).message });
}

const interval = studio.settings.get('gpu').watchdogIntervalSeconds * 1000;
const watchdog = setInterval(() => {
  studio.gpu
    .watchdog()
    .catch((err: unknown) => studio.logger.error('watchdog failed', { error: String(err) }));
}, interval);
watchdog.unref();

markReady();
console.log(`AI Story Studio running at ${url}  (mode: ${studio.cloud.modeLabel()})`);
// Hardware summary in the background: a missing or slow driver never delays the start.
void studio.hardware.nvidia().then((r) => {
  const g = r.gpus[0];
  const line = g
    ? `GPU: ${g.name}, ${(g.vramTotalMb / 1024).toFixed(1)} GB VRAM, driver ${r.driverVersion ?? '?'}, CUDA up to ${r.cudaDriverVersion ?? '?'}`
    : `GPU: no NVIDIA GPU detected (${r.error ?? 'none'})`;
  console.log(`${line}. Details: ${url}health`);
  studio.logger.info('hardware detected', {
    gpu: g?.name ?? null,
    vramMb: g?.vramTotalMb ?? 0,
    driver: r.driverVersion,
    cuda: r.cudaDriverVersion,
  });
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(watchdog);
  const cleaned = await studio.gpu.shutdownCleanup().catch((err: unknown) => {
    // Never silent: a GPU that could not be stopped may still cost money.
    studio.logger.error('shutdown: GPU cleanup FAILED; check your cloud provider console', {
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(
      'WARNING: could not confirm that every cloud GPU was stopped. Check the RunPod console → Pods.',
    );
    return 0;
  });
  studio.logger.info('shutdown', { signal, gpuTerminated: cleaned });
  server.close(() => {
    studio.close();
    process.exit(0);
  });
  // Cloud termination calls need a few seconds; the start-up recovery covers anything left over.
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Windows: closing the console window sends SIGHUP (about 10 s grace); Ctrl+Break sends SIGBREAK.
process.on('SIGHUP', () => void shutdown('SIGHUP'));
if (process.platform === 'win32') process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
