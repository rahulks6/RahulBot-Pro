import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { validate } from './schema-lite.ts';
import type { AddressInfo } from 'node:net';

/** Runpod's published GET /v2/catalog/gpus contract (fetched by .github/workflows/runpod-api-snapshot.yml). */
const CATALOG = JSON.parse(
  readFileSync(new URL('./runpod-catalog-openapi.json', import.meta.url), 'utf8'),
) as {
  paths: { '/v2/catalog/gpus': { get: { parameters: unknown[] } & Record<string, unknown> } };
  components: { parameters: Record<string, unknown>; schemas: Record<string, unknown> };
};

/** Runpod's published POST /v2/pods request schema (same source). */
const PODS = JSON.parse(readFileSync(new URL('./runpod-pods-openapi.json', import.meta.url), 'utf8')) as {
  createPodRequest: Record<string, unknown>;
};

/** Deep copy of a schema with the named properties removed everywhere (simulated API drift). */
function withoutFields(schema: unknown, fields: string[]): unknown {
  if (Array.isArray(schema)) return schema.map((x) => withoutFields(x, fields));
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' && v && typeof v === 'object')
      out[k] = Object.fromEntries(
        Object.entries(v)
          .filter(([name]) => !fields.includes(name))
          .map(([n, x]) => [n, withoutFields(x, fields)]),
      );
    else if (k === 'required' && Array.isArray(v)) out[k] = v.filter((r) => !fields.includes(r as string));
    else out[k] = withoutFields(v, fields);
  }
  return out;
}

export interface MockGpu {
  id: string;
  name: string;
  memory: number;
  secure: boolean;
  community: boolean;
  price: { secure: number; community: number };
  /** Availability level per cloud for pods (missing = NONE). */
  stock: Partial<Record<'SECURE' | 'COMMUNITY', 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'>>;
  /** Highest CUDA version its hosts offer. */
  maxCuda: string;
}

function gpu(
  id: string,
  name: string,
  memory: number,
  price: { secure: number; community: number },
  stock: MockGpu['stock'],
  maxCuda = '12.8',
): MockGpu {
  return {
    id,
    name,
    memory,
    secure: price.secure > 0,
    community: price.community > 0,
    price,
    stock,
    maxCuda,
  };
}

const cudaNum = (v: string): number => {
  const [maj, min] = v.split('.').map(Number);
  return (maj ?? 0) * 1000 + (min ?? 0);
};

/**
 * In-process fake of the RunPod REST API v2 for tests. Nothing here talks to
 * RunPod and nothing can be billed. Supports auth, the GPU catalog, pods with
 * a CREATED → RUNNING transition, cursor pagination, failure injection and a
 * published OpenAPI document (which tests can make "drift").
 */
export interface FakePod {
  id: string;
  name: string;
  status: string;
  costPerHr: string;
  gpu: { id: string; displayName: string; count: number };
  env: Record<string, string>;
  image: string;
  createdAt: string;
  pollsUntilRunning: number;
  body: Record<string, unknown>;
}

export interface InjectedFailure {
  method: string;
  path: RegExp;
  status: number;
  times: number;
  retryAfter?: string;
  /** Simulate a dropped connection instead of an HTTP status. */
  drop?: boolean;
  /** Response body (default {error: "injected <status>"}). */
  body?: unknown;
  /** Send the body as raw text instead of JSON. */
  text?: string;
}

