import type { Studio } from '../app/studio.ts';
import type { DialogueLine, NarrationLine } from '../domain/types.ts';
import { AppError, toAppError } from '../lib/errors.ts';
import { parseJson } from '../lib/json.ts';
import type { RunContext, TextModel } from '../providers/types.ts';
import {
  checkLine,
  localizePrompt,
  speechText,
  STYLE_GUIDE,
  validSpeechText,
  type LineIssue,
  type LocalizeLine,
} from './hinglish.ts';
import { extractJson } from './story-writer.ts';

/**
 * Language versions from ONE master: the English story is localized line by line (LLM + checks),
 * then copied into a story whose shots point at the SAME approved pictures and clips. Only the
 * words, voices, captions, thumbnail text and metadata differ. See docs/LOCALIZATION.md.
 */
export const HINGLISH = 'hi-Latn';

/** A language version's name for people. */
export function languageName(code: string): string {
  if (code === HINGLISH) return 'Hinglish';
  if (code === 'en' || code.startsWith('en-')) return 'English';
  return code;
}

export interface LocalizedText {
  text: string;
  speech: string;
}

export interface QaEntry {
  id: string;
  speaker: string;
  english: string;
  hinglish: string;
  issues: LineIssue[];
}

/** Kokoro's Hindi voices, handed out so two characters do not share one. */
const HINDI_VOICES = { female: ['hf_alpha', 'hf_beta'], male: ['hm_omega', 'hm_psi'] } as const;

type VoiceRow = { voice_identity: string };

export class LocalizationService {
  private readonly s: Studio;

  constructor(s: Studio) {
    this.s = s;
  }

  /** Every spoken line of a story (dialogue and narration), with who says it. */
  lines(storyId: string): Array<{
    id: string;
    kind: 'dialogue' | 'narration';
    speaker: string;
    characterId: string | null;
    line: DialogueLine | NarrationLine;
    seconds: number;
  }> {
    const tree = this.s.stories.tree(storyId);
    const out: ReturnType<LocalizationService['lines']> = [];
    const secs = (assetId: string | null, text: string): number => {
      const a = assetId
        ? this.s.db.get<{ duration_sec: number | null }>(
            'SELECT duration_sec FROM audio_assets WHERE id = ?',
            assetId,
          )
        : undefined;
      return a?.duration_sec ?? Math.max(1, text.split(/\s+/).length / 2.6);
    };
    for (const sc of tree.scenes) {
      for (const n of sc.narration.filter((x) => !x.shot_id))
        out.push({
          id: n.id,
          kind: 'narration',
          speaker: 'Narrator',
          characterId: null,
          line: n,
          seconds: secs(n.audio_asset_id, n.text),
        });
      for (const sh of sc.shots) {
        for (const n of sc.narration.filter((x) => x.shot_id === sh.shot.id))
          out.push({
            id: n.id,
            kind: 'narration',
            speaker: 'Narrator',
            characterId: null,
            line: n,
            seconds: secs(n.audio_asset_id, n.text),
          });
        for (const d of sh.dialogue) {
          const name = d.character_id ? this.s.characters.get(d.character_id).name : 'Someone';
          out.push({
            id: d.id,
            kind: 'dialogue',
            speaker: name,
            characterId: d.character_id,
            line: d,
            seconds: secs(d.audio_asset_id, d.text),
          });
        }
      }
    }
    return out;
  }

  /** Names that must survive localization unchanged (characters and locations of the project). */
  names(projectId: string): string[] {
    return [
      ...this.s.characters.list(projectId).map((c) => c.name),
      ...this.s.db
        .all<{ name: string }>('SELECT name FROM locations WHERE project_id = ?', projectId)
        .map((l) => l.name),
    ];
  }

  style(characterId: string | null): { englishShare: number; notes: string } {
    if (!characterId) return { englishShare: 0.45, notes: 'Narrator: warm storyteller, clear and simple.' };
    const p = this.s.series.characterProfile(characterId);
    const h = this.s.series.hinglishStyle(p);
    return { englishShare: h.english_share, notes: `${h.formality}${h.notes ? `; ${h.notes}` : ''}` };
  }

