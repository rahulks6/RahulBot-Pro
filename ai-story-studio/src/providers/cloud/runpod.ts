import { AppError } from '../../lib/errors.ts';
import {
  CloudHttpError,
  realSleep,
  requestJson,
  type FetchFn,
  type RetryPolicy,
  type SleepFn,
} from './http.ts';
import type {
  CloudGpuApi,
  CloudGpuType,
  CloudPod,
  CloudPodSpec,
  CloudPodState,
  ContractReport,
} from './types.ts';

/**
 * RunPod adapter for REST API **v2** (`https://api.runpod.io/v2`). REST v1 is
 * deprecated and retires on 15 Nov 2026, so v1 is deliberately not used.
 *
 * Endpoints used (from RunPod's v2 docs and migration guide, Sept 2026):
 *   GET    /pods                     list (cursor-paginated)           — also the auth test
 *   POST   /pods                     create {name, image, gpu:{id,count}, cloud, env, ports, mounts}
 *   GET    /pods/{id}                read one pod
 *   POST   /pods/{id}/action         {"action":"stop"|"terminate"|…}
 *   DELETE /pods/{id}                delete (terminate)
 *   GET    /catalog/gpus             GPU types and prices; stock with include=AVAILABILITY
 *                                    (+ cloudType, gpuCount — valid only together with include)
 *   GET    /openapi.json             machine-readable contract (checked before the first create)
 * Pod HTTP ports are reached through https://{podId}-{port}.proxy.runpod.net.
 *
 * Response shapes are parsed tolerantly (field names are looked up with
 * fallbacks) and optional create fields are only sent when the published
 * OpenAPI document declares them. The GPU catalog query is built from the
 * parameters that document declares for GET /catalog/gpus (see planCatalogQuery),
 * so a parameter RunPod does not accept is never sent.
 */
export interface RunPodOptions {
  apiKey: string;
  baseUrl?: string;
  proxyUrlTemplate?: string;
  fetch?: FetchFn;
  sleep?: SleepFn;
  retry?: RetryPolicy;
}

type Json = Record<string, unknown>;

const REQUIRED_PATHS = ['/pods', '/pods/{}', '/pods/{}/action', '/catalog/gpus'];
const REQUIRED_CREATE_FIELDS = ['name', 'image', 'gpu'];
const EXPECTED_CREATE_FIELDS = ['name', 'image', 'gpu', 'cloud', 'env', 'ports', 'mounts'];
const CONTAINER_DISK_FIELDS = ['containerDiskInGb', 'containerDiskGb', 'containerDisk'];
const REGISTRY_AUTH_FIELDS = ['registryAuthId', 'containerRegistryAuthId'];

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (...vals: unknown[]): string | null => {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
  return null;
};
const num = (...vals: unknown[]): number | null => {
  for (const v of vals) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
};

function listOf(body: unknown, keys: string[]): unknown[] {
  if (Array.isArray(body)) return body;
  const b = obj(body);
  for (const k of keys) if (Array.isArray(b[k])) return b[k] as unknown[];
  return [];
}

/** The GPU entries of a catalog response, or null when the response has no recognisable list. */
export function catalogList(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  const b = obj(body);
  for (const k of ['gpus', 'data', 'items', 'gpuTypes', 'results'])
    if (Array.isArray(b[k])) return b[k] as unknown[];
  const data = obj(b['data']);
  for (const k of ['gpus', 'items', 'gpuTypes']) if (Array.isArray(data[k])) return data[k] as unknown[];
  return null;
}

/** A safe description of a JSON value's shape (key names and types only, never values). */
export function describeShape(body: unknown): string {
  if (body === null || body === undefined) return 'empty response';
  if (typeof body !== 'object') return `a ${typeof body}`;
  const keys = Object.keys(body).slice(0, 8);
  return keys.length ? `keys: ${keys.join(', ')}` : 'an empty object';
}

export function normalizePodState(raw: string): CloudPodState {
  const s = raw.toLowerCase();
  if (/terminat|delet|remov/.test(s)) return 'terminated';
  if (/exit|stop|paus/.test(s)) return 'stopped';
  if (/run/.test(s)) return 'running';
  if (/creat|pend|start|provision|queue|init|boot/.test(s)) return 'starting';
  return 'unknown';
}

