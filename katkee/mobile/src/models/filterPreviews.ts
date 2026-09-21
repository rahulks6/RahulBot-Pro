import type { FilterName } from "./storyDraft";

/**
 * Preview-only approximation: a semi-transparent color overlay that gives
 * the editor's live preview the right *feel* for each filter. This is not
 * the real pixel transform — actually baking a filter into exported media
 * needs either a native image-processing module or a server-side pass
 * (ffmpeg), neither available in this sandbox (see backend/README.md for
 * why). The chosen filter name is still saved on the StoryDraft
 * (spec section 26) so a real renderer can apply it correctly later
 * without any change to the editor's UI or state shape.
 */
export interface FilterPreview {
  name: FilterName;
  overlayColor: string;
  overlayOpacity: number;
}

export const FILTER_PREVIEWS: FilterPreview[] = [
  { name: "Original", overlayColor: "transparent", overlayOpacity: 0 },
  { name: "Warm", overlayColor: "#FF8A34", overlayOpacity: 0.12 },
  { name: "Cool", overlayColor: "#3E7BFF", overlayOpacity: 0.12 },
  { name: "Bright", overlayColor: "#FFFFFF", overlayOpacity: 0.1 },
  { name: "Cinema", overlayColor: "#1A2A3A", overlayOpacity: 0.22 },
  { name: "Mono", overlayColor: "#808080", overlayOpacity: 0.35 },
  { name: "Vintage", overlayColor: "#C9A66B", overlayOpacity: 0.2 },
  { name: "Soft", overlayColor: "#FFE8E8", overlayOpacity: 0.15 },
  { name: "Vivid", overlayColor: "#FF3366", overlayOpacity: 0.08 },
  { name: "Night", overlayColor: "#0A1030", overlayOpacity: 0.3 },
  { name: "Fade", overlayColor: "#CCCCCC", overlayOpacity: 0.25 },
];
