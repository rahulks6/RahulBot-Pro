# KATKEE mobile — Phase 1 + Phase 2 + Phase 3

Real, hand-written TypeScript source for the design system, navigation shell,
authentication, search/follow, and now camera capture + the Story editor,
wired to the actual backend API (`../backend`) — not generated boilerplate.
It has **not** been built or run in this session; see the limitation below
before trusting it further, and see "Phase 3 specifically" for why this
phase carries more risk than 1-2.

## What exists here

- `src/theme/` — the Katkee design system tokens: near-black background,
  off-white text, one amber/yellow accent (`colors.accent`) used for the
  Story ring, primary CTA, Follow, Create, and unread badges. No
  Instagram-style pink/purple gradients anywhere.
- `src/navigation/` — the exact 6-item bottom nav (`HOME | SEARCH | + |
  ACTIVITY | DM | PROFILE`) with a custom tab bar (`BottomTabBar.tsx`) that
  renders Create as a raised amber circle, not a 7th equal tab. No Discover
  tab.
- `src/state/AuthContext.tsx` + `src/api/` — real signup/login/logout/token
  refresh wired to the backend's actual endpoints and response shapes
  (kept in lockstep with `backend/src/modules/auth/*` — see the comment at
  the top of `src/api/client.ts`), with token persistence via AsyncStorage
  and automatic refresh-on-expiry.
- `src/screens/` — Login, Signup, Search, and the tapped-through user
  profile (follow/unfollow, including the "Requested" state for private
  accounts) are real, functional, wired to the Phase 2 backend endpoints.
  Home, Activity, DM, and Create are honest empty states for phases that
  haven't been built yet (see spec build order) — the Profile tab shows
  the real authenticated user fetched from `/api/v1/auth/me`.
- `src/navigation/SearchStack.tsx` — the Search tab is its own stack
  (`SearchHome` → `UserProfile`) so tapping a result actually opens that
  person's profile (spec section 30), rather than everything living flush
  in the tab bar.
- `src/screens/create/CameraScreen.tsx` — full-screen capture against
  `react-native-vision-camera`: tap for a photo, press-and-hold for video
  (with a timer badge and a 60s cap), flip, flash, timer delay, pinch to
  zoom, tap to focus, double-tap to flip, and gallery import via
  `react-native-image-picker`.
- `src/screens/create/StoryEditorScreen.tsx` + `src/components/
  DraggableTextOverlay.tsx` — movable/pinch-resizable/two-finger-rotatable
  text overlays (hand-rolled multitouch on React Native's core
  `PanResponder`, reading `nativeEvent.touches` directly — no gesture
  library needed for this part), drag-to-trash delete, discard-protection
  on close, and a filter strip. Uploads the finished photo/video to the
  real `POST /api/v1/media/photos|videos` endpoints from Phase 3's
  backend work.
- `src/models/storyDraft.ts` — the `StoryDraft`/`Overlay` shapes from spec
  section 26, so a real renderer (later) can consume exactly what the
  editor already produces.

### Phase 3 specifically

Two things are honestly scoped down rather than faked:

- **Filters are preview-only.** `src/models/filterPreviews.ts` applies a
  color-tint `View` over the live preview so the picker actually does
  something on screen, but it does **not** bake the filter into the
  exported file's pixels — spec section 23 ("filters must actually modify
  media") needs either a native image-processing module or a server-side
  pass, and the backend can't do that here either (see
  `backend/README.md` — `apt-get install ffmpeg` was refused by the same
  network policy that blocks npm). The chosen filter name is still saved
  on the `StoryDraft`, so wiring up a real renderer later doesn't touch
  the editor's UI or state.
- **Stickers, drawing, mentions, and location are not in this pass.**
  Spec sections 21/22/24/25 are real scope for the Story editor, but
  given how much of this phase (camera + multitouch overlay gestures) is
  already impossible to verify without a device, adding several more
  unverified subsystems in one pass seemed like the wrong tradeoff. Text
  overlays are real and complete (drag, pinch-resize, rotate, delete,
  edit); the rest is a natural next slice.
- **The editor's action is "Upload," not "Share Story."** Publishing
  (audience selection, comment/sharing settings, the 24h lifecycle — spec
  sections 28-29) is Phase 4 and doesn't exist yet; claiming to "share a
  Story" without any of that would be exactly the fake-functionality this
  build has been avoiding.

## Known sandbox limitation (read this first)

This session's network policy blocks `registry.npmjs.org`, so `npm install`
could not run here — meaning `react`, `react-native`, and
`@react-navigation/*` were never actually resolved, and this code has not
been typechecked, built, or run. Separately, React Native requires Xcode
(iOS) and/or the Android SDK plus a physical or emulated device to build and
run at all — no cloud sandbox provides that, so real-device testing was
always going to happen on your hardware regardless of network access (see
the KATKEE build-plan doc, section on real-device testing).

This is also not yet a fully bootstrapped React Native project — there are
no native `android/`/`ios/` folders, `metro.config.js`, or Gradle/Xcode
project files. Those are ordinarily generated by the React Native CLI
itself; hand-writing them would be far more likely to produce broken
boilerplate than real value, so they're intentionally left for the actual
bootstrap step below rather than faked.

## To actually run this, on a machine with the RN toolchain installed

```bash
npx @react-native-community/cli@latest init KatkeeMobile --skip-install
# then copy this package's src/, App.tsx, index.js, app.json, babel.config.js,
# tsconfig.json, and package.json dependencies into the generated project
cd KatkeeMobile
npm install
npm run typecheck   # do this first — this code has never been typechecked
npm run ios         # or: npm run android
```

Point `API_BASE_URL` in `src/api/client.ts` at your backend (the iOS
simulator can reach `localhost:4000` directly; Android emulators need
`10.0.2.2:4000`; a physical device needs your machine's LAN IP).

Phase 3 additionally needs, once the native projects exist:

- **iOS** (`ios/KatkeeMobile/Info.plist`): `NSCameraUsageDescription`,
  `NSMicrophoneUsageDescription`, and `NSPhotoLibraryUsageDescription`
  (gallery import) — `react-native-vision-camera` and
  `react-native-image-picker` both refuse to function without these.
- **Android** (`android/app/src/main/AndroidManifest.xml`): the `CAMERA`
  and `RECORD_AUDIO` permissions.
- `react-native-vision-camera` requires iOS 13+ and may need a `Podfile`
  tweak per its own install docs (frame processors, if ever used, need
  `react-native-worklets-core` — not added here since nothing in this
  pass uses frame processors).

Camera capture, the pinch/rotate multitouch handling in
`DraggableTextOverlay.tsx`, and video playback are exactly the kind of
code that most needs real-device testing (spec section 56) before
trusting it — none of that happened in this session.
