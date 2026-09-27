import type { Studio } from '../app/studio.ts';
import { PLAN_MARKER, type SeriesBrief } from '../domain/script.ts';
import { videoStyle } from '../domain/video-styles.ts';
import { AppError } from '../lib/errors.ts';
import { parseJson } from '../lib/json.ts';
import type { Video } from '../repositories/videos.ts';
import {
  BIBLE_SECTIONS,
  type BibleSection,
  type Episode,
  type EpisodeFeatures,
  type Season,
  type Series,
} from '../repositories/series.ts';
import { DUPLICATE_THRESHOLD, jaccard, similarEpisodes, tokens } from './continuity.ts';
import { HINGLISH } from './localization.ts';
import { extractJson } from './story-writer.ts';

/**
 * Series production on top of the orchestrator: a series owns a project (its characters,
 * locations and props are the canon), a Series Bible, seasons and numbered episodes. Each episode
 * is made by the normal production pipeline with the series memory given to the writer, and its
 * events only become canon when the person approves the episode. See docs/SERIES_SYSTEM.md.
 */
export interface NewSeries {
  name: string;
  workingTitle?: string;
  description?: string;
  genre?: string;
  targetAge?: string;
  audience?: string;
  styleId?: string;
  tone?: string;
  episodeMinutes?: number;
  hinglish?: boolean;
  starter?: 'scifi' | 'blank';
  seasonEpisodes?: number;
}

/** An ORIGINAL science-fiction starting point (no existing franchise); everything is editable. */
export function sciFiStarter(): Partial<Record<BibleSection, string>> {
  return {
    PREMISE:
      'Two curious kids and their small helper robot solve science mysteries in a bright future city, where every problem is a puzzle that can be understood.',
    WORLD:
      'A friendly future city of glass gardens, sky-trams and floating parks; a nearby space station; strange planets reachable through carefully controlled portals.',
    TIMELINE: 'Present day of the series: the year the city opened its first public portal lab.',
    'SCIENCE / TECHNOLOGY RULES':
      'Technology follows understandable rules: energy must come from somewhere, portals need power and exact coordinates, robots cannot read minds, nobody travels in time by accident.',
    'FICTION RULES': 'No magic. Surprising things always get a scientific or logical explanation by the end.',
    CHARACTERS:
      'Recurring heroes are defined in Characters (looks, voices, Hinglish style). Keep them consistent.',
    RELATIONSHIPS: 'Friends who trust each other; disagreements are solved by listening and testing ideas.',
    LOCATIONS: 'Home, the school lab, the city skyline, the portal chamber, the space station.',
    VEHICLES: 'Sky-tram, a small shuttle, delivery drones.',
    PROPS: 'A scanner wristband, a hologram notebook, the helper robot’s toolkit.',
    ORGANIZATIONS: 'The City Science Council; the Portal Lab team.',
    ANTAGONISTS:
      'Mostly problems, accidents and misunderstandings; occasional mischievous rivals who learn a lesson. Never cruel villains.',
    'VISUAL LANGUAGE':
      'Rounded shapes, clean futuristic design, warm lights against cool blues; readable silhouettes for every character.',
    'CAMERA LANGUAGE':
      'Clear wide shots to set places, medium shots for talk, close-ups for discoveries; gentle camera moves.',
    LIGHTING: 'Bright and warm by day; soft neon at night; mysteries get cooler, dimmer light — never scary.',
    'COLOR LANGUAGE': 'Teal and orange for the heroes, purple for mysteries, green for solutions.',
    'MUSIC IDENTITY':
      'Light electronic adventure theme with a playful melody; mystery cues are soft and curious.',
    'SFX IDENTITY': 'Soft UI beeps, whooshes of sky-trams, portal hums, friendly robot chirps.',
    INTRO: 'Short (5 s) theme sting over the city skyline.',
    OUTRO: 'The friends recap what they learned; a teaser of the open mystery.',
    'STORY RULES':
      'Each episode: a clear problem, curious investigation, a mistake or twist, a smart solution by the kids, a small lesson. Understandable on its own; can advance a season mystery.',
    'AGE-SAFETY RULES':
      'For ages 6–12: no violence, no weapons used on anyone, no real danger to children without quick help, no scary imagery, no mean humour.',
    'CONTINUITY RULES':
      'Names, looks, voices and facts from approved episodes are canon. New facts need an approved episode.',
    'BANNED CONTENT':
      'Existing franchise characters, logos, brands, real people, politics, religion, romance.',
    'RECURRING MYSTERIES':
      'Who keeps leaving signals near the old portal? Why does the station’s clock skip one second every night?',
    'SEASON ARCS':
      'Season 1: the kids earn the trust of the Portal Lab and find the source of the mysterious signals.',
  };
}

