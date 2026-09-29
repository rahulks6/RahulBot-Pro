import { HttpError } from "../../http/errors";
import * as usersRepo from "../users/users.repository";
import { getStoryForViewer } from "../stories/stories.service";
import * as eventsRepo from "./events.repository";
import * as notInterestedRepo from "./not-interested.repository";
import type { RecordEventInput } from "./events.dto";

export async function recordEvent(viewerId: string, input: RecordEventInput): Promise<void> {
  if (input.creatorId) {
    if (input.creatorId === viewerId) {
      // Self-directed events (e.g. viewing your own profile) aren't a
      // recommendation signal — see spec section 11's self-view guard.
      return;
    }
    const creator = await usersRepo.findUserById(input.creatorId);
    if (!creator) throw new HttpError(404, "creatorId does not refer to a real user.");
  }

  if (input.storyId) {
    // Reuses the exact same access rule as viewing the Story itself — a
    // client can't manufacture engagement signal for content it can't see.
    await getStoryForViewer(input.storyId, viewerId);
  }

  await eventsRepo.insertEvent({
    viewerId,
    eventType: input.eventType,
    creatorId: input.creatorId,
    storyId: input.storyId,
    valueMs: input.valueMs,
  });

  if (input.eventType === "not_interested" && input.creatorId) {
    await notInterestedRepo.markNotInterested(viewerId, input.creatorId);
  }
}
