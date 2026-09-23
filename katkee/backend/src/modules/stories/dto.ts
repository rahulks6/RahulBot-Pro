import { ValidationError } from "../auth/dto";
import type { Audience, CommentSetting } from "./stories.repository";
import type { StoryOverlay, DrawStroke } from "./overlays";
import { OVERLAY_TYPES, TEXT_STYLES, STICKER_IDS, DATETIME_MODES, DRAW_TOOLS, FILTER_NAMES } from "./overlays";

const MAX_CAPTION_LENGTH = 280;
const AUDIENCES: Audience[] = ["public", "followers"];
const COMMENT_SETTINGS: CommentSetting[] = ["everyone", "followers", "disabled"];

export interface PublishStoryInput {
  mediaId: string;
  caption: string;
  audience: Audience;
  allowComments: CommentSetting;
  allowSharing: boolean;
  overlays: StoryOverlay[];
  drawing: DrawStroke[];
  filter: string;
  audioMuted: boolean;
}

const MAX_OVERLAYS = 40;
const MAX_STROKES = 80;
const MAX_POINTS_PER_STROKE = 500;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const UUID = /^[0-9a-f-]{36}$/i;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * Every overlay is trusted client geometry (x/y/scale/rotation) clamped to
 * a sane range, plus type-specific `properties` validated per type. Bad or
 * unknown shapes are dropped rather than rejecting the whole publish — an
 * editor bug in one overlay shouldn't block the rest of a Story.
 */
function parseOverlay(raw: unknown, index: number): StoryOverlay | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== "string" || !OVERLAY_TYPES.includes(type as (typeof OVERLAY_TYPES)[number])) return null;

  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : `overlay-${index}`;
  // A sanity backstop against an arbitrary API caller, not the UX
  // guarantee the mobile app's own gestures keep — see its
  // OVERLAY_SAFE_MARGIN (storyDraft.ts), which is deliberately tighter
  // than this so an overlay always stays within reach of a drag/tap; this
  // just rejects wildly out-of-view garbage (x=1000, etc).
  const x = isFiniteNumber(o.x) ? clamp(o.x, -0.1, 1.1) : 0.5;
  const y = isFiniteNumber(o.y) ? clamp(o.y, -0.1, 1.1) : 0.5;
  const scale = isFiniteNumber(o.scale) ? clamp(o.scale, 0.1, 6) : 1;
  const rotation = isFiniteNumber(o.rotation) ? ((o.rotation % 360) + 360) % 360 : 0;
  const zIndex = isFiniteNumber(o.zIndex) ? Math.trunc(o.zIndex) : index;

  const properties = o.properties as Record<string, unknown> | undefined;
  if (typeof properties !== "object" || properties === null) return null;

  switch (type) {
    case "text": {
      const text = typeof properties.text === "string" ? properties.text.slice(0, MAX_CAPTION_LENGTH) : "";
      if (text.trim().length === 0) return null;
      const style: (typeof TEXT_STYLES)[number] =
        typeof properties.style === "string" && TEXT_STYLES.includes(properties.style as (typeof TEXT_STYLES)[number])
          ? (properties.style as (typeof TEXT_STYLES)[number])
          : "Clean";
      const color = typeof properties.color === "string" && HEX_COLOR.test(properties.color) ? properties.color : "#FFFFFF";
      const backgroundColor =
        typeof properties.backgroundColor === "string" && HEX_COLOR.test(properties.backgroundColor)
          ? properties.backgroundColor
          : null;
      const align = properties.align === "left" || properties.align === "right" ? properties.align : "center";
      const fontSize = isFiniteNumber(properties.fontSize) ? clamp(properties.fontSize, 0.01, 0.2) : 0.045;
      return { id, type: "text", x, y, scale, rotation, zIndex, properties: { text, style, color, backgroundColor, align, fontSize } };
    }
    case "emoji": {
      const emoji = typeof properties.emoji === "string" ? properties.emoji.slice(0, 8) : "";
      if (emoji.length === 0) return null;
      return { id, type: "emoji", x, y, scale, rotation, zIndex, properties: { emoji } };
    }
    case "mention": {
      const userId = typeof properties.userId === "string" ? properties.userId : "";
      if (!UUID.test(userId)) return null;
      return { id, type: "mention", x, y, scale, rotation, zIndex, properties: { userId } };
    }
    case "location": {
      const label = typeof properties.label === "string" ? properties.label.trim().slice(0, 100) : "";
      if (label.length === 0) return null;
      return { id, type: "location", x, y, scale, rotation, zIndex, properties: { label } };
    }
    case "datetime": {
      const mode: (typeof DATETIME_MODES)[number] =
        typeof properties.mode === "string" && DATETIME_MODES.includes(properties.mode as (typeof DATETIME_MODES)[number])
          ? (properties.mode as (typeof DATETIME_MODES)[number])
          : "datetime";
      const value = typeof properties.value === "string" ? properties.value.slice(0, 40) : new Date().toISOString();
      const display = typeof properties.display === "string" ? properties.display.slice(0, 40) : value;
      return { id, type: "datetime", x, y, scale, rotation, zIndex, properties: { mode, value, display } };
    }
    case "sticker": {
      const stickerId = typeof properties.stickerId === "string" ? properties.stickerId : "";
      if (!STICKER_IDS.includes(stickerId as (typeof STICKER_IDS)[number])) return null;
      return { id, type: "sticker", x, y, scale, rotation, zIndex, properties: { stickerId: stickerId as (typeof STICKER_IDS)[number] } };
    }
    default:
      return null;
  }
}

