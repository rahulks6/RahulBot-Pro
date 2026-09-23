/**
 * KATKEE color tokens. Near-black navy + cool off-white, with a single
 * amber/orange accent — no Instagram-style pink/purple gradients anywhere
 * in the app.
 *
 * `background`, `textPrimary`, and `accent` are pixel-exact, decoded
 * directly from the real logo file (a pure-stdlib PNG decode — zlib
 * inflate + PNG filter reversal by hand — since no image library is
 * installable in this sandbox; see BRAND.md for the extraction and exact
 * pixel percentages). Every other near-black token is that same logo
 * background shifted by the identical delta from the old placeholder
 * background to this real one, so the whole near-black scale keeps its
 * relative lightness steps but now carries the logo's own slight navy
 * tint through consistently, rather than the old neutral gray sitting
 * next to a tinted background.
 */
export const colors = {
  background: "#080C14",
  surface: "#141820",
  surfaceElevated: "#1D212A",
  border: "#282C36",

  textPrimary: "#E4E8F0",
  textSecondary: "#A6A9AD",
  textDisabled: "#5A5D61",

  accent: "#FCB020", // Katkee amber — Story ring, primary CTA, Follow, Create, unread badges
  accentPressed: "#DC9820",
  onAccent: "#080C14",

  danger: "#E4483C",
  success: "#3FBF7F",

  overlayScrimStart: "rgba(0,0,0,0)",
  overlayScrimEnd: "rgba(0,0,0,0.65)",
} as const;

export type ColorToken = keyof typeof colors;
