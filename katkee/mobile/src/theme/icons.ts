/**
 * One canonical glyph per icon in Katkee's icon set, so every screen draws
 * the same symbol for the same action instead of each file picking its
 * own inline "✕"/"⚡"/etc. There's no vector icon font or SVG icon library
 * installed in this sandbox (network-blocked, no npm install — same
 * constraint as the rest of this project), so every entry here is a plain
 * Unicode character rendered through a `Text` component — the same
 * technique already used throughout the app (🗑, 👁, 🔥, ✕...), just now
 * centralized instead of inlined ad hoc per screen.
 *
 * Names and groupings follow the "Katkee Icon Set" reference sheet
 * (bottom navigation, story actions, camera, story editor, owner
 * controls, search, activity, DM, profile, highlights, archive). Where
 * that sheet depicts a feature this app doesn't have yet (a dedicated
 * Settings screen, Edit/Share Profile, Activity tabs, Search filters),
 * no icon is added here — an icon with nothing behind it would be a fake
 * button, not a real one.
 */
export const ICONS = {
  // Bottom navigation
  home: "⌂",
  search: "🔍",
  create: "+",
  activity: "♡",
  dm: "💬",
  profile: "◉",

  // Story actions (right rail)
  like: "♡",
  liked: "♥",
  comment: "◯",
  share: "➤",
  more: "•••",

  // Camera screen
  close: "✕",
  flash: "⚡",
  timer: "◷",
  gallery: "▤",
  capture: "◎",
  flip: "⟲",

  // Story editor (top)
  text: "Aa",
  sticker: "☺",
  draw: "✎",
  audioOn: "🔊",
  audioMuted: "🔇",
  crop: "⛶",

  // Story owner controls
  viewers: "👁",
  insights: "📊",

  // Search / Activity / DM chrome
  clear: "✕",
  back: "←",
  newChat: "✎",
  attach: "📎",
  emoji: "☺",
  send: "➤",
  notifications: "🔔",

  // Highlights / Archive / general
  add: "+",
  trash: "🗑",
  check: "✓",
  edit: "✎",
  changeCover: "▤",
  undo: "↺",
  redo: "↻",
  logout: "⎋",
  star: "☆",
  starFilled: "★",
  settings: "⚙",
} as const;

export type IconName = keyof typeof ICONS;
