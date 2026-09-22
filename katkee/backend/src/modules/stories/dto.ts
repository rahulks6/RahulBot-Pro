import { ValidationError } from "../auth/dto";
import type { Audience, CommentSetting } from "./stories.repository";

const MAX_CAPTION_LENGTH = 280;
const AUDIENCES: Audience[] = ["public", "followers"];
const COMMENT_SETTINGS: CommentSetting[] = ["everyone", "followers", "disabled"];

export interface PublishStoryInput {
  mediaId: string;
  caption: string;
  audience: Audience;
  allowComments: CommentSetting;
  allowSharing: boolean;
}

export function parsePublishStoryInput(body: unknown): PublishStoryInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const mediaId = typeof b.mediaId === "string" ? b.mediaId : "";
  if (!/^[0-9a-f-]{36}$/i.test(mediaId)) errors.mediaId = "mediaId must be a valid media id.";

  const caption = typeof b.caption === "string" ? b.caption : "";
  if (caption.length > MAX_CAPTION_LENGTH) errors.caption = `Caption must be at most ${MAX_CAPTION_LENGTH} characters.`;

  const audience = (b.audience as Audience) ?? "public";
  if (!AUDIENCES.includes(audience)) errors.audience = `audience must be one of: ${AUDIENCES.join(", ")}.`;

  const allowComments = (b.allowComments as CommentSetting) ?? "everyone";
  if (!COMMENT_SETTINGS.includes(allowComments)) {
    errors.allowComments = `allowComments must be one of: ${COMMENT_SETTINGS.join(", ")}.`;
  }

  const allowSharing = b.allowSharing === undefined ? true : b.allowSharing;
  if (typeof allowSharing !== "boolean") errors.allowSharing = "allowSharing must be a boolean.";

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { mediaId, caption, audience, allowComments, allowSharing: allowSharing as boolean };
}

const MAX_COMMENT_LENGTH = 500;

export function parseCommentInput(body: unknown): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const text = typeof b.body === "string" ? b.body.trim() : "";
  if (text.length < 1 || text.length > MAX_COMMENT_LENGTH) {
    throw new ValidationError({ body: `Comment must be 1-${MAX_COMMENT_LENGTH} characters.` });
  }
  return text;
}