export class MockRunPod {
  readonly apiKey: string;
  server!: Server;
  baseUrl = '';
  pods = new Map<string, FakePod>();
  requests: Array<{ method: string; path: string; auth: string | undefined; body: unknown }> = [];
  failures: InjectedFailure[] = [];
  pollsUntilRunning = 1;
  pageSize = 2;
  /** Remove fields from the published create schema to simulate API drift. */
  dropCreateFields: string[] = [];
  /**
   * GPU catalog validation (like a strict API): unknown query parameters, and
   * cloudType / gpuCount without include=AVAILABILITY, are rejected with HTTP 400.
   *  - requireCloudTypeWithInclude: include=AVAILABILITY also needs cloudType (a 400 of the
   *    kind the studio hit in real use: `include=AVAILABILITY&gpuCount=1`).
   *  - rejectAvailability: any include=AVAILABILITY query is refused (stock unavailable).
   */
  catalog = {
    /** Refuse every include=AVAILABILITY query (stock temporarily unavailable). */
    rejectAvailability: false,
    /** Replace the whole catalog response (malformed-response tests). */
    rawResponse: undefined as unknown,
    /** Publish the catalog parameters in openapi.json (false = old document without them). */
    declareParams: true,
    /** Entries per page (0 = no pagination, like the published API). */
    pageSize: 0,
    /** Declare an extra REQUIRED query parameter the studio does not know (API drift). */
    extraRequiredParam: '',
    secretInError: false,
  };
  /** GPU types in the published `GpuType` shape, plus per-cloud stock and the highest host CUDA. */
  gpus: MockGpu[] = [
    gpu(
      'NVIDIA GeForce RTX 4090',
      'RTX 4090',
      24,
      { secure: 0.69, community: 0.44 },
      { SECURE: 'HIGH', COMMUNITY: 'MEDIUM' },
    ),
    gpu(
      'NVIDIA RTX A5000',
      'RTX A5000',
      24,
      { secure: 0.27, community: 0.16 },
      { SECURE: 'MEDIUM', COMMUNITY: 'HIGH' },
    ),
    gpu('NVIDIA L4', 'L4', 24, { secure: 0.43, community: 0 }, { SECURE: 'NONE' }),
    gpu(
      'NVIDIA RTX A2000',
      'RTX A2000',
      6,
      { secure: 0.12, community: 0.08 },
      { SECURE: 'HIGH', COMMUNITY: 'HIGH' },
    ),
    gpu(
      'NVIDIA H100 80GB HBM3',
      'H100 SXM',
      80,
      { secure: 2.89, community: 2.39 },
      { SECURE: 'LOW', COMMUNITY: 'LOW' },
    ),
    // Cheapest 24 GB card, but its hosts only offer CUDA 12.4: excluded by minCudaVersion=12.6.
    gpu(
      'NVIDIA GeForce RTX 3090',
      'RTX 3090',
      24,
      { secure: 0.22, community: 0.14 },
      { SECURE: 'HIGH', COMMUNITY: 'HIGH' },
      '12.4',
    ),
  ];
  private seq = 0;