  pronunciation(projectId: string): Record<string, string> {
    const map: Record<string, string> = {};
    for (const c of this.s.characters.list(projectId)) {
      const p = this.s.series.characterProfile(c.id);
      Object.assign(map, parseJson<Record<string, string>>(p?.pronunciation_json, {}));
    }
    return map;
  }

  /**
   * Localize lines with the text model: asks, checks every line, asks again for the lines with
   * errors (with the problems listed), up to three rounds. Returns the texts and the QA report.
   */
  async localize(
    model: TextModel,
    input: LocalizeLine[],
    names: string[],
    pron: Record<string, string>,
    ctx: RunContext,
    opts: { shorter?: boolean; seed?: number } = {},
  ): Promise<{ texts: Map<string, LocalizedText>; qa: QaEntry[]; isMock: boolean }> {
    const texts = new Map<string, LocalizedText>();
    const qa = new Map<string, QaEntry>();
    let pending = input;
    let isMock = false;
    let problems = new Map<string, string[]>();
    for (let round = 1; round <= 3 && pending.length; round++) {
      const chunks: LocalizeLine[][] = [];
      for (let i = 0; i < pending.length; i += 30) chunks.push(pending.slice(i, i + 30));
      const failed: LocalizeLine[] = [];
      for (const [ci, chunk] of chunks.entries()) {
        const repair = problems.size
          ? `\n\nFix these problems from the previous answer:\n${chunk
              .filter((l) => problems.has(l.id))
              .map((l) => `- ${l.id}: ${problems.get(l.id)!.join(' ')}`)
              .join('\n')}`
          : '';
        const res = await model.write(
          {
            system: STYLE_GUIDE,
            prompt: localizePrompt(chunk, names, opts.shorter) + repair,
            maxTokens: 4000,
            temperature: round === 1 ? 0.5 : 0.3,
            seed: (opts.seed ?? 1) + round * 7919 + ci,
            json: true,
          },
          { ...ctx, attemptKey: `${ctx.attemptKey}:loc${round}:${ci}` },
        );
        isMock = isMock || res.isMock;
        let answer: Array<{ id?: string; hinglish?: string; speech?: string }> = [];
        try {
          answer = ((extractJson(res.text) as { lines?: unknown }).lines as typeof answer) ?? [];
        } catch {
          answer = [];
        }
        const byId = new Map(answer.filter((a) => a && typeof a.id === 'string').map((a) => [a.id!, a]));
        for (const l of chunk) {
          const a = byId.get(l.id);
          const h = typeof a?.hinglish === 'string' ? a.hinglish.trim() : '';
          const issues = checkLine(l.english, h, names, l.englishShare);
          qa.set(l.id, { id: l.id, speaker: l.speaker, english: l.english, hinglish: h, issues });
          if (issues.some((i) => i.severity === 'error')) {
            failed.push(l);
            continue;
          }
          const speech = validSpeechText(h, a?.speech) ? a!.speech!.trim() : speechText(h, pron);
          texts.set(l.id, { text: h, speech });
        }
      }
      problems = new Map(
        failed.map((l) => [
          l.id,
          qa
            .get(l.id)!
            .issues.filter((i) => i.severity === 'error')
            .map((i) => i.message),
        ]),
      );
      pending = failed;
    }
    return { texts, qa: [...qa.values()], isMock };
  }

