import { createServer } from 'node:http';
import { createStudio } from '../app/studio.ts';
import { connectWorker } from '../providers/worker/connect.ts';
import { createWebApp } from './app.ts';

/**
 * AI Story Studio local server. Binds to 127.0.0.1 by default (private,
 * single-user tool). A GPU watchdog runs on an interval, and on shutdown any
 * GPU still tracked as active is terminated.
 */
const studio = createStudio();
const { handle } = createWebApp(studio);
const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    studio.logger.error('unhandled request error', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal error');
  });
});

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

server.listen(studio.env.port, studio.env.host, () => {
  console.log(
    `AI Story Studio running at http://${studio.env.host}:${studio.env.port}/  (mode: ${studio.cloud.modeLabel()})`,
  );
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(watchdog);
  const cleaned = await studio.gpu.shutdownCleanup().catch(() => 0);
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