  constructor(apiKey = 'rpa_TESTKEY1234567890abcdef') {
    this.apiKey = apiKey;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v2`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((r) => {
      this.server.closeAllConnections();
      this.server.close(() => r());
    });
  }

  failNext(
    method: string,
    path: RegExp,
    status: number,
    times = 1,
    extra: Partial<InjectedFailure> = {},
  ): void {
    this.failures.push({ method, path, status, times, ...extra });
  }

  livePods(): FakePod[] {
    return [...this.pods.values()].filter((p) => p.status !== 'TERMINATED');
  }

  /** Test helper: a pod created "by someone else" or by an earlier crashed session. */
  addPod(name: string, status = 'RUNNING'): string {
    const id = `pod${++this.seq}x`;
    this.pods.set(id, {
      id,
      name,
      status,
      costPerHr: '0.69',
      gpu: { id: 'NVIDIA GeForce RTX 4090', displayName: 'RTX 4090', count: 1 },
      env: {},
      image: 'x',
      createdAt: new Date().toISOString(),
      pollsUntilRunning: 0,
      body: {},
    });
    return id;
  }

  /** The create schema this mock publishes (and enforces): Runpod's, minus any "drifted" fields. */
  createSchema(): Record<string, unknown> {
    return withoutFields(PODS.createPodRequest, this.dropCreateFields) as Record<string, unknown>;
  }

  private openapi(): unknown {
    return {
      openapi: '3.1.0',
      paths: {
        '/v2/pods': {
          get: {},
          post: {
            requestBody: {
              content: { 'application/json': { schema: this.createSchema() } },
            },
          },
        },
        '/v2/pods/{podId}': { get: {}, delete: {} },
        '/v2/pods/{podId}/action': { post: {} },
        '/v2/catalog/gpus': {
          get: this.catalog.declareParams
            ? {
                ...CATALOG.paths['/v2/catalog/gpus'].get,
                parameters: [
                  ...CATALOG.paths['/v2/catalog/gpus'].get.parameters,
                  ...(this.catalog.pageSize
                    ? [
                        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50 } },
                        { name: 'cursor', in: 'query', schema: { type: 'string' } },
                      ]
                    : []),
                  ...(this.catalog.extraRequiredParam
                    ? [
                        {
                          name: this.catalog.extraRequiredParam,
                          in: 'query',
                          required: true,
                          schema: { type: 'string' },
                        },
                      ]
                    : []),
                ],
              }
            : {},
        },
      },
      components: {
        parameters: CATALOG.components.parameters,
        schemas: {
          ...CATALOG.components.schemas,
        },
      },
    };
  }

  /**
   * GET /v2/catalog/gpus, following Runpod's published contract (test/fixtures/runpod-catalog-openapi.json):
   * include=AVAILABILITY requires `product`; product, count, cloud, countryCodes, cudaVersions and
   * minCudaVersion are valid only with include (400 otherwise); cudaVersions and minCudaVersion are
   * mutually exclusive; unknown parameters are rejected. Errors are application/problem+json.
   */
  private catalogResponse(url: URL, send: (status: number, payload: unknown) => void): void {
    const q = url.searchParams;
    const bad = (detail: string, errors?: string[]) =>
      send(400, {
        title: 'Bad Request',
        status: 400,
        detail: this.catalog.secretInError ? `${detail} (request key rpa_LEAKEDKEY1234567890)` : detail,
        ...(errors ? { errors } : {}),
      });
    const known = new Set([
      'include',
      'product',
      'count',
      'cloud',
      'countryCodes',
      'cudaVersions',
      'minCudaVersion',
    ]);
    if (this.catalog.pageSize) ['limit', 'cursor'].forEach((k) => known.add(k));
    for (const k of q.keys()) if (!known.has(k)) return bad(`unknown query parameter "${k}"`);
    const include = q.get('include');
    if (include !== null && include !== 'AVAILABILITY') return bad('include must be AVAILABILITY');
    const onlyWithInclude = ['product', 'count', 'cloud', 'countryCodes', 'cudaVersions', 'minCudaVersion'];
    if (!include) {
      const stray = onlyWithInclude.find((k) => q.has(k));
      if (stray) return bad(`${stray} is valid only with include=AVAILABILITY`);
    }
    const products = (q.get('product') ?? '').split(',').filter(Boolean);
    if (include && !products.length)
      return bad('product is required with include=AVAILABILITY; availability differs by product context');
    if (products.some((p) => !['POD', 'CLUSTER', 'SERVERLESS'].includes(p)))
      return bad('product must be POD, CLUSTER or SERVERLESS');
    if (q.has('cudaVersions') && q.has('minCudaVersion'))
      return bad('cudaVersions and minCudaVersion are mutually exclusive');
    if (include && this.catalog.rejectAvailability) return bad('availability is temporarily unavailable');
    const cloud = q.get('cloud') ?? 'SECURE';
    if (cloud !== 'SECURE' && cloud !== 'COMMUNITY') return bad('cloud must be SECURE or COMMUNITY');
    const count = Number(q.get('count') ?? 1);
    if (!Number.isInteger(count) || count < 1) return bad('count must be an integer >= 1');
    const minCuda = q.get('minCudaVersion');
    if (this.catalog.rawResponse !== undefined) return send(200, this.catalog.rawResponse);
    const cudaOk = (max: string) => !minCuda || cudaNum(max) >= cudaNum(minCuda);
    const rows = this.gpus.map((g) => {
      const base = {
        id: g.id,
        name: g.name,
        pool: null,
        manufacturer: 'NVIDIA',
        memory: g.memory,
        secure: g.secure,
        community: g.community,
        price: g.price,
        maxCount: { secure: 8, community: 4 },
      };
      if (!include) return base;
      const offered = cloud === 'SECURE' ? g.secure : g.community;
      const level = offered && cudaOk(g.maxCuda) ? (g.stock[cloud] ?? 'NONE') : 'NONE';
      return {
        ...base,
        availability: level,
        ...(level !== 'NONE'
          ? { dataCenters: [{ id: 'US-KS-2', name: 'US Kansas 2', availability: level }] }
          : {}),
        cudaVersions: [{ version: g.maxCuda, available: level !== 'NONE' }],
      };
    });
    if (!this.catalog.pageSize) return send(200, { gpus: rows });
    const start = Number(q.get('cursor') ?? 0);
    const size = Math.min(this.catalog.pageSize, Number(q.get('limit') ?? this.catalog.pageSize));
    const next = start + size < rows.length ? String(start + size) : null;
    return send(200, { gpus: rows.slice(start, start + size), nextCursor: next });
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/v2/, '');
    const method = req.method ?? 'GET';
    this.requests.push({ method, path, auth: req.headers.authorization, body });
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    const failure = this.failures.find((f) => f.times > 0 && f.method === method && f.path.test(path));
    if (failure) {
      failure.times--;
      if (failure.drop) {
        req.socket.destroy();
        return;
      }
      if (failure.text !== undefined) {
        res.writeHead(failure.status, { 'Content-Type': 'text/html' });
        res.end(failure.text);
        return;
      }
      send(
        failure.status,
        failure.body ?? { error: `injected ${failure.status}` },
        failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {},
      );
      return;
    }
    if (req.headers.authorization !== `Bearer ${this.apiKey}`) return send(401, { error: 'Unauthorized' });
    if (method === 'GET' && path === '/openapi.json') return send(200, this.openapi());
    if (method === 'GET' && path === '/catalog/gpus') return this.catalogResponse(url, send);
    if (method === 'GET' && path === '/pods') {
      const all = [...this.pods.values()].filter((p) => p.status !== 'TERMINATED');
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const page = all.slice(start, start + this.pageSize);
      const next = start + this.pageSize < all.length ? String(start + this.pageSize) : null;
      return send(200, { data: page, nextCursor: next });
    }
    if (method === 'POST' && path === '/pods') {
      const b = body ?? {};
      // Enforce the published schema, like the real API (unknown fields are rejected too).
      const errors = validate(b, PODS.createPodRequest);
      if (errors.length)
        return send(400, { title: 'Bad Request', status: 400, detail: 'request validation failed', errors });
      if (typeof b['image'] !== 'string' || !b['gpu'])
        return send(400, { title: 'Bad Request', status: 400, detail: 'image and gpu are required' });
      const gpu = b['gpu'] as { id: string; count: number };
      const offer = this.gpus.find((g) => g.id === gpu.id);
      if (!offer) return send(400, { error: `unknown gpu ${gpu.id}` });
      const cloud = (b['cloud'] as string | undefined) ?? 'SECURE';
      if ((offer.stock[cloud as 'SECURE' | 'COMMUNITY'] ?? 'NONE') === 'NONE')
        return send(409, { title: 'Conflict', status: 409, detail: 'no instances available' });
      const id = `pod${++this.seq}x`;
      const pod: FakePod = {
        id,
        name: String(b['name']),
        status: 'PROVISIONING', // published statuses: PROVISIONING, STARTING, RUNNING, EXITED, ERROR, TERMINATED
        costPerHr: String(offer.price.secure),
        gpu: { id: offer.id, displayName: offer.name, count: gpu.count },
        env: (b['env'] as Record<string, string>) ?? {},
        image: b['image'],
        createdAt: new Date().toISOString(),
        pollsUntilRunning: this.pollsUntilRunning,
        body: b,
      };
      this.pods.set(id, pod);
      return send(201, pod);
    }
    const m = /^\/pods\/([^/]+)(\/action)?$/.exec(path);
    if (m) {
      const pod = this.pods.get(decodeURIComponent(m[1]!));
      if (!pod || pod.status === 'TERMINATED') return send(404, { error: 'pod not found' });
      if (method === 'GET' && !m[2]) {
        if (pod.status === 'PROVISIONING' && pod.pollsUntilRunning-- <= 0) pod.status = 'RUNNING';
        return send(200, pod);
      }
      if (method === 'DELETE' && !m[2]) {
        pod.status = 'TERMINATED';
        return send(204, {});
      }
      if (method === 'POST' && m[2]) {
        const action = (body ?? {})['action'];
        if (action === 'stop') pod.status = 'EXITED';
        else if (action === 'terminate') pod.status = 'TERMINATED';
        else return send(400, { error: 'bad action' });
        return send(200, pod);
      }
    }
    send(404, { error: 'no route' });
  }
}
