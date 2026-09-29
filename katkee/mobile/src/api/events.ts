import { apiPost } from "./client";

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

export interface RecordEventInput {
  eventType: EventType;
  creatorId?: string;
  storyId?: string;
  valueMs?: number;
}

/**
 * Fire-and-forget by design at call sites (see StoryViewerScreen) — a
 * dropped analytics event should never block or break the viewing
 * experience. The backend validates and rejects malformed events for
 * real (see backend/src/modules/recommendations/events.dto.ts); this
 * client just needs to not let a failure surface as a user-facing error.
 */
export function recordEvent(input: RecordEventInput, accessToken: string): Promise<void> {
  return apiPost("/api/v1/events", input, accessToken);
}
