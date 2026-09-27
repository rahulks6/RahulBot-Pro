import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { checkImagePullable, parseChallenge, parseImage } from '../src/services/image-check.ts';
import { MockRegistry } from './fixtures/mock-registry.ts';

/** Worker-image pullability, against a local fake registry (no network, no credentials). */
describe('worker image verification (mock registry)', () => {
  const reg = new MockRegistry();
  const check = (image: string) => checkImagePullable(image, { baseUrlFor: () => reg.base, timeoutMs: 2000 });

  before(async () => {
    await reg.start();
  });
  after(() => reg.stop());
  beforeEach(() => {
    reg.repos.clear();
    reg.requests = [];
    reg.deniedStyle = 'ghcr';
    reg.refuseAnonymousTokens = false;
    reg.failWith = null;
    reg.proxyBlock = false;
  });

  it('IMAGE EXISTS AND PUBLICLY PULLABLE: anonymous token flow, no credentials sent', async () => {
    reg.repos.set('rahulks6/ai-story-studio-worker', {
      visibility: 'public',
      tags: { '1.2.0': { platforms: ['linux/amd64', 'unknown/unknown'] } },
    });
    const r = await check('ghcr.io/rahulks6/ai-story-studio-worker:1.2.0');
    assert.equal(r.status, 'PUBLIC', r.detail);
    assert.deepEqual(r.platforms, ['linux/amd64']);
    assert.match(r.digest ?? '', /^sha256:/);
    assert.equal(reg.requests[0]!.auth, undefined, 'first request is anonymous');
    assert.ok(
      reg.requests.some(
        (q) =>
          q.path.startsWith('/token?') &&
          q.path.includes('scope=repository%3Arahulks6%2Fai-story-studio-worker%3Apull'),
      ),
    );
    assert.match(reg.requests.at(-1)!.auth ?? '', /^Bearer anon:/, 'only the anonymous pull token is used');
  });

  it('IMAGE REQUIRES AUTHENTICATION: a private package (HTTP 403 DENIED)', async () => {
    reg.repos.set('rahulks6/ai-story-studio-worker', {
      visibility: 'private',
      tags: { '1.2.0': { platforms: ['linux/amd64'] } },
    });
    const r = await check('ghcr.io/rahulks6/ai-story-studio-worker:1.2.0');
    assert.equal(r.status, 'AUTH_REQUIRED');
    assert.match(r.detail, /private or not published \(HTTP 403 DENIED\)/);
    assert.match(
      r.detail,
      /GitHub Container Registry gives this same answer when the package was never pushed/,
    );
    reg.refuseAnonymousTokens = true;
    assert.equal((await check('ghcr.io/rahulks6/ai-story-studio-worker:1.2.0')).status, 'AUTH_REQUIRED');
  });

  it('IMAGE DOES NOT EXIST: missing tag, missing repository, or no linux/amd64 build', async () => {
    reg.repos.set('rahulks6/ai-story-studio-worker', {
      visibility: 'public',
      tags: { '1.0.0': { platforms: ['linux/amd64'] } },
    });
    const tag = await check('ghcr.io/rahulks6/ai-story-studio-worker:1.2.0');
    assert.equal(tag.status, 'NOT_FOUND');
    assert.match(tag.detail, /there is no tag "1\.2\.0"/);
    reg.deniedStyle = 'strict';
    const repo = await check('ghcr.io/someone/else:1');
    assert.equal(repo.status, 'NOT_FOUND');
    assert.match(repo.detail, /repository does not exist/);
    reg.repos.set('a/arm', { visibility: 'public', tags: { x: { platforms: ['linux/arm64'] } } });
    const arm = await check('ghcr.io/a/arm:x');
    assert.equal(arm.status, 'NOT_FOUND');
    assert.match(arm.detail, /no linux\/amd64 build/);
  });

  it('REGISTRY UNREACHABLE: network failure, server errors and rate limits are not blamed on the image', async () => {
    const down = await checkImagePullable('ghcr.io/a/b:1', {
      baseUrlFor: () => 'http://127.0.0.1:9',
      timeoutMs: 2000,
    });
    assert.equal(down.status, 'UNREACHABLE');
    assert.match(down.detail, /Could not reach ghcr\.io/);
    reg.failWith = 503;
    assert.equal((await check('ghcr.io/a/b:1')).status, 'UNREACHABLE');
    reg.failWith = null;
    reg.proxyBlock = true;
    const proxy = await check('ghcr.io/a/b:1');
    assert.equal(proxy.status, 'UNREACHABLE', 'a proxy/firewall 403 is not "private"');
    assert.match(proxy.detail, /did not come from the registry/);
    reg.proxyBlock = false;
    reg.failWith = 429;
    assert.match((await check('ghcr.io/a/b:1')).detail, /rate-limiting/);
  });

  it('rejects invalid names without any request', async () => {
    for (const bad of ['', 'Has Spaces/x:1', 'ghcr.io/UPPER/x:1', 'ghcr.io/a/b:bad tag'])
      assert.equal((await check(bad)).status, 'INVALID', bad);
    assert.equal(reg.requests.length, 0);
  });
});

describe('image name and challenge parsing (units)', () => {
  it('parses registries, Docker Hub defaults, tags and digests', () => {
    assert.deepEqual(parseImage('ghcr.io/rahulks6/ai-story-studio-worker:1.2.0'), {
      registry: 'ghcr.io',
      apiHost: 'ghcr.io',
      repository: 'rahulks6/ai-story-studio-worker',
      reference: '1.2.0',
    });
    assert.deepEqual(parseImage('ubuntu'), {
      registry: 'docker.io',
      apiHost: 'registry-1.docker.io',
      repository: 'library/ubuntu',
      reference: 'latest',
    });
    assert.equal(parseImage('localhost:5000/team/img:dev')!.registry, 'localhost:5000');
    assert.equal(parseImage(`ghcr.io/a/b@sha256:${'f'.repeat(64)}`)!.reference, `sha256:${'f'.repeat(64)}`);
  });

  it('parses a Bearer challenge', () => {
    assert.deepEqual(
      parseChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"'),
      {
        realm: 'https://ghcr.io/token',
        service: 'ghcr.io',
        scope: 'repository:a/b:pull',
      },
    );
    assert.equal(parseChallenge('Basic realm="x"'), null);
    assert.equal(parseChallenge(null), null);
  });
});
