import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../lib/errors.ts';
import type { SecretStore } from './secrets.ts';

/**
 * YouTube Data API v3 with Google OAuth 2.0 for installed apps: the person's own Google Cloud
 * "Desktop app" client, PKCE (S256), a loopback redirect to this app, offline access (refresh
 * token). The Google password never passes through AI Story Studio. Tokens and the client secret
 * are stored encrypted (SecretStore) and never logged or shown.
 *
 * Uploads use the resumable protocol: the file is sent in chunks, and an interrupted upload
 * continues from the last byte YouTube confirmed.
 */
export const YT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  // Captions (captions.insert) and reading the upload's status need the full YouTube scope.
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

export interface YoutubeEndpoints {
  auth: string;
  token: string;
  revoke: string;
  api: string;
  upload: string;
}

export const GOOGLE: YoutubeEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/youtube/v3',
  upload: 'https://www.googleapis.com/upload/youtube/v3',
};

interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
}

export interface VideoStatus {
  id: string;
  uploadStatus: string;
  privacyStatus: string;
  publishAt: string | null;
  failureReason: string | null;
  rejectionReason: string | null;
}

export interface UploadRequest {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  defaultLanguage: string;
  privacy: 'private' | 'unlisted' | 'public';
  publishAt: string | null;
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
}

const CHUNK = 8 * 1024 * 1024;

/** Plain-language meaning of YouTube API errors. */
export function youtubeError(status: number, body: string): AppError {
  let reason = '';
  let message = '';
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string; errors?: Array<{ reason?: string }> } | string;
      error_description?: string;
    };
    if (typeof j.error === 'string') {
      reason = j.error;
      message = j.error_description ?? '';
    } else {
      reason = j.error?.errors?.[0]?.reason ?? '';
      message = j.error?.message ?? '';
    }
  } catch {
    message = body.slice(0, 200);
  }
  if (reason === 'invalid_grant' || status === 401)
    return new AppError(
      'YOUTUBE_AUTH_FAILED',
      'YouTube no longer accepts this connection. Reconnect YouTube (Publish → YouTube).',
    );
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded')
    return new AppError(
      'YOUTUBE_QUOTA_EXCEEDED',
      'The YouTube API daily quota is used up. Uploads can continue tomorrow.',
    );
  if (reason === 'uploadLimitExceeded')
    return new AppError('YOUTUBE_BLOCKED', 'This YouTube channel has reached its upload limit for now.');
  if (reason === 'forbidden' || reason === 'insufficientPermissions' || status === 403)
    return new AppError(
      'YOUTUBE_BLOCKED',
      `YouTube refused the request (${reason || status}): ${message}`.trim(),
    );
  return new AppError(
    'YOUTUBE_UPLOAD_FAILED',
    `YouTube answered ${status}${reason ? ` (${reason})` : ''}: ${message}`.trim(),
  );
}

export class YoutubeClient {
  private readonly secrets: SecretStore;
  private readonly ep: YoutubeEndpoints;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  /** Pending sign-ins: state → PKCE verifier (valid 10 minutes). */
  private readonly pending = new Map<string, { verifier: string; redirectUri: string; at: number }>();

  constructor(
    secrets: SecretStore,
    opts: { endpoints?: Partial<YoutubeEndpoints>; fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.secrets = secrets;
    this.ep = { ...GOOGLE, ...opts.endpoints };
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  // --- client credentials -----------------------------------------------------------------------

  saveClient(clientId: string, clientSecret: string): void {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id))
      throw new AppError(
        'VALIDATION_FAILED',
        'The client ID should end with .apps.googleusercontent.com (Google Cloud → Credentials → OAuth client, type "Desktop app").',
      );
    if (secret.length < 10 || /\s/.test(secret))
      throw new AppError('VALIDATION_FAILED', 'Paste the client secret shown with that OAuth client.');
    this.secrets.setJson('youtubeClient', { clientId: id, clientSecret: secret });
  }

  hasClient(): boolean {
    return this.secrets.source('youtubeClient') !== 'none';
  }

  connected(): boolean {
    return this.secrets.source('youtubeToken') !== 'none';
  }

  private client(): ClientCreds {
    const c = this.secrets.getJson<ClientCreds>('youtubeClient');
    if (!c)
      throw new AppError('YOUTUBE_NOT_CONNECTED', 'Add your Google OAuth client first (Publish → YouTube).');
    return c;
  }

  // --- sign-in (authorization code + PKCE, loopback redirect) --------------------------------------