export function parsePod(raw: unknown): CloudPod {
  const p = obj(raw);
  const gpu = obj(p['gpu']);
  const machine = obj(p['machine']);
  const rawStatus = str(p['status'], p['desiredStatus'], p['state']) ?? 'UNKNOWN';
  return {
    id: str(p['id'], p['podId']) ?? '',
    name: str(p['name']) ?? '',
    state: normalizePodState(rawStatus),
    rawStatus,
    hourlyUsd: num(p['costPerHr'], p['adjustedCostPerHr'], obj(p['cost'])['perHour'], p['pricePerHour']),
    gpuName: str(gpu['displayName'], gpu['id'], machine['gpuDisplayName'], p['gpuTypeId']),
    createdAt: str(p['createdAt'], p['lastStartedAt']),
  };
}

const NO_STOCK = /^(none|unavailable|out[_ -]?of[_ -]?stock|sold[_ -]?out|0|false)$/i;
const STOCK_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** A price that may be a number, a numeric string, or an object such as {onDemand: 0.69}. */
const price = (...vals: unknown[]): number | null => {
  for (const v of vals) {
    const direct = num(v);
    if (direct !== null) return direct >= 0 ? direct : null;
    const o = obj(v);
    const nested = num(
      o['onDemand'],
      o['onDemandPrice'],
      o['uninterruptablePrice'],
      o['hourly'],
      o['perHour'],
      o['price'],
    );
    if (nested !== null) return nested >= 0 ? nested : null;
  }
  return null;
};

export function parseGpuType(raw: unknown, cloud: 'SECURE' | 'COMMUNITY'): CloudGpuType {
  const g = obj(raw);
  const lowest = obj(g['lowestPrice']);
  const availList = Array.isArray(g['availability']) ? (g['availability'] as unknown[]).map(obj) : [];
  const availability = Array.isArray(g['availability']) ? {} : obj(g['availability']);
  const prices = obj(g['prices'] ?? g['pricing']);
  const secure = cloud === 'SECURE';

  // Stock: a single status, or the best status across data centres.
  const stocks = [
    str(g['stockStatus'], availability['stockStatus'], lowest['stockStatus']),
    ...availList.map((a) => str(a['stockStatus'], a['stock'])),
  ].filter((x): x is string => x !== null);
  const stock =
    stocks.sort((a, b) => (STOCK_RANK[b.toLowerCase()] ?? 0) - (STOCK_RANK[a.toLowerCase()] ?? 0))[0] ?? null;

  const hourlyUsd = price(
    ...(secure
      ? [g['securePrice'], prices['secure'], prices['SECURE'], availability['securePrice']]
      : [g['communityPrice'], prices['community'], prices['COMMUNITY'], availability['communityPrice']]),
    lowest['uninterruptablePrice'],
    lowest['onDemandPrice'],
    lowest['price'],
    typeof g['lowestPrice'] === 'number' || typeof g['lowestPrice'] === 'string' ? g['lowestPrice'] : null,
    g['price'],
    g['pricePerHour'],
    g['onDemandPrice'],
  );

  let available: boolean | null = null;
  const offeredHere = secure ? g['secureCloud'] : g['communityCloud'];
  if (offeredHere === false) available = false;
  else if (typeof availability['available'] === 'boolean') available = availability['available'] as boolean;
  else if (typeof g['available'] === 'boolean') available = g['available'] as boolean;
  else if (availList.length)
    available = availList.some(
      (a) => a['available'] === true || (str(a['stockStatus'], a['stock']) ?? '').match(NO_STOCK) === null,
    );
  else if (stock) available = !NO_STOCK.test(stock);
  return {
    id: str(g['id'], g['gpuTypeId']) ?? '',
    displayName: str(g['displayName'], g['name'], g['id']) ?? 'unknown GPU',
    vramGb: num(g['memoryInGb'], g['vramGb'], g['memoryGb'], g['vram'], g['vramInGb']) ?? 0,
    hourlyUsd,
    available,
    stock,
  };
}

/** A declared query parameter of an OpenAPI operation. */
export interface ApiParam {
  name: string;
  required: boolean;
  enumValues: string[];
  maximum: number | null;
  hasDefault: boolean;
}

export interface CatalogQueryPlan {
  params: Record<string, string>;
  /** true when stock (include=AVAILABILITY) is requested. */
  availability: boolean;
  /** Query parameter used for the next page, if the API declares one. */
  cursorParam: string | null;
  /** Where the parameter list came from. */
  source: 'openapi' | 'documented';
  notes: string[];
}

