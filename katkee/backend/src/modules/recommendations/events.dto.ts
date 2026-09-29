import { ValidationError } from "../auth/dto";

export type EventType =
  | "creator_impression"
  | "story_impression"
  | "qualified_view"
  | "watch_duration"
  | "story_complete"
  | "story_next"
  | "story_previous"
  | "creator_sequence_started"
  | "creator_sequence_continued"
  | "creator_sequence_completed"
  | "creator_swipe_next"
  | "creator_swipe_previous"
  | "quick_creator_skip"
  | "story_replay"
  | "comment_open"
  | "profile_visit"
  | "follow_after_story"
  | "repeat_creator_visit"
  | "not_interested";

/** Which of creator_id/story_id each event type needs — enforced so a client can't send a meaningless half-formed event. */
const REQUIRES_STORY_ID: ReadonlySet<EventType> = new Set([
  "story_impression",
  "qualified_view",
  "watch_duration",
  "story_complete",
  "story_next",
  "story_previous",
  "story_replay",
  "comment_open",
]);

const REQUIRES_CREATOR_ID: ReadonlySet<EventType> = new Set([
  "creator_impression",
  "creator_sequence_started",
  "creator_sequence_continued",
  "creator_sequence_completed",
  "quick_creator_skip",
  "profile_visit",
  "follow_after_story",
  "repeat_creator_visit",
  "not_interested",
]);

const ALL_EVENT_TYPES: EventType[] = [
  "creator_impression",
  "story_impression",
  "qualified_view",
  "watch_duration",
  "story_complete",
  "story_next",
  "story_previous",
  "creator_sequence_started",
  "creator_sequence_continued",
  "creator_sequence_completed",
  "creator_swipe_next",
  "creator_swipe_previous",
  "quick_creator_skip",
  "story_replay",
  "comment_open",
  "profile_visit",
  "follow_after_story",
  "repeat_creator_visit",
  "not_interested",
];

export interface RecordEventInput {
  eventType: EventType;
  creatorId: string | undefined;
  storyId: string | undefined;
  valueMs: number | undefined;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

export function parseRecordEventInput(body: unknown): RecordEventInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const eventType = b.eventType as EventType;
  if (!ALL_EVENT_TYPES.includes(eventType)) {
    errors.eventType = `eventType must be one of: ${ALL_EVENT_TYPES.join(", ")}.`;
  }

  const creatorId = typeof b.creatorId === "string" ? b.creatorId : undefined;
  if (REQUIRES_CREATOR_ID.has(eventType) && !(creatorId && UUID_RE.test(creatorId))) {
    errors.creatorId = "creatorId is required for this eventType.";
  }

  const storyId = typeof b.storyId === "string" ? b.storyId : undefined;
  if (REQUIRES_STORY_ID.has(eventType) && !(storyId && UUID_RE.test(storyId))) {
    errors.storyId = "storyId is required for this eventType.";
  }

  let valueMs: number | undefined;
  if (eventType === "watch_duration") {
    valueMs = typeof b.valueMs === "number" ? b.valueMs : NaN;
    if (!Number.isFinite(valueMs) || valueMs < 0 || valueMs > 1000 * 60 * 30) {
      errors.valueMs = "valueMs must be a number of milliseconds between 0 and 1,800,000 (30 minutes).";
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return {
    eventType,
    creatorId: creatorId && UUID_RE.test(creatorId) ? creatorId : undefined,
    storyId: storyId && UUID_RE.test(storyId) ? storyId : undefined,
    valueMs,
  };
}