type NamedRow = { name: string; description: string };

interface PlannedIdea {
  title: string;
  premise: string;
  problem: string;
  setting: string;
  science: string;
  lesson: string;
}

export class SeriesService {
  private readonly s: Studio;

  constructor(s: Studio) {
    this.s = s;
  }

  create(input: NewSeries): Series {
    const name = input.name.trim();
    if (name.length < 2) throw new AppError('VALIDATION_FAILED', 'Give the series a (working) name.');
    return this.s.db.transaction(() => {
      const project = this.s.projects.create({ name, genre: input.genre ?? 'Science fiction' });
      const series = this.s.series.create({
        project_id: project.id,
        name,
        working_title: input.workingTitle ?? name,
        description: input.description ?? '',
        genre: input.genre ?? 'Science fiction, adventure, mystery, comedy',
        target_age: input.targetAge ?? '6-12',
        target_audience: input.audience ?? 'Children 6-12 and their families',
        style_id: videoStyle(input.styleId ?? '3d_kids').id,
        story_tone: input.tone ?? 'curious, funny, warm, never scary',
        episode_minutes: Math.min(15, Math.max(1, input.episodeMinutes ?? 6)),
        localizations_json: JSON.stringify(input.hinglish === false ? [] : [HINGLISH]),
        bible_json: JSON.stringify(input.starter === 'blank' ? {} : sciFiStarter()),
      });
      this.s.series.createSeason({
        series_id: series.id,
        number: 1,
        title: 'Season 1',
        episode_target: Math.max(1, Math.min(200, input.seasonEpisodes ?? 30)),
        premise: input.starter === 'blank' ? '' : (sciFiStarter()['SEASON ARCS'] ?? ''),
        status: 'in_production',
      });
      this.s.series.ensureDefaultChannels();
      return series;
    });
  }

  currentSeason(seriesId: string): Season {
    const seasons = this.s.series.seasons(seriesId);
    const s = seasons.find((x) => x.status === 'in_production') ?? seasons[seasons.length - 1];
    if (!s) throw new AppError('NOT_FOUND', 'This series has no season yet.');
    return s;
  }

  /** Earlier episodes that count as history (written, not rejected). */
  private history(e: Episode): Episode[] {
    return this.s.series
      .episodes({ seriesId: e.series_id })
      .filter(
        (x) =>
          x.id !== e.id &&
          x.story_status === 'written' &&
          !['rejected', 'cancelled', 'failed'].includes(x.production_status),
      );
  }

  /** Earlier episodes with their story features (for duplicate detection). */
  previousFeatures(e: Episode): Array<{ id: string; number: number; features: Partial<EpisodeFeatures> }> {
    return this.history(e).map((x) => ({ id: x.id, number: x.number, features: this.s.series.features(x) }));
  }

