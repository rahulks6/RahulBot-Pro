import type { Finding, GeneratedAsset, Project, Shot, TimelineItem } from '../../domain/types.ts';
import type { ProbeResult } from '../../providers/types.ts';
import type { StoryTree } from '../../repositories/stories.ts';
import type { MixResult } from '../mixer.ts';
import type { QualitySettings } from '../settings.ts';

/**
 * Rule-based production checks. They produce explainable findings:
 *   fail — must be fixed before an export can be marked complete,
 *   warn — worth a human look (creative choices are not blocked),
 *   info — context.
 * Automated checks cannot judge animation quality; human review is required.
 */

const PLACEHOLDER =
  /\b(todo|tbd|fixme|lorem ipsum|placeholder|xxx+|insert (name|text) here)\b|\{\{[^}]*\}\}|\[[A-Z _]{3,}\]/i;

export function findPlaceholder(text: string): string | undefined {
  const m = PLACEHOLDER.exec(text);
  return m ? m[0] : undefined;
}

function f(code: string, severity: Finding['severity'], message: string, ref?: string): Finding {
  return ref ? { code, severity, message, ref } : { code, severity, message };
}

// ---------------------------------------------------------------------------
// Story quality (spec §56)
// ---------------------------------------------------------------------------

export function checkStory(tree: StoryTree, estimatedDurationSec: number, q: QualitySettings): Finding[] {
  const out: Finding[] = [];
  const { story, scenes } = tree;
  if (scenes.length === 0) {
    out.push(f('no_scenes', 'fail', 'The episode has no scenes.'));
    return out;
  }
  scenes.forEach((s, i) => {
    if (s.scene.position !== i)
      out.push(
        f(
          'scene_order',
          'fail',
          `Scene "${s.scene.title}" has position ${s.scene.position}, expected ${i}.`,
          s.scene.id,
        ),
      );
    if (s.shots.length === 0)
      out.push(f('missing_shot', 'fail', `Scene "${s.scene.title}" has no shots.`, s.scene.id));
    s.shots.forEach((sh, j) => {
      if (sh.shot.position !== j)
        out.push(f('shot_order', 'fail', `Shot ${j + 1} in "${s.scene.title}" is out of order.`, sh.shot.id));
    });
  });

  const firstScene = scenes[0]!;
  const opening = [
    story.synopsis,
    story.story_text,
    firstScene.scene.summary,
    ...firstScene.narration.map((n) => n.text),
  ]
    .join(' ')
    .trim();
  if (!opening)
    out.push(
      f(
        'no_context',
        'warn',
        'No beginning/context found (synopsis, story text, first scene summary or narration).',
      ),
    );

  const allText = [
    story.synopsis,
    story.story_text,
    ...scenes.flatMap((s) => [s.scene.summary, ...s.narration.map((n) => n.text)]),
  ]
    .join(' ')
    .toLowerCase();
  if (
    !/\b(want|wants|need|needs|must|lost|problem|help|find|wish|try|tries|can't|cannot|goal|hope|search|decide|afraid)\b/.test(
      allText,
    )
  ) {
    out.push(
      f(
        'no_goal',
        'info',
        'No obvious character goal or problem was detected. That can be fine for some formats (e.g. bedtime mood pieces).',
      ),
    );
  }
  const last = scenes[scenes.length - 1]!;
  if (!last.scene.summary.trim() && last.narration.length === 0 && !story.moral.trim()) {
    out.push(
      f(
        'no_ending',
        'warn',
        'The final scene has no summary or narration and there is no moral; check the ending/resolution.',
        last.scene.id,
      ),
    );
  }

  const fields: Array<[string, string, string]> = [
    ['story title', story.title, story.id],
    ['synopsis', story.synopsis, story.id],
    ['story text', story.story_text, story.id],
  ];
  for (const s of scenes) {
    fields.push([`scene "${s.scene.title}" summary`, s.scene.summary, s.scene.id]);
    for (const n of s.narration) fields.push(['narration', n.text, n.id]);
    for (const sh of s.shots) {
      fields.push([`shot "${sh.shot.title}" action`, sh.shot.action, sh.shot.id]);
      fields.push([`shot "${sh.shot.title}" image prompt`, sh.shot.image_prompt, sh.shot.id]);
      fields.push([`shot "${sh.shot.title}" motion prompt`, sh.shot.motion_prompt, sh.shot.id]);
      for (const d of sh.dialogue) fields.push(['dialogue', d.text, d.id]);
    }
  }
  for (const [where, text, ref] of fields) {
    const p = findPlaceholder(text ?? '');
    if (p) out.push(f('placeholder', 'fail', `Placeholder text "${p}" remains in ${where}.`, ref));
  }

  for (const s of scenes) {
    for (const sh of s.shots) {
      if (!sh.shot.action.trim() && !sh.shot.image_prompt.trim()) {
        out.push(
          f(
            'unfinished_prompt',
            'warn',
            `Shot "${sh.shot.title || sh.shot.id}" has neither an action nor an image prompt.`,
            sh.shot.id,
          ),
        );
      }
      if (
        /(\.\.\.|…)\s*$/.test(sh.shot.image_prompt.trim()) ||
        /(\.\.\.|…)\s*$/.test(sh.shot.motion_prompt.trim())
      ) {
        out.push(
          f(
            'unfinished_prompt',
            'warn',
            `A prompt in shot "${sh.shot.title || sh.shot.id}" ends with an ellipsis; it may be unfinished.`,
            sh.shot.id,
          ),
        );
      }
      for (const d of sh.dialogue) {
        if (d.required && !d.character_id)
          out.push(
            f(
              'dialogue_speaker',
              'fail',
              `Dialogue "${d.text.slice(0, 40)}" has no speaking character.`,
              d.id,
            ),
          );
      }
    }
  }

  const lines = scenes.flatMap((s) => [
    ...s.narration.map((n) => ({ kind: 'narration', id: n.id, text: n.text })),
    ...s.shots.flatMap((sh) => sh.dialogue.map((d) => ({ kind: 'dialogue', id: d.id, text: d.text }))),
  ]);
  const seen = new Map<string, string>();
  for (const l of lines) {
    const key = `${l.kind}:${l.text.trim().toLowerCase()}`;
    if (l.text.trim().split(/\s+/).length >= 4 && seen.has(key)) {
      out.push(
        f(
          'duplicate_line',
          'warn',
          `The ${l.kind} line "${l.text.slice(0, 60)}" appears more than once.`,
          l.id,
        ),
      );
    }
    seen.set(key, l.id);
  }

  const target = story.target_duration_sec;
  if (target > 0 && estimatedDurationSec > 0) {
    const diff = Math.abs(estimatedDurationSec - target) / target;
    if (diff * 100 > q.durationTolerancePercent) {
      out.push(
        f(
          'duration',
          'warn',
          `Planned duration ≈ ${Math.round(estimatedDurationSec)}s differs from the ${target}s target by ${Math.round(diff * 100)}%.`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Visual (spec §58)
// ---------------------------------------------------------------------------

export interface VisualInput {
  project: Project;
  tree: StoryTree;
  timelineVideo: TimelineItem[];
  assets: Map<string, GeneratedAsset>;
  approvedRefCount: Map<string, number>;
  lockedCharacters: Set<string>;
  characterNames: Map<string, string>;
}

export function checkVisual(v: VisualInput, q: QualitySettings): Finding[] {
  const out: Finding[] = [];
  const shots: Shot[] = v.tree.scenes.flatMap((s) => s.shots.map((x) => x.shot));
  const wantAspect = v.project.width / v.project.height;
  let prev: { video: string | null; image: string | null } | undefined;
  for (const shot of shots) {
    const label = shot.title || shot.id;
    if (!shot.approved_video_asset_id)
      out.push(f('missing_clip', 'fail', `Shot "${label}" has no approved clip.`, shot.id));
    const clipId = shot.lipsync_video_asset_id ?? shot.approved_video_asset_id;
    const clip = clipId ? v.assets.get(clipId) : undefined;
    if (clip) {
      if (clip.approval === 'rejected')
        out.push(f('rejected_asset', 'fail', `Shot "${label}" uses a rejected clip.`, shot.id));
      if (clip.width && clip.height && Math.abs(clip.width / clip.height - wantAspect) > 0.01) {
        out.push(
          f(
            'aspect_ratio',
            'fail',
            `Shot "${label}" clip is ${clip.width}×${clip.height}, not ${v.project.aspect_ratio}.`,
            shot.id,
          ),
        );
      } else if (clip.width && clip.width !== v.project.width) {
        out.push(
          f(
            'resolution',
            'warn',
            `Shot "${label}" clip is ${clip.width}×${clip.height}; the master will be scaled to ${v.project.width}×${v.project.height}.`,
            shot.id,
          ),
        );
      }
      if (!clip.is_native_resolution)
        out.push(f('upscaled', 'info', `Shot "${label}" clip is upscaled (not native resolution).`, shot.id));
    }
    if (shot.duration_sec < q.minClipSeconds) {
      out.push(
        f(
          'short_clip',
          'warn',
          `Shot "${label}" is only ${shot.duration_sec}s long; check it is not accidental.`,
          shot.id,
        ),
      );
    }
    const cur = { video: shot.approved_video_asset_id, image: shot.approved_image_asset_id };
    if (prev && ((cur.video && cur.video === prev.video) || (cur.image && cur.image === prev.image))) {
      out.push(
        f(
          'duplicate_consecutive',
          'warn',
          `Shot "${label}" repeats the previous shot's ${cur.video === prev.video ? 'clip' : 'image'}.`,
          shot.id,
        ),
      );
    }
    prev = cur;
  }
  for (const s of v.tree.scenes) {
    for (const sh of s.shots) {
      for (const c of sh.characters) {
        const name = v.characterNames.get(c.character_id) ?? c.character_id;
        if ((v.approvedRefCount.get(c.character_id) ?? 0) === 0) {
          out.push(
            f(
              'missing_reference',
              'warn',
              `${name} appears in "${sh.shot.title || sh.shot.id}" but has no approved reference images.`,
              sh.shot.id,
            ),
          );
        }
      }
    }
  }
  for (const id of new Set(
    v.tree.scenes.flatMap((s) => s.shots.flatMap((x) => x.characters.map((c) => c.character_id))),
  )) {
    if (!v.lockedCharacters.has(id))
      out.push(
        f(
          'character_unlocked',
          'info',
          `${v.characterNames.get(id) ?? id} is not locked; appearance may drift between shots.`,
        ),
      );
  }
  for (const item of v.timelineVideo) {
    const a = item.asset_id ? v.assets.get(item.asset_id) : undefined;
    if (!a)
      out.push(f('timeline_missing_clip', 'fail', `Timeline item "${item.label}" has no clip.`, item.id));
    else if (a.approval === 'rejected')
      out.push(
        f('timeline_rejected', 'fail', `Timeline item "${item.label}" uses a rejected asset.`, item.id),
      );
    else if (a.approval !== 'approved')
      out.push(
        f('timeline_unapproved', 'fail', `Timeline item "${item.label}" uses an unapproved asset.`, item.id),
      );
  }
  out.push(
    f(
      'black_frames',
      'info',
      'Black-frame detection needs decoded video (FFmpeg blackdetect, Phase 4); not available for mock clips.',
    ),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Audio (spec §57)
// ---------------------------------------------------------------------------

export interface AudioInput {
  tree: StoryTree;
  items: TimelineItem[];
  mix: MixResult | null;
  speechRmsDb: Map<string, number>;
  videoEndSec: number;
  narratorConfigured: boolean;
}

export function checkAudio(a: AudioInput, q: QualitySettings): Finding[] {
  const out: Finding[] = [];
  for (const s of a.tree.scenes) {
    for (const n of s.narration) {
      if (n.required && !n.audio_asset_id)
        out.push(f('missing_narration', 'fail', `Narration "${n.text.slice(0, 50)}" has no audio.`, n.id));
    }
    for (const sh of s.shots) {
      for (const d of sh.dialogue) {
        if (d.required && !d.audio_asset_id)
          out.push(f('missing_dialogue', 'fail', `Dialogue "${d.text.slice(0, 50)}" has no audio.`, d.id));
      }
      for (const cue of sh.sfx) {
        if (!cue.required) continue;
        const placed = a.items.some((i) => i.track === 'sfx' && i.source_id === cue.id && i.asset_id);
        if (!placed)
          out.push(
            f(
              'missing_sfx',
              'fail',
              `Required SFX "${cue.tag}" in "${sh.shot.title || sh.shot.id}" is missing.`,
              cue.id,
            ),
          );
      }
    }
  }
  if (!a.narratorConfigured && a.tree.scenes.some((s) => s.narration.length > 0)) {
    out.push(f('no_narrator', 'fail', 'The story has narration but the project has no narrator voice.'));
  }
  for (const item of a.items) {
    if ((item.track === 'dialogue' || item.track === 'narration') && item.asset_id) {
      const rms = a.speechRmsDb.get(item.asset_id);
      if (rms !== undefined && rms < -50)
        out.push(
          f(
            'silent_speech',
            'warn',
            `"${item.label}" is nearly silent (${rms.toFixed(1)} dBFS RMS).`,
            item.id,
          ),
        );
    }
  }
  const bySource = new Map<string, number>();
  for (const i of a.items.filter((x) => x.track === 'narration' || x.track === 'dialogue')) {
    const k = `${i.track}:${i.source_id}`;
    bySource.set(k, (bySource.get(k) ?? 0) + 1);
  }
  for (const [k, count] of bySource)
    if (count > 1)
      out.push(
        f(
          'duplicate_placement',
          'warn',
          `The same ${k.split(':')[0]} line is placed ${count} times.`,
          k.split(':')[1],
        ),
      );
  const speech = a.items.filter((x) => (x.track === 'narration' || x.track === 'dialogue') && x.asset_id);
  for (let i = 0; i < speech.length; i++) {
    for (let j = i + 1; j < speech.length; j++) {
      const x = speech[i]!;
      const y = speech[j]!;
      if (
        x.asset_id === y.asset_id &&
        x.start_sec < y.start_sec + y.duration_sec &&
        y.start_sec < x.start_sec + x.duration_sec
      ) {
        out.push(
          f(
            'overlapping_duplicate',
            'warn',
            `The same speech audio overlaps itself ("${x.label.slice(0, 40)}").`,
            y.id,
          ),
        );
      }
    }
  }
  const audioEnd = a.items
    .filter((i) => i.track !== 'video' && i.track !== 'title' && !i.loop)
    .reduce((m, i) => Math.max(m, i.start_sec + i.duration_sec), 0);
  if (a.videoEndSec > 0 && audioEnd > a.videoEndSec + 0.5) {
    out.push(
      f(
        'av_mismatch',
        'warn',
        `Audio runs until ${audioEnd.toFixed(1)}s but the video ends at ${a.videoEndSec.toFixed(1)}s.`,
      ),
    );
  }
  if (a.mix) {
    const m = a.mix;
    if (m.clippedSamples > 0)
      out.push(f('clipping', 'fail', `${m.clippedSamples} clipped samples in the mix.`));
    if (m.preLimiterPeakDb > 0)
      out.push(
        f(
          'peak_protection',
          'info',
          `Mix peaked at ${m.preLimiterPeakDb} dBFS before peak protection (${m.limiterGainDb} dB applied).`,
        ),
      );
    const d = m.layers.dialogue?.rmsDb;
    const n = m.layers.narration?.rmsDb;
    if (
      d !== undefined &&
      n !== undefined &&
      Number.isFinite(d) &&
      Number.isFinite(n) &&
      Math.abs(d - n) > q.maxLayerLevelDifferenceDb
    ) {
      out.push(
        f(
          'level_difference',
          'warn',
          `Dialogue (${d} dBFS) and narration (${n} dBFS) differ by more than ${q.maxLayerLevelDifferenceDb} dB.`,
        ),
      );
    }
    if (m.musicOverSpeechDb !== null && m.musicOverSpeechDb > -q.musicOverSpeechMarginDb) {
      out.push(
        f(
          'music_overpowering',
          'warn',
          `During speech, music is only ${(-m.musicOverSpeechDb).toFixed(1)} dB below the voices (want ≥ ${q.musicOverSpeechMarginDb} dB).`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export validation (spec §24, §52) — failed validation is never "complete"
// ---------------------------------------------------------------------------

export interface ExportExpectation {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  sceneIds: string[];
  scenesWithClips: Set<string>;
}

export function validateExport(
  p: ProbeResult,
  exp: ExportExpectation,
  requiredAudioFindings: Finding[],
): Finding[] {
  const out: Finding[] = [];
  if (!p.exists) return [f('file_missing', 'fail', 'Output file does not exist.')];
  if (!p.readable)
    out.push(f('unreadable', 'fail', `Probe could not read the output. ${p.notes.join('; ')}`));
  if (!p.video) out.push(f('no_video_stream', 'fail', 'No video stream.'));
  if (!p.audio) out.push(f('no_audio_stream', 'fail', 'No audio stream.'));
  if (p.video) {
    if (p.video.width !== exp.width || p.video.height !== exp.height) {
      out.push(
        f(
          'resolution',
          'fail',
          `Resolution ${p.video.width}×${p.video.height}, expected ${exp.width}×${exp.height}.`,
        ),
      );
    }
    if (!(p.video.fps > 0) || Math.abs(p.video.fps - exp.fps) > 0.01)
      out.push(f('frame_rate', 'fail', `Frame rate ${p.video.fps}, expected ${exp.fps}.`));
    if (p.video.codec && !['h264', 'avc1'].includes(p.video.codec))
      out.push(f('video_codec', 'fail', `Video codec ${p.video.codec}, expected H.264.`));
  }
  if (p.audio && p.audio.codec && p.audio.codec !== 'aac')
    out.push(f('audio_codec', 'fail', `Audio codec ${p.audio.codec}, expected AAC.`));
  const tol = Math.max(0.5, exp.durationSec * 0.02);
  if (Math.abs(p.durationSec - exp.durationSec) > tol) {
    out.push(
      f(
        'duration',
        'fail',
        `Duration ${p.durationSec.toFixed(2)}s, expected ≈ ${exp.durationSec.toFixed(2)}s.`,
      ),
    );
  }
  for (const id of exp.sceneIds)
    if (!exp.scenesWithClips.has(id))
      out.push(f('missing_scene', 'fail', 'A required scene has no footage in the export.', id));
  for (const r of requiredAudioFindings) {
    if (['missing_dialogue', 'missing_narration', 'missing_sfx', 'no_narrator'].includes(r.code))
      out.push({ ...r, severity: 'fail' });
  }
  if (p.audio && p.audio.clippedSamples > 0)
    out.push(f('clipping', 'fail', 'Audio clipping detected in the export.'));
  if (!p.decodes) out.push(f('decode', 'fail', `Output does not decode cleanly. ${p.notes.join('; ')}`));
  if (p.isMock)
    out.push(
      f(
        'mock_output',
        'info',
        'Mock export: a manifest + WAV mix stands in for the MP4 (no encoding in Phase 1).',
      ),
    );
  return out;
}
