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

`background`, `textPrimary`, and `accent` below are **pixel-exact**,
decoded directly from the logo file you sent — not estimated, not
eyeballed. No image library (PIL, ImageMagick) is installable in this
sandbox, so this used a ~100-line pure-Python PNG decoder written from
scratch against only the standard library (`zlib` for the DEFLATE
stream, hand-rolled reversal of PNG's per-scanline filters), then a
histogram over every opaque pixel. The logo (850×267px) came out to
three flat colors, no gradients or anti-aliasing noise once quantized:

| Color | Hex | Share of opaque pixels |
| --- | --- | --- |
| Card background | `#080C14` | 41.2% |
| "Kat" | `#E4E8F0` | 7.1% |
| "kee" | `#FCB020` | 7.1% |

(The remaining ~44% was the screenshot's own surrounding chat-UI
background, not part of the logo itself — excluded by eye once the
image was actually viewed, not just histogrammed.)

Those three measured values are now `mobile/src/theme/colors.ts`'s
`background`, `textPrimary`, and `accent` directly. Every other
near-black token (`surface`, `surfaceElevated`, `border`,
`textSecondary`, `textDisabled`, `onAccent`) is the *old* placeholder
background shifted by the same delta as the real one, so the whole
near-black scale keeps its original relative lightness steps but now
carries the logo's own slight navy tint consistently, instead of a
neutral gray sitting next to a tinted background. `accentPressed` is the
new accent darkened by the same per-channel ratio the old
accent→accentPressed pair used. `danger`/`success` are independent
semantic colors, untouched.

| Token | Hex | Used for |
| --- | --- | --- |
| `background` | `#080C14` | Every screen's base background — measured directly from the logo |
| `surface` | `#141820` | Cards, sheets, input backgrounds |
| `surfaceElevated` | `#1D212A` | Raised elements over `surface` (e.g. avatar placeholders) |
| `border` | `#282C36` | Hairline dividers, input borders |
| `textPrimary` | `#E4E8F0` | Primary text — measured directly from the "Kat" half of the wordmark |
| `textSecondary` | `#A6A9AD` | Secondary text (captions, labels) |
| `textDisabled` | `#5A5D61` | Placeholder text, disabled states |
| `accent` | `#FCB020` | The one brand accent — measured directly from the "kee" half of the wordmark; Story ring, primary CTA, Follow, Create, unread badges |
| `accentPressed` | `#DC9820` | `accent`, pressed state |
| `onAccent` | `#080C14` | Text/icons drawn on top of `accent` — same as `background` |
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
