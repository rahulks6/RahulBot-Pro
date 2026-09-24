import { ValidationError } from "../auth/dto";
import type { SendMessageInput } from "./conversations.service";

const MAX_BODY_LENGTH = 2000;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export function parseSendMessageInput(body: unknown): SendMessageInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  let messageBody: string | null = null;
  if (b.body !== undefined && b.body !== null) {
    if (typeof b.body !== "string") {
      errors.body = "body must be a string.";
    } else {
      const trimmed = b.body.trim();
      if (trimmed.length > MAX_BODY_LENGTH) {
        errors.body = `body must be at most ${MAX_BODY_LENGTH} characters.`;
      } else if (trimmed.length > 0) {
        messageBody = trimmed;
      }
    }
  }

  let storyId: string | null = null;
  if (b.storyId !== undefined && b.storyId !== null) {
    if (typeof b.storyId !== "string" || !UUID_RE.test(b.storyId)) {
      errors.storyId = "storyId must be a valid Story id.";
    } else {
      storyId = b.storyId;
    }
  }

  if (!messageBody && !storyId) {
    errors.body = "A message needs text, a shared Story, or both.";
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { body: messageBody, storyId };
}
