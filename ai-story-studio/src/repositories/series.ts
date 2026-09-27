import type { Database, SqlParam } from '../db/database.ts';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { parseJson } from '../lib/json.ts';
import { requireRow } from './base.ts';

/**
 * Series → Seasons → Episodes, the Series Bible, character canon, continuity memory, language
 * versions (localizations) and YouTube channel profiles. See docs/SERIES_SYSTEM.md.
 */
export const BIBLE_SECTIONS = [
  'PREMISE',
  'WORLD',
  'TIMELINE',
  'SCIENCE / TECHNOLOGY RULES',
  'FICTION RULES',
  'CHARACTERS',
  'RELATIONSHIPS',
  'LOCATIONS',
  'VEHICLES',
  'PROPS',
  'ORGANIZATIONS',
  'ANTAGONISTS',
  'VISUAL LANGUAGE',
  'CAMERA LANGUAGE',
  'LIGHTING',
  'COLOR LANGUAGE',
  'MUSIC IDENTITY',
  'SFX IDENTITY',
  'INTRO',
  'OUTRO',
  'STORY RULES',
  'AGE-SAFETY RULES',
  'CONTINUITY RULES',
  'BANNED CONTENT',
  'RECURRING MYSTERIES',
  'SEASON ARCS',
] as const;
export type BibleSection = (typeof BIBLE_SECTIONS)[number];

export interface Series {
  id: string;
  project_id: string;
  name: string;
  working_title: string;
  description: string;
  genre: string;
  target_age: string;
  target_audience: string;
  style_id: string;
  story_tone: string;
  episode_minutes: number;
  master_language: string;
  localizations_json: string;
  status: 'active' | 'paused' | 'archived';
  bible_json: string;
  created_at: string;
  updated_at: string;
}

export interface Season {
  id: string;
  series_id: string;
  number: number;
  title: string;
  episode_target: number;
  premise: string;
  main_mystery: string;
  arcs: string;
  beginning_state: string;
  midseason: string;
  finale_state: string;
  status: 'planned' | 'in_production' | 'complete';
  created_at: string;
  updated_at: string;
}

export type EpisodeProduction =
  | 'planned'
  | 'generating'
  | 'qc'
  | 'ready_for_review'
  | 'approved'
  | 'rejected'
  | 'needs_attention'
  | 'failed'
  | 'cancelled';

export interface Episode {
  id: string;
  series_id: string;
  season_id: string;
  number: number;
  working_title: string;
  title_en: string;
  title_hi: string;
  idea: string;
  premise: string;
  synopsis: string;
  lesson: string;
  features_json: string;
  similarity_json: string;
  continuity_json: string;
  continuity_summary: string;
  story_status: 'planned' | 'writing' | 'written' | 'failed';
  production_status: EpisodeProduction;
  video_id: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EpisodeFeatures {
  problem: string;
  setting: string;
  villain: string;
  science: string;
  resolution: string;
  lesson: string;
  setpiece: string;
}

export interface SeriesCharacter {
  character_id: string;
  series_id: string;
  profile_json: string;
  hinglish_json: string;
  voice_en_json: string;
  voice_hi_json: string;
  pronunciation_json: string;
  created_at: string;
  updated_at: string;
}

export interface HinglishStyle {
  /** Rough share of English words in this character's Hinglish (0..1); style guidance, not a quota. */
  english_share: number;
  formality: 'casual' | 'neutral' | 'polite';
  notes: string;
}

export type FactKind =
  | 'canon'
  | 'event'
  | 'relationship'
  | 'discovery'
  | 'new_character'
  | 'new_location'
  | 'object_state'
  | 'character_state'
  | 'mystery_open'
  | 'mystery_resolved';

export interface ContinuityFact {
  id: string;
  series_id: string;
  season_id: string | null;
  episode_id: string | null;
  kind: FactKind;
  subject: string;
  fact: string;
  status: 'proposed' | 'canon' | 'rejected' | 'retired';
  created_at: string;
  approved_at: string | null;
}

export type LocalizationStatus =
  | 'planned'
  | 'localizing'
  | 'voicing'
  | 'ready'
  | 'needs_attention'
  | 'failed';

export interface Localization {
  id: string;
  video_id: string;
  short_id: string | null;
  language: string;
  story_id: string | null;
  status: LocalizationStatus;
  export_id: string | null;
  video_key: string | null;
  captions_srt_key: string | null;
  captions_vtt_key: string | null;
  thumbnail_key: string | null;
  metadata_json: string;
  qa_json: string;
  timing_json: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChannelProfile {
  id: string;
  name: string;
  language: string;
  youtube_channel_id: string | null;
  youtube_channel_title: string | null;
  default_privacy: 'private' | 'unlisted' | 'public';
  schedule: 'none' | 'daily' | 'weekly';
  publish_time: string;
  weekday: number;
  utc_offset_minutes: number | null;
  audience: 'ask' | 'kids' | 'not_kids';
  created_at: string;
  updated_at: string;
}

export class SeriesRepository {
  private readonly db: Database;
  private readonly now: () => string;

