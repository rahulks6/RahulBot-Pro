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
 *   GET    /catalog/gpus             GPU types, prices, stock (include=AVAILABILITY, gpuCount)
 *   GET    /openapi.json             machine-readable contract (checked before the first create)
 * Pod HTTP ports are reached through https://{podId}-{port}.proxy.runpod.net.
 *
 * Response shapes are parsed tolerantly (field names are looked up with
 * fallbacks) and optional create fields are only sent when the published
 * OpenAPI document declares them.
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

export function parseGpuType(raw: unknown, cloud: 'SECURE' | 'COMMUNITY'): CloudGpuType {
  const g = obj(raw);
  const lowest = obj(g['lowestPrice']);
  const availability = obj(g['availability']);
  const prices = obj(g['prices']);
  const stock = str(g['stockStatus'], lowest['stockStatus'], availability['stockStatus']);
  const preferred =
    cloud === 'SECURE'
      ? [g['securePrice'], prices['secure'], availability['securePrice']]
      : [g['communityPrice'], prices['community'], availability['communityPrice']];
  const hourlyUsd = num(
    ...preferred,
    lowest['uninterruptablePrice'],
    g['price'],
    g['pricePerHour'],
    g['onDemandPrice'],
  );
  let available: boolean | null = null;
  if (typeof availability['available'] === 'boolean') available = availability['available'] as boolean;
  else if (typeof g['available'] === 'boolean') available = g['available'] as boolean;
  else if (stock) available = !/^(none|unavailable|out[_ ]?of[_ ]?stock|0)$/i.test(stock);
  return {
    id: str(g['id'], g['gpuTypeId']) ?? '',
    displayName: str(g['displayName'], g['name'], g['id']) ?? 'unknown GPU',
    vramGb: num(g['memoryInGb'], g['vramGb'], g['memoryGb'], g['vram']) ?? 0,
    hourlyUsd,
    available,
    stock,
  };
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
  ): Promise<{ status: number; body: T }> {
    return requestJson<T>(
      {
        method,
        url: this.baseUrl + path,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body,
        retry,
        provider: 'RunPod',
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

  async listGpuTypes(cloud: 'SECURE' | 'COMMUNITY' = 'SECURE'): Promise<CloudGpuType[]> {
    const { body } = await this.call('GET', '/catalog/gpus?include=AVAILABILITY&gpuCount=1');
    return listOf(body, ['data', 'items', 'gpus', 'gpuTypes'])
      .map((g) => parseGpuType(g, cloud))
      .filter((g) => g.id);
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
    let spec: Json;
    try {
      spec = obj((await this.call<unknown>('GET', '/openapi.json')).body);
    } catch (err) {
      if (err instanceof CloudHttpError && err.code === 'CLOUD_AUTH_FAILED') throw err;
      report.notes.push(`Could not read RunPod's API description: ${(err as Error).message}`);
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