/** The parameters RunPod documents for GET /catalog/gpus (used only when openapi.json is unreadable). */
export const DOCUMENTED_CATALOG_PARAMS: ApiParam[] = [
  { name: 'include', required: false, enumValues: ['AVAILABILITY'], maximum: null, hasDefault: false },
  {
    name: 'cloudType',
    required: false,
    enumValues: ['SECURE', 'COMMUNITY'],
    maximum: null,
    hasDefault: true,
  },
  { name: 'gpuCount', required: false, enumValues: [], maximum: null, hasDefault: true },
  { name: 'minCudaVersion', required: false, enumValues: [], maximum: null, hasDefault: false },
];

const pick = (values: string[], wanted: string): string | null =>
  values.find((v) => v.toLowerCase() === wanted.toLowerCase()) ?? null;

/**
 * Builds the GPU catalog query from the parameters the API declares. Only declared
 * parameters are sent; the availability parameters (cloudType, gpuCount) are sent only
 * together with include=AVAILABILITY, as RunPod requires. An unknown REQUIRED parameter
 * means the API changed: the plan says so instead of guessing a value.
 */
export function planCatalogQuery(
  declared: ApiParam[],
  cloud: 'SECURE' | 'COMMUNITY',
  opts: { availability: boolean; source: 'openapi' | 'documented' },
): CatalogQueryPlan {
  const plan: CatalogQueryPlan = {
    params: {},
    availability: false,
    cursorParam: null,
    source: opts.source,
    notes: [],
  };
  const byName = new Map(declared.map((p) => [p.name.toLowerCase(), p]));
  const include = byName.get('include');
  const includeValue = include
    ? include.enumValues.length
      ? pick(include.enumValues, 'AVAILABILITY')
      : 'AVAILABILITY'
    : null;
  if (opts.availability && include && includeValue) {
    plan.params[include.name] = includeValue;
    plan.availability = true;
  } else if (opts.availability && !include)
    plan.notes.push('RunPod no longer offers live stock in the GPU catalog.');
  else if (opts.availability && include && !includeValue)
    plan.notes.push(
      `RunPod's catalog "include" no longer accepts AVAILABILITY (${include.enumValues.join(', ')}).`,
    );
  const unknownRequired: string[] = [];
  for (const p of declared) {
    const key = p.name.toLowerCase();
    if (key === 'include') continue;
    if (key === 'cloudtype' || key === 'cloud') {
      if (plan.availability || p.required)
        plan.params[p.name] = p.enumValues.length ? (pick(p.enumValues, cloud) ?? cloud) : cloud;
    } else if (key === 'gpucount') {
      if (plan.availability || p.required) plan.params[p.name] = '1';
    } else if (key === 'limit' || key === 'pagesize' || key === 'perpage' || key === 'per_page') {
      plan.params[p.name] = String(Math.min(p.maximum ?? 100, 100));
    } else if (
      key === 'cursor' ||
      key === 'after' ||
      key === 'pagetoken' ||
      key === 'page_token' ||
      key === 'nextcursor'
    ) {
      plan.cursorParam = p.name;
    } else if (p.required && !p.hasDefault) unknownRequired.push(p.name);
  }
  if (unknownRequired.length)
    plan.notes.push(
      `RunPod's GPU catalog now requires ${unknownRequired.join(', ')}, which AI Story Studio does not know yet. Update AI Story Studio.`,
    );
  return plan;
}

/** "/v2/pods/{podId}/action" → "/pods/{}/action" */
const normPath = (p: string): string => p.replace(/^\/v2(?=\/)/, '').replace(/\{[^}]+\}/g, '{}');

export class RunPodApi implements CloudGpuApi {
  readonly id = 'runpod' as const;
  readonly displayName = 'RunPod';
  readonly supported = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly proxyTemplate: string;
  private readonly fetchFn: FetchFn;
  private readonly sleep: SleepFn;
  private readonly retry: RetryPolicy | undefined;
  private contract: ContractReport | undefined;
  private createFieldTypes = new Map<string, string>();
  private spec: Json | null | undefined;
  private specError = '';
  /** What the last GPU catalog read did (shown by the dry-run diagnostics). */
  catalogNotes: string[] = [];

  constructor(opts: RunPodOptions) {
    if (!opts.apiKey)
      throw new AppError(
        'CLOUD_AUTH_FAILED',
        'No RunPod API key is configured. Add it in Settings → Cloud GPU.',
      );
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.runpod.io/v2').replace(/\/+$/, '');
    this.proxyTemplate = opts.proxyUrlTemplate ?? 'https://{podId}-{port}.proxy.runpod.net';
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.retry = opts.retry;
  }

