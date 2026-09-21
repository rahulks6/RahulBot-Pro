/** Per spec section 26 — the client-side shape an in-progress Story is held in before publishing (Phase 4). */

export type FilterName =
  | "Original"
  | "Warm"
  | "Cool"
  | "Bright"
  | "Cinema"
  | "Mono"
  | "Vintage"
  | "Soft"
  | "Vivid"
  | "Night"
  | "Fade";

export interface TextOverlayProperties {
  color: string;
  style: "Clean" | "Bold" | "Classic" | "Modern" | "Typewriter" | "Outline";
  hasBackground: boolean;
}

export interface Overlay {
  id: string;
  type: "text";
  x: number;
  y: number;
  scale: number;
  rotation: number;
  zIndex: number;
  text: string;
  properties: TextOverlayProperties;
}

export interface SourceMedia {
  uri: string;
  kind: "photo" | "video";
  width: number | null;
  height: number | null;
}

export interface StoryDraft {
  sourceMedia: SourceMedia;
  filter: FilterName;
  overlays: Overlay[];
  caption: string;
}

export function createEmptyDraft(sourceMedia: SourceMedia): StoryDraft {
  return { sourceMedia, filter: "Original", overlays: [], caption: "" };
}

/** Used for the discard-protection prompt (spec section 27) — has the user actually changed anything? */
export function hasMeaningfulEdits(draft: StoryDraft): boolean {
  return draft.filter !== "Original" || draft.overlays.length > 0 || draft.caption.trim().length > 0;
}
