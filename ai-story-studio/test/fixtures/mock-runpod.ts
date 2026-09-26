import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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
    requireCloudTypeWithInclude: false,
    rejectAvailability: false,
    /** Replace the whole catalog response (malformed-response tests). */
    rawResponse: undefined as unknown,
    /** Publish the catalog parameters in openapi.json (false = old document without them). */
    declareParams: true,
    /** Entries per page (0 = no pagination). */
    pageSize: 0,
    /** Declare an extra REQUIRED query parameter the studio does not know (API drift). */
    extraRequiredParam: '',
    secretInError: false,
  };
  gpus = [
    {
      id: 'NVIDIA GeForce RTX 4090',
      displayName: 'RTX 4090',
      memoryInGb: 24,
      securePrice: 0.69,
      communityPrice: 0.44,
      stockStatus: 'High',
    },
    {
      id: 'NVIDIA RTX A5000',
      displayName: 'RTX A5000',
      memoryInGb: 24,
      securePrice: 0.27,
      communityPrice: 0.16,
      stockStatus: 'Medium',
    },
    { id: 'NVIDIA L4', displayName: 'L4', memoryInGb: 24, securePrice: 0.43, stockStatus: 'None' },
    {
      id: 'NVIDIA RTX A2000',
      displayName: 'RTX A2000',
      memoryInGb: 6,
      securePrice: 0.12,
      stockStatus: 'High',
    },
    {
      id: 'NVIDIA H100 80GB HBM3',
      displayName: 'H100 SXM',
      memoryInGb: 80,
      securePrice: 2.89,
      stockStatus: 'Low',
    },
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

  private openapi(): unknown {
    const createProps: Record<string, unknown> = {
      name: { type: 'string' },
      image: { type: 'string' },
      gpu: { $ref: '#/components/schemas/GpuRequest' },
      cloud: { type: 'string', enum: ['SECURE', 'COMMUNITY'] },
      env: { type: 'object' },
      ports: { type: 'array', items: { type: 'string' } },
      mounts: { type: 'object' },
      containerDiskInGb: { type: 'integer' },
    };
    for (const f of this.dropCreateFields) delete createProps[f];
    return {
      openapi: '3.1.0',
      paths: {
        '/v2/pods': {
          get: {},
          post: {
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/CreatePodRequest' } } },
            },
          },
        },
        '/v2/pods/{podId}': { get: {}, delete: {} },
        '/v2/pods/{podId}/action': { post: {} },
        '/v2/catalog/gpus': {
          get: this.catalog.declareParams
            ? {
                parameters: [
                  { $ref: '#/components/parameters/CatalogInclude' },
                  {
                    name: 'cloudType',
                    in: 'query',
                    required: false,
                    schema: { type: 'string', enum: ['SECURE', 'COMMUNITY'], default: 'SECURE' },
                  },
                  { name: 'gpuCount', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
                  { name: 'minCudaVersion', in: 'query', schema: { type: 'string' } },
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
                  ...(this.catalog.pageSize
                    ? [
                        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50 } },
                        { name: 'cursor', in: 'query', schema: { type: 'string' } },
                      ]
                    : []),
                ],
              }
            : {},
        },
      },
      components: {
        parameters: {
          CatalogInclude: {
            name: 'include',
            in: 'query',
            schema: { type: 'array', items: { type: 'string', enum: ['AVAILABILITY'] } },
            style: 'form',
            explode: false,
          },
        },
        schemas: {
          CreatePodRequest: { type: 'object', required: ['name', 'image'], properties: createProps },
          GpuRequest: { type: 'object', properties: { id: { type: 'string' }, count: { type: 'integer' } } },
        },
      },
    };
  }

  private catalogResponse(url: URL, send: (status: number, payload: unknown) => void): void {
    const q = url.searchParams;
    const bad = (field: string, message: string) =>
      send(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
          details: [
            {
              field,
              message: this.catalog.secretInError
                ? `${message} (request key rpa_LEAKEDKEY1234567890)`
                : message,
            },
          ],
        },
      });
    const known = new Set(['include', 'cloudType', 'gpuCount', 'minCudaVersion']);
    if (this.catalog.pageSize) ['limit', 'cursor'].forEach((k) => known.add(k));
    for (const k of q.keys()) if (!known.has(k)) return bad(k, 'unknown query parameter');
    const include = q.get('include');
    if (include !== null && include !== 'AVAILABILITY') return bad('include', 'must be one of: AVAILABILITY');
    if (!include && (q.has('cloudType') || q.has('gpuCount')))
      return bad(q.has('cloudType') ? 'cloudType' : 'gpuCount', 'valid only with include=AVAILABILITY');
    if (include && this.catalog.rejectAvailability)
      return bad('include', 'availability is temporarily unavailable');
    if (include && this.catalog.requireCloudTypeWithInclude && !q.has('cloudType'))
      return bad('cloudType', 'is required with include=AVAILABILITY');
    const cloud = q.get('cloudType') ?? 'SECURE';
    if (cloud !== 'SECURE' && cloud !== 'COMMUNITY') return bad('cloudType', 'must be SECURE or COMMUNITY');
    if (this.catalog.rawResponse !== undefined) return send(200, this.catalog.rawResponse);
    const rows = this.gpus.map((g) => {
      const { stockStatus, ...base } = g;
      return include
        ? {
            ...base,
            availability: {
              cloudType: cloud,
              gpuCount: Number(q.get('gpuCount') ?? 1),
              stockStatus,
              available: stockStatus !== 'None',
            },
          }
        : base;
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
      if (typeof b['name'] !== 'string' || typeof b['image'] !== 'string' || !b['gpu'])
        return send(400, { error: 'name, image and gpu are required' });
      const gpu = b['gpu'] as { id: string; count: number };
      const offer = this.gpus.find((g) => g.id === gpu.id);
      if (!offer) return send(400, { error: `unknown gpu ${gpu.id}` });
      if (offer.stockStatus === 'None') return send(409, { error: 'no instances available' });
      const id = `pod${++this.seq}x`;
      const pod: FakePod = {
        id,
        name: b['name'],
        status: 'CREATED',
        costPerHr: String(offer.securePrice),
        gpu: { id: offer.id, displayName: offer.displayName, count: gpu.count },
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
        if (pod.status === 'CREATED' && pod.pollsUntilRunning-- <= 0) pod.status = 'RUNNING';
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