  /** The compact memory given to the writer: never the whole history, only what is relevant. */
  brief(e: Episode): SeriesBrief {
    const series = this.s.series.get(e.series_id);
    const season = this.s.series.season(e.season_id);
    const bible = this.s.series.bible(series);
    const clip = (t: string | undefined, n: number) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const project = series.project_id;
    const history = this.history(e).filter((x) => x.number < e.number || x.season_id !== e.season_id);
    const canon = this.s.series.facts(series.id, { status: ['canon'] });
    const resolved = canon.filter((f) => f.kind === 'mystery_resolved').map((f) => tokens(f.fact));
    const open = canon
      .filter((f) => f.kind === 'mystery_open')
      .filter((f) => !resolved.some((r) => jaccard(tokens(f.fact), r) >= 0.5))
      .map((f) => f.fact);
    const bibleMysteries = clip(bible['RECURRING MYSTERIES'], 400);
    const recentFeatures = history.slice(-8).map((x) => this.s.series.features(x));
    return {
      series: series.name,
      premise: clip(bible.PREMISE || series.description, 500),
      world: clip(bible.WORLD, 600),
      rules: [
        bible['SCIENCE / TECHNOLOGY RULES'],
        bible['FICTION RULES'],
        bible['STORY RULES'],
        bible['AGE-SAFETY RULES'],
        bible['CONTINUITY RULES'],
        bible['BANNED CONTENT'] ? `Never include: ${bible['BANNED CONTENT']}` : '',
      ]
        .filter(Boolean)
        .map((x) => clip(x, 300))
        .join(' '),
      tone: series.story_tone,
      targetAge: series.target_age,
      season: {
        number: season.number,
        title: season.title,
        premise: clip(season.premise, 400),
        mystery: clip(season.main_mystery, 200),
        arcs: clip(season.arcs, 300),
      },
      episodeNumber: e.number,
      characters: this.s.characters.list(project).map((c) => {
        const p = parseJson<Record<string, string>>(this.s.series.characterProfile(c.id)?.profile_json, {});
        return {
          name: c.name,
          role: clip(c.role || p['role'], 80),
          look: clip(c.appearance || c.prompt, 220),
          personality: clip(c.personality || p['personality'], 160),
          speech: clip(p['speech_style'], 120),
        };
      }),
      locations: this.s.db
        .all<NamedRow>(
          'SELECT name, description FROM locations WHERE project_id = ? ORDER BY created_at LIMIT 15',
          project,
        )
        .map((l) => ({ name: l.name, description: clip(l.description, 120) })),
      facts: canon
        .filter((f) => !f.kind.startsWith('mystery_'))
        .slice(-40)
        .map((f) => ({ kind: f.kind, subject: f.subject, fact: clip(f.fact, 200) })),
      recent: history.slice(-6).map((x) => ({
        number: x.number,
        title: x.title_en || x.working_title,
        synopsis: clip(x.synopsis || x.premise, 220),
      })),
      openMysteries: [...open, ...(bibleMysteries ? [bibleMysteries] : [])].slice(0, 6),
      avoid: {
        problems: recentFeatures.map((f) => clip(f.problem, 100)).filter(Boolean),
        villains: recentFeatures.map((f) => clip(f.villain, 60)).filter((x) => x && x !== 'none'),
        settings: recentFeatures.map((f) => clip(f.setting, 60)).filter(Boolean),
        lessons: recentFeatures.map((f) => clip(f.lesson, 80)).filter(Boolean),
      },
    };
  }

  /**
   * GENERATE EPISODE: the next episode of the season, made by the normal pipeline with the series
   * memory. An empty idea lets the writer choose one that fits the season and avoids repeats.
   */
  startEpisode(input: {
    seriesId: string;
    seasonId?: string;
    idea?: string;
    minutes?: number;
    hinglish?: boolean;
    makeEpisode?: boolean;
    makeShorts?: boolean;
    shortsCount?: number;
    reviewPlan?: boolean;
    /** Make a planned episode (from PLAN SEASON) instead of a new one. */
    episodeId?: string;
  }): { episode: Episode; video: Video } {
    const series = this.s.series.get(input.seriesId);
    const season = input.seasonId ? this.s.series.season(input.seasonId) : this.currentSeason(series.id);
    if (season.series_id !== series.id)
      throw new AppError('VALIDATION_FAILED', 'That season belongs to another series.');
    const busy = this.s.series
      .episodes({ seasonId: season.id })
      .find((x) => ['generating', 'qc'].includes(x.production_status));
    if (busy) throw new AppError('CONFLICT', `Episode ${busy.number} is still being made.`);
    const planned = input.episodeId ? this.s.series.episode(input.episodeId) : null;
    if (planned && (planned.series_id !== series.id || planned.production_status !== 'planned'))
      throw new AppError('CONFLICT', 'Only a planned episode of this series can be made from the plan.');
    const idea = (input.idea ?? '').trim() || planned?.idea || '';
    const episode = planned
      ? this.s.series.updateEpisode(planned.id, {
          idea,
          story_status: 'writing',
          production_status: 'generating',
        })
      : this.s.series.createEpisode({
          series_id: series.id,
          season_id: season.id,
          idea,
          working_title: idea ? idea.split(/[.!?\n]/)[0]!.slice(0, 80) : '',
          story_status: 'writing',
          production_status: 'generating',
        });
    const localizations =
      (input.hinglish ?? this.s.series.localizations(series).includes(HINGLISH)) ? [HINGLISH] : [];
    const video = this.s.orchestrator.create({
      idea:
        idea ||
        `(Episode ${episode.number}: choose a fresh idea that fits the season and does not repeat recent episodes.)`,
      length: 'custom',
      customMinutes: input.minutes ?? series.episode_minutes,
      styleId: series.style_id,
      makeEpisode: input.makeEpisode ?? true,
      makeShorts: input.makeShorts ?? true,
      shortsCount: input.shortsCount ?? 2,
      language: 'en',
      narrator: 'female',
      musicMood: 'auto',
      reviewPlan: input.reviewPlan ?? false,
      projectId: series.project_id,
      episodeId: episode.id,
      localizations,
    });
    const linked = this.s.series.updateEpisode(episode.id, { video_id: video.id });
    return { episode: linked, video };
  }

