/**
 * Shared shapes for the Camera + Editor module's structured overlay/drawing
 * data — mirrors mobile/src/models/storyDraft.ts's client-side types.
 * Stored as JSONB on `stories` (migration 0015), never baked into pixels,
 * so a mention stays a live reference (resolved per-viewer in
 * stories.service.ts, respecting blocks/deletion/username changes) rather
 * than a permanently-rendered "@username".
 */

export const OVERLAY_TYPES = ["text", "emoji", "mention", "location", "datetime", "sticker"] as const;
export type OverlayType = (typeof OVERLAY_TYPES)[number];

export const TEXT_STYLES = ["Clean", "Bold", "Classic", "Modern", "Typewriter", "Outline", "Soft", "Highlight"] as const;
export type TextStyle = (typeof TEXT_STYLES)[number];

export const STICKER_IDS = ["spark", "heart-line", "star-outline", "wave", "flame", "confetti", "ring", "bolt"] as const;
export type StickerId = (typeof STICKER_IDS)[number];

export const DATETIME_MODES = ["date", "time", "datetime"] as const;
export type DateTimeMode = (typeof DATETIME_MODES)[number];

export const DRAW_TOOLS = ["pen", "marker", "highlighter", "eraser"] as const;
export type DrawTool = (typeof DRAW_TOOLS)[number];

export const FILTER_NAMES = [
  "original",
  "warm",
  "cool",
  "bright",
  "cinema",
  "mono",
  "vintage",
  "soft",
  "vivid",
  "night",
  "fade",
] as const;
export type FilterKey = (typeof FILTER_NAMES)[number];

interface OverlayBase {
  id: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  zIndex: number;
}

export interface TextOverlay extends OverlayBase {
  type: "text";
  properties: { text: string; style: TextStyle; color: string; backgroundColor: string | null; align: "left" | "center" | "right"; fontSize: number };
}

export interface EmojiOverlay extends OverlayBase {
  type: "emoji";
  properties: { emoji: string };
}

export interface MentionOverlay extends OverlayBase {
  type: "mention";
  /**
   * `userId` is the only part that's actually persisted (see dto.ts's
   * parseOverlay — an incoming `username`/`displayName` is never trusted or
   * stored). `username`/`displayName` are attached fresh on every read, by
   * stories.service.ts's resolveOverlaysForViewer, from whatever that user's
   * identity actually is *right now* — a rename shows up immediately, and a
   * deleted account or a block in either direction makes the whole overlay
   * disappear from the response rather than ever rendering stale data.
   */
  properties: { userId: string; username?: string; displayName?: string };
}

export interface LocationOverlay extends OverlayBase {
  type: "location";
  properties: { label: string };
}

export interface DateTimeOverlay extends OverlayBase {
  type: "datetime";
  properties: { mode: DateTimeMode; value: string; display: string };
}

export interface StickerOverlay extends OverlayBase {
  type: "sticker";
  properties: { stickerId: StickerId };
}

export type StoryOverlay = TextOverlay | EmojiOverlay | MentionOverlay | LocationOverlay | DateTimeOverlay | StickerOverlay;

export interface DrawStroke {
  id: string;
  tool: DrawTool;
  color: string;
  width: number;
  points: { x: number; y: number }[];
}

/**
 * A live-applied crop, not a pixel-level one — see migration 0017's own
 * comment. `zoom` is clamped to [1, MAX_CROP_ZOOM]; `offsetX`/`offsetY`
 * to [-1, 1] (a fraction of the pan room available at that zoom, not raw
 * pixels — see mobile/src/components/CropGestureLayer.tsx for the exact
 * transform this is fed into).
 */
export interface StoryCrop {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export const MAX_CROP_ZOOM = 4;
