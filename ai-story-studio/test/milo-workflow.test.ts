import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createStudio, type Studio } from '../src/app/studio.ts';
import { findFfmpeg } from '../src/media/ffmpeg.ts';
import { createWebApp } from '../src/web/app.ts';
import { WebDriver, type Page } from './fixtures/web-driver.ts';

/**
 * The complete MOCK production workflow for the "Milo" test episode, driven ONLY through the web
 * pages and their real forms (no repository shortcuts for the workflow itself):
 *
 *   project → story → style → character → locations → prop → 3 scenes → shots → cast →
 *   narration → mock images → approve → mock clips → approve → mock TTS → queue →
 *   assets → editor → quality check → BUILD FINAL → export → backup → restore → restart.
 *
 * Runs against a FILE database in a temporary folder (never the user's data). Mock mode only:
 * nothing can reach RunPod. When FFmpeg is available (FFMPEG_PATH / PATH), the final MP4 is
 * checked with ffprobe (H.264 + AAC, 1920×1080, 30 fps); otherwise that step reports a skip.
 */
const FFMPEG = findFfmpeg();

const SCENES = [
  {
    title: 'Sunset at home',
    summary:
      'Milo is playing outside his little house at sunset when he notices a tiny glowing star falling into the nearby forest.',
    location: "Milo's House",
    time: 'sunset',
    shot: 'Milo plays outside his little house and looks up as a tiny glowing star falls into the forest.',
    narration: 'One warm evening, Milo saw a tiny star tumble out of the sky.',
  },
  {
    title: 'Into the forest',
    summary:
      'Milo follows the golden light through the forest and discovers the little star trapped between the branches of a tree.',
    location: 'Magical Forest',
    time: 'dusk',
    shot: 'Milo follows the golden light between the trees and finds the little star caught in the branches.',
    narration: 'He followed the golden glow deep into the magical forest.',
  },
  {
    title: 'Home to the sky',
    summary:
      'Milo carefully frees the star. It flies back into the night sky, lighting up the forest while Milo smiles and waves goodbye.',
    location: 'Magical Forest',
    time: 'night',
    shot: 'Milo gently frees the star; it rises into the night sky, lighting up the forest as Milo waves goodbye.',
    narration: 'Milo set the star free, and it shone brighter than ever.',
  },
];

