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

const interval = studio.settings.get('gpu').watchdogIntervalSeconds * 1000;
const watchdog = setInterval(() => {
  studio.gpu
    .watchdog()
    .catch((err: unknown) => studio.logger.error('watchdog failed', { error: String(err) }));
}, interval);
watchdog.unref();

server.listen(studio.env.port, studio.env.host, () => {
  console.log(
    `AI Story Studio running at http://${studio.env.host}:${studio.env.port}/  (MOCK_GENERATION=${studio.env.mockGeneration})`,
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
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
