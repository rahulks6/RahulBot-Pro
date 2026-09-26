import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { YoutubeEndpoints } from '../../src/services/youtube.ts';

/**
 * A stand-in for Google's OAuth 2.0 server and the YouTube Data API v3, on a real local HTTP
 * port, so the app's real YoutubeClient (fetch, headers, resumable protocol) is exercised. It
 * checks what Google checks: client ID/secret, redirect URI, PKCE S256 verifier, bearer tokens,
 * resumable Content-Range offsets. Tokens are made at runtime (never literals in the repo).
 */
export interface MockUpload {
  meta: {
    snippet: Record<string, unknown>;
    status: {
      privacyStatus: string;
      publishAt?: string;
      selfDeclaredMadeForKids?: boolean;
      containsSyntheticMedia?: boolean;
    };
  };
  size: number;
  data: Buffer;
  videoId: string | null;
}

export interface MockVideo {
  id: string;
  meta: MockUpload['meta'];
  bytes: number;
  status: { uploadStatus: string; privacyStatus: string; publishAt?: string };
  captions: Array<{ language: string; text: string }>;
  thumbnail: { mime: string; bytes: number } | null;
}

export class MockYoutube {
  server!: Server;
  base = '';
  readonly clientId = `${1000000 + Math.floor(Math.random() * 9000000)}-${randomBytes(8).toString('hex')}.apps.googleusercontent.com`;
  readonly clientSecret = `GOCSPX-${randomBytes(14).toString('base64url')}`;
  /** Every token ever issued (for "never stored in plain text / never logged" checks). */
  readonly issued: string[] = [];
  readonly revoked: string[] = [];
  readonly uploads = new Map<string, MockUpload>();
  readonly videos = new Map<string, MockVideo>();
  readonly requests: Array<{ method: string; path: string }> = [];
  private readonly codes = new Map<
    string,
    { challenge: string; redirectUri: string; clientId: string; scope: string }
  >();
  private readonly access = new Map<string, number>(); // token → expiry (ms)
  private readonly refresh = new Set<string>();

