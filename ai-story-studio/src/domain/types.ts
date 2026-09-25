// Row types for the SQLite schema (migrations/0001_initial_schema.sql).
// Entities use the column names directly; booleans are 0/1 integers.
import type {
  Approval,
  AspectRatio,
  AssetKind,
  AudioLayer,
  ExportFormat,
  GpuStatus,
  JobKind,
  JobStatus,
  QualityMode,
  QualityReportKind,
  ReferenceSlotType,
  ShotApprovalState,
  StoryStatus,
  Track,
  Transition,
  UsageCategory,
  VoicePresentation,
} from './enums.ts';

export type Flag = 0 | 1;

export interface Timestamps {
  created_at: string;
  updated_at: string;
}

export interface Lockable {
  locked: Flag;
  locked_at: string | null;
  lock_snapshot_json: string | null;
}

export interface Project extends Timestamps {
  id: string;
  name: string;
  series: string;
  description: string;
  genre: string;
  target_audience: string;
  default_style_id: string | null;
  width: number;
  height: number;
  aspect_ratio: AspectRatio;
  fps: number;
  default_quality: QualityMode;
  narrator_voice_id: string | null;
  production_notes: string;
}

export interface StylePreset extends Timestamps {
  id: string;
  project_id: string | null;
  name: string;
  style_prompt: string;
  rendering: string;
  lighting: string;
  colors: string;
  camera: string;
  negative_prompt: string;
}

export interface VoiceProfile extends Timestamps, Lockable {
  id: string;
  project_id: string;
  name: string;
  role: 'character' | 'narrator';
  voice_model: string;
  voice_identity: string;
  reference_asset_id: string | null;
  language: string;
  presentation: VoicePresentation;
  pitch: number;
  speed: number;
  speaking_style: string;
  narration_style: string;
  default_emotion: string;
  settings_json: string;
}

export interface ReferenceAsset {
  id: string;
  project_id: string;
  owner_type: 'character' | 'location' | 'prop' | 'style' | 'voice' | 'project';
  owner_id: string;
  label: string;
  storage_key: string;
  mime: string;
  approved: Flag;
  is_mock: Flag;
  created_at: string;
}

export interface Character extends Timestamps, Lockable {
  id: string;
  project_id: string;
  name: string;
  species: string;
  age: string;
  role: string;
  personality: string;
  appearance: string;
  face: string;
  hair: string;
  eyes: string;
  body: string;
  proportions: string;
  clothing: string;
  accessories: string;
  colors: string;
  prompt: string;
  negative_prompt: string;
  voice_profile_id: string | null;
  preferred_seeds_json: string;
  generation_settings_json: string;
}

export interface CharacterVariant extends Timestamps {
  id: string;
  character_id: string;
  name: string;
  description: string;
  clothing_override: string;
  prompt_additions: string;
  negative_additions: string;
}

export interface CharacterReference {
  id: string;
  character_id: string;
  variant_id: string | null;
  slot_type: ReferenceSlotType;
  slot: string;
  reference_asset_id: string;
  approved: Flag;
  created_at: string;
}

export interface Location extends Timestamps, Lockable {
  id: string;
  project_id: string;
  name: string;
  description: string;
  environment: string;
  architecture: string;
  important_objects: string;
  colors: string;
  lighting: string;
  weather: string;
  time_of_day: string;
  prompt: string;
  negative_prompt: string;
}

export interface Prop extends Timestamps, Lockable {
  id: string;
  project_id: string;
  name: string;
  description: string;
  scale: string;
  colors: string;
  prompt: string;
  negative_prompt: string;
}

export interface Story extends Timestamps {
  id: string;
  project_id: string;
  title: string;
  episode_number: number | null;
  synopsis: string;
  story_text: string;
  moral: string;
  language: string;
  target_duration_sec: number;
  status: StoryStatus;
  production_notes: string;
}

export interface Scene extends Timestamps {
  id: string;
  story_id: string;
  position: number;
  title: string;
  summary: string;
  location_id: string | null;
  time_of_day: string;
  music_mood: string;
  music_genre: string;
  music_energy: '' | 'low' | 'medium' | 'high';
  ambience: string;
  notes: string;
}

export interface Shot extends Timestamps {
  id: string;
  scene_id: string;
  position: number;
  title: string;
  action: string;
  emotion: string;
  framing: string;
  camera_angle: string;
  camera_movement: string;
  lighting: string;
  location_id: string | null;
  style_id: string | null;
  image_prompt: string;
  image_prompt_locked: Flag;
  motion_prompt: string;
  motion_prompt_locked: Flag;
  negative_prompt: string;
  negative_prompt_locked: Flag;
  duration_sec: number;
  fps: number;
  seed: number | null;
  generation_mode: QualityMode;
  mouth_visible: Flag;
  lipsync_enabled: Flag;
  music_notes: string;
  ambience_notes: string;
  approval_state: ShotApprovalState;
  approved_image_asset_id: string | null;
  approved_video_asset_id: string | null;
  lipsync_video_asset_id: string | null;
}

export interface ShotCharacter {
  shot_id: string;
  character_id: string;
  variant_id: string | null;
  position: number;
}

export interface ShotSfx {
  id: string;
  shot_id: string;
  tag: string;
  offset_sec: number;
  required: Flag;
  source: 'manual' | 'suggested' | 'package';
  approved: Flag;
  created_at: string;
}

export interface DialogueLine extends Timestamps {
  id: string;
  shot_id: string;
  position: number;
  character_id: string | null;
  text: string;
  emotion: string;
  delivery: string;
  speed: number;
  language: string;
  required: Flag;
  audio_asset_id: string | null;
}

