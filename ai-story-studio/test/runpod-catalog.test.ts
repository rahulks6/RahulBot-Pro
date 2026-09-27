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
  const catalogRequests = () => rp.requests.filter((r) => r.path === '/catalog/gpus');
  /** Full catalog URLs requested, in order. */
  const seen: string[] = [];
  const recording = (): RunPodApi =>
    new RunPodApi({
      apiKey: rp.apiKey,
      baseUrl: rp.baseUrl,
      sleep: async () => undefined,
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      fetch: (async (u: string | URL | Request, init?: RequestInit) => {
        if (String(u).includes('/catalog/gpus')) seen.push(new URL(String(u)).search);
        return fetch(u, init);
      }) as typeof fetch,
    });
  const get = (qs: string) =>
    fetch(`${rp.baseUrl}/catalog/gpus${qs}`, { headers: { Authorization: `Bearer ${rp.apiKey}` } });

  before(async () => {
    await rp.start();
  });
  after(() => rp.stop());
  beforeEach(() => {
    rp.requests = [];
    rp.failures = [];
    seen.length = 0;
    rp.catalog = {
      rejectAvailability: false,
      rawResponse: undefined,
      declareParams: true,
      pageSize: 0,
      secretInError: false,
      extraRequiredParam: '',
    };
  });

  it('reproduces the exact HTTP 400 the real dry run got, and the corrected request is accepted', async () => {
    // What the previous version sent (it passed the declared `include` and `cloud`, but not `product`):
    const previous = await get('?include=AVAILABILITY&cloud=SECURE');
    assert.equal(previous.status, 400);
    assert.equal(
      errorDetail(await previous.json()),
      'product is required with include=AVAILABILITY; availability differs by product context',
    );
    // And the version before that (hard-coded, undeclared parameter name):
    assert.equal((await get('?include=AVAILABILITY&gpuCount=1')).status, 400);
    rp.requests = [];

    const gpus = await recording().listGpuTypes('SECURE', { minCudaVersion: '12.6' });
    assert.deepEqual(seen, ['?include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=12.6']);
    assert.equal(catalogRequests().length, 1, 'one request, no fallback needed');
    assert.equal(gpus.length, 6);
    const a5000 = gpus.find((g) => g.id === 'NVIDIA RTX A5000')!;
    assert.deepEqual(
      [a5000.displayName, a5000.vramGb, a5000.hourlyUsd, a5000.available, a5000.stock, a5000.offered],
      ['RTX A5000', 24, 0.27, true, 'MEDIUM in 1 data centre', true],
    );
    assert.equal(gpus.find((g) => g.id === 'NVIDIA L4')!.available, false, 'availability NONE');
    const r3090 = gpus.find((g) => g.id === 'NVIDIA GeForce RTX 3090')!;
    assert.deepEqual(
      [r3090.hourlyUsd, r3090.available],
      [0.22, false],
      'priced, but no host with CUDA >= 12.6',
    );
  });

  it('asks for pods in the configured cloud, with the published parameter names and enum values', async () => {
    const x = recording();
    const community = await x.listGpuTypes('COMMUNITY', { minCudaVersion: '12.6' });
    assert.deepEqual(seen, ['?include=AVAILABILITY&product=POD&count=1&cloud=COMMUNITY&minCudaVersion=12.6']);
    assert.equal(community.find((g) => g.id === 'NVIDIA RTX A5000')!.hourlyUsd, 0.16, 'community price');
    const l4 = community.find((g) => g.id === 'NVIDIA L4')!;
    assert.deepEqual([l4.offered, l4.available], [false, false], 'not offered on community cloud');
    assert.ok(x.catalogNotes.some((n) => /parameters from openapi\.json/.test(n)));
    seen.length = 0;
    await x.listGpuTypes('SECURE');
    assert.deepEqual(
      seen,
      ['?include=AVAILABILITY&product=POD&count=1&cloud=SECURE'],
      'no CUDA filter unless asked',
    );
  });

  it('uses the documented parameters when openapi.json does not describe them (same request)', async () => {
    rp.catalog.declareParams = false;
    const x = recording();
    assert.equal((await x.listGpuTypes('SECURE', { minCudaVersion: '12.6' })).length, 6);
    assert.ok(x.catalogNotes.some((n) => n.includes('using the documented ones')));
    rp.failNext('GET', /^\/openapi\.json$/, 500, 5);
    const y = recording();
    assert.equal((await y.listGpuTypes('SECURE', { minCudaVersion: '12.6' })).length, 6);
    assert.ok(y.catalogNotes.some((n) => n.includes('could not be read')));
    assert.deepEqual(
      new Set(seen),
      new Set(['?include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=12.6']),
    );
  });

  it('never treats "price exists" as "available" when stock is refused', async () => {
    rp.catalog.rejectAvailability = true;
    const x = recording();
    const gpus = await x.listGpuTypes('SECURE', { minCudaVersion: '12.6' });
    assert.equal(gpus.length, 6);
    const a5000 = gpus.find((g) => g.id === 'NVIDIA RTX A5000')!;
    assert.equal(a5000.hourlyUsd, 0.27, 'price still known');
    assert.equal(a5000.available, null, 'stock unknown, so NOT available');
    const notes = x.catalogNotes.join(' ');
    assert.match(
      notes,
      /Live stock query refused \(RunPod rejected the GPU catalog request \(HTTP 400\): availability is temporarily unavailable\)/,
    );
    assert.match(notes, /no GPU is treated as available/);
    assert.deepEqual(
      seen,
      ['?include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=12.6', ''],
      'the fallback sends no availability-only parameters',
    );
  });

  it('refuses to guess a product the published API does not list', () => {
    const plan = planCatalogQuery(
      [
        { name: 'include', required: false, enumValues: ['AVAILABILITY'], maximum: null, hasDefault: false },
        { name: 'product', required: false, enumValues: ['SERVERLESS'], maximum: null, hasDefault: false },
        {
          name: 'cloud',
          required: false,
          enumValues: ['SECURE', 'COMMUNITY'],
          maximum: null,
          hasDefault: true,
        },
      ],
      'SECURE',
      { availability: true, source: 'openapi' },
    );
    assert.equal(plan.availability, false);
    assert.deepEqual(plan.params, {}, 'no include, no cloud: nothing that would be a 400');
    assert.match(plan.notes.join(), /does not list POD/);
  });

  it('follows pagination if the API ever adds it, respecting the declared page-size maximum', async () => {
    rp.catalog.pageSize = 2;
    const gpus = await recording().listGpuTypes('SECURE');
    assert.equal(gpus.length, 6);
    assert.equal(seen.length, 3);
    assert.ok(
      seen.every((u) => u.includes('limit=50')),
      'limit capped at the declared maximum',
    );
    assert.ok(seen[1]!.includes('cursor=2') && seen[2]!.includes('cursor=4'));
  });

  it('rejects a malformed catalog response with a safe, useful message', async () => {
    rp.catalog.rawResponse = { unexpected: { nested: true }, secret: 'rpa_SHOULDNOTAPPEAR123456' };
    await assert.rejects(recording().listGpuTypes(), (e: AppError) => {
      assert.equal(e.code, 'CLOUD_BAD_REQUEST');
      assert.match(e.message, /unexpected format \(keys: unexpected, secret\)/);
      assert.ok(!e.message.includes('rpa_SHOULD'), 'values are never echoed');
      return true;
    });
    rp.catalog.rawResponse = { gpus: [{ displayName: 'no id' }, { memoryInGb: 24 }] };
    await assert.rejects(recording().listGpuTypes(), /without ids/);
    rp.catalog.rawResponse = { gpus: [] };
    assert.deepEqual(
      await recording().listGpuTypes(),
      [],
      'an empty catalog is valid (reported as "none available")',
    );
  });

  it('reports a new REQUIRED catalog parameter as API drift instead of guessing', async () => {
    rp.catalog.extraRequiredParam = 'regionPolicy';
    await assert.rejects(recording().listGpuTypes(), (e: AppError) => {
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
      // Runpod's published error shape (application/problem+json).
      body: {
        title: 'Bad Request',
        status: 400,
        detail: 'Invalid query parameters',
        errors: ['cloud: must be one of SECURE, COMMUNITY; got Bearer rpa_ABCDEF1234567890'],
      },
    });
    await assert.rejects(recording().listGpuTypes(), (e: AppError) => {
      assert.equal(e.code, 'CLOUD_BAD_REQUEST');
      assert.match(
        e.message,
        /^RunPod rejected the GPU catalog request \(HTTP 400\): Invalid query parameters; cloud: must be one of SECURE, COMMUNITY/,
      );
      assert.ok(!/rpa_|ABCDEF1234567890/.test(e.message), e.message);
      return true;
    });
    rp.failNext('GET', /^\/catalog\/gpus$/, 400, 2, { text: '<html><body>Bad Request</body></html>' });
    await assert.rejects(
      recording().listGpuTypes(),
      (e: AppError) => e.message === 'RunPod rejected the GPU catalog request (HTTP 400)',
    );
  });
});

