import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { RunPodApi } from '../src/providers/cloud/runpod.ts';
import { MockRunPod } from './fixtures/mock-runpod.ts';

/**
 * Every HTTP outcome RunPod can give, through a stubbed fetch (no network, nothing billed):
 * a clear, sanitized message, the right error code, retries only where safe, and the key
 * never appears anywhere in the error.
 */
const KEY = 'rpa_SECRETKEY0123456789abcdef';

function api(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  calls: string[] = [],
) {
  return new RunPodApi({
    apiKey: KEY,
    baseUrl: 'https://runpod.test/v2',
    sleep: async () => undefined,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    fetch: (async (u: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(u)).pathname}`);
      return respond(String(u), init ?? {});
    }) as typeof fetch,
  });
}
const problem = (status: number, detail: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ title: 'Error', status, detail, ...extra }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    const e = err as AppError;
    assert.ok(!e.message.includes(KEY) && !e.message.includes('SECRETKEY'), `key leaked: ${e.message}`);
    return e;
  }
  throw new Error('expected a failure');
}

describe('RunPod error handling matrix (stubbed, ₹0)', () => {
  it('400 → CLOUD_BAD_REQUEST with the validation detail, not retried', async () => {
    const calls: string[] = [];
    const e = await failure(
      api(() => problem(400, 'count must be >= 1', { errors: ['$.count: minimum 1'] }), calls).listPods(),
    );
    assert.equal(e.code, 'CLOUD_BAD_REQUEST');
    assert.match(e.message, /HTTP 400\): count must be >= 1; \$\.count: minimum 1/);
    assert.equal(calls.length, 1);
  });

  it('401 and 403 → CLOUD_AUTH_FAILED with a fixed message, not retried', async () => {
    for (const status of [401, 403]) {
      const calls: string[] = [];
      const e = await failure(api(() => problem(status, `bad token ${KEY}`), calls).testConnection());
      assert.equal(e.code, 'CLOUD_AUTH_FAILED');
      assert.equal(e.message, 'RunPod authentication failed. Check your API key.');
      assert.equal(calls.length, 1, `${status} not retried`);
    }
  });

  it('404 → a missing pod reads as "gone" (null) and terminate is idempotent', async () => {
    const a = api(() => problem(404, 'pod not found'));
    assert.equal(await a.getPod('pod123'), null);
    await a.terminatePod('pod123');
    const e = await failure(a.listPods());
    assert.equal(e.code, 'NOT_FOUND');
  });

  it('409 on create (no capacity) → clear message, sent once, never retried (no duplicate pods)', async () => {
    // The local mock RunPod publishes the real contract (so the pre-create check passes), enforces
    // the published create schema, and answers 409 for a GPU with no stock (L4, secure cloud).
    const rp = await new MockRunPod().start();
    try {
      const a = new RunPodApi({
        apiKey: rp.apiKey,
        baseUrl: rp.baseUrl,
        sleep: async () => undefined,
        retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });
      const e = await failure(
        a.createPod({
          name: 'ais-x-1',
          image: 'ghcr.io/x/y:1',
          gpuTypeId: 'NVIDIA L4',
          gpuCount: 1,
          cloud: 'SECURE',
          env: { WORKER_AUTH_TOKEN: 'aisw_secret_token_value_123456' },
          ports: ['8765/http'],
          containerDiskGb: 40,
        }),
      );
      assert.equal(
        rp.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/pods')).length,
        1,
        'the create request was sent exactly once',
      );
      assert.match(e.message, /HTTP 409/);
      assert.match(e.message, /no instances available/);
      assert.ok(!e.message.includes('aisw_secret'), 'worker token never in errors');
      assert.equal(rp.pods.size, 0, 'no pod exists');
    } finally {
      await rp.stop();
    }
  });

  it('429 → retried with backoff, then CLOUD_RATE_LIMITED', async () => {
    const calls: string[] = [];
    const e = await failure(
      api(() => new Response('{}', { status: 429, headers: { 'retry-after': '1' } }), calls).listPods(),
    );
    assert.equal(e.code, 'CLOUD_RATE_LIMITED');
    assert.equal(calls.length, 3);
  });

  it('5xx → retried, then CLOUD_UNAVAILABLE (HTML error pages are not echoed)', async () => {
    const calls: string[] = [];
    const e = await failure(
      api(() => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 }), calls).listPods(),
    );
    assert.equal(e.code, 'CLOUD_UNAVAILABLE');
    assert.equal(e.message, 'RunPod is temporarily unavailable (HTTP 502)');
    assert.equal(calls.length, 3);
  });

  it('timeout / network failure → CLOUD_UNAVAILABLE "could not be reached (timeout)"', async () => {
    const e = await failure(
      api(() => {
        throw new globalThis.DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }).listPods(),
    );
    assert.equal(e.code, 'CLOUD_UNAVAILABLE');
    assert.match(e.message, /could not be reached \(timeout\)/);
  });

  it('malformed JSON / unexpected shape → a safe error, never a crash', async () => {
    const e = await failure(
      api(() => new Response('not json at all', { status: 200 })).listGpuTypes('SECURE'),
    );
    assert.equal(e.code, 'CLOUD_BAD_REQUEST');
    assert.match(e.message, /unexpected format/);
    const pods = await api(
      () => new Response(JSON.stringify({ data: [{ nothing: 1 }, 'x', null] }), { status: 200 }),
    ).listPods();
    assert.deepEqual(pods, [], 'entries without ids are ignored');
  });
});
