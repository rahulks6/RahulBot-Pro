import type { StudioCore } from '../app/studio.ts';
import type { StoryTree } from '../repositories/stories.ts';

/**
 * Shorts are coherent mini-episodes, not random crops: each one is a run of consecutive shots
 * (whole scenes where they fit) that tells a small moment with a hook, 15–58 seconds long.
 * Each chosen run is copied into its own VERTICAL story — same characters, same lines — so every
 * shot is drawn again natively in 9:16 with the same approved character references.
 */
export interface ShortPlan {
  title: string;
  hook: string;
  sceneIds: string[];
  shotIds: string[];
  seconds: number;
  score: number;
}

export const SHORT_MAX_SEC = 58;
export const SHORT_MIN_SEC = 15;

interface Unit {
  sceneId: string;
  shotIds: string[];
  seconds: number;
  score: number;
  hook: string;
  sceneTitle: string;
}

/** Candidate runs: whole scenes, and scenes that are too long split into consecutive chunks. */
function units(tree: StoryTree): Unit[] {
  const out: Unit[] = [];
  for (const sc of tree.scenes) {
    let chunk: Unit | null = null;
    for (const { shot, dialogue, characters } of sc.shots) {
      const lines = dialogue.length + sc.narration.filter((n) => n.shot_id === shot.id).length;
      const firstLine =
        dialogue[0]?.text ?? sc.narration.find((n) => n.shot_id === shot.id)?.text ?? sc.scene.summary ?? '';
      if (!chunk || chunk.seconds + shot.duration_sec > SHORT_MAX_SEC) {
        if (chunk) out.push(chunk);
        chunk = {
          sceneId: sc.scene.id,
          shotIds: [],
          seconds: 0,
          score: 0,
          hook: firstLine,
          sceneTitle: sc.scene.title,
        };
      }
      chunk.shotIds.push(shot.id);
      chunk.seconds += shot.duration_sec;
      // Speech and characters make a Short watchable on its own; energy helps the hook.
      chunk.score +=
        2 * dialogue.length +
        lines +
        characters.length +
        (/adventure|excit|high/i.test(`${sc.scene.music_mood} ${sc.scene.music_energy}`) ? 1 : 0);
      if (!chunk.hook) chunk.hook = firstLine;
    }
    if (chunk) out.push(chunk);
  }
  return out;
}

export function planShorts(tree: StoryTree, count: number): ShortPlan[] {
  const us = units(tree);
  // Windows of consecutive units (story order), within the Shorts length.
  const windows: Array<{ from: number; to: number; seconds: number; score: number }> = [];
  for (let i = 0; i < us.length; i++) {
    let seconds = 0;
    let score = 0;
    for (let j = i; j < us.length; j++) {
      seconds += us[j]!.seconds;
      score += us[j]!.score;
      if (seconds > SHORT_MAX_SEC) break;
      // Prefer about 30–50 s: long enough to tell something, short enough to keep.
      const fit = seconds >= SHORT_MIN_SEC ? 1 - Math.abs(40 - seconds) / 60 : seconds / SHORT_MIN_SEC - 1;
      windows.push({ from: i, to: j, seconds, score: score / Math.max(1, j - i + 1) + 4 * fit });
    }
  }
  windows.sort((a, b) => b.score - a.score || a.from - b.from);
  const taken = new Set<number>();
  const picked: typeof windows = [];
  for (const w of windows) {
    if (picked.length >= count) break;
    let free = true;
    for (let k = w.from; k <= w.to; k++) if (taken.has(k)) free = false;
    if (!free) continue;
    for (let k = w.from; k <= w.to; k++) taken.add(k);
    picked.push(w);
  }
  picked.sort((a, b) => a.from - b.from);
  return picked.map((w, i) => {
    const part = us.slice(w.from, w.to + 1);
    const hook = part.map((u) => u.hook).find((h) => h.trim()) ?? tree.story.title;
    return {
      title: `${tree.story.title}${picked.length > 1 ? ` (${i + 1})` : ''}`,
      hook: hook.slice(0, 140),
      sceneIds: [...new Set(part.map((u) => u.sceneId))],
      shotIds: part.flatMap((u) => u.shotIds),
      seconds: Math.round(w.seconds * 10) / 10,
      score: Math.round(w.score * 100) / 100,
    };
  });
}

