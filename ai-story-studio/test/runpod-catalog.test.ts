import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AppError } from '../src/lib/errors.ts';
import { errorDetail, httpError, sanitizeDetail } from '../src/providers/cloud/http.ts';
import {
  catalogList,
  DOCUMENTED_CATALOG_PARAMS,
  parseGpuType,
  planCatalogQuery,
  RunPodApi,
} from '../src/providers/cloud/runpod.ts';
import { MockRunPod } from './fixtures/mock-runpod.ts';

/**
 * GPU discovery against a local mock of RunPod's v2 catalog that validates query
 * parameters like a strict API. Nothing talks to RunPod; nothing is billed.
 */
describe('RunPod GPU catalog (discovery and pricing)', () => {
  const rp = new MockRunPod();
  const api = () =>
    new RunPodApi({
      apiKey: rp.apiKey,
      baseUrl: rp.baseUrl,
      sleep: async () => undefined,
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
  const catalogRequests = () => rp.requests.filter((r) => r.path === '/catalog/gpus');
  const lastCatalogQuery = () => {
    const urls = rp.requests.filter((r) => r.path === '/catalog/gpus');
    return urls.length;
  };

  before(async () => {
    await rp.start();
  });
  after(() => rp.stop());
  beforeEach(() => {
    rp.requests = [];
    rp.failures = [];
    rp.catalog = {
      requireCloudTypeWithInclude: false,
      rejectAvailability: false,
      rawResponse: undefined,
      declareParams: true,
      pageSize: 0,
      secretInError: false,
      extraRequiredParam: '',
    };
  });

  it('reproduces the HTTP 400 of the old query and shows that the new query is accepted', async () => {
    rp.catalog.requireCloudTypeWithInclude = true;
    // The exact request earlier versions sent:
    const old = await fetch(`${rp.baseUrl}/catalog/gpus?include=AVAILABILITY&gpuCount=1`, {
      headers: { Authorization: `Bearer ${rp.apiKey}` },
    });
    assert.equal(old.status, 400);
    assert.match(errorDetail(await old.json()), /cloudType: is required with include=AVAILABILITY/);
    rp.requests = [];

    const gpus = await api().listGpuTypes('SECURE');
    assert.equal(gpus.length, 5);
    const a5000 = gpus.find((g) => g.id === 'NVIDIA RTX A5000')!;
    assert.deepEqual(
      [a5000.vramGb, a5000.hourlyUsd, a5000.available, a5000.stock],
      [24, 0.27, true, 'Medium'],
    );
    assert.equal(gpus.find((g) => g.id === 'NVIDIA L4')!.available, false, 'stock None = unavailable');
    assert.equal(lastCatalogQuery(), 1, 'one request, no fallback needed');
  });

  it('sends only parameters declared in openapi.json, with cloudType/gpuCount only alongside include', async () => {
    const x = api();
    await x.listGpuTypes('COMMUNITY');
    const sent = await captureQuery(rp, () => x.listGpuTypes('COMMUNITY'));
    assert.deepEqual(Object.fromEntries(sent), {
      include: 'AVAILABILITY',
      cloudType: 'COMMUNITY',
      gpuCount: '1',
    });
    assert.ok(
      x.catalogNotes.some((n) => /parameters from openapi\.json: include, cloudType, gpuCount/.test(n)),
    );
    assert.equal(
      (await x.listGpuTypes('COMMUNITY')).find((g) => g.id === 'NVIDIA RTX A5000')!.hourlyUsd,
      0.16,
      'community price',
    );
  });

  it('falls back to the documented parameters when openapi.json does not describe them', async () => {
    rp.catalog.declareParams = false;
    const x = api();
    const gpus = await x.listGpuTypes('SECURE');
    assert.equal(gpus.length, 5);
    assert.ok(x.catalogNotes.some((n) => n.includes('using the documented ones')));
    rp.failNext('GET', /^\/openapi\.json$/, 500, 5);
    const y = api();
    assert.equal((await y.listGpuTypes('SECURE')).length, 5);
    assert.ok(y.catalogNotes.some((n) => n.includes('could not be read')));
  });

  it('reads prices without stock when RunPod refuses the availability query (and says why)', async () => {
    rp.catalog.rejectAvailability = true;
    const x = api();
    const gpus = await x.listGpuTypes('SECURE');
    assert.equal(gpus.length, 5);
    assert.equal(gpus.find((g) => g.id === 'NVIDIA RTX A5000')!.hourlyUsd, 0.27, 'price still known');
    assert.equal(gpus.find((g) => g.id === 'NVIDIA RTX A5000')!.available, null, 'stock unknown');
    const notes = x.catalogNotes.join(' ');
    assert.match(notes, /Live stock query refused/);
    assert.match(notes, /include: availability is temporarily unavailable/, "RunPod's own reason is shown");
    assert.match(notes, /stock not reported/);
    assert.equal(catalogRequests().length, 2, 'exactly one fallback request');
  });

  it('follows catalog pagination and respects the declared page-size maximum', async () => {
    rp.catalog.pageSize = 2;
    const sent: string[] = [];
    const orig = globalThis.fetch;
    const x = new RunPodApi({
      apiKey: rp.apiKey,
      baseUrl: rp.baseUrl,
      fetch: (async (u: string | URL | Request, i?: RequestInit) => {
        sent.push(String(u));
        return orig(u, i);
      }) as typeof fetch,
    });
    const gpus = await x.listGpuTypes('SECURE');
    assert.equal(gpus.length, 5);
    const pages = sent.filter((u) => u.includes('/catalog/gpus'));
    assert.equal(pages.length, 3);
    assert.ok(
      pages.every((u) => u.includes('limit=50')),
      'limit capped at the declared maximum',
    );
    assert.ok(pages[1]!.includes('cursor=2') && pages[2]!.includes('cursor=4'));
  });

  it('rejects a malformed catalog response with a safe, useful message', async () => {
    rp.catalog.rawResponse = { unexpected: { nested: true }, secret: 'rpa_SHOULDNOTAPPEAR123456' };
    await assert.rejects(api().listGpuTypes(), (e: AppError) => {
      assert.equal(e.code, 'CLOUD_BAD_REQUEST');
      assert.match(e.message, /unexpected format \(keys: unexpected, secret\)/);
      assert.ok(!e.message.includes('rpa_SHOULD'), 'values are never echoed');
      return true;
    });
    rp.catalog.rawResponse = { gpus: [{ displayName: 'no id' }, { memoryInGb: 24 }] };
    await assert.rejects(api().listGpuTypes(), /without ids/);
    rp.catalog.rawResponse = { gpus: [] };
    assert.deepEqual(
      await api().listGpuTypes(),
      [],
      'an empty catalog is valid (reported as "none available")',
    );
  });

  it('reports a new REQUIRED catalog parameter as API drift instead of guessing', async () => {
    rp.catalog.extraRequiredParam = 'regionPolicy';
    await assert.rejects(api().listGpuTypes(), (e: AppError) => {
      assert.equal(e.code, 'CLOUD_BAD_REQUEST');
      assert.match(e.message, /requires regionPolicy.*Update AI Story Studio/);
      return true;
    });
    assert.equal(catalogRequests().length, 0, 'no catalog request was sent');
  });

  it('shows the useful part of an HTTP 400 without credentials', async () => {
    rp.catalog.rejectAvailability = true;
    rp.catalog.secretInError = true;
    rp.failNext('GET', /^\/catalog\/gpus$/, 400, 2, {
      body: {
        error: {
          message: 'Invalid query parameters',
          details: [
            {
              field: 'cloudType',
              message: 'must be one of SECURE, COMMUNITY; got Bearer rpa_ABCDEF1234567890',
            },
          ],
        },
      },
    });
    await assert.rejects(api().listGpuTypes(), (e: AppError) => {
      assert.equal(e.code, 'CLOUD_BAD_REQUEST');
      assert.match(
        e.message,
        /^RunPod rejected the GPU catalog request \(HTTP 400\): Invalid query parameters; cloudType: must be one of SECURE, COMMUNITY/,
      );
      assert.ok(!/rpa_|ABCDEF1234567890/.test(e.message), e.message);
      return true;
    });
    rp.failNext('GET', /^\/catalog\/gpus$/, 400, 2, { text: '<html><body>Bad Request</body></html>' });
    await assert.rejects(
      api().listGpuTypes(),
      (e: AppError) => e.message === 'RunPod rejected the GPU catalog request (HTTP 400)',
    );
  });
});

/** Runs fn and returns the query parameters of the last catalog request it made. */
async function captureQuery(rp: MockRunPod, fn: () => Promise<unknown>): Promise<URLSearchParams> {
  let seen = '';
  const server = rp.server;
  const listener = (req: import('node:http').IncomingMessage) => {
    if ((req.url ?? '').includes('/catalog/gpus')) seen = req.url ?? '';
  };
  server.prependListener('request', listener);
  try {
    await fn();
  } finally {
    server.removeListener('request', listener);
  }
  return new URL(seen, 'http://x').searchParams;
}

describe('catalog query planning (units)', () => {
  it('never sends cloudType or gpuCount without include=AVAILABILITY', () => {
    const plan = planCatalogQuery(DOCUMENTED_CATALOG_PARAMS, 'SECURE', {
      availability: false,
      source: 'documented',
    });
    assert.deepEqual(plan.params, {});
    const withStock = planCatalogQuery(DOCUMENTED_CATALOG_PARAMS, 'COMMUNITY', {
      availability: true,
      source: 'documented',
    });
    assert.deepEqual(withStock.params, { include: 'AVAILABILITY', cloudType: 'COMMUNITY', gpuCount: '1' });
  });

  it('uses the enum spelling the API declares and skips undeclared parameters', () => {
    const plan = planCatalogQuery(
      [
        { name: 'include', required: false, enumValues: ['availability'], maximum: null, hasDefault: false },
        {
          name: 'cloudType',
          required: false,
          enumValues: ['secure', 'community'],
          maximum: null,
          hasDefault: false,
        },
      ],
      'SECURE',
      { availability: true, source: 'openapi' },
    );
    assert.deepEqual(plan.params, { include: 'availability', cloudType: 'secure' });
    const none = planCatalogQuery([], 'SECURE', { availability: true, source: 'openapi' });
    assert.deepEqual(none.params, {});
    assert.equal(none.availability, false);
    assert.match(none.notes.join(), /no longer offers live stock/);
  });
});

describe('GPU catalog entry parsing (units)', () => {
  it('parses v2 availability, per-data-centre stock, nested prices and cloud flags', () => {
    const perDc = parseGpuType(
      {
        id: 'NVIDIA L40S',
        displayName: 'L40S',
        memoryInGb: '48',
        pricing: { secure: { onDemand: '0.86' }, community: { onDemand: 0.79 } },
        availability: [
          { dataCenterId: 'EU-RO-1', stockStatus: 'None' },
          { dataCenterId: 'US-TX-3', stockStatus: 'Low' },
        ],
      },
      'SECURE',
    );
    assert.deepEqual([perDc.vramGb, perDc.hourlyUsd, perDc.available, perDc.stock], [48, 0.86, true, 'Low']);
    const lowest = parseGpuType(
      { id: 'x', memoryInGb: 24, lowestPrice: { uninterruptablePrice: 0.34, stockStatus: 'High' } },
      'COMMUNITY',
    );
    assert.deepEqual([lowest.hourlyUsd, lowest.available], [0.34, true]);
    const notOffered = parseGpuType(
      { id: 'y', memoryInGb: 24, securePrice: 0.5, secureCloud: false },
      'SECURE',
    );
    assert.equal(notOffered.available, false, 'not offered in secure cloud');
    const unpriced = parseGpuType(
      { id: 'z', memoryInGb: 24, securePrice: null, communityPrice: 'n/a' },
      'SECURE',
    );
    assert.equal(unpriced.hourlyUsd, null, 'a missing price stays unknown (never rented automatically)');
    const negative = parseGpuType({ id: 'n', memoryInGb: 24, securePrice: -1 }, 'SECURE');
    assert.equal(negative.hourlyUsd, null);
  });

  it('finds the GPU list in the known response wrappers', () => {
    assert.equal(catalogList({ gpus: [1] })!.length, 1);
    assert.equal(catalogList({ data: { gpus: [1, 2] } })!.length, 2);
    assert.equal(catalogList([1, 2, 3])!.length, 3);
    assert.equal(catalogList({ nothing: 1 }), null);
    assert.equal(catalogList('text'), null);
  });
});

describe('API error message sanitization (units)', () => {
  it('extracts validation details from common error shapes', () => {
    assert.equal(
      errorDetail({ detail: [{ loc: ['query', 'gpuCount'], msg: 'must be >= 1' }] }),
      'query.gpuCount: must be >= 1',
    );
    assert.equal(
      errorDetail({
        title: 'Bad Request',
        detail: 'include must be AVAILABILITY',
        errors: { cloudType: ['invalid'] },
      }),
      'include must be AVAILABILITY; cloudType: invalid',
    );
    assert.equal(errorDetail({ errors: ['a', { message: 'b', path: 'x' }] }), 'a; x: b');
    assert.equal(errorDetail({ error: 'plain' }), 'plain');
    assert.equal(errorDetail('<!doctype html><h1>400</h1>'), '');
    assert.equal(errorDetail(null), '');
  });

  it('removes credentials, tokens and long opaque strings, and limits length', () => {
    const cleaned = sanitizeDetail(
      'key rpa_ABC123DEF456GHI789 Authorization: Bearer abc.def.ghi api_key=supersecret token="x1y2z3" hf_abcdefghijk ' +
        'aisw_0123456789abcdef sig=' +
        'Z'.repeat(60),
    );
    for (const leaked of [
      'ABC123DEF456',
      'abc.def.ghi',
      'supersecret',
      'x1y2z3',
      'hf_abcdef',
      'aisw_0123',
      'ZZZZZZZZZZ',
    ])
      assert.ok(!cleaned.includes(leaked), `${leaked} leaked: ${cleaned}`);
    assert.match(cleaned, /api_key=\[redacted\]/);
    assert.ok(sanitizeDetail('x'.repeat(5000).replace(/x/g, 'ab ')).length <= 400);
    assert.equal(sanitizeDetail('line1\nline2\t\u0007end'), 'line1 line2 end');
  });

  it('names the failing request and keeps authentication errors generic', () => {
    assert.equal(
      httpError('RunPod', 400, 'bad', 'GPU catalog').message,
      'RunPod rejected the GPU catalog request (HTTP 400): bad',
    );
    assert.equal(httpError('RunPod', 422, '').message, 'RunPod rejected the request (HTTP 422)');
    assert.equal(
      httpError('RunPod', 401, 'key rpa_x is revoked').message,
      'RunPod authentication failed. Check your API key.',
    );
  });
});
