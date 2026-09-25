import type { StudioCore } from '../app/studio.ts';
import type { AudioLayer } from '../domain/enums.ts';
import type {
  AudioAsset,
  DialogueLine,
  NarrationLine,
  Scene,
  ShotSfx,
  VoiceProfile,
} from '../domain/types.ts';
import { AppError } from '../lib/errors.ts';
import { hashObject } from '../lib/hash.ts';
import { parseJson } from '../lib/json.ts';
import { decodeWav, encodeWav, DEFAULT_SAMPLE_RATE } from '../media/wav.ts';
import type { ModelResult, ProviderInfo, RunContext, VoiceSettings } from '../providers/types.ts';
import type { VoiceReferenceService } from './voice-reference.ts';

export interface AudioOutcome {
  audio: AudioAsset;
  /** True when an identical, previously generated asset was reused (no generation). */
  reused: boolean;
  result?: ModelResult;
  provider: ProviderInfo;
  request: Record<string, unknown>;
}

/** Gap between consecutive speech lines inside a shot (seconds). */
export const SPEECH_GAP_SEC = 0.25;
/** Lead-in before the first speech line of a shot (seconds). */
export const SPEECH_LEAD_SEC = 0.3;

/**
 * AudioPipeline (spec §24–§32). Produces the five separately editable layers
 * — dialogue, narration, music, SFX, ambience — through replaceable provider
 * interfaces. Every request has a content-addressed cache key so identical
 * audio (same text, voice lock, emotion, speed, language / same mood and
 * duration) is reused instead of regenerated (spec §21).
 */
export class AudioPipeline {
  private readonly s: StudioCore;
  private readonly voiceRefs: VoiceReferenceService;

  constructor(core: StudioCore & { voiceRefs: VoiceReferenceService }) {
    this.s = core;
    this.voiceRefs = core.voiceRefs;
  }

  /** Voice settings from the profile; a locked voice always uses its frozen identity. */
  voiceSettings(v: VoiceProfile): VoiceSettings & { language: string; lockKey: Record<string, unknown> } {
    const snap = v.locked
      ? parseJson<{ fields?: Partial<VoiceProfile> } | undefined>(v.lock_snapshot_json, undefined)
      : undefined;
    const f = { ...v, ...(snap?.fields ?? {}) } as VoiceProfile;
    return {
      voiceModel: f.voice_model,
      voiceIdentity: f.voice_identity || f.id,
      presentation: f.presentation,
      pitch: f.pitch,
      speed: f.speed,
      speakingStyle: f.speaking_style || f.narration_style,
      language: f.language,
      lockKey: {
        voice: f.id,
        model: f.voice_model,
        identity: f.voice_identity || f.id,
        pitch: f.pitch,
        speed: f.speed,
        presentation: f.presentation,
        style: f.speaking_style,
        settings: f.settings_json,
        // A consented reference recording changes the voice; revoking it changes the key.
        reference: this.voiceRefs.active(v)?.id ?? null,
      },
    };
  }

  /** Voice settings plus the consented reference recording (sent to the TTS model only while consent is active). */
  async resolveVoice(
    v: VoiceProfile,
  ): Promise<ReturnType<AudioPipeline['voiceSettings']> & { consentId?: string }> {
    const vs = this.voiceSettings(v);
    const ref = await this.voiceRefs.referenceAudio(v);
    return ref ? { ...vs, referenceAudio: ref.data, consentId: ref.consent.id } : vs;
  }

  private async store(
    projectId: string,
    layer: AudioLayer,
    cacheKey: string,
    result: ModelResult,
    provider: ProviderInfo,
    meta: Partial<Omit<AudioAsset, 'id' | 'created_at'>>,
    label: string,
  ): Promise<AudioAsset> {
    const pcm = decodeWav(result.file.data);
    const durationSec = pcm.samples.length / pcm.sampleRate;
    const asset = await this.s.assets.create({
      projectId,
      kind: 'audio',
      data: result.file.data,
      ext: result.file.ext,
      mime: result.file.mime,
      durationSec,
      isMock: provider.isMock,
      label,
      tags: layer,
    });
    return this.s.assets.createAudio({
      project_id: projectId,
      generated_asset_id: asset.id,
      layer,
      cache_key: cacheKey,
      voice_profile_id: meta.voice_profile_id ?? null,
      character_id: meta.character_id ?? null,
      language: meta.language ?? '',
      text: meta.text ?? '',
      emotion: meta.emotion ?? '',
      speed: meta.speed ?? 1,
      mood: meta.mood ?? '',
      genre: meta.genre ?? '',
      energy: meta.energy ?? '',
      sfx_tag: meta.sfx_tag ?? '',
      loopable: meta.loopable ?? 0,
      duration_sec: durationSec,
      provider: provider.id,
      model: result.model,
      voice_consent_id: meta.voice_consent_id ?? null,
    });
  }

  private projectForScene(scene: Scene): string {
    return this.s.stories.projectIdForStory(scene.story_id);
  }

