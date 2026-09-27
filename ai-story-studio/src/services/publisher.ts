import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Studio } from '../app/studio.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import { parseJson } from '../lib/json.ts';
import { runTool } from '../media/ffmpeg.ts';
import type { ChannelProfile } from '../repositories/series.ts';
import type { Publication, Video } from '../repositories/videos.ts';
import type { YoutubeMetadata } from './metadata.ts';
import type { SecretName } from './secrets.ts';
import type { VideoStatus, YoutubeClient } from './youtube.ts';

/**
 * Publishing to YouTube, always behind a deliberate approval:
 *
 *   READY FOR REVIEW → (person edits, chooses the audience, APPROVE & UPLOAD / APPROVE & SCHEDULE)
 *   → uploading → UPLOAD SUCCESSFUL / PRIVATE / SCHEDULED / PUBLISHED
 *                 or BLOCKED BY API RESTRICTION / UPLOAD FAILED (with what to do)
 *
 * Nothing is uploaded straight after generation. The audience ("made for kids") must be chosen
 * for every upload; AI (synthetic) content is disclosed. Uploads run one at a time in the
 * background and resume where they stopped.
 *
 * Channels: each channel profile (English, Hinglish, ...) has its own Google sign-in, defaults and
 * schedule. The English channel is the original "YouTube connection" (its token and the Publishing
 * settings), so single-channel setups keep working unchanged. Every language version of a video gets
 * its own review row, uploaded to its own channel with its own files.
 */
export type PublicState =
  | 'READY FOR REVIEW'
  | 'APPROVED'
  | 'UPLOADING'
  | 'UPLOAD SUCCESSFUL'
  | 'PRIVATE'
  | 'SCHEDULED'
  | 'PUBLISHED'
  | 'BLOCKED BY API RESTRICTION'
  | 'UPLOAD FAILED';

export function publicState(p: Publication): PublicState {
  switch (p.status) {
    case 'ready_for_review':
      return 'READY FOR REVIEW';
    case 'approved':
      return 'APPROVED';
    case 'uploading':
      return 'UPLOADING';
    case 'uploaded':
      return p.remote_status === 'private' ? 'PRIVATE' : 'UPLOAD SUCCESSFUL';
    case 'scheduled':
      return 'SCHEDULED';
    case 'published':
      return 'PUBLISHED';
    case 'blocked':
      return 'BLOCKED BY API RESTRICTION';
    case 'failed':
      return 'UPLOAD FAILED';
  }
}

export interface ReviewInput {
  title: string;
  description: string;
  tags: string;
  privacy: string;
  publishAt: string;
  audience: string;
  synthetic: boolean;
}

/** One channel's publishing defaults (the English channel uses the Publishing settings). */
export interface ChannelDefaults {
  defaultPrivacy: 'private' | 'unlisted' | 'public';
  schedule: 'none' | 'daily' | 'weekly';
  time: string;
  weekday: number;
  audience: 'ask' | 'kids' | 'not_kids';
  shortsGapHours: number;
  /** The audience's time zone in minutes from UTC; null = this computer's time zone. */
  utcOffsetMinutes: number | null;
}

export type ClientFactory = (tokenName: SecretName) => YoutubeClient;

const API_AUDIT =
  'YouTube keeps videos uploaded through unverified API projects PRIVATE. Ask Google for an API audit (see YOUTUBE_SETUP.md), or change the visibility yourself in YouTube Studio.';

export class Publisher {
  private readonly s: Studio;
  /** The English channel's client (the original single YouTube connection). */
  readonly yt: YoutubeClient;
  private readonly make: ClientFactory;
  private readonly clients = new Map<SecretName, YoutubeClient>();
  private queue: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();

  constructor(s: Studio, make: ClientFactory) {
    this.s = s;
    this.make = make;
    this.yt = this.client('youtubeToken');
  }

  private client(name: SecretName): YoutubeClient {
    let c = this.clients.get(name);
    if (!c) {
      c = this.make(name);
      this.clients.set(name, c);
    }
    return c;
  }

  /** Where a channel's Google sign-in is kept: the English channel keeps the original one. */
  tokenFor(channel: ChannelProfile): SecretName {
    return channel.language === 'en' ? 'youtubeToken' : `youtubeToken:${channel.id}`;
  }

