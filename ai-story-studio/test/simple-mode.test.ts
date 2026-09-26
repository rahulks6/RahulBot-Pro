import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { encodePng } from '../src/media/png.ts';
import { studioProject } from '../src/services/simple-studio.ts';
import { createWebApp } from '../src/web/app.ts';
import { testStudio, type TestStudio } from './helpers.ts';
import { WebDriver } from './fixtures/web-driver.ts';

/** Simple Mode pages through HTTP forms, like a browser: menu, My Videos, the Characters library. */
describe('Simple Mode pages', () => {
  let s: TestStudio;
  let server: Server;
  let web: WebDriver;
  before(async () => {
    s = testStudio();
    const { handle } = createWebApp(s);
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    web = WebDriver.fromServer(server);
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    s.cleanup();
  });

  it('the Simple menu has only the product pages that exist', async () => {
    const home = await web.get('/');
    const nav = /<nav class="sidebar">([\s\S]*?)<\/nav>/.exec(home.html)![1]!;
    const links = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const l of links) assert.equal((await web.get(l!)).status, 200, `${l} answers`);
    assert.ok(links.includes('/') && links.includes('/settings') && links.includes('/videos'));
    assert.ok(!links.includes('/benchmarks') && !links.includes('/queue'), 'no Advanced tools');
  });

  it('My Videos: empty state and status filters', async () => {
    const p = await web.get('/videos');
    assert.equal(p.status, 200);
    assert.match(p.text, /No videos here/);
    for (const f of ['draft', 'generating', 'attention', 'ready', 'approved', 'scheduled', 'published'])
      assert.equal((await web.get(`/videos?show=${f}`)).status, 200);
  });

  it('Characters: create with a picture (used right away), edit, add another picture', async () => {
    await web.get('/library/characters');
    const png = `data:image/png;base64,${Buffer.from(encodePng(16, 16, () => [200, 120, 40])).toString('base64')}`;
    const created = await web.submit('/library/characters', {
      name: 'Milo',
      description: 'A curious fox cub with a green scarf',
      image: png,
    });
    assert.match(created.notice ?? '', /Milo saved/);
    const project = studioProject(s);
    const milo = s.characters.findByName(project.id, 'Milo')!;
    assert.ok(milo, 'stored in the shared Simple Mode project');
    const refs = s.characters.listReferences(milo.id);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.approved, 1, "the user's own picture is used");
    assert.equal(refs[0]!.slot, 'front');
    const page = await web.get(`/library/characters/${milo.id}`);
    assert.match(page.text, /used/);
    const edited = await web.submit(`/library/characters/${milo.id}`, {
      description: 'A curious fox cub with a green scarf and a red backpack',
      image: png,
    });
    assert.match(edited.notice ?? '', /Saved/);
    assert.match(s.characters.get(milo.id).appearance, /red backpack/);
    assert.equal(s.characters.listReferences(milo.id).length, 2);
    const again = await web.get('/library/characters');
    assert.match(again.text, /2 approved picture\(s\)/);
  });

  it('refuses a fake picture and a character without a description', async () => {
    await web.get('/library/characters');
    const bad = await web.submit('/library/characters', {
      name: 'Nia',
      description: 'A brave owl',
      image: `data:image/png;base64,${Buffer.from('not an image at all').toString('base64')}`,
    });
    assert.match(bad.error ?? '', /not the picture type/);
    await web.get('/library/characters');
    const empty = await web.submit('/library/characters', { name: 'Nia', description: '' });
    assert.ok(empty.error);
    assert.equal(s.characters.findByName(studioProject(s).id, 'Nia'), undefined, 'nothing half-saved');
  });

  it('Simple Settings save the defaults for new videos and the spending limits', async () => {
    await web.get('/settings');
    const p = await web.submit('/settings/simple/defaults', {
      defaultStyle: 'anime',
      defaultLength: 'standard',
      language: 'hinglish',
      shortsCount: '3',
    });
    assert.match(p.notice ?? '', /Saved/);
    const a = s.settings.get('app');
    assert.equal(a.defaultStyle, 'anime');
    assert.equal(a.defaultLength, 'standard');
    assert.equal(a.language, 'hinglish');
    assert.equal(a.shortsCount, 3);
    await web.get('/settings');
    await web.submit('/settings/simple/limits', { sessionBudgetInr: '99', dailyInr: '300' });
    assert.equal(s.settings.get('cloud').sessionBudgetInr, 99);
    assert.equal(s.settings.get('budget').dailyInr, 300);
  });

  it('an install still on the old default worker image moves to the current one', () => {
    s.settings.set('cloud', {
      ...s.settings.get('cloud'),
      workerImage: 'ghcr.io/rahulks6/ai-story-studio-worker:1.1.0',
    });
    assert.equal(s.settings.get('cloud').workerImage, 'ghcr.io/rahulks6/ai-story-studio-worker:1.2.0');
    s.settings.set('cloud', { ...s.settings.get('cloud'), workerImage: 'ghcr.io/someone/custom-worker:7' });
    assert.equal(
      s.settings.get('cloud').workerImage,
      'ghcr.io/someone/custom-worker:7',
      'a custom image is kept',
    );
  });
});