describe('catalog query planning (units)', () => {
  it('sends product/count/cloud/minCudaVersion only together with include=AVAILABILITY', () => {
    const plain = planCatalogQuery(DOCUMENTED_CATALOG_PARAMS, 'SECURE', {
      availability: false,
      source: 'documented',
      minCudaVersion: '12.6',
    });
    assert.deepEqual(plain.params, {});
    const withStock = planCatalogQuery(DOCUMENTED_CATALOG_PARAMS, 'COMMUNITY', {
      availability: true,
      source: 'documented',
      minCudaVersion: '12.6',
    });
    assert.deepEqual(withStock.params, {
      include: 'AVAILABILITY',
      product: 'POD',
      count: '1',
      cloud: 'COMMUNITY',
      minCudaVersion: '12.6',
    });
  });

  it('reads the parameter list from the published contract, $refs included', async () => {
    const api = new RunPodApi({ apiKey: 'rpa_x' });
    const fixture = JSON.parse(
      (await import('node:fs')).readFileSync(
        new URL('./fixtures/runpod-catalog-openapi.json', import.meta.url),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const params = api.catalogParams(fixture)!;
    assert.deepEqual(
      params.map((p) => [p.name, p.enumValues.join('|')]),
      [
        ['include', 'AVAILABILITY'],
        ['product', 'POD|CLUSTER|SERVERLESS'],
        ['count', ''],
        ['cloud', 'SECURE|COMMUNITY'],
        ['countryCodes', ''],
        ['cudaVersions', ''],
        ['minCudaVersion', ''],
      ],
    );
    assert.deepEqual(
      DOCUMENTED_CATALOG_PARAMS.map((p) => p.name),
      params.map((p) => p.name),
    );
  });

  it('uses the enum spelling the API declares and skips undeclared parameters', () => {
    const plan = planCatalogQuery(
      [
        { name: 'include', required: false, enumValues: ['availability'], maximum: null, hasDefault: false },
        {
          name: 'product',
          required: false,
          enumValues: ['pod', 'serverless'],
          maximum: null,
          hasDefault: false,
        },
        {
          name: 'cloudType',
          required: false,
          enumValues: ['secure', 'community'],
          maximum: null,
          hasDefault: false,
        },
      ],
      'SECURE',
      { availability: true, source: 'openapi', minCudaVersion: '12.6' },
    );
    assert.deepEqual(plan.params, { include: 'availability', product: 'pod', cloudType: 'secure' });
    const none = planCatalogQuery([], 'SECURE', { availability: true, source: 'openapi' });
    assert.deepEqual(none.params, {});
    assert.equal(none.availability, false);
    assert.match(none.notes.join(), /no longer offers live stock/);
  });
});

describe('GPU catalog entry parsing (units)', () => {
  it('parses the published GpuType example exactly', () => {
    // The example response in Runpod's published contract for GET /v2/catalog/gpus.
    const example = {
      id: 'NVIDIA GeForce RTX 4090',
      name: 'RTX 4090',
      pool: 'ADA_24',
      manufacturer: 'NVIDIA',
      memory: 24,
      secure: true,
      community: true,
      price: { secure: 0.44, community: 0.31, serverless: 1.1 },
      maxCount: { secure: 8, community: 4 },
      availability: 'HIGH',
      dataCenters: [{ id: 'US-KS-2', name: 'US Kansas 2', availability: 'HIGH' }],
    };
    assert.deepEqual(parseGpuType(example, 'SECURE'), {
      id: 'NVIDIA GeForce RTX 4090',
      displayName: 'RTX 4090',
      vramGb: 24,
      hourlyUsd: 0.44,
      available: true,
      stock: 'HIGH in 1 data centre',
      offered: true,
    });
    assert.equal(
      parseGpuType(example, 'COMMUNITY').hourlyUsd,
      0.31,
      'pod price per cloud; never the serverless rate',
    );
    const { availability: _a, dataCenters: _d, ...noStock } = example;
    assert.equal(parseGpuType(noStock, 'SECURE').available, null, 'a price alone is not availability');
    assert.equal(parseGpuType({ ...example, availability: 'NONE' }, 'SECURE').available, false);
    assert.equal(
      parseGpuType({ ...example, secure: false }, 'SECURE').available,
      false,
      'not offered on secure',
    );
  });

  it('still reads older field names (fallback)', () => {
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