function parseOverlays(raw: unknown): StoryOverlay[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_OVERLAYS)
    .map((o, i) => parseOverlay(o, i))
    .filter((o): o is StoryOverlay => o !== null);
}

function parseStroke(raw: unknown): DrawStroke | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const id = typeof s.id === "string" && s.id.length > 0 ? s.id : `stroke-${Date.now()}`;
  const tool: (typeof DRAW_TOOLS)[number] =
    typeof s.tool === "string" && DRAW_TOOLS.includes(s.tool as (typeof DRAW_TOOLS)[number])
      ? (s.tool as (typeof DRAW_TOOLS)[number])
      : "pen";
  const color = typeof s.color === "string" && HEX_COLOR.test(s.color) ? s.color : "#FCB020";
  const width = isFiniteNumber(s.width) ? clamp(s.width, 0.002, 0.08) : 0.01;
  const rawPoints = Array.isArray(s.points) ? s.points : [];
  const points = rawPoints
    .slice(0, MAX_POINTS_PER_STROKE)
    .filter((p): p is { x: number; y: number } => {
      if (typeof p !== "object" || p === null) return false;
      const pt = p as Record<string, unknown>;
      return isFiniteNumber(pt.x) && isFiniteNumber(pt.y);
    })
    .map((p) => ({ x: clamp(p.x, -0.2, 1.2), y: clamp(p.y, -0.2, 1.2) }));
  if (points.length < 2) return null;
  return { id, tool, color, width, points };
}

function parseDrawing(raw: unknown): DrawStroke[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_STROKES)
    .map(parseStroke)
    .filter((s): s is DrawStroke => s !== null);
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

  const filter = typeof b.filter === "string" && FILTER_NAMES.includes(b.filter as (typeof FILTER_NAMES)[number]) ? b.filter : "original";
  const audioMuted = b.audioMuted === undefined ? false : b.audioMuted;
  if (typeof audioMuted !== "boolean") errors.audioMuted = "audioMuted must be a boolean.";

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return {
    mediaId,
    caption,
    audience,
    allowComments,
    allowSharing: allowSharing as boolean,
    overlays: parseOverlays(b.overlays),
    drawing: parseDrawing(b.drawing),
    filter,
    audioMuted: audioMuted as boolean,
  };
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