  constructor(db: Database, now: () => string) {
    this.db = db;
    this.now = now;
  }

  // --- series -----------------------------------------------------------------------------------

  create(
    v: Pick<Series, 'project_id' | 'name'> &
      Partial<Omit<Series, 'id' | 'project_id' | 'name' | 'created_at' | 'updated_at'>>,
  ): Series {
    const id = newId('ser');
    const at = this.now();
    this.db.insert('series', { ...(v as Record<string, SqlParam>), id, created_at: at, updated_at: at });
    return this.get(id);
  }

  get(id: string): Series {
    return requireRow<Series>(this.db, 'series', id, 'Series');
  }

  byProject(projectId: string): Series | undefined {
    return this.db.get<Series>('SELECT * FROM series WHERE project_id = ?', projectId);
  }

  list(): Series[] {
    return this.db.all<Series>("SELECT * FROM series WHERE status != 'archived' ORDER BY created_at");
  }

  update(id: string, values: Partial<Omit<Series, 'id' | 'project_id' | 'created_at'>>): Series {
    this.db.update('series', id, { ...(values as Record<string, SqlParam>), updated_at: this.now() });
    return this.get(id);
  }

  bible(s: Series): Partial<Record<BibleSection, string>> {
    return parseJson<Partial<Record<BibleSection, string>>>(s.bible_json, {});
  }

  localizations(s: Series): string[] {
    return parseJson<string[]>(s.localizations_json, []);
  }

  // --- seasons ----------------------------------------------------------------------------------

  createSeason(
    v: Pick<Season, 'series_id' | 'number'> & Partial<Omit<Season, 'id' | 'series_id' | 'number'>>,
  ): Season {
    if (this.db.get('SELECT 1 FROM seasons WHERE series_id = ? AND number = ?', v.series_id, v.number))
      throw new AppError('CONFLICT', `Season ${v.number} already exists.`);
    const id = newId('sea');
    const at = this.now();
    this.db.insert('seasons', { ...(v as Record<string, SqlParam>), id, created_at: at, updated_at: at });
    return this.season(id);
  }

  season(id: string): Season {
    return requireRow<Season>(this.db, 'seasons', id, 'Season');
  }

  seasons(seriesId: string): Season[] {
    return this.db.all<Season>('SELECT * FROM seasons WHERE series_id = ? ORDER BY number', seriesId);
  }

  updateSeason(id: string, values: Partial<Omit<Season, 'id' | 'series_id' | 'created_at'>>): Season {
    this.db.update('seasons', id, { ...(values as Record<string, SqlParam>), updated_at: this.now() });
    return this.season(id);
  }

  // --- episodes ---------------------------------------------------------------------------------

  /** The next episode number in a season (1 + the highest existing). */
  nextEpisodeNumber(seasonId: string): number {
    return (
      (this.db.scalar<number>('SELECT MAX(number) FROM episodes WHERE season_id = ?', seasonId) ?? 0) + 1
    );
  }

