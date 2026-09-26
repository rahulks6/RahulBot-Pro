// Central list of enumerations shared by the database, validation and UI.

export const QUALITY_MODES = ['fast_preview', 'optimized', 'high_quality'] as const;
export type QualityMode = (typeof QUALITY_MODES)[number];

export const ASPECT_RATIOS = ['16:9', '9:16'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const FPS_VALUES = [24, 30] as const;
export type Fps = (typeof FPS_VALUES)[number];

export const SHOT_APPROVAL_STATES = [
  'draft',
  'image_review',
  'image_approved',
  'video_review',
  'approved',
  'rejected',
] as const;
export type ShotApprovalState = (typeof SHOT_APPROVAL_STATES)[number];

export const APPROVALS = ['pending', 'approved', 'rejected'] as const;
export type Approval = (typeof APPROVALS)[number];

export const EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'excited',
  'afraid',
  'angry',
  'whispering',
  'tired',
  'surprised',
  'nervous',
  'calm',
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const REFERENCE_VIEWS = ['front', 'side', 'three_quarter', 'full_body', 'face_closeup'] as const;
export const REFERENCE_EXPRESSIONS = ['happy', 'sad', 'excited', 'surprised', 'afraid', 'angry'] as const;
export const REFERENCE_POSES = ['standing', 'walking', 'running', 'sitting'] as const;
export const REFERENCE_SLOT_TYPES = ['view', 'expression', 'pose', 'other'] as const;
export type ReferenceSlotType = (typeof REFERENCE_SLOT_TYPES)[number];

export const NARRATION_STYLES = [
  'warm storyteller',
  'energetic narrator',
  'calm bedtime narrator',
  'educational narrator',
] as const;

export const VOICE_PRESENTATIONS = ['male', 'female', 'neutral'] as const;
export type VoicePresentation = (typeof VOICE_PRESENTATIONS)[number];

export const AUDIO_LAYERS = ['dialogue', 'narration', 'music', 'sfx', 'ambience'] as const;
export type AudioLayer = (typeof AUDIO_LAYERS)[number];

export const TRACKS = ['video', 'dialogue', 'narration', 'sfx', 'ambience', 'music', 'title'] as const;
export type Track = (typeof TRACKS)[number];

export const TRANSITIONS = ['cut', 'crossfade', 'fade_black'] as const;
export type Transition = (typeof TRANSITIONS)[number];

export const JOB_KINDS = [
  'image',
  'video',
  'upscale',
  'tts',
  'music',
  'sfx',
  'ambience',
  'lipsync',
  'reference',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Queue statuses (spec §39). */
export const JOB_STATUSES = [
  'waiting',
  'provisioning_gpu',
  'starting_worker',
  'loading_model',
  'generating_image',
  'generating_video',
  'generating_audio',
  'upscaling',
  'lip_sync',
  'audio_processing',
  'encoding',
  'downloading',
  'complete',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(['complete', 'failed', 'cancelled']);

/** What the queue shows for a status (one plain stage name per step; details go next to it). */
export function jobStageLabel(status: JobStatus): string {
  switch (status) {
    case 'waiting':
      return 'QUEUED';
    case 'provisioning_gpu':
    case 'starting_worker':
      return 'STARTING';
    case 'loading_model':
      return 'LOADING MODEL';
    case 'upscaling':
      return 'UPSCALING';
    case 'encoding':
      return 'ENCODING';
    case 'downloading':
      return 'DOWNLOADING';
    case 'complete':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'GENERATING';
  }
}

export const ASSET_KINDS = [
  'image',
  'video',
  'audio',
  'upscaled_image',
  'upscaled_video',
  'lipsync_video',
  'mix',
  'master',
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const CONTINUITY_TAGS = [
  '',
  'intro',
  'outro',
  'theme',
  'catchphrase',
  'transition',
  'establishing',
] as const;
export type ContinuityTag = (typeof CONTINUITY_TAGS)[number];

export const EXPORT_FORMATS = ['landscape', 'vertical'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_PROFILES: Record<ExportFormat, { width: number; height: number; aspect: AspectRatio }> = {
  landscape: { width: 1920, height: 1080, aspect: '16:9' },
  vertical: { width: 1080, height: 1920, aspect: '9:16' },
};

export const GPU_STATUSES = ['provisioning', 'running', 'terminating', 'terminated', 'failed'] as const;

/** Cloud GPU lifecycle shown in the UI (Phase 5). */
export const CLOUD_STATES = [
  'DISABLED',
  'AUTHENTICATING',
  'PROVISIONING',
  'BOOTING',
  'WORKER_STARTING',
  'READY',
  'GENERATING',
  'DOWNLOADING',
  'IDLE',
  'STOPPING',
  'TERMINATING',
  'STOPPED',
  'FAILED',
] as const;
export type CloudLifecycleState = (typeof CLOUD_STATES)[number];
export type GpuStatus = (typeof GPU_STATUSES)[number];

export const USAGE_CATEGORIES = [
  'startup',
  'model_load',
  'generation',
  'upscale',
  'audio',
  'lipsync',
  'idle',
  'other',
] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

export const QUALITY_REPORT_KINDS = ['story', 'audio', 'visual', 'technical', 'youtube'] as const;
export type QualityReportKind = (typeof QUALITY_REPORT_KINDS)[number];

export const STORY_STATUSES = ['draft', 'in_production', 'review', 'complete'] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

/** Human review gate checklist (spec §60). */
export const REVIEW_CHECKLIST = [
  { key: 'story_reviewed', label: 'Story reviewed' },
  { key: 'character_consistency', label: 'Character consistency reviewed' },
  { key: 'animation_reviewed', label: 'Animation reviewed' },
  { key: 'dialogue_reviewed', label: 'Dialogue reviewed' },
  { key: 'narration_reviewed', label: 'Narration reviewed' },
  { key: 'music_sfx_reviewed', label: 'Music/SFX reviewed' },
  { key: 'no_duplicate_scenes', label: 'No accidental duplicate scenes' },
  { key: 'no_placeholders', label: 'No placeholder content' },
  { key: 'originality_reviewed', label: 'Originality report reviewed' },
  { key: 'final_video_watched', label: 'Final video watched' },
] as const;
