// Browser smoke test: drives AI Story Studio in a real browser (JavaScript on, real clicks).
// NOT part of `npm test` (it needs Playwright and a running app). Usage:
//
//   node test/e2e/browser-smoke.mjs --base http://127.0.0.1:3000 [--channel msedge] [--verify-only]
//
// Playwright is resolved from PLAYWRIGHT_MODULE, then from a normal `require('playwright')`,
// then `playwright-core`. It creates "Milo Test Episode" data in the app it points at, so run it
// against a throw-away data folder (the CI job does), never against your own data.
// --verify-only checks that the data from a previous run survived an app restart.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const base = opt('base', 'http://127.0.0.1:3000').replace(/\/$/, '');
const channel = opt('channel', '');
const verifyOnly = args.includes('--verify-only');
const outDir = opt('out', 'e2e-results');
mkdirSync(outDir, { recursive: true });

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean);
  for (const t of tries) {
    try {
      return require(t);
    } catch {
      /* next */
    }
  }
  throw new Error(`Playwright not found (tried ${tries.join(', ')}). Set PLAYWRIGHT_MODULE.`);
}
const { chromium } = loadPlaywright();
const launch = channel
  ? { channel }
  : process.env.PW_EXECUTABLE
    ? { executablePath: process.env.PW_EXECUTABLE }
    : {};
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const results = [];
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('dialog', (d) => d.accept());

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String(err?.message ?? err) });
    console.log(`FAIL  ${name} — ${err?.message ?? err}`);
    await page
      .screenshot({ path: join(outDir, `${name.replace(/[^a-z0-9]+/gi, '_')}.png`), fullPage: true })
      .catch(() => {});
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const notice = async () =>
  (await page.locator('.notice, .flash, [role=status]').allTextContents()).join(' ').trim();
const errorText = async () => (await page.locator('.error, [role=alert]').allTextContents()).join(' ').trim();
async function clickAndWait(locator) {
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), locator.click()]);
}

if (!verifyOnly) {
  await step('open Projects', async () => {
    await page.goto(`${base}/projects`);
    expect((await page.title()).startsWith('Projects'), `title: ${await page.title()}`);
  });

  let projectUrl = '';
  await step('create project "Milo Test Episode" (form + click)', async () => {
    const f = page.locator('form[action="/projects"]');
    await f.locator('[name=name]').fill('Milo Test Episode');
    await f.locator('[name=series]').fill('Milo Adventures');
    await f
      .locator('[name=description]')
      .fill('A short test episode about Milo helping a fallen magical star return to the night sky.');
    await f.locator('[name=genre]').fill('Kids Fantasy Adventure');
    await f.locator('[name=target_audience]').fill('Kids age 4–8');
    await f.locator('[name=aspect_ratio]').selectOption('16:9');
    await f.locator('[name=fps]').selectOption('30');
    await f.locator('[name=default_quality]').selectOption('optimized');
    await f
      .locator('[name=production_notes]')
      .fill('3-scene pipeline test. Keep Milo visually consistent across all scenes.');
    await clickAndWait(f.locator('button').last());
    projectUrl = page.url();
    expect(/\/projects\/prj_/.test(projectUrl), `landed on ${projectUrl} ${await errorText()}`);
    return projectUrl;
  });

  await step('Add story "Milo and the Glowing Star" (click the Add story button)', async () => {
    const f = page.locator('form[action$="/stories"]');
    await f.locator('[name=title]').fill('Milo and the Glowing Star');
    await clickAndWait(f.getByRole('button', { name: 'Add story' }));
    const url = page.url();
    const msg = await notice();
    expect(/\/stories\/sto_/.test(url), `landed on ${url}; error: ${await errorText()}`);
    expect(/Milo and the Glowing Star/.test(await page.locator('h1').innerText()), 'story heading');
    return `${url} · "${msg}"`;
  });

  await step('Add story with Enter key (keyboard submit)', async () => {
    await page.goto(projectUrl);
    const f = page.locator('form[action$="/stories"]');
    await f.locator('[name=title]').fill('Milo Keyboard Story');
    await Promise.all([page.waitForNavigation(), f.locator('[name=title]').press('Enter')]);
    expect(/\/stories\/sto_/.test(page.url()), `landed on ${page.url()}; error: ${await errorText()}`);
  });
}

