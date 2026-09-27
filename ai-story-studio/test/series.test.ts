import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import type { SeriesBrief, StoryScript } from '../src/domain/script.ts';
import { findFfmpeg } from '../src/media/ffmpeg.ts';
import { checkContinuity, similarEpisodes } from '../src/services/continuity.ts';
import { checkLine, LOCALIZE_MARKER, speechText } from '../src/services/hinglish.ts';
import { mockHinglish } from '../src/providers/mock/text.ts';
import type { TextModel } from '../src/providers/types.ts';
import { SeriesService } from '../src/services/series.ts';
import { testStudio, type TestStudio } from './helpers.ts';

/**
 * Series production in DEVELOPER TEST MODE (placeholder AI, real FFmpeg): the series memory given
 * to the writer, duplicate detection, continuity fixes, proposed canon that only becomes canon on
 * approval, and the English master + Hinglish version sharing the SAME pictures and clips.
 * This proves the pipeline, not the quality of real AI or of real Hinglish.
 */
const ff = findFfmpeg();

describe('continuity and localization rules (deterministic)', () => {
  const brief = {
    characters: [
      {
        name: 'Aira',
        role: 'hero',
        look: 'girl with a teal jacket and a scanner wristband',
        personality: 'curious',
        speech: '',
      },
    ],
    locations: [{ name: 'Portal Lab', description: 'a round lab with a glowing ring' }],
    facts: [
      { kind: 'object_state', subject: 'old portal', fact: 'The old portal was destroyed in episode 3.' },
    ],
  } as unknown as SeriesBrief;
  const script = (): StoryScript => ({
    title: 't',
    logline: '',
    mood: 'playful',
    characters: [{ name: 'Ayra', description: 'a girl in a red dress', voice: 'child' }],
    locations: [{ name: 'portal lab', description: 'x' }],
    scenes: [
      {
        title: 's',
        location: 'portal lab',
        shots: [
          {
            visual: 'Ayra looks at the old portal',
            characters: ['Ayra'],
            camera: 'wide shot',
            movement: 'static',
            dialogue: [{ character: 'Ayra', line: 'Ayra here!' }],
          },
        ],
      },
    ],
  });

  it('fixes a misspelled canon name and look, keeps canon location spelling, flags a contradiction', () => {
    const sc = script();
    const issues = checkContinuity(sc, brief);
    assert.equal(sc.characters[0]!.name, 'Aira');
    assert.equal(
      sc.characters[0]!.description,
      'girl with a teal jacket and a scanner wristband',
      'canon look kept',
    );
    assert.deepEqual(sc.scenes[0]!.shots[0]!.characters, ['Aira']);
    assert.equal(sc.scenes[0]!.shots[0]!.dialogue![0]!.line, 'Aira here!');
    assert.equal(sc.scenes[0]!.location, 'Portal Lab');
    assert.ok(issues.some((i) => i.severity === 'fixed' && /Ayra/.test(i.message)));
    assert.ok(
      issues.some((i) => i.severity === 'error' && /old portal/.test(i.message)),
      'escalated, not silently changed',
    );
  });

  it('duplicate detection compares story features, not titles', () => {
    const a = {
      problem: 'the station clock skips one second every night',
      setting: 'space station',
      resolution: 'they recalibrate the clock with a laser',
      villain: 'none',
      science: 'time signals',
      lesson: 'patience',
      setpiece: 'spacewalk',
    };
    const same = { ...a, problem: 'every night the space station clock skips a second' };
    const other = {
      problem: 'a robot forgets how to laugh',
      setting: 'school lab',
      resolution: 'they teach it jokes',
      villain: 'none',
      science: 'machine learning',
      lesson: 'friendship',
      setpiece: 'comedy show',
    };
    const r = similarEpisodes(same, [
      { id: 'e1', number: 1, features: a },
      { id: 'e2', number: 2, features: other },
    ]);
    assert.equal(r[0]!.episodeId, 'e1');
    assert.ok(r[0]!.score >= 0.5, String(r[0]!.score));
    assert.ok(r[1]!.score < 0.2, String(r[1]!.score));
  });

  it('Hinglish checks and speech text (spec examples)', () => {
    const en = 'The portal is losing power. We have thirty seconds!';
    assert.deepEqual(checkLine(en, 'Portal ki power down ho rahi hai. Sirf thirty seconds hain!', []), []);
    const bad = checkLine(en, 'Pravesh dwar ki urja samapt ho rahi hai.', []).map((i) => i.code);
    assert.ok(bad.includes('formal_hindi') && bad.includes('number_changed'));
    assert.equal(
      speechText('Aira, scanner activate karo. Us wall ke peeche kuch move kar raha hai.', { Aira: 'आइरा' }),
      'आइरा, scanner activate करो. उस wall के पीछे कुछ move कर रहा है.',
    );
    assert.equal(speechText('This is the main system.'), 'This is the main system.', 'English stays English');
  });
});