  /** The Hinglish voice for a character (created once, then kept for every episode). */
  hinglishVoice(characterId: string | null, projectId: string): string {
    const who = characterId ? this.s.characters.get(characterId) : null;
    const label = `${who ? who.name : 'Narrator'} (Hinglish)`;
    const existing = this.s.db.get<{ id: string }>(
      'SELECT id FROM voice_profiles WHERE project_id = ? AND name = ?',
      projectId,
      label,
    );
    if (existing) return existing.id;
    const base = who?.voice_profile_id
      ? this.s.characters.getVoice(who.voice_profile_id)
      : this.s.projects.get(projectId).narrator_voice_id
        ? this.s.characters.getVoice(this.s.projects.get(projectId).narrator_voice_id!)
        : null;
    const presentation = base?.presentation === 'male' ? 'male' : 'female';
    const used = new Set(
      this.s.db
        .all<VoiceRow>(
          "SELECT voice_identity FROM voice_profiles WHERE project_id = ? AND name LIKE '% (Hinglish)'",
          projectId,
        )
        .map((v) => v.voice_identity),
    );
    const pool = HINDI_VOICES[presentation];
    const pick = pool.find((v) => !used.has(`kokoro:${v}`)) ?? pool[used.size % pool.length]!;
    const voice = this.s.characters.createVoice(projectId, {
      name: label,
      role: who ? 'character' : 'narrator',
      voice_model: base?.voice_model ?? 'auto',
      voice_identity: `kokoro:${pick}`,
      language: HINGLISH,
      presentation,
      pitch: base?.pitch ?? 0,
      speed: base?.speed ?? 1,
    });
    if (who) {
      const profile = this.s.series.characterProfile(who.id);
      const series = this.s.series.byProject(projectId);
      if (series)
        this.s.series.saveCharacterProfile(series.id, who.id, {
          voice_hi_json: JSON.stringify({
            ...parseJson<Record<string, unknown>>(profile?.voice_hi_json, {}),
            voice_profile_id: voice.id,
          }),
        });
    }
    return voice.id;
  }