  private call<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    retry: 'idempotent' | 'no-duplicate' = 'idempotent',
    what?: string,
  ): Promise<{ status: number; body: T }> {
    return requestJson<T>(
      {
        method,
        url: this.baseUrl + path,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body,
        retry,
        provider: 'RunPod',
        ...(what ? { what } : {}),
      },
      { fetch: this.fetchFn, sleep: this.sleep, ...(this.retry ? { policy: this.retry } : {}) },
    );
  }

  async testConnection(): Promise<{ ok: true; detail: string }> {
    const { body } = await this.call('GET', '/pods?limit=1');
    const n = listOf(body, ['data', 'items', 'pods']).length;
    return {
      ok: true,
      detail: `RunPod API v2 reachable; key accepted (${n ? 'pods visible' : 'no pods listed'}).`,
    };
  }

  /** RunPod's published API description, fetched once (null when it could not be read). */
  private async loadSpec(): Promise<Json | null> {
    if (this.spec !== undefined) return this.spec;
    try {
      this.spec = obj(
        (await this.call<unknown>('GET', '/openapi.json', undefined, 'idempotent', 'API description')).body,
      );
    } catch (err) {
      if (err instanceof CloudHttpError && err.code === 'CLOUD_AUTH_FAILED') throw err;
      this.specError = (err as Error).message;
      this.spec = null;
    }
    return this.spec;
  }

  /** Query parameters the published API declares for GET /catalog/gpus (null: unknown). */
  catalogParams(spec: Json): ApiParam[] | null {
    const paths = obj(spec['paths']);
    const entry = Object.entries(paths).find(([p]) => normPath(p) === '/catalog/gpus');
    if (!entry) return null;
    const pathItem = obj(entry[1]);
    const op = obj(pathItem['get']);
    const components = obj(spec['components']);
    const resolve = (v: unknown, depth = 0): Json => {
      const o = obj(v);
      const ref = str(o['$ref']);
      if (ref && depth < 6) {
        const [, , section, name] = ref.split('/');
        if (section && name) return resolve(obj(components[section])[name], depth + 1);
      }
      return o;
    };
    // No parameter list at all = the document does not describe them (not "accepts none").
    if (!Array.isArray(pathItem['parameters']) && !Array.isArray(op['parameters'])) return null;
    const raw = [
      ...(Array.isArray(pathItem['parameters']) ? (pathItem['parameters'] as unknown[]) : []),
      ...(Array.isArray(op['parameters']) ? (op['parameters'] as unknown[]) : []),
    ];
    const out: ApiParam[] = [];
    for (const r of raw) {
      const p = resolve(r);
      if (str(p['in']) !== 'query' || !str(p['name'])) continue;
      const schema = resolve(p['schema']);
      const items = resolve(schema['items']);
      const enums = [schema['enum'], items['enum']].find(Array.isArray) as unknown[] | undefined;
      out.push({
        name: str(p['name'])!,
        required: p['required'] === true,
        enumValues: (enums ?? []).filter((e): e is string => typeof e === 'string'),
        maximum: num(schema['maximum']),
        hasDefault: schema['default'] !== undefined,
      });
    }
    return out;
  }

  private async readCatalog(plan: CatalogQueryPlan): Promise<unknown[]> {
    const all: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams(plan.params);
      if (cursor && plan.cursorParam) q.set(plan.cursorParam, cursor);
      const qs = q.toString();
      const { body } = await this.call(
        'GET',
        `/catalog/gpus${qs ? `?${qs}` : ''}`,
        undefined,
        'idempotent',
        'GPU catalog',
      );
      const list = catalogList(body);
      if (list === null)
        throw new AppError(
          'CLOUD_BAD_REQUEST',
          `RunPod returned the GPU catalog in an unexpected format (${describeShape(body)}). Nothing was rented. Update AI Story Studio.`,
        );
      all.push(...list);
      const b = obj(body);
      cursor = plan.cursorParam
        ? str(b['nextCursor'], b['next_cursor'], obj(b['pagination'])['nextCursor'], obj(b['page'])['next'])
        : null;
      if (!cursor) break;
    }
    return all;
  }

  /**
   * GPU types with prices (and stock when RunPod reports it). The query uses only the
   * parameters RunPod's openapi.json declares for this endpoint. If RunPod still refuses
   * the stock query, prices are read without it (a free, read-only GET) so the price
   * ceiling can still be enforced; the reason is kept in catalogNotes.
   */
  async listGpuTypes(cloud: 'SECURE' | 'COMMUNITY' = 'SECURE'): Promise<CloudGpuType[]> {
    const notes: string[] = [];
    const spec = await this.loadSpec();
    const declared = spec ? this.catalogParams(spec) : null;
    const source = declared ? 'openapi' : 'documented';
    if (!declared)
      notes.push(
        spec
          ? 'RunPod’s API description does not list the GPU catalog parameters; using the documented ones.'
          : `RunPod’s API description could not be read (${this.specError || 'unknown error'}); using the documented catalog parameters.`,
      );
    const params = declared ?? DOCUMENTED_CATALOG_PARAMS;
    const plan = planCatalogQuery(params, cloud, { availability: true, source });
    notes.push(...plan.notes);
    if (plan.notes.some((n) => n.includes('requires'))) {
      this.catalogNotes = notes;
      throw new AppError('CLOUD_BAD_REQUEST', plan.notes.find((n) => n.includes('requires'))!);
    }
    let rows: unknown[];
    try {
      rows = await this.readCatalog(plan);
    } catch (err) {
      const refused = err instanceof CloudHttpError && (err.status === 400 || err.status === 422);
      if (!refused || !plan.availability) {
        this.catalogNotes = notes;
        throw err;
      }
      // Stock query refused: read prices without it, so the price ceiling still applies.
      notes.push(`Live stock query refused (${err.message}); prices were read without stock.`);
      rows = await this.readCatalog(planCatalogQuery(params, cloud, { availability: false, source }));
      plan.availability = false;
    }
    const types = rows.map((g) => parseGpuType(g, cloud)).filter((g) => g.id);
    if (rows.length && !types.length)
      throw new AppError(
        'CLOUD_BAD_REQUEST',
        'RunPod returned GPU catalog entries without ids. Nothing was rented. Update AI Story Studio.',
      );
    notes.push(
      `${types.length} GPU type(s) listed; ${types.filter((t) => t.hourlyUsd !== null).length} with a ${cloud.toLowerCase()} price; stock ${plan.availability ? 'included' : 'not reported'} (catalog parameters from ${source === 'openapi' ? 'openapi.json' : 'the documentation'}: ${Object.keys(plan.params).join(', ') || 'none'}).`,
    );
    this.catalogNotes = notes;
    return types;
  }

  async checkContract(): Promise<ContractReport> {
    const report: ContractReport = {
      checked: false,
      ok: false,
      source: `${this.baseUrl}/openapi.json`,
      missingPaths: [],
      missingCreateFields: [],
      createFields: [],
      notes: [],
    };
    this.spec = undefined; // always re-read: the contract check is the explicit "is it still the same API" test
    const spec = await this.loadSpec();
    if (!spec) {
      report.notes.push(`Could not read RunPod's API description: ${this.specError}`);
      this.contract = report;
      return report;
    }
    report.checked = true;
    const paths = obj(spec['paths']);
    const have = new Set(Object.keys(paths).map(normPath));
    report.missingPaths = REQUIRED_PATHS.filter((p) => !have.has(p));
    const schemas = obj(obj(spec['components'])['schemas']);
    const resolve = (s: unknown, depth = 0): Json => {
      const o = obj(s);
      if (depth > 8) return o;
      const ref = str(o['$ref']);
      if (ref?.startsWith('#/components/schemas/')) return resolve(schemas[ref.split('/').pop()!], depth + 1);
      const merged: Json = { ...o, properties: { ...obj(o['properties']) } };
      for (const key of ['allOf', 'oneOf', 'anyOf'])
        if (Array.isArray(o[key]))
          for (const part of o[key] as unknown[])
            Object.assign(merged['properties'] as Json, obj(resolve(part, depth + 1)['properties']));
      return merged;
    };
    const podsPath = Object.entries(paths).find(([p]) => normPath(p) === '/pods')?.[1];
    const createSchema = resolve(
      obj(obj(obj(obj(obj(podsPath)['post'])['requestBody'])['content'])['application/json'])['schema'],
    );
    const props = obj(createSchema['properties']);
    report.createFields = Object.keys(props).sort();
    this.createFieldTypes = new Map(
      Object.entries(props).map(([k, v]) => [k, str(resolve(v)['type']) ?? 'object'] as [string, string]),
    );
    report.missingCreateFields = EXPECTED_CREATE_FIELDS.filter((f) => !(f in props));
    const gpuProps = obj(resolve(props['gpu'])['properties']);
    if ('gpu' in props && !('id' in gpuProps && 'count' in gpuProps))
      report.notes.push('The create-pod "gpu" object no longer declares both "id" and "count".');
    report.ok =
      report.missingPaths.length === 0 &&
      REQUIRED_CREATE_FIELDS.every((f) => f in props) &&
      !report.notes.some((n) => n.includes('"gpu"'));
    this.contract = report;
    return report;
  }

  private optionalField(candidates: string[], type: 'number' | 'string'): string | undefined {
    return candidates.find((c) => {
      const t = this.createFieldTypes.get(c);
      return t === type || (type === 'number' && t === 'integer');
    });
  }

  async createPod(spec: CloudPodSpec): Promise<CloudPod> {
    const contract = this.contract ?? (await this.checkContract());
    if (contract.checked && !contract.ok)
      throw new AppError(
        'CLOUD_BAD_REQUEST',
        `RunPod's API no longer matches what AI Story Studio expects (${[
          ...contract.missingPaths.map((p) => `path ${p}`),
          ...contract.missingCreateFields
            .filter((f) => REQUIRED_CREATE_FIELDS.includes(f))
            .map((f) => `field ${f}`),
          ...contract.notes,
        ].join('; ')}). Nothing was created. Update AI Story Studio.`,
      );
    const body: Json = {
      name: spec.name,
      image: spec.image,
      gpu: { id: spec.gpuTypeId, count: spec.gpuCount },
      cloud: spec.cloud,
      env: spec.env,
      ports: spec.ports,
    };
    if (spec.volume?.kind === 'persistent')
      body['mounts'] = { persistent: { size: spec.volume.sizeGb, path: spec.volume.path } };
    if (spec.volume?.kind === 'network')
      body['mounts'] = { network: [{ volumeId: spec.volume.volumeId, path: spec.volume.path }] };
    const diskField = this.optionalField(CONTAINER_DISK_FIELDS, 'number');
    if (diskField) body[diskField] = spec.containerDiskGb;
    const registryField = this.optionalField(REGISTRY_AUTH_FIELDS, 'string');
    if (spec.registryAuthId) {
      if (!registryField)
        throw new AppError(
          'CLOUD_BAD_REQUEST',
          'This RunPod API version has no registry-credential field; use a public worker image.',
        );
      body[registryField] = spec.registryAuthId;
    }
    const { body: created } = await this.call('POST', '/pods', body, 'no-duplicate');
    const pod = parsePod(obj(created)['pod'] ?? created);
    if (!pod.id)
      throw new AppError('CLOUD_BAD_REQUEST', 'RunPod accepted the request but returned no pod id');
    return pod;
  }

  async getPod(id: string): Promise<CloudPod | null> {
    try {
      const { body } = await this.call('GET', `/pods/${encodeURIComponent(id)}`);
      return parsePod(obj(body)['pod'] ?? body);
    } catch (err) {
      if (err instanceof CloudHttpError && err.status === 404) return null;
      throw err;
    }
  }

  async listPods(): Promise<CloudPod[]> {
    const pods: CloudPod[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const q: string = `/pods?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { body } = await this.call('GET', q);
      pods.push(...listOf(body, ['data', 'items', 'pods']).map(parsePod));
      const b = obj(body);
      cursor = str(
        b['nextCursor'],
        b['next_cursor'],
        obj(b['pagination'])['nextCursor'],
        obj(b['page'])['next'],
      );
      if (!cursor) break;
    }
    return pods.filter((p) => p.id);
  }

  async stopPod(id: string): Promise<void> {
    await this.call('POST', `/pods/${encodeURIComponent(id)}/action`, { action: 'stop' });
  }

  async terminatePod(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/pods/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof CloudHttpError && err.status === 404) return; // already gone
      if (err instanceof CloudHttpError && err.status === 405) {
        await this.call('POST', `/pods/${encodeURIComponent(id)}/action`, { action: 'terminate' });
        return;
      }
      throw err;
    }
  }

  workerUrl(podId: string, port: number): string {
    return this.proxyTemplate.replace('{podId}', encodeURIComponent(podId)).replace('{port}', String(port));
  }
}
