# KATKEE mobile — Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5

Real, hand-written TypeScript source for the design system, navigation shell,
authentication, search/follow, camera capture + the Story editor, publishing
and viewing Stories, and now the full gesture set plus likes/comments/
sharing, wired to the actual backend API (`../backend`) — not generated
boilerplate. It has **not** been built or run in this session; see the
limitation below before trusting it further, and see "Phase 3 specifically"
for why that phase carries more risk than 1-2 (Phase 4 and 5 inherit the
same camera/gesture risk, plus their own new ones — see "Phase 4
specifically" and "Phase 5 specifically"). A best-effort `tsc` pass (no
real library types installed — see below) ran clean against every Phase 5
file, for what that's worth given its limits.

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
- `src/screens/create/StoryEditorScreen.tsx` now actually **publishes**:
  a caption field and a Public/Followers audience picker, then "Share
  Story" uploads the media and calls the real `POST /api/v1/stories`
  from Phase 4's backend work, landing back on Home.
- `src/screens/story/StoryViewerScreen.tsx` — the full-screen Story viewer
  (spec section 4), now with the complete gesture set: tap right/left move
  within a creator's Stories (crossing to the next creator once you tap
  past their last Story, per spec), swipe up/down move between creators
  outright, hold pauses (a real `Animated.timing`-driven progress bar per
  segment), and double-tap ensures a like — never unlikes, and single-tap
  navigation is deliberately delayed behind the double-tap window so a
  double-tap is never misread as two single taps first. Each view is
  recorded through `POST /api/v1/stories/:id/view`. It's reached from
  three real places: the Story ring on your own Profile and on another
  user's profile (both tappable only when they actually have an active
  Story — checked via a real API call, not assumed), and a horizontal
  tray of followed creators at the top of Home, which now opens the
  viewer with that whole tray as the swipe order (not just one person).
- `src/screens/home/HomeScreen.tsx` — no longer only an empty state: it
  fetches `GET /api/v1/stories/feed/following` and shows a real tray of
  people you follow who currently have an active Story. It's still
  follow-graph order, not a recommendation-ranked feed — that's Phase 6.
- `RootNavigator.tsx` wraps the tab navigator in a root-level stack so
  `StoryViewer` is reachable from any tab (Profile, Search, Home) without
  each tab's own stack needing to know about it.
- `src/components/CommentsSheet.tsx` — a bottom-sheet Modal (no
  bottom-sheet library installed) with real pagination, posting, and
  delete (your own comment, or any comment if you own the Story — spec
  section 14's moderation allowance), wired to the Phase 5 backend.
- `src/components/ShareSheet.tsx` — native OS share via React Native's
  built-in `Share` API, plus "Copy link" gated to public Stories only (spec
  section 15: "Sharing must NEVER bypass Story privacy") — see "Phase 5
  specifically" for what the copied link actually is.
- `src/components/StoryMoreMenu.tsx` — View Insights (real view count) and
  Delete for your own Story; Mute/Block (Phase 2 endpoints) for someone
  else's. "Not Interested" and "Report" are left out on purpose — see
  "Phase 5 specifically".
- The right-side action rail (Heart with live count, Comment with live
  count, Share, More) on the Story viewer is real, not decorative — spec
  section 5.

### Phase 4 specifically

- **Video duration for the progress bar comes from the player, not the
  server.** The backend doesn't parse a video's real duration yet (see
  `backend/README.md` — that needs `ffmpeg`, which the sandbox's network
  policy refused), so the viewer waits for `react-native-video`'s own
  `onLoad` to report the real duration before starting that segment's
  progress bar, falling back to a 15s guess only if that never fires.
- **Knowing whether a Story's media is a photo or video** now uses a real
  `GET /api/v1/media/:id` metadata lookup (Phase 4 also opened that
  endpoint up beyond owner-only — see `backend/README.md`) rather than
  guessing from a file extension.

### Phase 5 specifically

- **The copied/shared link is real but inert.** `ShareSheet.tsx` builds a
  `katkee://story/:id` deep link — correct scheme, correct id — but
  Universal Links (iOS) / App Links (Android) aren't configured in the
  (nonexistent) native projects, so tapping that link on a device won't
  open the app yet. That native configuration is a real, separate step;
  the link format itself isn't a placeholder.
- **"Send to a Katkee user" isn't in the Share sheet.** Spec section 15
  lists it alongside Copy Link and native share, but it needs a
  conversation to send it into — DMs are Phase 8. Offering a picker that
  saved to nothing would be fake functionality.
- **"Not Interested" and "Report" aren't in the More menu.** The spec
  lists them (section 16), but "Not Interested" is a recommendation
  signal with no recommender to feed yet (Phase 6), and "Report" needs
  a moderation queue that doesn't exist (Phase 11). Mute and Block —
  the two items that already have a real backend — are there and work.
- **Haptic feedback on like uses `Vibration.vibrate()`**, React Native's
  built-in API, rather than a dedicated haptics package — this sandbox
  can't install one, and a short vibration is a real (if blunter)
  substitute for a haptic tick, not a stub.
- **The hand-rolled tap/double-tap/hold/swipe recognizer in
  `StoryViewerScreen.tsx`** is now doing more at once than Phase 4's
  version (it also has to not mistake a double-tap-to-like for two
  single taps) — worth deliberately testing on a real device before
  trusting the timing values (`HOLD_DELAY_MS`, `DOUBLE_TAP_WINDOW_MS`,
  `SWIPE_CLOSE_THRESHOLD`) feel right, not just that they compile.

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
- **The editor's action was "Upload," not "Share Story," in this phase.**
  Phase 4 added real publishing underneath it — see below — so the button
  now says "Share Story" and actually is one.

## Known sandbox limitation (read this first)

This session's network policy blocks `registry.npmjs.org`, so `npm install`
could not run here — meaning `react`, `react-native`, and
`@react-navigation/*` were never actually resolved, and this code has not
been properly typechecked, built, or run. As a partial, best-effort check,
`tsc` was run directly against every file with real library types stubbed
out (so most of its output is expected "cannot find module react-native"
noise, not real findings) — it still caught one genuine bug worth knowing
about: `StoryEditorScreen.tsx`'s error-message style spread `typography.caption`
*after* setting `color: colors.danger`, so the spread's own gray silently
overwrote the intended red. Fixed. That's the kind of thing this technique
can catch (property-order bugs, obvious type mismatches) and the kind it
can't (anything needing real React Native/library type information, or
anything only wrong at runtime on a device). Separately, React Native requires Xcode
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
