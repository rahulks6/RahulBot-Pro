import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { Logger, MemorySink, redact } from '../src/lib/logger.ts';
import { array, object, string, validate } from '../src/lib/schema.ts';
import { validateStorageKey } from '../src/storage/storage.ts';
import { readEnv } from '../src/config/env.ts';
import { encodeWav } from '../src/media/wav.ts';
import { createWebApp } from '../src/web/app.ts';
import { seedSmall, testStudio, type TestStudio } from './helpers.ts';

describe('security-sensitive validation', () => {
  it('rejects storage keys that could escape the storage root', () => {
    for (const bad of [
      '../x.png',
      'a/../../x.png',
      '/etc/passwd.png',
      'a/.hidden.png',
      'a\\b.png',
      'x.exe',
      'a//b.png',
      '',
    ]) {
      assert.throws(
        () => validateStorageKey(bad),
        (e: AppError) => e.code === 'FORBIDDEN',
        bad,
      );
    }
    validateStorageKey('projects/prj_1/images/ast_2.png');
  });

  it('never logs credentials', () => {
    const sink = new MemorySink();
    new Logger('info', [sink]).info('provider call', {
      apiKey: 'sk-live-1234567890abcdef',
      headers: { Authorization: 'Bearer abc.def.ghi' },
      note: 'token sk_test_ABCDEFGHIJKLMNOP leaked?',
      gpu: 'L4',
    });
    const line = sink.lines[0]!;
    assert.ok(
      !line.includes('1234567890abcdef') &&
        !line.includes('ABCDEFGHIJKLMNOP') &&
        !line.includes('abc.def.ghi'),
    );
    assert.ok(line.includes('"gpu":"L4"'));
    assert.deepEqual(redact({ password: 'x' }), { password: '[REDACTED]' });
  });

  it('enforces schema limits and rejects unknown fields', () => {
    const schema = object({ name: string({ max: 5 }), tags: array(string(), { max: 2 }) });
    const r = validate(schema, { name: 'toolong', tags: ['a', 'b', 'c'], extra: 1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual(r.errors.map((e) => e.path).sort(), ['extra', 'name', 'tags']);
  });

  it('defaults to mock mode and cloud GPU off', () => {
    const env = readEnv({});
    assert.equal(env.mockGeneration, true);
    assert.equal(env.enableCloudGpu, false);
    assert.equal(env.host, '127.0.0.1');
    assert.equal(readEnv({ MOCK_GENERATION: '' }).mockGeneration, true);
  });
});

describe('web app', () => {
  let s: TestStudio;
  let server: Server;
  let base = '';
  const token = 'test-csrf-token';
  before(async () => {
    s = testStudio();
    seedSmall(s);
    const { handle } = createWebApp(s, { csrfToken: token });
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    s.cleanup();
  });

  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields),
    });

  it('serves every main navigation page with security headers', async () => {
    for (const path of [
      '/',
      '/projects',
      '/stories',
      '/characters',
      '/locations',
      '/props',
      '/styles',
      '/assets',
      '/queue',
      '/editor',
      '/quality',
      '/exports',
      '/gpu',
      '/settings',
      '/stories/import',
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
  });

  it('rejects POSTs without a valid CSRF token or from another origin', async () => {
    assert.equal((await post('/projects', { name: 'X' })).status, 403);
    assert.equal((await post('/projects', { name: 'X', _csrf: 'wrong' })).status, 403);
    assert.equal(
      (await post('/projects', { name: 'X', _csrf: token }, { origin: 'http://evil.example' })).status,
      403,
    );
    const ok = await post('/projects', { name: 'Created via web', _csrf: token });
    assert.equal(ok.status, 303);
    assert.ok(s.projects.list().some((p) => p.name === 'Created via web'));
  });

  it('escapes user content in pages', async () => {
    const p = s.projects.create({ name: '<script>alert(1)</script>' });
    const html = await (await fetch(`${base}/projects/${p.id}`)).text();
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  it('attaches a voice reference only with consent, and revokes it', async () => {
    const voice = s.db.get<{ id: string }>("SELECT id FROM voice_profiles WHERE role = 'character' LIMIT 1")!;
    const wav = encodeWav({ sampleRate: 16000, samples: new Float32Array(16000 * 4).fill(0.1) });
    const fields = {
      reference: `data:audio/wav;base64,${wav.toString('base64')}`,
      speaker_name: 'Me',
      relationship: 'self',
      method: 'self',
      scope: 'stories',
      evidence: '',
      confirm: 'false',
      _csrf: token,
    };
    const refused = await post(`/voices/${voice.id}/reference`, fields);
    assert.equal(s.voiceRefs.list(voice.id).length, 0, `no consent → nothing stored (${refused.status})`);
    const ok = await post(`/voices/${voice.id}/reference`, { ...fields, confirm: 'true' });
    assert.equal(ok.status, 303);
    const consent = s.voiceRefs.active(s.characters.getVoice(voice.id))!;
    assert.equal(consent.speaker_name, 'Me');
    const page = await (await fetch(`${base}/voices/${voice.id}`)).text();
    assert.match(page, /consent required/);
    assert.match(page, /Revoke consent/);
    const revoked = await post(`/voice-consents/${consent.id}/revoke`, { reason: 'test', _csrf: token });
    assert.equal(revoked.status, 303);
    assert.equal(s.voiceRefs.active(s.characters.getVoice(voice.id)), undefined);
  });

  it('blocks path traversal on media URLs', async () => {
    for (const path of [
      '/media/..%2F..%2Fstudio.sqlite',
      '/media/projects/../../etc/passwd.png',
      '/media/x.exe',
    ]) {
      const res = await fetch(base + path);
      assert.ok([403, 404].includes(res.status), `${path} → ${res.status}`);
    }
  });

  it('serves media with byte ranges (video seeking)', async () => {
    const key = 'projects/prj_test/audio/ast_range.wav';
    await s.storage.put(key, Buffer.from('0123456789'));
    const part = await fetch(`${base}/media/${key}`, { headers: { range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await part.text(), '2345');
    const tail = await fetch(`${base}/media/${key}`, { headers: { range: 'bytes=-3' } });
    assert.equal(await tail.text(), '789');
    assert.equal((await fetch(`${base}/media/${key}`, { headers: { range: 'bytes=50-' } })).status, 416);
  });

  it('limits request body size', async () => {
    const res = await post('/projects', { name: 'x'.repeat(5 * 1024 * 1024), _csrf: token });
    assert.notEqual(res.status, 200);
    assert.ok(!s.projects.list().some((p) => p.name.startsWith('xxxx')));
  });

  it('kill switch requires the typed confirmation', async () => {
    const res = await post('/gpu/kill-all', { confirm: 'please', _csrf: token }, { referer: `${base}/gpu` });
    assert.equal(res.status, 303);
    assert.match(
      new URL(res.headers.get('location') ?? '', base).searchParams.get('error') ?? '',
      /Type TERMINATE ALL to confirm/,
    );
  });

  it('shows validation errors for bad Story Package input without importing', async () => {
    const res = await post(
      '/stories/import',
      { package: '{"format":"x"}', _mode: 'import', project_id: '', _csrf: token },
      { referer: `${base}/stories/import` },
    );
    assert.equal(res.status, 303);
    assert.match(
      new URL(res.headers.get('location') ?? '', base).searchParams.get('error') ?? '',
      /Story Package is invalid/,
    );
    assert.equal(s.reports.imports()[0]!.status, 'failed');
  });
});