  /** The YouTube client of a channel profile (none = the English channel). */
  ytFor(channelId: string | null | undefined): YoutubeClient {
    return channelId ? this.client(this.tokenFor(this.s.series.channel(channelId))) : this.yt;
  }

  /** The channel whose sign-in Google is returning to (each sign-in has its own state). */
  channelForSignIn(state: string): { yt: YoutubeClient; channel: ChannelProfile | null } | null {
    if (this.yt.startedSignIn(state)) return { yt: this.yt, channel: this.s.series.channelFor('en') ?? null };
    for (const channel of this.s.series.channels()) {
      const yt = this.ytFor(channel.id);
      if (yt.startedSignIn(state)) return { yt, channel };
    }
    return null;
  }

  /** A channel's defaults: the English channel uses the Publishing settings, others their profile. */
  defaults(channel: ChannelProfile | null | undefined): ChannelDefaults {
    const pub = this.s.settings.get('publishing');
    if (!channel || channel.language === 'en')
      return {
        defaultPrivacy: pub.defaultPrivacy,
        schedule: pub.schedule,
        time: pub.time,
        weekday: pub.weekday,
        audience: pub.audience,
        shortsGapHours: pub.shortsGapHours,
        utcOffsetMinutes: null,
      };
    return {
      defaultPrivacy: channel.default_privacy,
      schedule: channel.schedule,
      time: channel.publish_time,
      weekday: channel.weekday,
      audience: channel.audience,
      shortsGapHours: pub.shortsGapHours,
      utcOffsetMinutes: channel.utc_offset_minutes,
    };
  }

  /** The suggested publish time for a review row, from its own channel's schedule. */
  suggestedSlot(p: Publication): Date | null {
    const d = this.defaults(p.channel_profile_id ? this.s.series.channel(p.channel_profile_id) : null);
    const short = p.short_id ? this.s.videos.getShort(p.short_id) : null;
    const gap = short ? d.shortsGapHours * (short.idx + 1) : 0;
    return nextSlotIn(d, this.s.clock.now(), gap);
  }

  channelName(p: Publication): string {
    return p.channel_profile_id ? this.s.series.channel(p.channel_profile_id).name : 'YouTube';
  }

  /**
   * Review rows for a finished video: the episode and each ready Short, and the same for every
   * finished language version (each for its own channel, with that channel's defaults).
   */
  ensurePublications(videoId: string): Publication[] {
    const v = this.s.videos.get(videoId);
    const existing = this.s.videos.publications(videoId);
    const kidsOf = (a: ChannelDefaults['audience']) => (a === 'kids' ? 1 : a === 'not_kids' ? 0 : null);
    const english = this.s.series.channelFor('en');
    const en = this.defaults(english);
    const master = existing.filter((p) => !p.localization_id);
    if (v.episode_export_id && !master.some((p) => p.kind === 'episode'))
      this.s.videos.createPublication({
        video_id: v.id,
        short_id: null,
        kind: 'episode',
        metadata_json: v.metadata_json,
        made_for_kids: kidsOf(en.audience),
        privacy: en.defaultPrivacy,
        channel_profile_id: english?.id ?? null,
      });
    for (const sh of this.s.videos.shorts(videoId))
      if (sh.status === 'ready' && !master.some((p) => p.short_id === sh.id))
        this.s.videos.createPublication({
          video_id: v.id,
          short_id: sh.id,
          kind: 'short',
          metadata_json: sh.metadata_json,
          made_for_kids: kidsOf(en.audience),
          privacy: en.defaultPrivacy,
          channel_profile_id: english?.id ?? null,
        });
    const locs = this.s.series
      .videoLocalizations(videoId)
      .filter((l) => ['ready', 'needs_attention'].includes(l.status) && l.video_key);
    if (locs.length) this.s.series.ensureDefaultChannels();
    for (const loc of locs) {
      if (existing.some((p) => p.localization_id === loc.id)) continue;
      const channel = this.s.series.channelFor(loc.language) ?? null;
      const d = this.defaults(channel);
      this.s.videos.createPublication({
        video_id: v.id,
        short_id: loc.short_id,
        kind: loc.short_id ? 'short' : 'episode',
        metadata_json: loc.metadata_json,
        made_for_kids: kidsOf(d.audience),
        privacy: d.defaultPrivacy,
        language: loc.language,
        channel_profile_id: channel?.id ?? null,
        localization_id: loc.id,
      });
    }
    return this.s.videos.publications(videoId);
  }