describe('Milo test episode — full MOCK workflow through the web UI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ais-milo-'));
  const dataDir = join(dir, 'data');
  let studio: Studio;
  let server: Server;
  let web: WebDriver;
  const ids: Record<string, string> = {};

  async function boot(): Promise<void> {
    studio = createStudio({
      env: {
        mockGeneration: true,
        enableCloudGpu: false,
        dataDir,
        logLevel: 'info',
        mockFailureRate: 0,
        assemblyMode: FFMPEG ? 'ffmpeg' : 'mock',
      },
      dbPath: join(dataDir, 'studio.sqlite'),
      ffmpeg: FFMPEG,
      logSinks: [],
      secretEnv: {},
    });
    const { handle } = createWebApp(studio);
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    web = WebDriver.fromServer(server);
  }
  async function shutdown(): Promise<void> {
    await new Promise<void>((r) => server.close(() => r()));
    studio.close();
  }
  const ok = (p: Page, what: string): Page => {
    assert.equal(p.status, 200, `${what}: HTTP ${p.status} at ${p.url}: ${p.text.slice(0, 400)}`);
    assert.equal(p.error, null, `${what}: error shown: ${p.error}`);
    return p;
  };
  const idFrom = (url: string, prefix: string): string => {
    const m = new RegExp(`(${prefix}_[a-z0-9]+)`).exec(url);
    assert.ok(m, `no ${prefix} id in ${url}`);
    return m[1]!;
  };
  const runQueue = async (from: string) => {
    await web.get(from);
    const p = await web.submit('/queue/run');
    const failed = studio.db.all<{ kind: string; error_code: string; error_message: string }>(
      "SELECT kind, error_code, error_message FROM generation_jobs WHERE status = 'failed'",
    );
    assert.deepEqual(failed, [], `queue run: ${p.error ?? p.notice}`);
    return ok(p, 'run queue');
  };

  before(boot);
  after(async () => {
    await shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the project and the story', async () => {
    await web.get('/projects');
    let p = ok(
      await web.submit('/projects', {
        name: 'Milo Test Episode',
        series: 'Milo Adventures',
        description: 'A short test episode about Milo helping a fallen magical star return to the night sky.',
        genre: 'Kids Fantasy Adventure',
        target_audience: 'Kids age 4–8',
        aspect_ratio: '16:9',
        fps: '30',
        default_quality: 'optimized',
        production_notes: '3-scene pipeline test. Keep Milo visually consistent across all scenes.',
      }),
      'create project',
    );
    ids['project'] = idFrom(p.url, 'prj');
    p = ok(
      await web.submit(`/projects/${ids['project']}/stories`, { title: 'Milo and the Glowing Star' }),
      'add story',
    );
    ids['story'] = idFrom(p.url, 'sto');
    ok(await web.get('/stories'), 'stories page');
    assert.ok(web.page!.html.includes(`/stories/${ids['story']}`));
  });

  it('creates a style and makes it the project default', async () => {
    await web.get('/styles');
    const p = ok(
      await web.submit('/styles', {
        name: 'Warm 3D Kids Adventure',
        style_prompt: 'warm 3D animated kids film, soft rounded shapes, gentle lighting',
        rendering: '3D animation',
        lighting: 'warm golden hour',
        colors: 'warm oranges, soft blues, golden highlights',
        camera: 'child eye level',
        negative_prompt: 'scary, dark, realistic photo',
      }),
      'create style',
    );
    assert.match(p.notice ?? '', /./, 'a confirmation is shown');
    const style = studio.projects.listStyles().find((s) => s.name === 'Warm 3D Kids Adventure');
    assert.ok(style, 'style stored');
    ids['style'] = style.id;
    await web.get(`/projects/${ids['project']}`);
    ok(
      await web.submit(`/projects/${ids['project']}/update`, { default_style_id: style.id }),
      'set default style',
    );
    assert.equal(studio.projects.get(ids['project']!).default_style_id, style.id);
    assert.equal(studio.projects.get(ids['project']!).name, 'Milo Test Episode', 'other fields kept');
  });

  it('creates Milo, two locations and the Glowing Star prop', async () => {
    await web.get(`/characters?project=${ids['project']}`);
    let p = ok(
      await web.submit(/^\/characters\?project=/, {
        name: 'Milo',
        role: 'Main character',
        personality: 'A curious, kind young boy who loves exploring and helping others.',
        appearance: 'Consistent child character suitable for a warm 3D animated kids story.',
      }),
      'create character',
    );
    ids['milo'] = idFrom(p.url, 'chr');
    await web.get(`/locations?project=${ids['project']}`);
    for (const [name, description] of [
      ["Milo's House", 'A small cosy cottage with a garden at the edge of a forest.'],
      ['Magical Forest', 'A gentle forest with glowing mushrooms and tall friendly trees.'],
    ] as const) {
      await web.get(`/locations?project=${ids['project']}`);
      p = ok(await web.submit('/locations', { name, description }), `create location ${name}`);
      ids[name] = idFrom(p.url, 'loc');
    }
    await web.get(`/props?project=${ids['project']}`);
    p = ok(
      await web.submit('/props', {
        name: 'Glowing Star',
        description: 'A tiny warm golden magical star emitting a soft glow.',
      }),
      'create prop',
    );
    ids['star'] = idFrom(p.url, 'prp');
    const proj = ok(await web.get(`/projects/${ids['project']}`), 'project page');
    for (const n of ['Milo', "Milo's House", 'Magical Forest', 'Glowing Star'])
      assert.ok(proj.text.includes(n), n);
  });

  it('adds the three scenes with locations, one shot each, cast and narration', async () => {
    for (const [i, sc] of SCENES.entries()) {
      await web.get(`/stories/${ids['story']}`);
      const p = ok(
        await web.submit(`/stories/${ids['story']}/scenes`, {
          title: sc.title,
          summary: sc.summary,
          location_id: ids[sc.location]!,
          time_of_day: sc.time,
        }),
        `scene ${i + 1}`,
      );
      assert.equal(p.notice, 'Scene added');
    }
    const scenes = studio.stories.listScenes(ids['story']!);
    assert.deepEqual(
      scenes.map((s) => s.title),
      SCENES.map((s) => s.title),
      'scenes in order',
    );
    for (const [i, scene] of scenes.entries()) {
      await web.get(`/stories/${ids['story']}`);
      let p = ok(
        await web.submit(`/scenes/${scene.id}/shots`, { title: `Shot ${i + 1}`, action: SCENES[i]!.shot }),
        'shot',
      );
      const shotId = idFrom(p.url, 'sht');
      ids[`shot${i + 1}`] = shotId;
      const castForm = web.form(`/shots/${shotId}/cast`);
      const names = castForm.fields.map((f) => f.name);
      const values: Record<string, string | string[]> = { props: ids['star']! };
      if (names.includes('characters')) values['characters'] = ids['milo']!;
      p = ok(await web.submit(`/shots/${shotId}/cast`, values), 'cast');
      await web.get(`/stories/${ids['story']}`);
      ok(
        await web.submit(`/scenes/${scene.id}/narration`, { text: SCENES[i]!.narration, shot_id: shotId }),
        'narration',
      );
    }
    const tree = studio.stories.tree(ids['story']!);
    assert.equal(tree.scenes.length, 3);
    for (const [i, sc] of tree.scenes.entries()) {
      assert.equal(sc.scene.location_id, ids[SCENES[i]!.location]);
      assert.equal(sc.shots.length, 1);
      assert.deepEqual(sc.shots[0]!.propIds, [ids['star']]);
      assert.equal(sc.narration.length, 1);
    }
  });

  it('builds prompts that carry the character, location, prop and style', async () => {
    for (const n of [1, 2, 3]) {
      const shot = ids[`shot${n}`]!;
      await web.get(`/shots/${shot}`);
      ok(await web.submit(`/shots/${shot}/apply-built`), 'use built prompt');
    }
    const page = ok(await web.get(`/shots/${ids['shot2']}`), 'shot page');
    assert.match(page.text, /Magical Forest/);
    const prompt = web
      .form(`/shots/${ids['shot2']}/prompts`)
      .fields.find((f) => f.name === 'image_prompt')!.value;
    for (const re of [/Milo/i, /star/i, /forest/i, /3D/i]) assert.match(prompt, re, prompt);
  });

  it('generates MOCK images, approves them, animates, and generates MOCK narration audio', async () => {
    await web.get(`/stories/${ids['story']}`);
    let p = ok(await web.submit(`/stories/${ids['story']}/generate-images`), 'queue images');
    assert.match(p.notice ?? '', /image/i);
    await runQueue(`/stories/${ids['story']}`);
    // Approve the newest successful attempt on every shot page (as a person would).
    const approve = async () => {
      let n = 0;
      for (const k of ['shot1', 'shot2', 'shot3']) {
        await web.get(`/shots/${ids[k]}`);
        const f = web.forms().find((x) => /^\/attempts\/[^/]+\/approve$/.test(x.action));
        if (!f) continue;
        ok(await web.submit(f.action), 'approve');
        n++;
      }
      return n;
    };
    assert.equal(await approve(), 3, 'one approved image per shot');
    await web.get(`/stories/${ids['story']}`);
    p = ok(await web.submit(`/stories/${ids['story']}/animate`), 'queue clips');
    assert.match(p.notice ?? '', /clip job/);
    await runQueue(`/stories/${ids['story']}`);
    assert.equal(await approve(), 3, 'one approved clip per shot');
    const lines = studio.stories.tree(ids['story']!).scenes.flatMap((sc) => sc.narration);
    // Without a narrator voice the request is refused up front with guidance (not queued to fail).
    await web.get(`/stories/${ids['story']}`);
    p = await web.submit(`/narration/${lines[0]!.id}/audio`);
    assert.match(p.error ?? '', /Narration needs a narrator voice/);
    assert.equal(studio.db.scalar<number>("SELECT COUNT(*) FROM generation_jobs WHERE kind = 'tts'"), 0);
    // Create the narrator voice and choose it in the project settings, as a user would.
    await web.get(`/characters?project=${ids['project']}`);
    p = ok(
      await web.submit('/voices', { name: 'Storyteller', role: 'narrator', presentation: 'female' }),
      'narrator voice',
    );
    const voice = studio.characters.listVoices(ids['project']!).find((v) => v.name === 'Storyteller')!;
    await web.get(`/projects/${ids['project']}`);
    ok(
      await web.submit(`/projects/${ids['project']}/update`, { narrator_voice_id: voice.id }),
      'choose narrator',
    );
    for (const line of lines) {
      await web.get(`/stories/${ids['story']}`);
      ok(await web.submit(`/narration/${line.id}/audio`), 'queue narration audio');
    }
    await runQueue(`/stories/${ids['story']}`);
    const jobs = studio.db.all<{ kind: string; status: string; error_message: string | null }>(
      'SELECT kind, status, error_message FROM generation_jobs WHERE project_id = ?',
      ids['project'],
    );
    assert.ok(jobs.length >= 9, `jobs: ${jobs.length}`);
    assert.ok(
      jobs.every((j) => j.status === 'complete'),
      JSON.stringify(jobs),
    );
    assert.ok(
      ['image', 'video', 'tts'].every((k) => jobs.some((j) => j.kind === k)),
      JSON.stringify(jobs),
    );
  });

  it('lists the MOCK assets, linked to the project and clearly labelled', async () => {
    const assets = studio.db.all<{ kind: string; is_mock: number; project_id: string; storage_key: string }>(
      'SELECT kind, is_mock, project_id, storage_key FROM generated_assets WHERE project_id = ?',
      ids['project'],
    );
    assert.ok(assets.length >= 9);
    assert.ok(
      assets.every((a) => a.is_mock === 1),
      'every asset is flagged as mock',
    );
    const page = ok(await web.get(`/assets?project=${ids['project']}`), 'assets page');
    assert.match(page.text, /MOCK/i);
    for (const a of assets.slice(0, 3)) {
      const res = await fetch(`${web.base}/media/${a.storage_key}`);
      assert.equal(res.status, 200, `media ${a.storage_key}`);
      await res.arrayBuffer();
    }
    const traversal = await fetch(`${web.base}/media/..%2F..%2Fstudio.sqlite`);
    assert.notEqual(traversal.status, 200, 'no path traversal through /media');
    await traversal.arrayBuffer();
  });

  it('opens the queue, the editor and the quality check', async () => {
    ok(await web.get('/queue'), 'queue page');
    const ed = ok(await web.get(`/editor/${ids['story']}`), 'editor');
    ok(await web.submit(`/editor/${ids['story']}/build`), 'build timeline');
    const tl = studio.db.all<{ track: string }>(
      'SELECT i.track FROM timeline_items i JOIN timelines t ON t.id = i.timeline_id WHERE t.story_id = ?',
      ids['story'],
    );
    assert.ok(tl.length > 0, `timeline items (editor page: ${ed.text.slice(0, 80)})`);
    await web.get(`/quality/${ids['story']}`);
    const q = ok(await web.submit(`/quality/${ids['story']}/run`), 'quality run');
    assert.match(q.text, /mock/i, 'quality check says the media are placeholders');
  });

  it('BUILD FINAL produces the export (a real H.264/AAC 1080p30 MP4 when FFmpeg is available)', async (t) => {
    await web.get(`/stories/${ids['story']}`);
    const p = ok(
      await web.submit(`/stories/${ids['story']}/build-final`, { format: 'landscape' }),
      'build final',
    );
    const exp = studio.db.get<{ id: string; status: string; is_mock: number; output_key: string | null }>(
      `SELECT e.id, e.status, e.is_mock, a.storage_key AS output_key FROM exports e
         LEFT JOIN generated_assets a ON a.id = e.master_asset_id
        WHERE e.story_id = ? ORDER BY e.created_at DESC LIMIT 1`,
      ids['story'],
    );
    assert.ok(exp, `an export row (${p.notice})`);
    assert.equal(exp.status, 'complete', `export status (${p.notice})`);
    ids['export'] = exp.id;
    ok(await web.get('/exports'), 'exports page');
    ok(await web.get(`/exports/${exp.id}`), 'export page');
    if (!FFMPEG) {
      t.skip(
        'FFmpeg not found: the MP4 itself was not produced (set FFMPEG_PATH/FFPROBE_PATH to run this check)',
      );
      return;
    }
    assert.ok(exp.output_key, 'export has an output file');
    const file = studio.storage.localPath(exp.output_key);
    assert.ok(existsSync(file) && statSync(file).size > 1000, `mp4 at ${file}`);
    const probe = JSON.parse(
      execFileSync(FFMPEG.ffprobe, [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        file,
      ]).toString(),
    ) as { streams: Array<Record<string, unknown>>; format: { duration: string } };
    const v = probe.streams.find((s) => s['codec_type'] === 'video')!;
    const a = probe.streams.find((s) => s['codec_type'] === 'audio');
    assert.deepEqual(
      [v['codec_name'], v['width'], v['height'], v['r_frame_rate']],
      ['h264', 1920, 1080, '30/1'],
    );
    assert.equal(a?.['codec_name'], 'aac');
    assert.ok(Number(probe.format.duration) > 3, `duration ${probe.format.duration}`);
  });

  it('backs up (metadata and full) and restores into a fresh, separate studio', async () => {
    const meta = await fetch(`${web.base}/projects/${ids['project']}/backup`);
    assert.equal(meta.status, 200);
    const backup = (await meta.json()) as Record<string, unknown>;
    const full = await fetch(`${web.base}/projects/${ids['project']}/backup?media=1`);
    assert.equal(full.status, 200);
    const fullBody = (await full.json()) as Record<string, unknown>;
    assert.ok(JSON.stringify(fullBody).length > JSON.stringify(backup).length, 'full backup carries media');
    const text = JSON.stringify(backup);
    for (const needle of [
      'Milo Test Episode',
      'Milo and the Glowing Star',
      'Warm 3D Kids Adventure',
      'Glowing Star',
      "Milo's House",
      'Magical Forest',
    ])
      assert.ok(text.includes(needle), `backup contains ${needle}`);

    // Restore into a completely separate data folder (the original is untouched).
    const other = mkdtempSync(join(tmpdir(), 'ais-milo-restore-'));
    const s2 = createStudio({
      env: {
        mockGeneration: true,
        enableCloudGpu: false,
        dataDir: other,
        logLevel: 'error',
        mockFailureRate: 0,
        assemblyMode: 'mock',
      },
      dbPath: join(other, 'studio.sqlite'),
      logSinks: [],
      secretEnv: {},
    });
    try {
      const { handle } = createWebApp(s2);
      const srv2 = createServer((req, res) => void handle(req, res));
      await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', r));
      const w2 = WebDriver.fromServer(srv2);
      await w2.get('/projects');
      const p = ok(
        await w2.submit('/projects/import-backup', { backup: JSON.stringify(fullBody) }),
        'restore',
      );
      const pid = idFrom(p.url, 'prj');
      const st = s2.stories.list(pid);
      assert.equal(st[0]?.title, 'Milo and the Glowing Star');
      assert.equal(s2.stories.listScenes(st[0]!.id).length, 3);
      assert.equal(s2.characters.list(pid)[0]?.name, 'Milo');
      await new Promise<void>((r) => srv2.close(() => r()));
    } finally {
      s2.close();
      rmSync(other, { recursive: true, force: true });
    }
    // Restoring did not change the original studio.
    assert.equal(studio.projects.list().length, 1);
  });

  it('everything is still there after a restart', async () => {
    const before = {
      stories: studio.stories.list(ids['project']!).length,
      scenes: studio.stories.listScenes(ids['story']!).length,
      assets: studio.db.scalar<number>('SELECT COUNT(*) FROM generated_assets'),
      jobs: studio.db.scalar<number>('SELECT COUNT(*) FROM generation_jobs'),
    };
    await shutdown();
    await boot();
    const after = {
      stories: studio.stories.list(ids['project']!).length,
      scenes: studio.stories.listScenes(ids['story']!).length,
      assets: studio.db.scalar<number>('SELECT COUNT(*) FROM generated_assets'),
      jobs: studio.db.scalar<number>('SELECT COUNT(*) FROM generation_jobs'),
    };
    assert.deepEqual(after, before);
    for (const path of [
      '/',
      '/projects',
      '/stories',
      `/stories/${ids['story']}`,
      `/characters/${ids['milo']}`,
      '/assets',
      '/queue',
      `/editor/${ids['story']}`,
      `/quality/${ids['story']}`,
      '/exports',
      '/logs',
    ])
      ok(await web.get(path), path);
  });

  it('never contacted a cloud provider (mock mode)', () => {
    assert.equal(studio.cloud.mode(), 'MOCK');
    assert.equal(studio.gpu.currentProvider.paid, false);
    assert.equal(
      studio.db.scalar<number>("SELECT COUNT(*) FROM gpu_instances WHERE provider NOT LIKE 'mock%'"),
      0,
    );
  });
});
