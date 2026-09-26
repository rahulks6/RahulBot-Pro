import type { FetchFn } from '../providers/cloud/http.ts';

/**
 * Checks whether a container image can be pulled WITHOUT credentials, exactly as a
 * RunPod pod would pull a public image. It speaks the standard registry protocol
 * (OCI distribution): HEAD/GET the manifest anonymously, follow the registry's
 * `WWW-Authenticate: Bearer realm=…` challenge to get an anonymous pull token, and
 * try again. Nothing is downloaded except the small manifest; no credential is used.
 */
export type ImageStatus = 'PUBLIC' | 'AUTH_REQUIRED' | 'NOT_FOUND' | 'UNREACHABLE' | 'INVALID';

export interface ImageCheckResult {
  status: ImageStatus;
  image: string;
  registry: string;
  repository: string;
  reference: string;
  /** Platforms listed by a multi-platform image (e.g. linux/amd64). */
  platforms: string[];
  digest: string | null;
  detail: string;
}

export const IMAGE_STATUS_LABEL: Record<ImageStatus, string> = {
  PUBLIC: 'IMAGE EXISTS AND PUBLICLY PULLABLE',
  AUTH_REQUIRED: 'IMAGE REQUIRES AUTHENTICATION',
  NOT_FOUND: 'IMAGE DOES NOT EXIST',
  UNREACHABLE: 'REGISTRY UNREACHABLE',
  INVALID: 'IMAGE NAME NOT VALID',
};

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface ParsedImage {
  registry: string;
  /** Host actually contacted (Docker Hub's API lives on registry-1.docker.io). */
  apiHost: string;
  repository: string;
  reference: string;
}

/** "ghcr.io/owner/name:tag", "owner/name:tag" (Docker Hub), "name" (Docker Hub library, :latest), "x@sha256:…". */
export function parseImage(image: string): ParsedImage | null {
  const s = image.trim();
  if (!s || /\s/.test(s) || s.length > 512) return null;
  let rest = s;
  let reference = 'latest';
  const at = rest.indexOf('@');
  if (at >= 0) {
    reference = rest.slice(at + 1);
    rest = rest.slice(0, at);
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon > rest.lastIndexOf('/')) {
      reference = rest.slice(colon + 1);
      rest = rest.slice(0, colon);
    }
  }
  const parts = rest.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!)) registry = parts.shift()!;
  let repository = parts.join('/');
  if (registry === 'docker.io' && parts.length === 1) repository = `library/${repository}`;
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(repository)) return null;
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|sha256:[a-f0-9]{64})$/.test(reference)) return null;
  const apiHost = registry === 'docker.io' ? 'registry-1.docker.io' : registry;
  return { registry, apiHost, repository, reference };
}

/** Parses `Bearer realm="…",service="…",scope="…"`. */
export function parseChallenge(header: string | null): Record<string, string> | null {
  if (!header || !/^\s*bearer\s/i.test(header)) return null;
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) out[m[1]!.toLowerCase()] = m[2]!;
  return out['realm'] ? out : null;
}

/**
 * Error codes from a registry error response, and whether the answer came from a registry at all:
 * registries answer with JSON {"errors":[{"code":…}]} and/or a Docker-Distribution-Api-Version
 * header; a plain-text 403 comes from a proxy, firewall or antivirus in between.
 */
async function registryAnswer(res: Response): Promise<{ codes: string[]; fromRegistry: boolean }> {
  const header = res.headers.has('docker-distribution-api-version');
  try {
    const body = (await res.json()) as { errors?: Array<{ code?: unknown }> };
    const errors = Array.isArray(body.errors) ? body.errors : null;
    return {
      codes: (errors ?? []).map((e) => String(e.code ?? '')).filter(Boolean),
      fromRegistry: header || errors !== null,
    };
  } catch {
    return { codes: [], fromRegistry: header };
  }
}

export interface ImageCheckOptions {
  fetch?: FetchFn;
  timeoutMs?: number;
  /** Tests only: talk plain HTTP to this base URL instead of https://<registry host>. */
  baseUrlFor?: (apiHost: string) => string;
}