  createEpisode(
    v: Pick<Episode, 'series_id' | 'season_id'> &
      Partial<Omit<Episode, 'id' | 'series_id' | 'season_id' | 'created_at' | 'updated_at'>>,
  ): Episode {
    const id = newId('epi');
    const at = this.now();
    const number = v.number ?? this.nextEpisodeNumber(v.season_id);
    if (this.db.get('SELECT 1 FROM episodes WHERE season_id = ? AND number = ?', v.season_id, number))
      throw new AppError('CONFLICT', `Episode ${number} already exists in this season.`);
    this.db.insert('episodes', {
      ...(v as Record<string, SqlParam>),
      number,
      id,
      created_at: at,
      updated_at: at,
    });
    return this.episode(id);
  }

  episode(id: string): Episode {
    return requireRow<Episode>(this.db, 'episodes', id, 'Episode');
  }

  episodeByVideo(videoId: string): Episode | undefined {
    return this.db.get<Episode>('SELECT * FROM episodes WHERE video_id = ?', videoId);
  }

  episodes(opts: { seriesId?: string; seasonId?: string } = {}): Episode[] {
    if (opts.seasonId)
      return this.db.all<Episode>(
        'SELECT * FROM episodes WHERE season_id = ? ORDER BY number',
        opts.seasonId,
      );
    return this.db.all<Episode>(
      `SELECT e.* FROM episodes e JOIN seasons s ON s.id = e.season_id
       WHERE e.series_id = ? ORDER BY s.number, e.number`,
      opts.seriesId ?? '',
    );
  }

  updateEpisode(id: string, values: Partial<Omit<Episode, 'id' | 'series_id' | 'created_at'>>): Episode {
    this.db.update('episodes', id, { ...(values as Record<string, SqlParam>), updated_at: this.now() });
    return this.episode(id);
  }

  features(e: Episode): Partial<EpisodeFeatures> {
    return parseJson<Partial<EpisodeFeatures>>(e.features_json, {});
  }

  // --- character canon --------------------------------------------------------------------------

  characterProfile(characterId: string): SeriesCharacter | undefined {
    return this.db.get<SeriesCharacter>(
      'SELECT * FROM series_characters WHERE character_id = ?',
      characterId,
    );
  }

  characterProfiles(seriesId: string): SeriesCharacter[] {
    return this.db.all<SeriesCharacter>('SELECT * FROM series_characters WHERE series_id = ?', seriesId);
  }

  saveCharacterProfile(
    seriesId: string,
    characterId: string,
    values: Partial<
      Pick<
        SeriesCharacter,
        'profile_json' | 'hinglish_json' | 'voice_en_json' | 'voice_hi_json' | 'pronunciation_json'
      >
    >,
  ): SeriesCharacter {
    const at = this.now();
    if (this.characterProfile(characterId))
      this.db.run(
        `UPDATE series_characters SET ${Object.keys(values)
          .map((k) => `${k} = ?`)
          .join(', ')}${Object.keys(values).length ? ',' : ''} updated_at = ? WHERE character_id = ?`,
        ...(Object.values(values) as SqlParam[]),
        at,
        characterId,
      );
    else
      this.db.insert('series_characters', {
        character_id: characterId,
        series_id: seriesId,
        ...(values as Record<string, SqlParam>),
        created_at: at,
        updated_at: at,
      });
    return this.characterProfile(characterId)!;
  }

  hinglishStyle(p: SeriesCharacter | undefined): HinglishStyle {
    const h = parseJson<Partial<HinglishStyle>>(p?.hinglish_json, {});
    return {
      english_share:
        typeof h.english_share === 'number' ? Math.min(0.9, Math.max(0.1, h.english_share)) : 0.4,
      formality: h.formality ?? 'casual',
      notes: h.notes ?? '',
    };
  }

  // --- continuity memory ------------------------------------------------------------------------

  addFact(
    v: Pick<ContinuityFact, 'series_id' | 'kind' | 'fact'> &
      Partial<Pick<ContinuityFact, 'season_id' | 'episode_id' | 'subject' | 'status'>>,
  ): ContinuityFact {
    const id = newId('fct');
    const at = this.now();
    const status = v.status ?? 'proposed';
    this.db.insert('continuity_facts', {
      subject: '',
      ...(v as Record<string, SqlParam>),
      status,
      id,
      created_at: at,
      approved_at: status === 'canon' ? at : null,
    });
    return requireRow<ContinuityFact>(this.db, 'continuity_facts', id, 'Fact');
  }

