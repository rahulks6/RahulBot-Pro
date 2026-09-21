/**
 * KATKEE color tokens. Near-black + off-white, with a single amber/yellow
 * accent — no Instagram-style pink/purple gradients anywhere in the app.
 */
export const colors = {
  background: "#0A0A0B",
  surface: "#161617",
  surfaceElevated: "#1F1F21",
  border: "#2A2A2D",

  textPrimary: "#F5F3EF",
  textSecondary: "#A8A7A4",
  textDisabled: "#5C5B58",

  accent: "#F5B400", // Katkee amber — Story ring, primary CTA, Follow, Create, unread badges
  accentPressed: "#D69B00",
  onAccent: "#0A0A0B",

  danger: "#E4483C",
  success: "#3FBF7F",

  overlayScrimStart: "rgba(0,0,0,0)",
  overlayScrimEnd: "rgba(0,0,0,0.65)",
} as const;

export type ColorToken = keyof typeof colors;
