import { ValidationError } from "../auth/dto";

const MAX_TITLE_LENGTH = 30;
const MAX_ITEMS = 100;
const UUID_RE = /^[0-9a-f-]{36}$/i;

function parseTitle(value: unknown, errors: Record<string, string>): string | undefined {
  if (typeof value !== "string") {
    errors.title = "title must be a string.";
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_TITLE_LENGTH) {
    errors.title = `title must be 1-${MAX_TITLE_LENGTH} characters.`;
    return undefined;
  }
  return trimmed;
}

function parseStoryIds(value: unknown, errors: Record<string, string>): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    errors.storyIds = "storyIds must be a non-empty array.";
    return undefined;
  }
  if (value.length > MAX_ITEMS) {
    errors.storyIds = `A Highlight can hold at most ${MAX_ITEMS} Stories.`;
    return undefined;
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !UUID_RE.test(item)) {
      errors.storyIds = "storyIds must all be valid Story ids.";
      return undefined;
    }
    if (!seen.has(item)) {
      seen.add(item);
      ids.push(item);
    }
  }
  return ids;
}

export interface CreateHighlightInput {
  title: string;
  storyIds: string[];
}

export function parseCreateHighlightInput(body: unknown): CreateHighlightInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const title = parseTitle(b.title, errors);
  const storyIds = parseStoryIds(b.storyIds, errors);

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { title: title as string, storyIds: storyIds as string[] };
}

export interface UpdateHighlightInput {
  title?: string;
  storyIds?: string[];
}

export function parseUpdateHighlightInput(body: unknown): UpdateHighlightInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const result: UpdateHighlightInput = {};

  if (b.title !== undefined) {
    const title = parseTitle(b.title, errors);
    if (title !== undefined) result.title = title;
  }
  if (b.storyIds !== undefined) {
    const storyIds = parseStoryIds(b.storyIds, errors);
    if (storyIds !== undefined) result.storyIds = storyIds;
  }
  if (b.title === undefined && b.storyIds === undefined) {
    errors.title = "Nothing to update — provide title and/or storyIds.";
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return result;
}