await step('Stories page lists the story (after reload)', async () => {
  await page.goto(`${base}/stories`);
  await page.reload();
  const text = await page.locator('main').innerText();
  expect(!text.includes('Nothing here yet.'), 'Stories page says "Nothing here yet."');
  expect(text.includes('Milo and the Glowing Star'), 'story missing from /stories');
  expect(text.includes('Milo Test Episode'), 'project missing from /stories');
});

await step('open the story from the Stories page', async () => {
  await clickAndWait(page.getByRole('link', { name: 'Milo and the Glowing Star' }).first());
  expect(/\/stories\/sto_/.test(page.url()), page.url());
});

if (!verifyOnly) {
  const projectId = await page
    .locator('a[href^="/projects/prj_"]')
    .first()
    .getAttribute('href')
    .then((h) => h.split('/')[2]);

  await step('add three scenes', async () => {
    for (const title of ['Sunset at home', 'Into the forest', 'Home to the sky']) {
      const f = page.locator('form[action$="/scenes"]');
      await f.locator('[name=title]').fill(title);
      await clickAndWait(f.getByRole('button', { name: 'Add scene' }));
      expect(
        (await notice()).includes('Scene added'),
        `notice: ${await notice()} error: ${await errorText()}`,
      );
    }
  });

  await step('create character Milo', async () => {
    await page.goto(`${base}/characters?project=${projectId}`);
    const f = page.locator(`form[action^="/characters?project="]`);
    await f.locator('[name=name]').fill('Milo');
    await f.locator('[name=role]').fill('Main character');
    await f
      .locator('[name=personality]')
      .fill('A curious, kind young boy who loves exploring and helping others.');
    await clickAndWait(f.locator('button').last());
    expect(/\/characters\/chr_/.test(page.url()), `${page.url()} ${await errorText()}`);
  });

  for (const name of ["Milo's House", 'Magical Forest']) {
    await step(`create location ${name}`, async () => {
      await page.goto(`${base}/locations?project=${projectId}`);
      const f = page.locator('form[method=post][action="/locations"]');
      await f.locator('[name=name]').fill(name);
      await clickAndWait(f.locator('button').last());
      expect(/\/locations\/loc_/.test(page.url()), `${page.url()} ${await errorText()}`);
    });
  }

  await step('create prop Glowing Star', async () => {
    await page.goto(`${base}/props?project=${projectId}`);
    const f = page.locator('form[method=post][action="/props"]');
    await f.locator('[name=name]').fill('Glowing Star');
    await f.locator('[name=description]').fill('A tiny warm golden magical star emitting a soft glow.');
    await clickAndWait(f.locator('button').last());
    expect(/\/props\/prp_/.test(page.url()), `${page.url()} ${await errorText()}`);
  });

  await step('create style Warm 3D Kids Adventure', async () => {
    await page.goto(`${base}/styles`);
    const f = page.locator('form[method=post][action="/styles"]');
    await f.locator('[name=name]').fill('Warm 3D Kids Adventure');
    await clickAndWait(f.locator('button').last());
    expect(!(await errorText()), await errorText());
  });
}

const NAV = [
  'Dashboard',
  'Projects',
  'Stories',
  'Characters',
  'Locations',
  'Props',
  'Styles',
  'Assets',
  'Generation Queue',
  'Editor',
  'Quality Check',
  'Exports',
  'GPU & Costs',
  'Model Benchmarks',
  'Cloud GPU',
  'Settings',
  'System Health',
  'Logs',
];
for (const label of NAV) {
  await step(`nav: ${label}`, async () => {
    await page.goto(`${base}/`);
    const res = page.waitForNavigation();
    await page.locator('nav').getByRole('link', { name: label, exact: true }).click();
    const r = await res;
    expect(r && r.status() === 200, `HTTP ${r?.status()}`);
    const title = await page.title();
    expect(!title.startsWith('Error'), `error page: ${await page.locator('main').innerText()}`);
    expect(/MODE: MOCK/.test(await page.locator('body').innerText()), 'mock-mode banner missing');
  });
}

await step('no JavaScript errors in the pages', async () => {
  expect(consoleErrors.length === 0, consoleErrors.join('; '));
});

await browser.close();
writeFileSync(join(outDir, verifyOnly ? 'verify.json' : 'smoke.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