  /**
   * Copy a story into a language version: same scenes, shots, characters, SFX and the SAME
   * approved pictures and clips; localized dialogue/narration (caption text + speech text) and
   * this version's voices.
   */
  createLocalizedStory(
    sourceStoryId: string,
    language: string,
    texts: Map<string, LocalizedText>,
    title: string,
  ): string {
    const src = this.s.stories.tree(sourceStoryId);
    const projectId = src.story.project_id;
    return this.s.db.transaction(() => {
      const story = this.s.stories.create(projectId, {
        title: title.slice(0, 300),
        synopsis: src.story.synopsis,
        moral: src.story.moral,
        language,
        target_duration_sec: src.story.target_duration_sec,
        production_notes: `${language} version of "${src.story.title}" (${sourceStoryId}): same pictures and clips.`,
      });
      const overrides: Record<string, string> = { narrator: this.hinglishVoice(null, projectId) };
      this.s.db.run(
        'UPDATE stories SET format = ?, source_story_id = ? WHERE id = ?',
        src.story.format,
        sourceStoryId,
        story.id,
      );
      const loc = (line: { id: string; text: string }): LocalizedText => {
        const t = texts.get(line.id);
        if (!t)
          throw new AppError(
            'LOCALIZATION_FAILED',
            `Line "${line.text.slice(0, 60)}" has no ${language} version.`,
          );
        return t;
      };
      for (const sc of src.scenes) {
        const scene = this.s.stories.createScene(story.id, {
          title: sc.scene.title,
          summary: sc.scene.summary,
          location_id: sc.scene.location_id ?? undefined,
          time_of_day: sc.scene.time_of_day,
          music_mood: sc.scene.music_mood,
          music_genre: sc.scene.music_genre,
          music_energy: sc.scene.music_energy,
          ambience: sc.scene.ambience,
        });
        const addNarration = (n: NarrationLine, shotId?: string): void => {
          const t = loc(n);
          const copy = this.s.stories.addNarration(scene.id, {
            ...(shotId ? { shot_id: shotId } : {}),
            text: t.text,
            emotion: n.emotion,
            speed: n.speed,
            language,
            required: !!n.required,
          });
          this.s.db.run('UPDATE narration_lines SET speech_text = ? WHERE id = ?', t.speech, copy.id);
        };
        for (const n of sc.narration.filter((x) => !x.shot_id)) addNarration(n);
        for (const { shot, characters, dialogue, sfx } of sc.shots) {
          const copy = this.s.stories.createShot(scene.id, {
            title: shot.title,
            action: shot.action,
            emotion: shot.emotion,
            framing: shot.framing,
            camera_angle: shot.camera_angle,
            camera_movement: shot.camera_movement,
            lighting: shot.lighting,
            location_id: shot.location_id ?? undefined,
            style_id: shot.style_id ?? undefined,
            duration_sec: shot.duration_sec,
            fps: shot.fps,
            generation_mode: shot.generation_mode,
            mouth_visible: !!shot.mouth_visible,
            // Lip sync is language-specific: the shared master uses general talking animation.
            lipsync_enabled: false,
            music_notes: shot.music_notes,
            ambience_notes: shot.ambience_notes,
          });
          this.s.stories.setShotCharacters(
            copy.id,
            characters.map((c) => ({ character_id: c.character_id, variant_id: c.variant_id })),
          );
          if (shot.approved_image_asset_id && shot.approved_video_asset_id)
            this.s.stories.setShotState(copy.id, {
              approved_image_asset_id: shot.approved_image_asset_id,
              approved_video_asset_id: shot.approved_video_asset_id,
              approval_state: 'approved',
            });
          for (const d of dialogue) {
            const t = loc(d);
            if (d.character_id && !overrides[d.character_id])
              overrides[d.character_id] = this.hinglishVoice(d.character_id, projectId);
            const line = this.s.stories.addDialogue(copy.id, {
              character_id: d.character_id ?? undefined,
              text: t.text,
              emotion: d.emotion,
              delivery: d.delivery,
              speed: d.speed,
              language,
              required: !!d.required,
            });
            this.s.db.run('UPDATE dialogue_lines SET speech_text = ? WHERE id = ?', t.speech, line.id);
          }
          for (const n of sc.narration.filter((x) => x.shot_id === shot.id)) addNarration(n, copy.id);
          for (const cue of sfx)
            this.s.stories.addShotSfx(copy.id, cue.tag, {
              offsetSec: cue.offset_sec,
              required: !!cue.required,
              source: cue.source,
              approved: !!cue.approved,
            });
        }
      }
      this.s.db.run(
        'UPDATE stories SET voice_overrides_json = ? WHERE id = ?',
        JSON.stringify(overrides),
        story.id,
      );
      return story.id;
    });
  }

  /**
   * Timing: a localized line should fit the time its English line had in the SAME shots.
   * Returns the lines (localized line ids) that take clearly longer than the English original.
   */
  overruns(
    sourceStoryId: string,
    localizedStoryId: string,
    tolerance = 1.15,
  ): Array<{ id: string; sourceId: string; english: number; localized: number }> {
    const src = this.lines(sourceStoryId);
    const loc = this.lines(localizedStoryId);
    const out: ReturnType<LocalizationService['overruns']> = [];
    src.forEach((a, i) => {
      const b = loc[i];
      if (!b || !a.line.audio_asset_id || !b.line.audio_asset_id) return;
      if (b.seconds > a.seconds * tolerance + 0.3)
        out.push({ id: b.id, sourceId: a.id, english: a.seconds, localized: b.seconds });
    });
    return out;
  }

  /** Replace a localized line's words (clears its audio so it is spoken again). */
  setLine(id: string, kind: 'dialogue' | 'narration', t: LocalizedText, speed?: number): void {
    const table = kind === 'dialogue' ? 'dialogue_lines' : 'narration_lines';
    this.s.db.run(
      `UPDATE ${table} SET text = ?, speech_text = ?, audio_asset_id = NULL${speed ? ', speed = ?' : ''} WHERE id = ?`,
      t.text,
      t.speech,
      ...(speed ? [speed] : []),
      id,
    );
  }
}

export function errorMessage(err: unknown): string {
  return toAppError(err).message;
}
