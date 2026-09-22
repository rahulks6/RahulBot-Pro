import { nullable, query } from "../../db/psql";
import type { EventType } from "./events.dto";

const IMPRESSION_TYPES: ReadonlySet<EventType> = new Set(["creator_impression", "story_impression"]);
const IMPRESSION_DEDUP_MINUTES = 30;

export interface InsertEventInput {
  viewerId: string;
  eventType: EventType;
  creatorId?: string | undefined;
  storyId?: string | undefined;
  valueMs?: number | undefined;
}

/**
 * Impression-type events are deduplicated at the application level (a
 * fresh impression after the window is a real, separate signal — this
 * isn't a hard "once ever" uniqueness rule). Every other event type is
 * logged as-is: repeated skips, replays, or sequence-nav taps are each
 * their own real occurrence.
 */
export async function insertEvent(input: InsertEventInput): Promise<boolean> {
  if (IMPRESSION_TYPES.has(input.eventType) && input.storyId) {
    const recent = await query(
      `SELECT 1 FROM recommendation_events
       WHERE viewer_id = :'viewer_id' AND story_id = :'story_id' AND event_type = :'event_type'
         AND created_at > now() - make_interval(mins => :'dedup_minutes')
       LIMIT 1`,
      {
        viewer_id: input.viewerId,
        story_id: input.storyId,
        event_type: input.eventType,
        dedup_minutes: IMPRESSION_DEDUP_MINUTES,
      },
    );
    if (recent.length > 0) return false;
  }

  await query(
    `INSERT INTO recommendation_events (viewer_id, event_type, creator_id, story_id, value_ms)
     VALUES (:'viewer_id', :'event_type', ${nullable("creator_id", "uuid")}, ${nullable("story_id", "uuid")}, ${nullable("value_ms", "integer")})`,
    {
      viewer_id: input.viewerId,
      event_type: input.eventType,
      creator_id: input.creatorId ?? null,
      story_id: input.storyId ?? null,
      value_ms: input.valueMs ?? null,
    },
  );
  return true;
}

/** Count of `eventType` events aimed at `creatorId` within the last `days` days — the raw input to both StoryQuality and affinity scoring. */
export async function countEventsForCreator(creatorId: string, eventType: EventType, days: number): Promise<number> {
  const row = await query(
    `SELECT COUNT(*) AS n FROM recommendation_events
     WHERE creator_id = :'creator_id' AND event_type = :'event_type' AND created_at > now() - make_interval(days => :'days')`,
    { creator_id: creatorId, event_type: eventType, days },
  );
  return Number(row[0]?.n ?? 0);
}

/** Count of `eventType` events this specific viewer directed at this specific creator, ever — the input to per-viewer affinity. */
export async function countViewerEventsForCreator(viewerId: string, creatorId: string, eventType: EventType): Promise<number> {
  const row = await query(
    `SELECT COUNT(*) AS n FROM recommendation_events
     WHERE viewer_id = :'viewer_id' AND creator_id = :'creator_id' AND event_type = :'event_type'`,
    { viewer_id: viewerId, creator_id: creatorId, event_type: eventType },
  );
  return Number(row[0]?.n ?? 0);
}

/** Distinct calendar days a viewer has had a story_impression/qualified_view for this creator — the real "did they come back" signal (spec section 9). */
export async function distinctEngagementDays(viewerId: string, creatorId: string): Promise<number> {
  const row = await query(
    `SELECT COUNT(DISTINCT date_trunc('day', created_at)) AS n
     FROM recommendation_events
     WHERE viewer_id = :'viewer_id' AND creator_id = :'creator_id'
       AND event_type IN ('story_impression', 'qualified_view')`,
    { viewer_id: viewerId, creator_id: creatorId },
  );
  return Number(row[0]?.n ?? 0);
}

/** Lifetime impression count for a creator — the input to the new-creator exploration multiplier (spec section 11). */
export async function lifetimeImpressionCount(creatorId: string): Promise<number> {
  const row = await query(
    `SELECT COUNT(*) AS n FROM recommendation_events
     WHERE creator_id = :'creator_id' AND event_type IN ('creator_impression', 'story_impression')`,
    { creator_id: creatorId },
  );
  return Number(row[0]?.n ?? 0);
}
