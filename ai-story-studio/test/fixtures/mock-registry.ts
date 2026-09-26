import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-process fake container registry (OCI distribution protocol, like ghcr.io):
 * anonymous manifest requests get a 401 Bearer challenge, the token endpoint
 * issues anonymous pull tokens, and the manifest then answers according to the
 * repository's visibility. Nothing leaves the machine.
 */
export type RepoVisibility = 'public' | 'private';

export interface FakeRepo {
  visibility: RepoVisibility;
  tags: Record<string, { platforms: string[] }>;
}

export class MockRegistry {
  server!: Server;
  base = '';
  repos = new Map<string, FakeRepo>();
  /** How the registry answers anonymous requests for private or unknown repositories. */
  deniedStyle: 'ghcr' | 'strict' = 'ghcr';
  /** Refuse to issue anonymous tokens at all (some registries do). */
  refuseAnonymousTokens = false;
  failWith: number | null = null;
  /** Answer like a blocking proxy: plain-text 403, no registry headers. */
  proxyBlock = false;
  requests: Array<{ path: string; auth: string | undefined }> = [];

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      this.requests.push({ path: url.pathname + url.search, auth: req.headers.authorization });
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (this.proxyBlock) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden by proxy policy');
        return;
      }
      if (this.failWith) return json(this.failWith, { errors: [{ code: 'UNAVAILABLE' }] });
      if (url.pathname === '/token') {
        if (this.refuseAnonymousTokens) return json(401, { errors: [{ code: 'UNAUTHORIZED' }] });
        const scope = url.searchParams.get('scope') ?? '';
        return json(200, { token: `anon:${scope}` });
      }
      const m = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(url.pathname);
      if (!m) return json(404, { errors: [{ code: 'NOT_FOUND' }] });
      const [, repo, tag] = m as unknown as [string, string, string];
      const auth = req.headers.authorization;
      if (!auth)
        return json(
          401,
          { errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] },
          {
            'WWW-Authenticate': `Bearer realm="${this.base}/token",service="mock-registry",scope="repository:${repo}:pull"`,
          },
        );
      const r = this.repos.get(repo);
      if (!r || r.visibility === 'private') {
        // GHCR answers "private" and "does not exist" identically to anonymous users.
        if (!r && this.deniedStyle === 'strict') return json(404, { errors: [{ code: 'NAME_UNKNOWN' }] });
        return json(403, {
          errors: [{ code: 'DENIED', message: 'requested access to the resource is denied' }],
        });
      }
      const t = r.tags[tag];
      if (!t) return json(404, { errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown' }] });
      return json(
        200,
        {
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifests: t.platforms.map((p) => {
            const [os, architecture] = p.split('/');
            return { digest: `sha256:${'0'.repeat(64)}`, platform: { os, architecture } };
          }),
        },
        { 'Docker-Content-Digest': `sha256:${'a'.repeat(64)}` },
      );
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((r) => {
      this.server.closeAllConnections();
      this.server.close(() => r());
    });
  }
}