  // --- behaviour switches for tests ---
  /** Unaudited API project: every upload is locked to private (and loses its publish time). */
  unaudited = false;
  /** The channel is not verified: thumbnails.set answers 403. */
  thumbnailsForbidden = false;
  /** Drop the connection after receiving this many bytes of the next chunk (then reset). */
  dropNextChunkAfter: number | null = null;
  /** Grant only these scopes on the next sign-in (the person unticked some). */
  grantScopes: string[] | null = null;
  /** Access token lifetime in seconds. */
  tokenLifetime = 3600;
  now: () => number = Date.now;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500).end(String(err));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  endpoints(): YoutubeEndpoints {
    return {
      auth: `${this.base}/o/oauth2/v2/auth`,
      token: `${this.base}/token`,
      revoke: `${this.base}/revoke`,
      api: `${this.base}/youtube/v3`,
      upload: `${this.base}/upload/youtube/v3`,
    };
  }

  /** Mark a scheduled/private video as published (what YouTube does at publishAt). */
  publish(id: string): void {
    const v = this.videos.get(id)!;
    v.status = { ...v.status, privacyStatus: 'public', uploadStatus: 'processed' };
    delete v.status.publishAt;
  }

  private body(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });
  }

  private json(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  }

  private apiError(res: ServerResponse, status: number, reason: string, message: string): void {
    this.json(res, status, { error: { code: status, message, errors: [{ reason, message }] } });
  }

  private authorized(req: IncomingMessage): boolean {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const exp = m ? this.access.get(m[1]!) : undefined;
    return exp !== undefined && exp > this.now();
  }

  private issue(scope: string): {
    access_token: string;
    expires_in: number;
    scope: string;
    token_type: string;
  } {
    const access = `ya29.${randomBytes(24).toString('base64url')}`;
    this.access.set(access, this.now() + this.tokenLifetime * 1000);
    this.issued.push(access);
    return { access_token: access, expires_in: this.tokenLifetime, scope, token_type: 'Bearer' };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, this.base);
    const path = url.pathname;
    this.requests.push({ method: req.method!, path });

    // --- the consent screen: the "person" signs in and allows; Google redirects back ---
    if (req.method === 'GET' && path === '/o/oauth2/v2/auth') {
      const q = url.searchParams;
      if (q.get('client_id') !== this.clientId) return this.json(res, 400, { error: 'invalid_client' });
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge'))
        return this.json(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 required' });
      if (q.get('access_type') !== 'offline')
        return this.json(res, 400, { error: 'offline access expected' });
      const code = `4/${randomBytes(16).toString('base64url')}`;
      this.codes.set(code, {
        challenge: q.get('code_challenge')!,
        redirectUri: q.get('redirect_uri')!,
        clientId: q.get('client_id')!,
        scope: (this.grantScopes ?? q.get('scope')!.split(' ')).join(' '),
      });
      this.grantScopes = null;
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('state', q.get('state')!);
      back.searchParams.set('code', code);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }

    if (req.method === 'POST' && path === '/token') {
      const f = new URLSearchParams((await this.body(req)).toString());
      if (f.get('client_id') !== this.clientId || f.get('client_secret') !== this.clientSecret)
        return this.json(res, 401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = this.codes.get(f.get('code') ?? '');
        this.codes.delete(f.get('code') ?? '');
        if (!c) return this.json(res, 400, { error: 'invalid_grant', error_description: 'Bad code.' });
        if (c.redirectUri !== f.get('redirect_uri'))
          return this.json(res, 400, { error: 'redirect_uri_mismatch' });
        const verifier = f.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge)
          return this.json(res, 400, {
            error: 'invalid_grant',
            error_description: 'PKCE verification failed.',
          });
        const refresh = `1//${randomBytes(30).toString('base64url')}`;
        this.refresh.add(refresh);
        this.issued.push(refresh);
        return this.json(res, 200, { ...this.issue(c.scope), refresh_token: refresh });
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (!this.refresh.has(f.get('refresh_token') ?? ''))
          return this.json(res, 400, {
            error: 'invalid_grant',
            error_description: 'Token has been revoked.',
          });
        return this.json(res, 200, this.issue('granted'));
      }
      return this.json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (req.method === 'POST' && path === '/revoke') {
      const t = url.searchParams.get('token') ?? '';
      this.revoked.push(t);
      this.refresh.delete(t);
      return this.json(res, 200, {});
    }

    // --- resumable upload session URLs (capabilities: no bearer check on the status probe) ---
    const session = /^\/upload\/session\/([a-z0-9]+)$/.exec(path);
    if (session && req.method === 'PUT') {
      const up = this.uploads.get(session[1]!);
      if (!up) return this.json(res, 404, {});
      if (!this.authorized(req)) return this.apiError(res, 401, 'authError', 'Invalid Credentials');
      const range = req.headers['content-range'] ?? '';
      const probe = /^bytes \*\/(\d+)$/.exec(range);
      const incomplete = (): void => {
        const headers: Record<string, string> = up.data.length
          ? { range: `bytes=0-${up.data.length - 1}` }
          : {};
        res.writeHead(308, headers).end();
      };
      if (probe) return up.videoId ? this.json(res, 200, { id: up.videoId }) : incomplete();
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      if (!m) return this.json(res, 400, { error: 'bad range' });
      const from = Number(m[1]);
      if (from !== up.data.length) return this.json(res, 400, { error: `expected offset ${up.data.length}` });
      if (this.dropNextChunkAfter !== null) {
        // Take part of the chunk, then the "network" fails.
        const keep = this.dropNextChunkAfter;
        this.dropNextChunkAfter = null;
        const chunk = await this.body(req);
        up.data = Buffer.concat([up.data, chunk.subarray(0, keep)]);
        req.socket.destroy();
        return;
      }
      const chunk = await this.body(req);
      up.data = Buffer.concat([up.data, chunk]);
      if (up.data.length < up.size) return incomplete();
      const id = randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
      up.videoId = id;
      const locked = this.unaudited;
      this.videos.set(id, {
        id,
        meta: up.meta,
        bytes: up.data.length,
        status: {
          uploadStatus: 'uploaded',
          privacyStatus: locked ? 'private' : up.meta.status.privacyStatus,
          ...(!locked && up.meta.status.publishAt ? { publishAt: up.meta.status.publishAt } : {}),
        },
        captions: [],
        thumbnail: null,
      });
      return this.json(res, 200, { id, kind: 'youtube#video' });
    }

    if (!this.authorized(req)) return this.apiError(res, 401, 'authError', 'Invalid Credentials');

    if (req.method === 'GET' && path === '/youtube/v3/channels')
      return this.json(res, 200, { items: [{ id: 'UCmockchannel', snippet: { title: 'Milo Stories' } }] });

    if (req.method === 'POST' && path === '/upload/youtube/v3/videos') {
      if (url.searchParams.get('uploadType') !== 'resumable') return this.json(res, 400, {});
      const meta = JSON.parse((await this.body(req)).toString()) as MockUpload['meta'];
      if (typeof meta.status.selfDeclaredMadeForKids !== 'boolean')
        return this.apiError(res, 400, 'invalidVideoMetadata', 'selfDeclaredMadeForKids missing');
      if (meta.status.publishAt && meta.status.privacyStatus !== 'private')
        return this.apiError(res, 400, 'invalidPublishAt', 'Scheduled videos must be private.');
      const id = randomBytes(8).toString('hex');
      this.uploads.set(id, {
        meta,
        size: Number(req.headers['x-upload-content-length']),
        data: Buffer.alloc(0),
        videoId: null,
      });
      res.writeHead(200, { location: `${this.base}/upload/session/${id}?upload_id=${id}` }).end();
      return;
    }

    if (req.method === 'POST' && path === '/upload/youtube/v3/captions') {
      const raw = (await this.body(req)).toString();
      const meta = /\{"snippet".*?\}\}/.exec(raw);
      const snippet = (JSON.parse(meta![0]) as { snippet: { videoId: string; language: string } }).snippet;
      const v = this.videos.get(snippet.videoId);
      if (!v) return this.apiError(res, 404, 'videoNotFound', 'no video');
      const text = raw.split('application/octet-stream\r\n\r\n')[1]!.split('\r\n--')[0]!;
      v.captions.push({ language: snippet.language, text });
      return this.json(res, 200, { id: 'cap1', snippet });
    }

    if (req.method === 'POST' && path === '/upload/youtube/v3/thumbnails/set') {
      if (this.thumbnailsForbidden)
        return this.apiError(
          res,
          403,
          'forbidden',
          'The authenticated user doesnt have permissions to upload and set custom video thumbnails.',
        );
      const v = this.videos.get(url.searchParams.get('videoId') ?? '');
      if (!v) return this.apiError(res, 404, 'videoNotFound', 'no video');
      v.thumbnail = { mime: req.headers['content-type'] ?? '', bytes: (await this.body(req)).length };
      return this.json(res, 200, {});
    }

    if (req.method === 'GET' && path === '/youtube/v3/videos') {
      const v = this.videos.get(url.searchParams.get('id') ?? '');
      return this.json(res, 200, { items: v ? [{ id: v.id, status: v.status }] : [] });
    }

    if (req.method === 'DELETE' && path === '/youtube/v3/videos') {
      const id = url.searchParams.get('id') ?? '';
      if (!this.videos.delete(id)) return this.apiError(res, 404, 'videoNotFound', 'no video');
      res.writeHead(204).end();
      return;
    }

    return this.json(res, 404, { error: `mock: no route ${req.method} ${path}` });
  }
}
