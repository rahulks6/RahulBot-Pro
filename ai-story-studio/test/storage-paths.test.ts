import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createStudio } from '../src/app/studio.ts';
import { readEnv, storagePaths } from '../src/config/env.ts';

describe('configurable storage paths (for a second drive)', () => {
  it('defaults to folders inside DATA_DIR', () => {
    const env = readEnv({ DATA_DIR: '/x/data' });
    assert.deepEqual(storagePaths(env), {
      generatedAssets: join('/x/data', 'storage'),
      tempRender: join('/x/data', 'tmp'),
      downloadCache: join('/x/data', 'tmp', 'downloads'),
      modelCache: join('/x/data', 'models'),
    });
  });

  it('reads GENERATED_ASSETS_PATH, TEMP_RENDER_PATH, DOWNLOAD_CACHE_PATH and MODEL_CACHE_PATH', () => {
    const env = readEnv({
      DATA_DIR: '/x/data',
      GENERATED_ASSETS_PATH: '/d/ais/assets',
      TEMP_RENDER_PATH: '/d/ais/render',
      DOWNLOAD_CACHE_PATH: '/d/ais/downloads',
      MODEL_CACHE_PATH: '/d/ais/models',
    });
    assert.deepEqual(storagePaths(env), {
      generatedAssets: '/d/ais/assets',
      tempRender: '/d/ais/render',
      downloadCache: '/d/ais/downloads',
      modelCache: '/d/ais/models',
    });
    assert.equal(
      storagePaths(readEnv({ DATA_DIR: '/x/data', GENERATED_ASSETS_PATH: '   ' })).generatedAssets,
      join('/x/data', 'storage'),
      'blank = default',
    );
  });

  it('stores generated media under GENERATED_ASSETS_PATH, the database stays in DATA_DIR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ais-paths-'));
    const s = createStudio({
      env: {
        mockGeneration: true,
        enableCloudGpu: false,
        dataDir: join(dir, 'data'),
        logLevel: 'error',
        mockFailureRate: 0,
        assemblyMode: 'mock',
        paths: { generatedAssets: join(dir, 'second-drive', 'assets') },
      },
      dbPath: join(dir, 'data', 'studio.sqlite'),
      logSinks: [],
      secretEnv: {},
    });
    try {
      const p = s.projects.create({ name: 'Paths' });
      const st = s.stories.create(p.id, { title: 'T' });
      const sc = s.stories.createScene(st.id, { title: 'S' });
      const shot = s.stories.createShot(sc.id, { title: 'a', action: 'b' });
      s.generation.queueImage(shot.id);
      await s.generation.processQueue();
      assert.ok(
        readdirSync(join(dir, 'second-drive', 'assets'), { recursive: true }).length > 0,
        'media on the second drive',
      );
      assert.ok(!existsSync(join(dir, 'data', 'storage')), 'nothing written to the default media folder');
      assert.ok(existsSync(join(dir, 'data', 'studio.sqlite')));
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a storage drive that is not available', () => {
  it('stops the start with a plain message naming the .env setting (no silent fallback)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ais-nodrive-'));
    try {
      // A path below a FILE can never be created: the same failure as a disconnected drive.
      const blocker = join(dir, 'not-a-folder');
      writeFileSync(blocker, 'x');
      assert.throws(
        () =>
          createStudio({
            env: {
              mockGeneration: true,
              enableCloudGpu: false,
              dataDir: join(dir, 'data'),
              logLevel: 'error',
              mockFailureRate: 0,
              assemblyMode: 'mock',
              paths: { generatedAssets: join(blocker, 'assets') },
            },
            dbPath: join(dir, 'data', 'studio.sqlite'),
            logSinks: [],
            secretEnv: {},
          }),
        /GENERATED_ASSETS_PATH=.* is not available .*Connect that drive, or remove the line from \.env/,
      );
      assert.ok(!existsSync(join(dir, 'data', 'studio.sqlite')), 'nothing was created in the data folder');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