  /** Dialogue audio using the speaking character's Voice Lock. */
  async dialogue(line: DialogueLine, ctx: RunContext, opts: { force?: boolean } = {}): Promise<AudioOutcome> {
    if (!line.character_id)
      throw new AppError('PRECONDITION_FAILED', 'Dialogue line has no speaking character');
    const character = this.s.characters.get(line.character_id);
    if (!character.voice_profile_id) {
      throw new AppError('PRECONDITION_FAILED', `Character "${character.name}" has no voice profile`);
    }
    const voice = this.s.characters.getVoice(character.voice_profile_id);
    const projectId = character.project_id;
    const vs = await this.resolveVoice(voice);
    const provider = this.s.providers.tts;
    const request = {
      layer: 'dialogue',
      text: line.text,
      language: line.language,
      emotion: line.emotion,
      speed: line.speed,
    };
    const cacheKey = hashObject({
      p: provider.info.id,
      v: provider.info.modelVersion,
      ...request,
      voice: vs.lockKey,
    });
    const cached = opts.force ? undefined : this.s.assets.findAudioByCacheKey(projectId, cacheKey);
    if (cached) {
      this.s.stories.setDialogueAudio(line.id, cached.id);
      return { audio: cached, reused: true, provider: provider.info, request };
    }
    const result = await provider.synthesize(
      { text: line.text, language: line.language, emotion: line.emotion, speed: line.speed, voice: vs },
      ctx,
    );
    const audio = await this.store(
      projectId,
      'dialogue',
      cacheKey,
      result,
      provider.info,
      {
        voice_profile_id: voice.id,
        voice_consent_id: vs.consentId ?? null,
        character_id: character.id,
        language: line.language,
        text: line.text,
        emotion: line.emotion,
        speed: line.speed,
      },
      `${character.name}: ${line.text.slice(0, 60)}`,
    );
    this.s.stories.setDialogueAudio(line.id, audio.id);
    return { audio, reused: false, result, provider: provider.info, request };
  }

  /** Narration audio using the project's persistent narrator voice. */
  async narration(
    line: NarrationLine,
    ctx: RunContext,
    opts: { force?: boolean } = {},
  ): Promise<AudioOutcome> {
    const scene = this.s.stories.getScene(line.scene_id);
    const projectId = this.projectForScene(scene);
    const project = this.s.projects.get(projectId);
    if (!project.narrator_voice_id)
      throw new AppError('PRECONDITION_FAILED', 'Project has no narrator voice');
    const voice = this.s.characters.getVoice(project.narrator_voice_id);
    const vs = await this.resolveVoice(voice);
    const provider = this.s.providers.tts;
    const request = {
      layer: 'narration',
      text: line.text,
      language: line.language,
      emotion: line.emotion,
      speed: line.speed,
    };
    const cacheKey = hashObject({
      p: provider.info.id,
      v: provider.info.modelVersion,
      ...request,
      voice: vs.lockKey,
    });
    const cached = opts.force ? undefined : this.s.assets.findAudioByCacheKey(projectId, cacheKey);
    if (cached) {
      this.s.stories.setNarrationAudio(line.id, cached.id);
      return { audio: cached, reused: true, provider: provider.info, request };
    }
    const result = await provider.synthesize(
      { text: line.text, language: line.language, emotion: line.emotion, speed: line.speed, voice: vs },
      ctx,
    );
    const audio = await this.store(
      projectId,
      'narration',
      cacheKey,
      result,
      provider.info,
      {
        voice_profile_id: voice.id,
        voice_consent_id: vs.consentId ?? null,
        language: line.language,
        text: line.text,
        emotion: line.emotion,
        speed: line.speed,
      },
      `Narrator: ${line.text.slice(0, 60)}`,
    );
    this.s.stories.setNarrationAudio(line.id, audio.id);
    return { audio, reused: false, result, provider: provider.info, request };
  }

  private musicRequest(scene: Scene, durationSec: number) {
    const provider = this.s.providers.music;
    const request = {
      layer: 'music',
      mood: scene.music_mood || 'gentle',
      genre: scene.music_genre || 'orchestral',
      energy: scene.music_energy || 'medium',
      durationSec: Math.ceil(durationSec),
    };
    const cacheKey = hashObject({ p: provider.info.id, v: provider.info.modelVersion, ...request });
    return { provider, request, cacheKey, projectId: this.projectForScene(scene) };
  }

  private ambienceRequest(scene: Scene) {
    const provider = this.s.providers.sfx;
    // Ambience is generated as a short seamless loop and looped on the timeline.
    const request = {
      layer: 'ambience',
      tag: (scene.ambience || 'room tone').toLowerCase(),
      durationSec: 12,
      loopable: true,
    };
    const cacheKey = hashObject({ p: provider.info.id, v: provider.info.modelVersion, ...request });
    return { provider, request, cacheKey, projectId: this.projectForScene(scene) };
  }

