# Katkee brand

The name, tagline, and colors below come from the wordmark logo you
provided (dark near-black background, "Kat" in off-white, "kee" in
amber/orange-yellow). This file is the single source of truth for them —
everywhere else in the codebase that needs a color or the wordmark should
point back here, not redefine its own.

## Name & wordmark

**Katkee** — mixed case, never all-caps ("KATKEE"). The two halves are
styled differently, matching the logo:

- `Kat` — off-white (`colors.textPrimary`)
- `kee` — amber (`colors.accent`)

`mobile/src/screens/auth/LoginScreen.tsx` renders this exactly (two nested
`<Text>` spans, not a single string) — that's the one place in the app a
large wordmark appears today, and the pattern to copy anywhere else one's
needed (a splash screen, a marketing site, store listing graphics).

## Tagline

> Story that connects.

Shown under the wordmark on the login screen. Use it as the short,
one-line description wherever the store listing forms or a marketing page
ask for one (see `STORE_LISTING.md`'s "subtitle (iOS)/short description
(Android)" line) — it already fits both stores' short-description length
limits with room to spare.

## Colors

These aren't new — they're `mobile/src/theme/colors.ts`, already in use
everywhere in the app (the Story ring, primary buttons, unread badges,
every screen's background). They were chosen when that file was first
built to be a near-black + off-white + single-amber-accent system with no
Instagram-style pink/purple gradients, which is a close visual match to
the logo you sent. **One honest caveat**: this sandbox has no image
library available (no PIL, no ImageMagick, no way to install one — see
`backend/README.md`'s sandbox-limitation note for the same class of
constraint elsewhere in this project), so the hex values below were not
extracted pixel-by-pixel from your logo file — they're the app's existing,
deliberately-matching tokens. If pixel-exact brand colors matter to you
(e.g. for a design system handed to another designer), sample the logo
file yourself in any image editor and I'll swap these tokens to match
exactly — it's a one-file change (`theme/colors.ts`), everything else
reads from it.

| Token | Hex | Used for |
| --- | --- | --- |
| `background` | `#0A0A0B` | Every screen's base background — near-black, not pure black |
| `surface` | `#161617` | Cards, sheets, input backgrounds |
| `surfaceElevated` | `#1F1F21` | Raised elements over `surface` (e.g. avatar placeholders) |
| `border` | `#2A2A2D` | Hairline dividers, input borders |
| `textPrimary` | `#F5F3EF` | Primary text — off-white, not pure white (the "Kat" in the wordmark) |
| `textSecondary` | `#A8A7A4` | Secondary text (captions, labels) |
| `textDisabled` | `#5C5B58` | Placeholder text, disabled states |
| `accent` | `#F5B400` | The one brand accent — amber/orange-yellow (the "kee" in the wordmark), Story ring, primary CTA, Follow, Create, unread badges |
| `accentPressed` | `#D69B00` | `accent`, pressed state |
| `onAccent` | `#0A0A0B` | Text/icons drawn on top of `accent` |
| `danger` | `#E4483C` | Destructive actions, errors |
| `success` | `#3FBF7F` | Confirmations |

## What still needs real assets

Brand *tokens* (name, tagline, colors) are wired into the running app —
brand *artifacts* (an actual icon file, a splash screen, store graphics)
are not, and can't be produced in this sandbox (no image-editing tool
available here). `STORE_LISTING.md`'s "Visual assets" checklist has the
exact specs each one needs (1024×1024 icon, splash screen, Android
feature graphic, screenshots) — when you produce them, use the wordmark
and color styling above so they match what's actually in the app.
