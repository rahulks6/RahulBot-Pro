import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

/**
 * The real server entry point, started as a separate process (like Start-AI-Story-Studio.bat)
 * with a temporary DATA_DIR. A second copy on the same port must stop with a clear message and
 * leave the running copy alone.
 */
const root = join(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'ais-startup-'));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function start(port: number): { proc: ChildProcess; output: () => string; exit: Promise<number> } {
  let out = '';
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/web/server.ts'], {
    cwd: root,
    env: {
      PATH: process.env['PATH'] ?? '',
      DATA_DIR: dir,
      PORT: String(port),
      MOCK_GENERATION: 'true',
      ENABLE_CLOUD_GPU: 'false',
      LOG_LEVEL: 'error',
    },
  });
  proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  const exit = new Promise<number>((r) => proc.on('exit', (code) => r(code ?? -1)));
  return { proc, output: () => out, exit };
}

describe('server start-up', () => {
  const procs: ChildProcess[] = [];
  after(() => {
    for (const p of procs) p.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a second copy on the same port explains itself and leaves the first one running', async () => {
    const port = await freePort();
    const first = start(port);
    procs.push(first.proc);
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      up = await fetch(`http://127.0.0.1:${port}/`).then(
        (r) => r.ok,
        () => false,
      );
    }
    assert.ok(up, `first copy did not start: ${first.output()}`);

    const second = start(port);
    procs.push(second.proc);
    assert.equal(await second.exit, 1);
    assert.match(second.output(), /already running at http:\/\/127\.0\.0\.1:\d+\//);
    assert.match(second.output(), /Nothing was changed/);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200, 'first copy still serves');
    assert.match(await res.text(), /MODE: MOCK/);
    first.proc.kill('SIGTERM');
    const code = await first.exit;
    // On Windows, kill() is a hard stop (no SIGTERM handler runs); elsewhere shutdown is clean.
    if (process.platform !== 'win32') assert.equal(code, 0, 'clean shutdown');
  });
});