  /**
   * PLAN SEASON: the story model suggests the next episode ideas for the season; ideas too close to
   * an earlier (or already planned) episode are dropped. Saved as PLANNED episodes the person can
   * edit, make, or delete. Nothing is produced yet.
   */
  async planSeason(seasonId: string, count: number): Promise<{ created: Episode[]; skipped: string[] }> {
    const season = this.s.series.season(seasonId);
    const series = this.s.series.get(season.series_id);
    const bible = this.s.series.bible(series);
    const all = this.s.series.episodes({ seriesId: series.id });
    const n = Math.max(1, Math.min(12, Math.round(count) || 1));
    const clip = (t: string | undefined, k: number) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, k);
    const known = all
      .filter((e) => !['rejected', 'cancelled'].includes(e.production_status))
      .slice(-20)
      .map(
        (e) =>
          `${e.number}. ${e.title_en || e.working_title}: ${clip(e.synopsis || e.premise || e.idea, 140)}`,
      );
    const request = { count: n, season: season.number, from: this.s.series.nextEpisodeNumber(season.id) };
    const prompt = `${PLAN_MARKER} ${JSON.stringify(request)}
Series: ${series.name}. Tone: ${series.story_tone}. Ages ${series.target_age}.
Premise: ${clip(bible.PREMISE || series.description, 500)}
World: ${clip(bible.WORLD, 400)}
Rules: ${clip([bible['STORY RULES'], bible['AGE-SAFETY RULES'], bible['SCIENCE / TECHNOLOGY RULES']].filter(Boolean).join(' '), 700)}
Never include: ${clip(bible['BANNED CONTENT'], 200) || 'existing franchise characters, brands, real people'}
Season ${season.number} "${season.title}": ${clip(season.premise, 400)} Mystery: ${clip(season.main_mystery, 200)}
Episodes so far (do NOT repeat their problems, villains, settings or lessons):
${known.join('\n') || '(none yet)'}
Plan ${n} new ORIGINAL episodes that continue the season. Answer with JSON only:
{"episodes":[{"title":"...","premise":"2 sentences","problem":"...","setting":"...","science":"...","lesson":"..."}]}`;
    const text = this.s.providers.text;
    const run = () =>
      text.write(
        {
          system:
            "You plan episodes for an original children's animated series. Every idea is new, age-appropriate and never copies existing shows or characters.",
          prompt,
          maxTokens: 400 + n * 220,
          temperature: 0.8,
          seed: all.length * 7919 + n,
          json: true,
        },
        { attemptKey: `season:${season.id}:plan:${all.length}` },
      );
    const out =
      text.info.computeLocation === 'cloud_gpu'
        ? await this.s.orchestrator.onGpu(run, ['text'])
        : await run();
    const body = extractJson(out.text) as { episodes?: unknown };
    const ideas = (Array.isArray(body.episodes) ? body.episodes : [])
      .map((x) => x as Partial<Record<keyof PlannedIdea, unknown>>)
      .map((x) => ({
        title: clip(String(x.title ?? ''), 80),
        premise: clip(String(x.premise ?? ''), 400),
        problem: clip(String(x.problem ?? ''), 200),
        setting: clip(String(x.setting ?? ''), 120),
        science: clip(String(x.science ?? ''), 160),
        lesson: clip(String(x.lesson ?? ''), 160),
      }))
      .filter((x) => x.title && x.premise);
    if (!ideas.length)
      throw new AppError('STORY_GENERATION_FAILED', 'The story model did not suggest any episode.');
    const previous = all
      .filter((e) => !['rejected', 'cancelled'].includes(e.production_status))
      .map((e) => ({ id: e.id, number: e.number, features: this.s.series.features(e) }));
    const created: Episode[] = [];
    const skipped: string[] = [];
    for (const idea of ideas.slice(0, n)) {
      const features = {
        problem: idea.problem || idea.premise,
        setting: idea.setting,
        science: idea.science,
        lesson: idea.lesson,
      };
      const top = similarEpisodes(features, previous)[0];
      if (top && top.score >= DUPLICATE_THRESHOLD) {
        skipped.push(`"${idea.title}" (too close to episode ${top.number})`);
        continue;
      }
      const e = this.s.series.createEpisode({
        series_id: series.id,
        season_id: season.id,
        working_title: idea.title,
        idea: idea.premise,
        premise: idea.premise,
        lesson: idea.lesson,
        features_json: JSON.stringify(features),
        story_status: 'planned',
        production_status: 'planned',
      });
      previous.push({ id: e.id, number: e.number, features });
      created.push(e);
    }
    this.s.logger.info('season planned', {
      season: season.id,
      created: created.length,
      skipped: skipped.length,
      mock: out.isMock,
    });
    return { created, skipped };
  }

  /** Remove a planned (not yet made) episode. Made episodes are never deleted from here. */
  deletePlanned(episodeId: string): void {
    const e = this.s.series.episode(episodeId);
    if (e.production_status !== 'planned' || e.video_id)
      throw new AppError('CONFLICT', 'Only a planned episode that was not made yet can be removed.');
    this.s.db.run('DELETE FROM episodes WHERE id = ?', e.id);
  }

  /** The person approved the episode: its proposed facts become canon. */
  approve(episodeId: string): Episode {
    const e = this.s.series.episode(episodeId);
    if (!['ready_for_review', 'needs_attention'].includes(e.production_status))
      throw new AppError('CONFLICT', 'Only a finished episode can be approved.');
    const n = this.s.series.settleFacts(e.id, true);
    this.s.logger.info('episode approved', { episode: e.id, number: e.number, canonFacts: n });
    return this.s.series.updateEpisode(e.id, {
      production_status: 'approved',
      approved_at: this.s.clock.now().toISOString(),
    });
  }

  /** Rejected: nothing from this episode enters the canon; its number stays used. */
  reject(episodeId: string): Episode {
    const e = this.s.series.episode(episodeId);
    this.s.series.settleFacts(e.id, false);
    return this.s.series.updateEpisode(e.id, { production_status: 'rejected' });
  }

  /** Home / calendar counts, per language version. */
  pipeline(seriesId: string): Record<string, number> {
    const counts: Record<string, number> = {
      published: 0,
      scheduled: 0,
      ready: 0,
      generating: 0,
      planned: 0,
    };
    for (const e of this.s.series.episodes({ seriesId })) {
      const pubs = e.video_id
        ? this.s.videos.publications(e.video_id).filter((p) => p.kind === 'episode')
        : [];
      if (pubs.some((p) => p.status === 'published')) counts['published']!++;
      else if (pubs.some((p) => p.status === 'scheduled')) counts['scheduled']!++;
      else if (['ready_for_review', 'approved', 'needs_attention'].includes(e.production_status))
        counts['ready']!++;
      else if (['generating', 'qc'].includes(e.production_status)) counts['generating']!++;
      else if (e.production_status === 'planned') counts['planned']!++;
    }
    return counts;
  }
}

export { BIBLE_SECTIONS, PLAN_MARKER };