  meta(p: Publication): YoutubeMetadata {
    return parseJson<YoutubeMetadata>(p.metadata_json, {
      title: '',
      description: '',
      tags: [],
      categoryId: '1',
      defaultLanguage: 'en',
      madeForKids: null,
      containsSyntheticMedia: true,
    });
  }

  /** Save the reviewed metadata (no upload). */
  save(pubId: string, f: ReviewInput): Publication {
    const p = this.s.videos.getPublication(pubId);
    if (!['ready_for_review', 'approved', 'failed', 'blocked'].includes(p.status))
      throw new AppError('CONFLICT', 'This video is already on YouTube; change it in YouTube Studio.');
    const title = f.title.trim();
    if (!title) throw new AppError('VALIDATION_FAILED', 'A title is needed.');
    if (title.length > 100)
      throw new AppError('VALIDATION_FAILED', 'YouTube titles are at most 100 characters.');
    if (/[<>]/.test(title) || /[<>]/.test(f.description))
      throw new AppError('VALIDATION_FAILED', 'YouTube does not accept < or > in titles and descriptions.');
    if (f.description.length > 5000)
      throw new AppError('VALIDATION_FAILED', 'YouTube descriptions are at most 5000 characters.');
    const tags = f.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.join(',').length > 500)
      throw new AppError('VALIDATION_FAILED', 'The tags are too long for YouTube (500 characters in total).');
    const privacy = (['private', 'unlisted', 'public'] as const).find((x) => x === f.privacy) ?? 'private';
    let publishAt: string | null = null;
    if (f.publishAt.trim()) {
      const t = new Date(f.publishAt);
      if (Number.isNaN(t.getTime()))
        throw new AppError('VALIDATION_FAILED', 'The schedule date is not valid.');
      publishAt = t.toISOString();
    }
    const made = f.audience === 'kids' ? 1 : f.audience === 'not_kids' ? 0 : null;
    const meta = {
      ...this.meta(p),
      title,
      description: f.description,
      tags,
      madeForKids: made === null ? null : made === 1,
      containsSyntheticMedia: f.synthetic,
    };
    return this.s.videos.updatePublication(p.id, {
      metadata_json: JSON.stringify(meta),
      privacy,
      publish_at: publishAt,
      made_for_kids: made,
      synthetic_media: f.synthetic ? 1 : 0,
    });
  }

  /**
   * The deliberate approval. `schedule` uploads privately with a publish time; otherwise the chosen
   * visibility is used (private by default). Checks everything YouTube and the rules need first.
   */
  approve(pubId: string, mode: 'upload' | 'schedule'): Publication {
    const p = this.s.videos.getPublication(pubId);
    this.checkApproval(p, mode);
    const updated = this.s.videos.updatePublication(p.id, {
      status: 'approved',
      approved_at: this.s.clock.now().toISOString(),
      error_message: null,
      ...(mode === 'upload' ? { publish_at: null } : {}),
    });
    this.s.logger.info('publication approved', {
      publication: p.id,
      video: p.video_id,
      language: p.language,
      mode,
      privacy: updated.privacy,
    });
    this.syncVideo(p.video_id);
    this.enqueue(p.id);
    return updated;
  }

  /**
   * APPROVE BOTH (or all): every listed row is checked first, so either all are approved or none.
   * For scheduling, a row without a time gets its own channel's next slot.
   */
  approveMany(pubIds: string[], mode: 'upload' | 'schedule'): Publication[] {
    const pubs = pubIds.map((id) => this.s.videos.getPublication(id));
    if (!pubs.length) throw new AppError('VALIDATION_FAILED', 'Nothing to approve.');
    const planned = pubs.map((p) => {
      if (mode !== 'schedule' || p.publish_at) return p;
      const slot = this.suggestedSlot(p);
      if (!slot)
        throw new AppError(
          'VALIDATION_FAILED',
          `Choose the publish time for "${this.meta(p).title}" (${this.channelName(p)} has no schedule).`,
        );
      return { ...p, publish_at: slot.toISOString() };
    });
    for (const p of planned) this.checkApproval(p, mode);
    for (const p of planned)
      if (p.publish_at !== this.s.videos.getPublication(p.id).publish_at)
        this.s.videos.updatePublication(p.id, { publish_at: p.publish_at });
    return planned.map((p) => this.approve(p.id, mode));
  }

  private checkApproval(p: Publication, mode: 'upload' | 'schedule'): void {
    if (!this.ytFor(p.channel_profile_id).connected())
      throw new AppError(
        'YOUTUBE_NOT_CONNECTED',
        p.channel_profile_id && p.language !== 'en'
          ? `Connect the ${this.channelName(p)} first (Publish → YouTube).`
          : 'Connect YouTube first (Publish → YouTube).',
      );
    if (p.made_for_kids === null)
      throw new AppError(
        'VALIDATION_FAILED',
        'Choose the audience first: is this video made for kids? (YouTube requires this; AI Story Studio never decides it for you.)',
      );
    if (!this.meta(p).title.trim()) throw new AppError('VALIDATION_FAILED', 'A title is needed.');
    if (mode === 'schedule') {
      if (!p.publish_at) throw new AppError('VALIDATION_FAILED', 'Choose the date and time to publish.');
      if (new Date(p.publish_at).getTime() < this.s.clock.now().getTime() + 15 * 60_000)
        throw new AppError('VALIDATION_FAILED', 'Schedule it at least 15 minutes from now.');
    }
    if (!['ready_for_review', 'failed', 'blocked'].includes(p.status))
      throw new AppError('CONFLICT', 'This video was already approved.');
  }

  /** Try again (continues an interrupted upload). */
  retry(pubId: string): void {
    const p = this.s.videos.getPublication(pubId);
    if (p.status !== 'failed') throw new AppError('CONFLICT', 'Only a failed upload can be retried.');
    this.s.videos.updatePublication(p.id, { status: 'approved', error_message: null });
    this.enqueue(p.id);
  }

  /** Waits for the upload queue (tests, and before the app closes). */
  idle(): Promise<void> {
    return this.queue;
  }

  private enqueue(pubId: string): void {
    if (this.queued.has(pubId)) return;
    this.queued.add(pubId);
    this.queue = this.queue.then(() =>
      this.upload(pubId)
        .catch((err: unknown) =>
          this.s.logger.error('upload failed', { publication: pubId, error: toAppError(err).message }),
        )
        .finally(() => this.queued.delete(pubId)),
    );
  }

  private file(p: Publication): {
    data: Buffer;
    srt: Buffer | null;
    thumb: { data: Buffer; mime: string } | null;
    language: string;
  } {
    const v = this.s.videos.get(p.video_id);
    let videoKey: string | null = null;
    let srtKey: string | null;
    let thumbKey: string | null;
    let language: string | null = null;
    if (p.localization_id) {
      // A language version: its own video, captions and thumbnail (same pictures, other voices).
      const loc = this.s.series.localization(p.localization_id);
      videoKey = loc.video_key;
      srtKey = loc.captions_srt_key;
      thumbKey = loc.thumbnail_key;
      language = loc.language;
    } else if (p.kind === 'episode') {
      const exp = v.episode_export_id ? this.s.reports.getExport(v.episode_export_id) : null;
      videoKey = exp?.master_asset_id ? this.s.assets.get(exp.master_asset_id).storage_key : null;
      srtKey = v.captions_srt_key;
      thumbKey = v.thumbnail_key;
    } else {
      const sh = this.s.videos.getShort(p.short_id!);
      videoKey = sh.video_key;
      srtKey = sh.captions_srt_key;
      thumbKey = sh.thumbnail_key;
    }
    if (!videoKey) throw new AppError('PRECONDITION_FAILED', 'The video file is missing.');
    const read = (k: string | null) => (k ? readFileSync(this.s.storage.localPath(k)) : null);
    const t = read(thumbKey);
    const story = v.story_id ? this.s.stories.get(v.story_id) : null;
    return {
      data: readFileSync(this.s.storage.localPath(videoKey)),
      srt: read(srtKey),
      thumb: t ? { data: t, mime: thumbKey!.endsWith('.png') ? 'image/png' : 'image/jpeg' } : null,
      language: language ?? (story?.language ?? 'en').split('-')[0]!,
    };
  }

  private async upload(pubId: string): Promise<void> {
    let p = this.s.videos.getPublication(pubId);
    if (p.status !== 'approved' && p.status !== 'uploading') return;
    const log = this.s.logger.child({ publication: p.id, video: p.video_id, language: p.language });
    const yt = this.ytFor(p.channel_profile_id);
    try {
      const f = this.file(p);
      const meta = this.meta(p);
      p = this.s.videos.updatePublication(p.id, { status: 'uploading' });
      let from = 0;
      let videoId: string | null = null;
      if (p.upload_url) {
        try {
          const prog = await yt.uploadProgress(p.upload_url, f.data.length);
          if ('videoId' in prog) videoId = prog.videoId;
          else from = prog.received;
        } catch {
          p = this.s.videos.updatePublication(p.id, { upload_url: null, uploaded_bytes: 0 });
        }
      }
      if (!videoId) {
        if (!p.upload_url) {
          const url = await yt.startUpload(
            {
              title: meta.title,
              description: meta.description,
              tags: meta.tags,
              categoryId: meta.categoryId,
              defaultLanguage: meta.defaultLanguage || f.language.split('-')[0]!,
              privacy: p.privacy,
              publishAt: p.publish_at,
              madeForKids: p.made_for_kids === 1,
              containsSyntheticMedia: p.synthetic_media === 1,
            },
            f.data.length,
          );
          p = this.s.videos.updatePublication(p.id, { upload_url: url });
        }
        videoId = await yt.sendFile(p.upload_url!, f.data, from, (bytes) => {
          this.s.videos.updatePublication(pubId, { uploaded_bytes: bytes });
        });
      }
      p = this.s.videos.updatePublication(p.id, {
        youtube_video_id: videoId,
        youtube_url:
          p.kind === 'short' ? `https://youtube.com/shorts/${videoId}` : `https://youtu.be/${videoId}`,
        upload_url: null,
        uploaded_bytes: f.data.length,
      });
      log.info('uploaded to youtube', { youtubeVideo: videoId });
      let captions = 'not included (no speech)';
      if (f.srt)
        captions = await yt.uploadCaptions(videoId, f.language, f.srt).then(
          () => 'uploaded',
          (err: unknown) => `not uploaded: ${toAppError(err).message}`,
        );
      let thumbnail = 'not included';
      if (f.thumb)
        thumbnail = await yt.setThumbnail(videoId, f.thumb.data, f.thumb.mime).then(
          () => 'uploaded',
          (err: unknown) => {
            const e = toAppError(err);
            return e.code === 'YOUTUBE_BLOCKED'
              ? 'not set: custom thumbnails need a verified YouTube channel (youtube.com/verify)'
              : `not set: ${e.message}`;
          },
        );
      this.s.videos.updatePublication(p.id, { captions_status: captions, thumbnail_status: thumbnail });
      await this.refresh(p.id);
    } catch (err) {
      const e = toAppError(err);
      const blocked = e.code === 'YOUTUBE_BLOCKED' || e.code === 'YOUTUBE_QUOTA_EXCEEDED';
      this.s.videos.updatePublication(pubId, {
        status: blocked ? 'blocked' : 'failed',
        error_message: e.message,
      });
      log.warn('upload did not complete', { code: e.code, error: e.message });
    } finally {
      this.syncVideo(p.video_id);
    }
  }

  /** Ask YouTube for the current state and map it. */
  async refresh(pubId: string): Promise<Publication> {
    const p = this.s.videos.getPublication(pubId);
    if (!p.youtube_video_id) return p;
    const st = await this.ytFor(p.channel_profile_id).status(p.youtube_video_id);
    const next = mapStatus(p, st);
    const out = this.s.videos.updatePublication(p.id, next);
    this.syncVideo(p.video_id);
    return out;
  }

  private syncVideo(videoId: string): void {
    const v = this.s.videos.get(videoId);
    if (!['ready', 'approved', 'scheduled', 'published'].includes(v.status)) return;
    const pubs = this.s.videos.publications(videoId);
    if (!pubs.length) return;
    let status: Video['status'] = 'ready';
    if (pubs.some((p) => p.status === 'published')) status = 'published';
    else if (pubs.some((p) => p.status === 'scheduled')) status = 'scheduled';
    else if (pubs.some((p) => ['approved', 'uploading', 'uploaded'].includes(p.status))) status = 'approved';
    if (status !== v.status) this.s.videos.update(videoId, { status });
  }

  /** Production calendar: what goes out on which channel over the next days (scheduled or timed). */
  calendar(days = 21): Array<{
    at: string;
    channel: string;
    language: string;
    kind: Publication['kind'];
    title: string;
    state: PublicState;
    videoId: string;
  }> {
    const now = this.s.clock.now().getTime();
    const until = now + days * 86_400_000;
    return this.s.videos
      .publications()
      .filter((p) => p.publish_at && ['approved', 'uploading', 'scheduled', 'published'].includes(p.status))
      .filter((p) => {
        const t = Date.parse(p.publish_at!);
        return t >= now - 86_400_000 && t <= until;
      })
      .map((p) => ({
        at: p.publish_at!,
        channel: this.channelName(p),
        language: p.language,
        kind: p.kind,
        title: this.meta(p).title,
        state: publicState(p),
        videoId: p.video_id,
      }))
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * Content buffer per channel: full episodes already scheduled for the future (and until when),
   * and finished ones still waiting for review. A small buffer means: make the next episodes now.
   */
  buffer(): Array<{
    channel: string;
    language: string;
    scheduled: number;
    through: string | null;
    ready: number;
  }> {
    const now = this.s.clock.now().toISOString();
    const channels = this.s.series.channels();
    const rows = channels.length
      ? channels.map((c) => ({ id: c.id as string | null, name: c.name, language: c.language }))
      : [{ id: null, name: 'YouTube', language: 'en' }];
    const english = this.s.series.channelFor('en')?.id ?? null;
    const pubs = this.s.videos.publications().filter((p) => p.kind === 'episode');
    return rows.map((c) => {
      const mine = pubs.filter(
        (p) => (p.channel_profile_id ?? english) === c.id || (!c.id && !p.channel_profile_id),
      );
      const ahead = mine
        .filter((p) => p.status === 'scheduled' && p.publish_at && p.publish_at > now)
        .map((p) => p.publish_at!)
        .sort();
      return {
        channel: c.name,
        language: c.language,
        scheduled: ahead.length,
        through: ahead[ahead.length - 1] ?? null,
        ready: mine.filter((p) => p.status === 'ready_for_review').length,
      };
    });
  }

  /** After a restart: an upload that was running is shown as failed and continues on RETRY. */
  recoverAfterRestart(): number {
    const stuck = this.s.videos
      .publications()
      .filter((p) => p.status === 'uploading' || p.status === 'approved');
    for (const p of stuck)
      this.s.videos.updatePublication(p.id, {
        status: 'failed',
        error_message:
          'AI Story Studio was closed during the upload. Press RETRY: it continues where it stopped.',
      });
    return stuck.length;
  }

  // --- the safe private test ----------------------------------------------------------------------

  /**
   * SAFE PRIVATE TEST UPLOAD: a 3-second test picture uploaded as PRIVATE (never public), then
   * its status read back. Proves the connection, upload, and status reading. Delete it afterwards.
   */
  private testKey(channelId: string | null | undefined): string {
    const ch = channelId ? this.s.series.channel(channelId) : null;
    return ch && ch.language !== 'en' ? `youtube.privateTest:${ch.id}` : 'youtube.privateTest';
  }

  async privateTest(channelId?: string | null): Promise<{ videoId: string; state: string; privacy: string }> {
    const yt = this.ytFor(channelId);
    if (!this.s.ffmpeg) throw new AppError('PRECONDITION_FAILED', 'FFmpeg is needed to make the test clip.');
    const tmp = join(this.s.env.dataDir, 'tmp');
    mkdirSync(tmp, { recursive: true });
    const dir = mkdtempSync(join(tmp, 'yt-test-'));
    try {
      await runTool(
        this.s.ffmpeg.ffmpeg,
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=1280x720:rate=30:duration=3',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=3',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          'test.mp4',
        ],
        { cwd: dir },
      );
      const data = readFileSync(join(dir, 'test.mp4'));
      const url = await yt.startUpload(
        {
          title: 'AI Story Studio — private test upload (safe to delete)',
          description: 'A private test made by AI Story Studio to check the YouTube connection.',
          tags: ['test'],
          categoryId: '22',
          defaultLanguage: 'en',
          privacy: 'private',
          publishAt: null,
          madeForKids: false,
          containsSyntheticMedia: false,
        },
        data.length,
      );
      const videoId = await yt.sendFile(url, data, 0, () => undefined);
      const st = await yt.status(videoId);
      const result = {
        videoId,
        state: st.uploadStatus,
        privacy: st.privacyStatus,
        at: this.s.clock.now().toISOString(),
      };
      this.s.db.run(
        'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        this.testKey(channelId),
        JSON.stringify(result),
      );
      this.s.logger.info('youtube private test uploaded', {
        youtubeVideo: videoId,
        privacy: st.privacyStatus,
      });
      return result;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  lastPrivateTest(channelId?: string | null): {
    videoId: string;
    state: string;
    privacy: string;
    at: string;
    deleted?: boolean;
  } | null {
    const row = this.s.db.get<{ value: string }>(
      'SELECT value FROM app_meta WHERE key = ?',
      this.testKey(channelId),
    );
    return row ? parseJson(row.value, null) : null;
  }

  async deletePrivateTest(channelId?: string | null): Promise<void> {
    const t = this.lastPrivateTest(channelId);
    if (!t || t.deleted) return;
    await this.ytFor(channelId).deleteVideo(t.videoId);
    this.s.db.run(
      'UPDATE app_meta SET value = ? WHERE key = ?',
      JSON.stringify({ ...t, deleted: true }),
      this.testKey(channelId),
    );
  }
}

/** YouTube's answer → our status, with the API restriction recognised for what it is. */
export function mapStatus(p: Publication, st: VideoStatus): Partial<Publication> {
  if (st.uploadStatus === 'rejected' || st.uploadStatus === 'failed')
    return {
      status: 'failed',
      remote_status: st.uploadStatus,
      error_message: `YouTube ${st.uploadStatus} the video: ${st.rejectionReason ?? st.failureReason ?? 'no reason given'}.`,
    };
  const wanted = p.publish_at ? 'scheduled' : p.privacy;
  if (
    st.privacyStatus === 'private' &&
    (wanted === 'public' || wanted === 'unlisted' || (wanted === 'scheduled' && !st.publishAt))
  )
    return { status: 'blocked', remote_status: 'private', error_message: API_AUDIT };
  if (st.publishAt && st.privacyStatus === 'private')
    return { status: 'scheduled', remote_status: 'private', publish_at: st.publishAt };
  if (st.privacyStatus === 'public')
    return { status: 'published', remote_status: 'public', error_message: null };
  return { status: 'uploaded', remote_status: st.privacyStatus, error_message: null };
}

/** The next publishing slot from the schedule template (local time), or null for "no schedule". */
export function nextSlot(
  pub: { schedule: 'none' | 'daily' | 'weekly'; time: string; weekday: number },
  now: Date,
  offsetHours = 0,
): Date | null {
  if (pub.schedule === 'none') return null;
  const [h, m] = pub.time.split(':').map(Number) as [number, number];
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  const soon = now.getTime() + 20 * 60_000;
  if (pub.schedule === 'daily') {
    while (d.getTime() < soon) d.setDate(d.getDate() + 1);
  } else {
    while (d.getDay() !== pub.weekday || d.getTime() < soon) d.setDate(d.getDate() + 1);
  }
  return new Date(d.getTime() + offsetHours * 3_600_000);
}

/**
 * The next publishing slot for a channel. With a channel time zone (minutes from UTC) the time is
 * the audience's wall-clock time (e.g. 18:00 in India); without one, this computer's local time.
 */
export function nextSlotIn(d: ChannelDefaults, now: Date, offsetHours = 0): Date | null {
  if (d.utcOffsetMinutes === null) return nextSlot(d, now, offsetHours);
  if (d.schedule === 'none') return null;
  const shift = d.utcOffsetMinutes * 60_000;
  const [h, m] = d.time.split(':').map(Number) as [number, number];
  // Work on the audience's wall clock, held in a Date's UTC fields.
  const wall = new Date(now.getTime() + shift);
  const t = new Date(wall);
  t.setUTCHours(h, m, 0, 0);
  const soon = wall.getTime() + 20 * 60_000;
  if (d.schedule === 'daily') {
    while (t.getTime() < soon) t.setUTCDate(t.getUTCDate() + 1);
  } else {
    while (t.getUTCDay() !== d.weekday || t.getTime() < soon) t.setUTCDate(t.getUTCDate() + 1);
  }
  return new Date(t.getTime() - shift + offsetHours * 3_600_000);
}