describe(
  'Series production: English master + Hinglish version (developer test mode)',
  { skip: !ff && 'FFmpeg not installed' },
  () => {
    let s: TestStudio;
    after(() => s?.cleanup());
    const probe = (path: string): string =>
      execFileSync(ff!.ffprobe, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        path,
      ])
        .toString()
        .trim();

    it('episode 1: series memory → story → shared visuals → English and Hinglish finals, Shorts, captions', async () => {
      s = testStudio({ env: { assemblyMode: 'auto' }, ffmpeg: ff });
      const svc = new SeriesService(s);
      const series = svc.create({ name: 'Untitled Sci-Fi Series', starter: 'scifi', episodeMinutes: 0.4 });
      assert.equal(s.series.seasons(series.id)[0]!.number, 1);
      assert.ok(s.series.bible(series)['AGE-SAFETY RULES'], 'starter bible filled');
      assert.equal(s.series.channels().length, 2, 'English + Hinglish channel profiles');
      const { episode, video } = svc.startEpisode({
        seriesId: series.id,
        idea: 'The space station clock skips one second every night and the kids find out why.',
        shortsCount: 1,
      });
      assert.equal(episode.number, 1);
      await s.orchestrator.start(video.id);
      const v = s.videos.get(video.id);
      assert.equal(
        v.status,
        'ready',
        JSON.stringify({ stages: s.videos.stages(v), a: v.attention_json }, null, 1),
      );
      const ep = s.series.episode(episode.id);
      assert.equal(ep.production_status, 'ready_for_review');
      assert.equal(ep.story_status, 'written');
      assert.ok(ep.premise && ep.synopsis);
      assert.equal(s.series.features(ep).problem?.length ? true : false, true);
      const proposed = s.series.facts(series.id, { status: ['proposed'] });
      assert.ok(
        proposed.length >= 1 && proposed.every((f) => f.episode_id === ep.id),
        'facts proposed, not canon',
      );
      assert.equal(s.series.facts(series.id).length, 0, 'nothing is canon before approval');

      // Hinglish version of the episode and of the Short.
      const locs = s.series.videoLocalizations(v.id);
      assert.equal(locs.length, 2, JSON.stringify(locs));
      for (const loc of locs)
        assert.ok(['ready', 'needs_attention'].includes(loc.status), `${loc.status}: ${loc.error_message}`);
      const epLoc = locs.find((l) => !l.short_id)!;
      const master = s.stories.listStoryShots(v.story_id!);
      const hi = s.stories.listStoryShots(epLoc.story_id!);
      assert.equal(hi.length, master.length);
      hi.forEach((sh, i) => {
        assert.equal(sh.approved_image_asset_id, master[i]!.approved_image_asset_id, 'same picture');
        assert.equal(sh.approved_video_asset_id, master[i]!.approved_video_asset_id, 'same clip');
      });
      const hiStory = s.stories.get(epLoc.story_id!);
      assert.equal(hiStory.language, 'hi-Latn');
      assert.equal(hiStory.source_story_id, v.story_id);
      const overrides = JSON.parse(hiStory.voice_overrides_json) as Record<string, string>;
      assert.ok(overrides['narrator'], 'Hinglish narrator voice');
      for (const id of Object.values(overrides))
        assert.match(s.characters.getVoice(id).voice_identity, /^kokoro:h[fm]_/);
      const lines = s.localization.lines(epLoc.story_id!);
      assert.equal(
        lines.length,
        s.localization.lines(v.story_id!).length,
        'every line has a Hinglish version',
      );
      assert.ok(
        lines.some((l) => /[ऀ-ॿ]/.test(l.line.speech_text ?? '')),
        'speech text uses Devanagari for Hindi words',
      );
      assert.ok(
        lines.every((l) => !/[ऀ-ॿ]/.test(l.line.text)),
        'captions stay Roman',
      );
      // Two playable finals from one master.
      const enKey = s.assets.get(s.reports.getExport(v.episode_export_id!).master_asset_id!).storage_key;
      assert.equal(probe(s.storage.localPath(enKey)), '1920,1080');
      assert.equal(probe(s.storage.localPath(epLoc.video_key!)), '1920,1080');
      assert.notEqual(epLoc.video_key, enKey);
      assert.ok(epLoc.captions_srt_key && epLoc.thumbnail_key);
      assert.doesNotMatch((await s.storage.get(epLoc.captions_srt_key!)).toString(), /[ऀ-ॿ]/);
      const meta = JSON.parse(epLoc.metadata_json) as {
        defaultLanguage: string;
        description: string;
        madeForKids: unknown;
      };
      assert.equal(meta.defaultLanguage, 'hi');
      assert.match(meta.description, /AI-generated \(synthetic\)/);
      assert.equal(meta.madeForKids, null);
      const shortLoc = locs.find((l) => l.short_id)!;
      assert.equal(probe(s.storage.localPath(shortLoc.video_key!)), '1080,1920');
      const timing = JSON.parse(epLoc.timing_json) as { lines: number };
      assert.ok(timing.lines > 0);
      const qc = JSON.parse(s.videos.get(v.id).qc_json) as Array<{ code: string; severity: string }>;
      assert.ok(!qc.some((f) => f.code === 'localization_mismatch'), 'EN/HI line counts match');
    });

    it('approval turns proposed facts into canon; episode 2 gets the memory and avoids a repeat', async () => {
      const svc = new SeriesService(s);
      const series = s.series.list()[0]!;
      const ep1 = s.series.episodes({ seriesId: series.id })[0]!;
      svc.approve(ep1.id);
      assert.equal(s.series.episode(ep1.id).production_status, 'approved');
      assert.ok(s.series.facts(series.id).length >= 1, 'canon after approval');
      const { episode, video } = svc.startEpisode({
        seriesId: series.id,
        idea: 'The space station clock skips one second every night and the kids find out why.',
        makeShorts: false,
        hinglish: false,
      });
      const brief = svc.brief(s.series.episode(episode.id));
      assert.equal(brief.episodeNumber, 2);
      assert.equal(brief.recent[0]!.number, 1, 'episode 1 is in the memory');
      assert.ok(brief.facts.length >= 1);
      assert.ok(
        brief.characters.some((c) => c.name === 'Milo'),
        'recurring cast from canon',
      );
      assert.ok(brief.avoid.problems.length >= 1, 'recent problems to avoid');
      await s.orchestrator.start(video.id);
      const ep2 = s.series.episode(episode.id);
      assert.equal(s.videos.get(video.id).status, 'ready');
      const similar = JSON.parse(ep2.similarity_json) as Array<{ number: number; score: number }>;
      assert.equal(similar[0]?.number, 1, 'compared with episode 1');
      const story = s.videos.stages(s.videos.get(video.id)).find((x) => x.stage === 'story')!;
      assert.match(story.detail, /episode 2/);
      // The placeholder writer repeats the same idea: written again once, then flagged for the person.
      assert.match(story.detail, /still similar to episode 1/);
      // Rejecting an episode keeps its events out of the canon.
      const before = s.series.facts(series.id).length;
      svc.reject(ep2.id);
      assert.equal(s.series.facts(series.id).length, before);
      assert.ok(s.series.facts(series.id, { status: ['rejected'] }).some((f) => f.episode_id === ep2.id));
    });

    it('three consecutive episodes: episode 3 remembers approved episode 1, not rejected episode 2', async () => {
      const svc = new SeriesService(s);
      const series = s.series.list()[0]!;
      const [ep1, ep2] = s.series.episodes({ seriesId: series.id });
      const { episode, video } = svc.startEpisode({
        seriesId: series.id,
        idea: 'A sky-tram stops at every red balloon and the friends discover how magnets work.',
        makeShorts: false,
        hinglish: false,
      });
      assert.equal(episode.number, 3);
      const brief = svc.brief(s.series.episode(episode.id));
      assert.deepEqual(
        brief.recent.map((x) => x.number),
        [1],
        'the rejected episode 2 is not part of the story so far',
      );
      assert.ok(brief.facts.length >= 1, 'canon from episode 1');
      const canon = s.series.facts(series.id, { status: ['canon'] });
      assert.ok(
        canon.every((f) => f.episode_id !== ep2!.id),
        'nothing from the rejected episode is canon',
      );
      assert.equal(
        brief.facts.length,
        canon.filter((f) => !f.kind.startsWith('mystery_')).length,
        'the writer gets exactly the canon',
      );
      await s.orchestrator.start(video.id);
      assert.equal(s.videos.get(video.id).status, 'ready');
      const ep3 = s.series.episode(episode.id);
      const similar = JSON.parse(ep3.similarity_json) as Array<{ score: number }>;
      assert.ok(
        similar.every((x) => x.score < 0.5),
        `a new story, not a repeat: ${ep3.similarity_json}`,
      );
      const story = s.videos.stages(s.videos.get(video.id)).find((x) => x.stage === 'story')!;
      assert.doesNotMatch(story.detail, /similar to episode/);
      svc.approve(ep3.id);
      assert.ok(
        s.series.facts(series.id).some((f) => f.episode_id === ep3.id),
        'episode 3 facts are canon after approval',
      );
      assert.deepEqual(
        s.series.episodes({ seriesId: series.id }).map((e) => [e.number, e.production_status]),
        [
          [1, 'approved'],
          [2, 'rejected'],
          [3, 'approved'],
        ],
      );
      // The recurring cast is reused across all three episodes, never duplicated.
      const cast = s.characters.list(series.project_id).map((c) => c.name);
      assert.equal(cast.filter((n) => n === 'Milo').length, 1, cast.join());
      assert.equal(ep1!.video_id !== ep3.video_id, true);
    });

    it('timing fit: a Hinglish line too long for its shot is rewritten shorter, then paced, then flagged', async () => {
      const t = testStudio({ env: { assemblyMode: 'auto' }, ffmpeg: ff });
      try {
        const base = t.providers.text;
        // Narrator lines come back far too long; after "shorter" the first one fits, the others still do not.
        const long: TextModel = {
          info: base.info,
          write: async (req, ctx) => {
            const at = req.prompt.indexOf(LOCALIZE_MARKER);
            if (at < 0) return base.write(req, ctx);
            const body = JSON.parse(
              req.prompt
                .slice(at + LOCALIZE_MARKER.length)
                .split('\n')[0]!
                .trim(),
            ) as {
              lines: Array<{ id: string; english: string; speaker: string }>;
              shorter?: boolean;
            };
            let n = 0;
            const lines = body.lines.map((l) => {
              const h = mockHinglish(l.english, false);
              if (l.speaker !== 'Narrator') return { id: l.id, hinglish: h };
              n++;
              const extra = body.shorter ? (n === 1 ? 0 : 6) : 14;
              return {
                id: l.id,
                hinglish: `${h} ${'aur phir sab dost saath mein chalte hain'
                  .split(' ')
                  .concat(Array(extra).fill('yaar'))
                  .slice(0, 7 + extra)
                  .join(' ')}`.trim(),
              };
            });
            return {
              text: JSON.stringify({ lines }),
              model: base.info.id,
              modelVersion: 'x',
              isMock: true,
              generationSeconds: 0,
              hitLimit: false,
            };
          },
        };
        t.providers.text = long;
        const svc = new SeriesService(t);
        const series = svc.create({ name: 'Timing series', episodeMinutes: 0.4 });
        const { video } = svc.startEpisode({
          seriesId: series.id,
          idea: 'The kids race a sky-tram to deliver a message.',
          makeShorts: false,
        });
        await t.orchestrator.start(video.id);
        const loc = t.series.videoLocalizations(video.id)[0]!;
        const timing = JSON.parse(loc.timing_json) as {
          rewritten: number;
          paced: number;
          flagged: unknown[];
        };
        assert.ok(timing.rewritten >= 1, JSON.stringify(timing));
        assert.ok(timing.paced >= 1, 'a small speed-up was tried');
        assert.ok(timing.flagged.length >= 1, 'what still does not fit is flagged, not hidden');
        assert.equal(loc.status, 'needs_attention');
        const paced = t.localization.lines(loc.story_id!).filter((l) => l.line.speed > 1);
        assert.ok(
          paced.every((l) => l.line.speed <= 1.12),
          'never more than 12% faster',
        );
        const qc = JSON.parse(t.videos.get(video.id).qc_json) as Array<{ code: string }>;
        assert.ok(qc.some((f) => f.code === 'localization_timing'));
      } finally {
        t.cleanup();
      }
    });
  },
);