export interface NarrationLine extends Timestamps {
  id: string;
  scene_id: string;
  shot_id: string | null;
  position: number;
  text: string;
  emotion: string;
  speed: number;
  language: string;
  required: Flag;
  audio_asset_id: string | null;
}

export interface GeneratedAsset {
  id: string;
  project_id: string;
  kind: AssetKind;
  storage_key: string;
  mime: string;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  fps: number | null;
  source_asset_id: string | null;
  is_native_resolution: Flag;
  is_mock: Flag;
  checksum: string;
  size_bytes: number;
  approval: Approval;
  reusable: Flag;
  continuity_tag: string;
  tags: string;
  label: string;
  created_at: string;
}

export interface AudioAsset {
  id: string;
  project_id: string;
  generated_asset_id: string;
  layer: AudioLayer;
  cache_key: string;
  voice_profile_id: string | null;
  character_id: string | null;
  language: string;
  text: string;
  emotion: string;
  speed: number;
  mood: string;
  genre: string;
  energy: string;
  sfx_tag: string;
  loopable: Flag;
  duration_sec: number;
  provider: string;
  model: string;
  /** Set when the line was synthesised from a consented reference recording. */
  voice_consent_id?: string | null;
  created_at: string;
}

export interface VoiceConsent {
  id: string;
  project_id: string;
  voice_profile_id: string;
  reference_asset_id: string;
  speaker_name: string;
  relationship: 'self' | 'consenting_person';
  method: 'self' | 'written' | 'recorded_statement' | 'contract';
  scope: string;
  evidence: string;
  created_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface GpuInstance {
  id: string;
  provider: string;
  provider_instance_id: string;
  tag: string;
  gpu_model: string;
  vram_gb: number;
  hourly_rate_inr: number;
  status: GpuStatus;
  idle_timeout_sec: number;
  max_lifetime_sec: number;
  is_mock: Flag;
  created_at: string;
  ready_at: string | null;
  last_activity_at: string;
  terminated_at: string | null;
  termination_reason: string | null;
}

export interface GpuEvent {
  id: string;
  gpu_instance_id: string | null;
  provider: string;
  event: string;
  detail: string;
  is_mock: Flag;
  created_at: string;
}

export interface GenerationJob {
  id: string;
  project_id: string;
  story_id: string | null;
  shot_id: string | null;
  kind: JobKind;
  target_type: string;
  target_id: string;
  status: JobStatus;
  mode: QualityMode;
  batch_id: string | null;
  params_json: string;
  attempt_count: number;
  max_attempts: number;
  log_json: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface GenerationAttempt {
  id: string;
  job_id: string;
  project_id: string;
  shot_id: string | null;
  kind: JobKind;
  attempt_number: number;
  prompt: string;
  negative_prompt: string;
  model: string;
  model_version: string;
  seed: number | null;
  references_json: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  duration_sec: number | null;
  settings_json: string;
  provider: string;
  gpu_model: string | null;
  gpu_instance_id: string | null;
  started_at: string;
  finished_at: string | null;
  generation_seconds: number;
  gpu_seconds: number;
  estimated_cost_inr: number;
  status: 'succeeded' | 'failed' | 'cancelled';
  error_code: string | null;
  error_message: string | null;
  output_asset_id: string | null;
  approval: Approval;
  is_mock: Flag;
  created_at: string;
}

export interface UsageRecord {
  id: string;
  gpu_instance_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  project_id: string | null;
  story_id: string | null;
  shot_id: string | null;
  category: UsageCategory;
  seconds: number;
  hourly_rate_inr: number;
  cost_inr: number;
  provider: string;
  gpu_model: string;
  model: string;
  is_mock: Flag;
  recorded_at: string;
}

export interface Timeline extends Timestamps {
  id: string;
  story_id: string;
  fps: number;
}

export interface TimelineItem extends Timestamps {
  id: string;
  timeline_id: string;
  track: Track;
  position: number;
  asset_id: string | null;
  source_type: string;
  source_id: string;
  label: string;
  start_sec: number;
  duration_sec: number;
  trim_in_sec: number;
  volume_db: number;
  fade_in_sec: number;
  fade_out_sec: number;
  transition: Transition;
  loop: Flag;
  manual: Flag;
}

export interface ExportRecord {
  id: string;
  story_id: string;
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  status: 'pending' | 'building' | 'validating' | 'complete' | 'failed';
  master_asset_id: string | null;
  mix_asset_id: string | null;
  duration_sec: number | null;
  is_mock: Flag;
  steps_json: string;
  validation_json: string;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export type Severity = 'info' | 'warn' | 'fail';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  /** Optional reference to the entity concerned (scene/shot/line id). */
  ref?: string;
}

export interface QualityReport {
  id: string;
  story_id: string;
  export_id: string | null;
  kind: QualityReportKind;
  status: 'pass' | 'warn' | 'fail';
  findings_json: string;
  created_at: string;
}

export interface SimilarityReport {
  id: string;
  story_id: string;
  compared_story_id: string;
  story_similarity: number;
  dialogue_similarity: number;
  narration_similarity: number;
  shot_plan_similarity: number;
  prompt_similarity: number;
  asset_reuse: number;
  repeated_clips: number;
  repeated_audio: number;
  title_duplicate: Flag;
  findings_json: string;
  created_at: string;
}

export interface ReviewChecklistItem {
  id: string;
  story_id: string;
  item_key: string;
  checked: Flag;
  note: string;
  checked_at: string | null;
}

export interface StoryPackageImport {
  id: string;
  project_id: string | null;
  story_id: string | null;
  status: 'imported' | 'failed';
  package_hash: string;
  errors_json: string;
  summary_json: string;
  created_at: string;
}