  facts(
    seriesId: string,
    opts: { status?: ContinuityFact['status'][]; episodeId?: string } = {},
  ): ContinuityFact[] {
    const status = opts.status ?? ['canon'];
    return this.db.all<ContinuityFact>(
      `SELECT * FROM continuity_facts WHERE series_id = ? AND status IN (${status.map(() => '?').join(', ')})
       ${opts.episodeId ? 'AND episode_id = ?' : ''} ORDER BY created_at`,
      seriesId,
      ...status,
      ...(opts.episodeId ? [opts.episodeId] : []),
    );
  }

  /** Approve (proposed → canon) or reject all proposed facts of an episode. */
  settleFacts(episodeId: string, approve: boolean): number {
    const at = this.now();
    return this.db.run(
      `UPDATE continuity_facts SET status = ?, approved_at = ? WHERE episode_id = ? AND status = 'proposed'`,
      approve ? 'canon' : 'rejected',
      approve ? at : null,
      episodeId,
    ).changes;
  }

  // --- localizations ----------------------------------------------------------------------------

  localization(id: string): Localization {
    return requireRow<Localization>(this.db, 'localizations', id, 'Language version');
  }

  findLocalization(videoId: string, shortId: string | null, language: string): Localization | undefined {
    return this.db.get<Localization>(
      `SELECT * FROM localizations WHERE video_id = ? AND ${shortId ? 'short_id = ?' : 'short_id IS NULL'} AND language = ?`,
      videoId,
      ...(shortId ? [shortId] : []),
      language,
    );
  }

  ensureLocalization(videoId: string, shortId: string | null, language: string): Localization {
    const found = this.findLocalization(videoId, shortId, language);
    if (found) return found;
    const id = newId('loc');
    const at = this.now();
    this.db.insert('localizations', {
      id,
      video_id: videoId,
      short_id: shortId,
      language,
      status: 'planned',
      created_at: at,
      updated_at: at,
    });
    return this.localization(id);
  }

  videoLocalizations(videoId: string): Localization[] {
    return this.db.all<Localization>(
      'SELECT * FROM localizations WHERE video_id = ? ORDER BY short_id IS NOT NULL, created_at',
      videoId,
    );
  }

  updateLocalization(id: string, values: Partial<Omit<Localization, 'id' | 'created_at'>>): Localization {
    this.db.update('localizations', id, { ...(values as Record<string, SqlParam>), updated_at: this.now() });
    return this.localization(id);
  }

  // --- channel profiles -------------------------------------------------------------------------

  channels(): ChannelProfile[] {
    return this.db.all<ChannelProfile>('SELECT * FROM channel_profiles ORDER BY created_at');
  }

  channel(id: string): ChannelProfile {
    return requireRow<ChannelProfile>(this.db, 'channel_profiles', id, 'Channel');
  }

  channelFor(language: string): ChannelProfile | undefined {
    return this.db.get<ChannelProfile>('SELECT * FROM channel_profiles WHERE language = ?', language);
  }

  /** The two default channel profiles (English and Hinglish); created once, never overwritten. */
  ensureDefaultChannels(): ChannelProfile[] {
    const defaults: Array<Pick<ChannelProfile, 'name' | 'language' | 'utc_offset_minutes' | 'publish_time'>> =
      [
        { name: 'English channel', language: 'en', utc_offset_minutes: null, publish_time: '17:00' },
        {
          name: 'Hinglish channel (India)',
          language: 'hi-Latn',
          utc_offset_minutes: 330,
          publish_time: '18:00',
        },
      ];
    for (const d of defaults)
      if (!this.channelFor(d.language)) {
        const at = this.now();
        this.db.insert('channel_profiles', { id: newId('chn'), ...d, created_at: at, updated_at: at });
      }
    return this.channels();
  }

  updateChannel(
    id: string,
    values: Partial<Omit<ChannelProfile, 'id' | 'language' | 'created_at'>>,
  ): ChannelProfile {
    this.db.update('channel_profiles', id, {
      ...(values as Record<string, SqlParam>),
      updated_at: this.now(),
    });
    return this.channel(id);
  }
}