  private sfxRequest(cue: ShotSfx) {
    const shot = this.s.stories.getShot(cue.shot_id);
    const provider = this.s.providers.sfx;
    const durationSec = Math.min(4, Math.max(1, shot.duration_sec - cue.offset_sec));
    const request = {
      layer: 'sfx',
      tag: cue.tag,
      durationSec: Math.round(durationSec * 2) / 2,
      loopable: false,
    };
    const cacheKey = hashObject({ p: provider.info.id, v: provider.info.modelVersion, ...request });
    return {
      provider,
      request,
      cacheKey,
      projectId: this.s.stories.projectIdForStory(this.s.stories.storyIdForShot(shot.id)),
    };
  }

  /** Scene music bed. Stored separately; never baked into video clips. */
  async music(
    scene: Scene,
    durationSec: number,
    ctx: RunContext,
    opts: { force?: boolean } = {},
  ): Promise<AudioOutcome> {
    const { provider, request, cacheKey, projectId } = this.musicRequest(scene, durationSec);
    const cached = opts.force ? undefined : this.s.assets.findAudioByCacheKey(projectId, cacheKey);
    if (cached) return { audio: cached, reused: true, provider: provider.info, request };
    const result = await provider.compose(
      {
        mood: request.mood,
        genre: request.genre,
        energy: request.energy,
        durationSec: request.durationSec,
        storyContext: scene.summary,
      },
      ctx,
    );
    const audio = await this.store(
      projectId,
      'music',
      cacheKey,
      result,
      provider.info,
      {
        mood: request.mood,
        genre: request.genre,
        energy: request.energy,
      },
      `Music: ${request.mood}`,
    );
    return { audio, reused: false, result, provider: provider.info, request };
  }

  /** Looping ambience bed for a scene. */
  async ambience(scene: Scene, ctx: RunContext, opts: { force?: boolean } = {}): Promise<AudioOutcome> {
    const { provider, request, cacheKey, projectId } = this.ambienceRequest(scene);
    const cached = opts.force ? undefined : this.s.assets.findAudioByCacheKey(projectId, cacheKey);
    if (cached) return { audio: cached, reused: true, provider: provider.info, request };
    const result = await provider.create(
      {
        tag: request.tag,
        durationSec: request.durationSec,
        loopable: true,
        description: `${request.tag} ambience`,
      },
      ctx,
    );
    const audio = await this.store(
      projectId,
      'ambience',
      cacheKey,
      result,
      provider.info,
      { sfx_tag: request.tag, loopable: 1 },
      `Ambience: ${request.tag}`,
    );
    return { audio, reused: false, result, provider: provider.info, request };
  }

  /** One-shot sound effect for a shot SFX cue. */
  async sfx(cue: ShotSfx, ctx: RunContext, opts: { force?: boolean } = {}): Promise<AudioOutcome> {
    const { provider, request, cacheKey, projectId } = this.sfxRequest(cue);
    const cached = opts.force ? undefined : this.s.assets.findAudioByCacheKey(projectId, cacheKey);
    if (cached) return { audio: cached, reused: true, provider: provider.info, request };
    const result = await provider.create(
      { tag: cue.tag, durationSec: request.durationSec, loopable: false, description: cue.tag },
      ctx,
    );
    const audio = await this.store(
      projectId,
      'sfx',
      cacheKey,
      result,
      provider.info,
      { sfx_tag: cue.tag },
      `SFX: ${cue.tag}`,
    );
    return { audio, reused: false, result, provider: provider.info, request };
  }

  /** Existing (non-rejected) audio matching the scene's current music / ambience settings. */
  findSceneAudio(
    scene: Scene,
    layer: 'music' | 'ambience',
    durationSec: number,
  ): (AudioAsset & { storage_key: string }) | undefined {
    const r = layer === 'music' ? this.musicRequest(scene, durationSec) : this.ambienceRequest(scene);
    return this.s.assets.findAudioByCacheKey(r.projectId, r.cacheKey);
  }

  findSfxAudio(cue: ShotSfx): (AudioAsset & { storage_key: string }) | undefined {
    const r = this.sfxRequest(cue);
    return this.s.assets.findAudioByCacheKey(r.projectId, r.cacheKey);
  }

  /** The shot's dialogue laid out as one track (same placement rules as the timeline) — lip-sync input. */
  async shotDialogueTrack(shotId: string): Promise<{ wav: Buffer; durationSec: number } | undefined> {
    const lines = this.s.stories.listDialogue(shotId).filter((l) => l.audio_asset_id);
    if (lines.length === 0) return undefined;
    const clips: Float32Array[] = [];
    for (const l of lines) {
      const audio = this.s.assets.getAudio(l.audio_asset_id!);
      clips.push(decodeWav(await this.s.assets.read(audio.generated_asset_id)).samples);
    }
    const sr = DEFAULT_SAMPLE_RATE;
    const total =
      Math.round(SPEECH_LEAD_SEC * sr) +
      clips.reduce((n, c) => n + c.length + Math.round(SPEECH_GAP_SEC * sr), 0);
    const out = new Float32Array(total);
    let pos = Math.round(SPEECH_LEAD_SEC * sr);
    for (const c of clips) {
      out.set(c, pos);
      pos += c.length + Math.round(SPEECH_GAP_SEC * sr);
    }
    return { wav: encodeWav({ sampleRate: sr, samples: out }), durationSec: total / sr };
  }
}