/** Anonymous pullability check. Never throws; network trouble is reported as UNREACHABLE. */
export async function checkImagePullable(
  image: string,
  opts: ImageCheckOptions = {},
): Promise<ImageCheckResult> {
  const fetchFn = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 10_000;
  const parsed = parseImage(image);
  const result = (
    status: ImageStatus,
    detail: string,
    extra: Partial<ImageCheckResult> = {},
  ): ImageCheckResult => ({
    status,
    image,
    registry: parsed?.registry ?? '',
    repository: parsed?.repository ?? '',
    reference: parsed?.reference ?? '',
    platforms: [],
    digest: null,
    detail,
    ...extra,
  });
  if (!parsed)
    return result(
      'INVALID',
      `"${image}" is not a valid image name (expected e.g. ghcr.io/you/ai-story-studio-worker:1.1.0).`,
    );
  const base = opts.baseUrlFor?.(parsed.apiHost) ?? `https://${parsed.apiHost}`;
  const manifestUrl = `${base}/v2/${parsed.repository}/manifests/${parsed.reference}`;
  const where = `${parsed.registry}/${parsed.repository}:${parsed.reference}`;

  const get = (url: string, headers: Record<string, string> = {}) =>
    fetchFn(url, { headers: { Accept: MANIFEST_TYPES, ...headers }, signal: AbortSignal.timeout(timeout) });

  try {
    let res = await get(manifestUrl);
    if (res.status === 401) {
      const challenge = parseChallenge(res.headers.get('www-authenticate'));
      await res.body?.cancel();
      if (!challenge)
        return result(
          'AUTH_REQUIRED',
          `${where} requires authentication (the registry offers no anonymous access).`,
        );
      const realm = new URL(challenge['realm']!);
      if (realm.protocol !== 'https:' && !opts.baseUrlFor)
        return result('UNREACHABLE', `${parsed.registry} asked for a non-HTTPS login address; not followed.`);
      if (challenge['service']) realm.searchParams.set('service', challenge['service']);
      realm.searchParams.set('scope', challenge['scope'] ?? `repository:${parsed.repository}:pull`);
      const tokenRes = await fetchFn(realm, { signal: AbortSignal.timeout(timeout) });
      if (tokenRes.status === 401 || tokenRes.status === 403) {
        await tokenRes.body?.cancel();
        return result(
          'AUTH_REQUIRED',
          `${where} is not available anonymously (the registry refused an anonymous pull token).`,
        );
      }
      if (tokenRes.status >= 500)
        return result(
          'UNREACHABLE',
          `${parsed.registry} is having problems (HTTP ${tokenRes.status} from its login service).`,
        );
      const tokenBody = (await tokenRes.json().catch(() => ({}))) as {
        token?: string;
        access_token?: string;
      };
      const token = tokenBody.token ?? tokenBody.access_token;
      if (!token)
        return result('AUTH_REQUIRED', `${where} is not available anonymously (no pull token was issued).`);
      res = await get(manifestUrl, { Authorization: `Bearer ${token}` });
    }
    if (res.ok) {
      const digest = res.headers.get('docker-content-digest');
      let platforms: string[] = [];
      try {
        const m = (await res.json()) as {
          manifests?: Array<{ platform?: { os?: string; architecture?: string } }>;
        };
        platforms = (m.manifests ?? [])
          .map((x) =>
            x.platform?.os && x.platform.architecture ? `${x.platform.os}/${x.platform.architecture}` : '',
          )
          .filter((p) => p && p !== 'unknown/unknown');
      } catch {
        /* a single-platform manifest */
      }
      if (platforms.length && !platforms.includes('linux/amd64'))
        return result(
          'NOT_FOUND',
          `${where} exists but has no linux/amd64 build (it has ${platforms.join(', ')}). RunPod GPUs need linux/amd64.`,
          {
            platforms,
            digest,
          },
        );
      return result(
        'PUBLIC',
        `${where} can be pulled without credentials${platforms.length ? ` (${platforms.join(', ')})` : ''}.`,
        {
          platforms,
          digest,
        },
      );
    }
    const { codes, fromRegistry } = await registryAnswer(res);
    if ((res.status === 401 || res.status === 403) && !fromRegistry)
      return result(
        'UNREACHABLE',
        `Something between this computer and ${parsed.registry} refused the connection (HTTP ${res.status} that did not come from the registry: a proxy, firewall or antivirus). This says nothing about the image; check your network and try again.`,
      );
    if (res.status === 404 || codes.some((c) => c === 'MANIFEST_UNKNOWN' || c === 'NAME_UNKNOWN'))
      return result(
        'NOT_FOUND',
        `${where} was not found: ${codes.includes('NAME_UNKNOWN') ? 'the repository does not exist' : `there is no tag "${parsed.reference}"`}. Build and push it first.`,
      );
    if (res.status === 401 || res.status === 403)
      return result(
        'AUTH_REQUIRED',
        `${where} is private or not published (HTTP ${res.status}${codes.length ? ` ${codes.join(', ')}` : ''}). RunPod cannot pull it without credentials.${
          parsed.registry === 'ghcr.io'
            ? ' GitHub Container Registry gives this same answer when the package was never pushed, so push it first if you have not, then make it public.'
            : ''
        }`,
      );
    if (res.status === 429)
      return result(
        'UNREACHABLE',
        `${parsed.registry} is rate-limiting requests; try again in a few minutes.`,
      );
    if (res.status >= 500)
      return result(
        'UNREACHABLE',
        `${parsed.registry} is having problems (HTTP ${res.status}); try again later.`,
      );
    return result('AUTH_REQUIRED', `${where} could not be pulled anonymously (HTTP ${res.status}).`);
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const why =
      e.name === 'TimeoutError'
        ? 'timed out'
        : e.cause?.code === 'ENOTFOUND' || e.cause?.code === 'EAI_AGAIN'
          ? 'name lookup failed'
          : 'network error';
    return result(
      'UNREACHABLE',
      `Could not reach ${parsed.registry} (${why}). Check your internet connection and try again.`,
    );
  }
}
