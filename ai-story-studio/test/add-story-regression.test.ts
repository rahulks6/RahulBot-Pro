import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createStudio, type Studio } from '../src/app/studio.ts';
import { createWebApp } from '../src/web/app.ts';
import { WebDriver } from './fixtures/web-driver.ts';

/**
 * Regression for the real manual test failure (v1.1.0): Projects → open project → "New story
 * title" → Add story, then the Stories page must list the story — after a refresh and after an
 * application restart. Driven through the real web routes and the real form markup, against a
 * FILE database in a temporary folder (never the user's data folder).
 */
describe('Add Story regression (project page → Stories, refresh, restart)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ais-addstory-'));
  const dbPath = join(dir, 'data', 'studio.sqlite');
  let studio: Studio;
  let server: Server;
  let web: WebDriver;

  async function boot(): Promise<void> {
    studio = createStudio({
      env: {
        mockGeneration: true,
        enableCloudGpu: false,
        dataDir: join(dir, 'data'),
        logLevel: 'error',
        mockFailureRate: 0,
        assemblyMode: 'mock',
      },
      dbPath,
      logSinks: [],
      secretEnv: {},
    });
    const { handle } = createWebApp(studio); // a fresh random CSRF token, like a real restart
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    web = WebDriver.fromServer(server);
  }

  async function shutdown(): Promise<void> {
    await new Promise<void>((r) => server.close(() => r()));
    studio.close();
  }

  before(boot);
  after(async () => {
    await shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  let projectId = '';
  let storyId = '';

  it('1–2. creates the Milo project through the Projects form and opens it', async () => {
    await web.get('/projects');
    const page = await web.submit('/projects', {
      name: 'Milo Test Episode',
      series: 'Milo Adventures',
      description: 'A short test episode about Milo helping a fallen magical star return to the night sky.',
      genre: 'Kids Fantasy Adventure',
      target_audience: 'Kids age 4–8',
      aspect_ratio: '16:9',
      fps: '30',
      default_quality: 'optimized',
      production_notes: '3-scene pipeline test. Keep Milo visually consistent across all scenes.',
    });
    assert.equal(page.status, 200);
    assert.match(page.url, /^\/projects\/prj_[a-z0-9]+\?/);
    assert.equal(page.error, null);
    projectId = page.url.split('/')[2]!.split('?')[0]!;
    const p = studio.projects.get(projectId);
    assert.deepEqual(
      [p.name, p.series, p.fps, p.aspect_ratio, p.width, p.height],
      ['Milo Test Episode', 'Milo Adventures', 30, '16:9', 1920, 1080],
    );
  });

  it('3–5. Add story on the project page creates a story that belongs to the project', async () => {
    const page = await web.submit(`/projects/${projectId}/stories`, { title: 'Milo and the Glowing Star' });
    assert.equal(page.status, 200, page.text.slice(0, 300));
    assert.equal(page.error, null, `unexpected error: ${page.error}`);
    assert.match(page.url, /^\/stories\/sto_[a-z0-9]+\?/, 'lands on the new story');
    assert.equal(page.notice, "Story 'Milo and the Glowing Star' created.");
    assert.match(page.text, /Milo and the Glowing Star/);
    storyId = page.url.split('/')[2]!.split('?')[0]!;
    const st = studio.stories.get(storyId);
    assert.equal(st.project_id, projectId);
    assert.equal(st.title, 'Milo and the Glowing Star');
  });

  it('6–9. the story is listed on /stories and on the project page (fresh GETs = browser refresh)', async () => {
    let page = await web.get('/stories');
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes('Nothing here yet.'), 'Stories page is not empty');
    assert.ok(page.html.includes(`href="/stories/${storyId}"`), 'links to the story');
    assert.match(page.text, /Milo Test Episode .*Milo and the Glowing Star/);
    page = await web.get(`/projects/${projectId}`);
    assert.ok(page.html.includes(`href="/stories/${storyId}"`), 'listed on the project page');
    page = await web.get(`/stories/${storyId}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Milo and the Glowing Star/);
  });

  it('10–11. survives an application restart (new process state, same database file)', async () => {
    await shutdown();
    await boot();
    const page = await web.get('/stories');
    assert.ok(page.html.includes(`href="/stories/${storyId}"`), 'still listed after restart');
    assert.equal(studio.stories.get(storyId).project_id, projectId);
  });

  it('a missing title or an unknown project is reported, never a silent redirect', async () => {
    await web.get(`/projects/${projectId}`);
    let page = await web.submit(`/projects/${projectId}/stories`, { title: '   ' });
    assert.equal(page.error, 'Story title is required.');
    assert.match(page.url, new RegExp(`^/projects/${projectId}\\?`), 'back on the project page');
    await web.get(`/projects/${projectId}`);
    page = await web.post('/projects/prj_doesnotexist/stories', { title: 'Orphan' });
    assert.equal(page.error, 'Project could not be found.');
    assert.equal(
      studio.db.scalar<number>("SELECT COUNT(*) FROM stories WHERE title = 'Orphan'"),
      0,
      'no orphan story',
    );
  });

  it('a form from before a restart (stale CSRF token) explains itself and offers a way back', async () => {
    await web.get(`/projects/${projectId}`);
    const stale = web.page!;
    await shutdown();
    await boot(); // new token; the old page is still "open in the browser"
    web.page = stale;
    const page = await web.submit(`/projects/${projectId}/stories`, { title: 'After restart' });
    assert.equal(page.status, 403);
    assert.match(page.text, /AI Story Studio was restarted after this page was opened/);
    assert.ok(page.html.includes(`href="/projects/${projectId}"`), 'link back to the page it came from');
    assert.equal(studio.db.scalar<number>("SELECT COUNT(*) FROM stories WHERE title = 'After restart'"), 0);
  });
});