/**
 * Copies the chosen shots (with their characters, lines and sound cues) into a new vertical story
 * in the same project. Prompts the person wrote by hand are kept; generated ones are rebuilt for 9:16.
 */
export function createShortStory(
  s: Pick<StudioCore, 'db' | 'stories'>,
  sourceStoryId: string,
  plan: ShortPlan,
  title: string,
): string {
  const src = s.stories.tree(sourceStoryId);
  const wanted = new Set(plan.shotIds);
  return s.db.transaction(() => {
    const story = s.stories.create(src.story.project_id, {
      title: title.slice(0, 300),
      synopsis: plan.hook,
      moral: src.story.moral,
      language: src.story.language,
      target_duration_sec: Math.max(5, Math.round(plan.seconds)),
      production_notes: `Short made from "${src.story.title}" (${sourceStoryId}), drawn again in 9:16.`,
    });
    s.db.run("UPDATE stories SET format = 'vertical' WHERE id = ?", story.id);
    for (const sc of src.scenes) {
      const shots = sc.shots.filter((x) => wanted.has(x.shot.id));
      if (!shots.length) continue;
      const scene = s.stories.createScene(story.id, {
        title: sc.scene.title,
        summary: sc.scene.summary,
        location_id: sc.scene.location_id ?? undefined,
        time_of_day: sc.scene.time_of_day,
        music_mood: sc.scene.music_mood,
        music_genre: sc.scene.music_genre,
        music_energy: sc.scene.music_energy,
        ambience: sc.scene.ambience,
      });
      // Scene-level narration (not tied to a shot) opens the scene only when its first shot is kept.
      if (shots[0]!.shot.id === sc.shots[0]!.shot.id)
        for (const n of sc.narration.filter((x) => !x.shot_id))
          s.stories.addNarration(scene.id, {
            text: n.text,
            emotion: n.emotion,
            speed: n.speed,
            language: n.language,
            required: !!n.required,
          });
      for (const { shot, characters, dialogue, sfx } of shots) {
        const copy = s.stories.createShot(scene.id, {
          title: shot.title,
          action: shot.action,
          emotion: shot.emotion,
          framing: shot.framing,
          camera_angle: shot.camera_angle,
          camera_movement: shot.camera_movement,
          lighting: shot.lighting,
          location_id: shot.location_id ?? undefined,
          style_id: shot.style_id ?? undefined,
          ...(shot.image_prompt_locked ? { image_prompt: shot.image_prompt, image_prompt_locked: true } : {}),
          ...(shot.motion_prompt_locked
            ? { motion_prompt: shot.motion_prompt, motion_prompt_locked: true }
            : {}),
          ...(shot.negative_prompt_locked
            ? { negative_prompt: shot.negative_prompt, negative_prompt_locked: true }
            : {}),
          duration_sec: shot.duration_sec,
          fps: shot.fps,
          generation_mode: shot.generation_mode,
          mouth_visible: !!shot.mouth_visible,
          lipsync_enabled: !!shot.lipsync_enabled,
          music_notes: shot.music_notes,
          ambience_notes: shot.ambience_notes,
        });
        s.stories.setShotCharacters(
          copy.id,
          characters.map((c) => ({ character_id: c.character_id, variant_id: c.variant_id })),
        );
        for (const d of dialogue)
          s.stories.addDialogue(copy.id, {
            character_id: d.character_id ?? undefined,
            text: d.text,
            emotion: d.emotion,
            delivery: d.delivery,
            speed: d.speed,
            language: d.language,
            required: !!d.required,
          });
        for (const n of sc.narration.filter((x) => x.shot_id === shot.id))
          s.stories.addNarration(scene.id, {
            shot_id: copy.id,
            text: n.text,
            emotion: n.emotion,
            speed: n.speed,
            language: n.language,
            required: !!n.required,
          });
        for (const cue of sfx)
          s.stories.addShotSfx(copy.id, cue.tag, {
            offsetSec: cue.offset_sec,
            required: !!cue.required,
            source: cue.source,
            approved: !!cue.approved,
          });
      }
    }
    return story.id;
  });
}