  authUrl(redirectUri: string): string {
    const c = this.client();
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');
    for (const [k, p] of this.pending) if (this.now() - p.at > 10 * 60_000) this.pending.delete(k);
    this.pending.set(state, { verifier, redirectUri, at: this.now() });
    const q = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: YT_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${this.ep.auth}?${q}`;
  }

  /** The browser came back to the app: exchange the code for tokens. */
  async finishSignIn(state: string, code: string): Promise<void> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || this.now() - p.at > 10 * 60_000)
      throw new AppError(
        'YOUTUBE_AUTH_FAILED',
        'This sign-in link expired or was not started here. Press CONNECT YOUTUBE again.',
      );
    const c = this.client();
    const res = await this.fetch(this.ep.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        code,
        code_verifier: p.verifier,
        grant_type: 'authorization_code',
        redirect_uri: p.redirectUri,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw youtubeError(res.status, text);
    const t = JSON.parse(text) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    };
    if (!t.refresh_token)
      throw new AppError(
        'YOUTUBE_AUTH_FAILED',
        'Google did not grant offline access. Remove the app at myaccount.google.com → Security → Third-party access, then connect again.',
      );
    const missing = YT_SCOPES.filter((sc) => !t.scope.split(' ').includes(sc));
    if (missing.length)
      throw new AppError(
        'YOUTUBE_AUTH_FAILED',
        'Some YouTube permissions were not granted (upload and captions are both needed). Connect again and allow them.',
      );
    this.secrets.setJson('youtubeToken', {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: this.now() + t.expires_in * 1000,
      scope: t.scope,
    } satisfies Tokens);
  }

  private async accessToken(): Promise<string> {
    const t = this.secrets.getJson<Tokens>('youtubeToken');
    if (!t) throw new AppError('YOUTUBE_NOT_CONNECTED', 'YouTube is not connected (Publish → YouTube).');
    if (t.expires_at - this.now() > 60_000) return t.access_token;
    const c = this.client();
    const res = await this.fetch(this.ep.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: t.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const text = await res.text();
    if (!res.ok) throw youtubeError(res.status, text);
    const n = JSON.parse(text) as { access_token: string; expires_in: number; scope?: string };
    this.secrets.setJson('youtubeToken', {
      ...t,
      access_token: n.access_token,
      expires_at: this.now() + n.expires_in * 1000,
    });
    return n.access_token;
  }

  /** Disconnect: revoke at Google, then forget the tokens here (the client ID/secret stay). */
  async disconnect(): Promise<void> {
    const t = this.secrets.getJson<Tokens>('youtubeToken');
    if (t)
      await this.fetch(`${this.ep.revoke}?${new URLSearchParams({ token: t.refresh_token })}`, {
        method: 'POST',
      }).catch(() => undefined);
    this.secrets.delete('youtubeToken');
  }

  forgetClient(): void {
    this.secrets.delete('youtubeClient');
  }

  private async api(
    method: string,
    url: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<{ status: number; text: string; headers: Headers }> {
    const token = await this.accessToken();
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined && !(body instanceof Uint8Array)
          ? { 'Content-Type': 'application/json; charset=UTF-8' }
          : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
    });
    return { status: res.status, text: await res.text(), headers: res.headers };
  }

  async channel(): Promise<{ id: string; title: string }> {
    const r = await this.api('GET', `${this.ep.api}/channels?part=snippet&mine=true`);
    if (r.status !== 200) throw youtubeError(r.status, r.text);
    const item = (JSON.parse(r.text) as { items?: Array<{ id: string; snippet: { title: string } }> })
      .items?.[0];
    if (!item)
      throw new AppError(
        'YOUTUBE_BLOCKED',
        'This Google account has no YouTube channel yet. Create one on youtube.com first.',
      );
    return { id: item.id, title: item.snippet.title };
  }

  // --- upload ----------------------------------------------------------------------------------------

  /** Start a resumable upload session; returns its URL (a capability: keep it private). */
  async startUpload(meta: UploadRequest, size: number): Promise<string> {
    const body = {
      snippet: {
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        categoryId: meta.categoryId,
        defaultLanguage: meta.defaultLanguage,
        defaultAudioLanguage: meta.defaultLanguage,
      },
      status: {
        privacyStatus: meta.publishAt ? 'private' : meta.privacy,
        ...(meta.publishAt ? { publishAt: meta.publishAt } : {}),
        selfDeclaredMadeForKids: meta.madeForKids,
        containsSyntheticMedia: meta.containsSyntheticMedia,
        embeddable: true,
      },
    };
    const r = await this.api(
      'POST',
      `${this.ep.upload}/videos?uploadType=resumable&part=snippet,status`,
      body,
      {
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(size),
      },
    );
    const location = r.headers.get('location');
    if (r.status !== 200 || !location) throw youtubeError(r.status, r.text);
    return location;
  }

  /** Bytes YouTube already has for an upload session (resume point), or 'done' with the video id. */
  async uploadProgress(uploadUrl: string, size: number): Promise<{ received: number } | { videoId: string }> {
    const token = await this.accessToken();
    const res = await this.fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Range': `bytes */${size}`,
        'Content-Length': '0',
      },
    });
    const text = await res.text();
    if (res.status === 308) {
      const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '');
      return { received: m ? Number(m[1]) + 1 : 0 };
    }
    if (res.status === 200 || res.status === 201) return { videoId: (JSON.parse(text) as { id: string }).id };
    if (res.status === 404 || res.status === 410)
      throw new AppError(
        'YOUTUBE_UPLOAD_FAILED',
        'The interrupted upload expired at YouTube; it starts again from the beginning.',
      );
    throw youtubeError(res.status, text);
  }

  /** Send the file from `from`, chunk by chunk; returns the new video id. */
  async sendFile(
    uploadUrl: string,
    data: Uint8Array,
    from: number,
    onProgress: (bytes: number) => void,
  ): Promise<string> {
    let offset = from;
    while (offset < data.length) {
      const end = Math.min(data.length, offset + CHUNK);
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await this.fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'video/mp4',
            'Content-Length': String(end - offset),
            'Content-Range': `bytes ${offset}-${end - 1}/${data.length}`,
          },
          body: data.subarray(offset, end),
        });
      } catch (err) {
        throw new AppError(
          'YOUTUBE_UPLOAD_FAILED',
          `The connection to YouTube was interrupted (${(err as Error).message}). Press RETRY to continue the upload.`,
        );
      }
      const text = await res.text();
      if (res.status === 308) {
        const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '');
        offset = m ? Number(m[1]) + 1 : offset;
        onProgress(offset);
        continue;
      }
      if (res.status === 200 || res.status === 201) {
        onProgress(data.length);
        return (JSON.parse(text) as { id: string }).id;
      }
      throw youtubeError(res.status, text);
    }
    throw new AppError('YOUTUBE_UPLOAD_FAILED', 'YouTube did not confirm the upload.');
  }

  async uploadCaptions(videoId: string, language: string, srt: Uint8Array): Promise<void> {
    const boundary = `ais${randomBytes(12).toString('hex')}`;
    const meta = JSON.stringify({ snippet: { videoId, language, name: '', isDraft: false } });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(srt),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const r = await this.api(
      'POST',
      `${this.ep.upload}/captions?uploadType=multipart&part=snippet`,
      new Uint8Array(body),
      {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
    );
    if (r.status !== 200) throw youtubeError(r.status, r.text);
  }

  async setThumbnail(videoId: string, image: Uint8Array, mime: string): Promise<void> {
    const r = await this.api(
      'POST',
      `${this.ep.upload}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
      image,
      {
        'Content-Type': mime,
      },
    );
    if (r.status !== 200) throw youtubeError(r.status, r.text);
  }

  async status(videoId: string): Promise<VideoStatus> {
    const r = await this.api('GET', `${this.ep.api}/videos?part=status&id=${encodeURIComponent(videoId)}`);
    if (r.status !== 200) throw youtubeError(r.status, r.text);
    const item = (
      JSON.parse(r.text) as { items?: Array<{ id: string; status: Record<string, string | undefined> }> }
    ).items?.[0];
    if (!item)
      throw new AppError('NOT_FOUND', 'YouTube does not list this video (it may have been deleted).');
    return {
      id: item.id,
      uploadStatus: item.status['uploadStatus'] ?? '',
      privacyStatus: item.status['privacyStatus'] ?? '',
      publishAt: item.status['publishAt'] ?? null,
      failureReason: item.status['failureReason'] ?? null,
      rejectionReason: item.status['rejectionReason'] ?? null,
    };
  }

  async deleteVideo(videoId: string): Promise<void> {
    const r = await this.api('DELETE', `${this.ep.api}/videos?id=${encodeURIComponent(videoId)}`);
    if (r.status !== 204 && r.status !== 200) throw youtubeError(r.status, r.text);
  }
}
