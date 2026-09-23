# KATKEE mobile — Phase 1 through Phase 12

Real, hand-written TypeScript source for the design system, navigation shell,
authentication, search/follow, camera capture + the Story editor, publishing
and viewing Stories, the full gesture set plus likes/comments/sharing, real
analytics-event emission feeding the backend's recommendation system, a real
Activity tab backed by the backend's notifications, a real DM inbox and
conversation thread (including sharing a Story into a conversation), real
Highlights — create/edit/view, picked from a real Archive of every Story
you've ever published — a real Report flow (Story, comment, and
account) feeding the backend's moderation queue, and now everything
needed to actually ship this to the App Store and Play Store — real
account deletion, an environment config that points at a real deployed
backend instead of `localhost`, a crash boundary, and a hook for real
crash reporting — wired to the actual backend API (`../backend`) — not
generated boilerplate. It has **not** been built or run in this session;
see the limitation below before trusting it further, and see "Phase 3
specifically" for why that phase carries more risk than 1-2 (Phases 4-10
inherit the same camera/gesture risk, plus their own new ones — see each
phase's own "specifically" section). A best-effort `tsc` pass (no real
library types installed — see below) ran clean against every file
touched through Phase 12 (Phase 11 — the backend's production hardening —
needed no mobile changes at all; see "Phase 11 specifically" below for
why), for what that's worth given its limits. See `../DEPLOYMENT.md` for
the actual build-and-submit runbook and `../STORE_LISTING.md` for what
both stores require in the listing itself.

## What exists here

- **Phase 13 (spec realignment):** a pass against the full 123-section
  KATKEE master spec found real daylight between it and what Phases 1-12
  had built, and closed the highest-impact gaps:
  - `src/screens/story/StoryFeed.tsx` — the gesture/engagement core
    extracted from `StoryViewerScreen.tsx` so **Home can be the Story feed
    itself** (spec sections 4-6: zero-tap, full-screen, auto-advancing —
    not a tray you tap into, which is what Phase 6 actually shipped).
    `HomeScreen.tsx` now renders it directly; `StoryViewerScreen.tsx` is a
    thin wrapper used when a specific creator's Stories are opened from
    somewhere with a real "back" (a profile, a notification, a DM share).
    Reaching either edge of Home's feed shows a "you're all caught up" end
    state instead of navigating away, since Home has nowhere to go back to.
  - A Story's view count is now visible to **any** viewer who can watch it
    (previously owner-only), while who's actually behind that number stays
    a strictly owner-only `GET /api/v1/stories/:id/viewers` door —
    `src/components/StoryViewersSheet.tsx`, opened by tapping the count on
    your own Story. Backend: `stories.repository.ts`'s new `listViewers`,
    `stories.service.ts`'s relaxed `getViewCount` + new `getStoryViewers`,
    both covered by new tests in `test/stories.test.ts`.
  - `src/components/HighlightsRow.tsx` rebuilt as an exactly-3-per-row grid
    of rectangular/portrait cards — spec section 62 explicitly rules out
    the circular Instagram-style bubbles this rendered as before.
    `ProfileScreen.tsx`/`UserProfileScreen.tsx` are now `ScrollView`s so a
    multi-row grid can't overflow off-screen.
  - `src/screens/profile/ArchiveScreen.tsx` (new) — a dedicated, private,
    month-grouped, multi-select grid over every Story you've ever
    published (`GET /api/v1/stories/mine/archive`, previously only fed the
    Highlight-creation picker). Multi-select feeds straight into creating
    a Highlight (`HighlightEditorScreen.tsx` gained an `initialStoryIds`
    preselect param) or bulk-deleting. Reached from a new **Archive** link
    on your own `ProfileScreen.tsx`.
  - `src/screens/activity/ActivityScreen.tsx` now groups consecutive
    `like` notifications for the same Story into one row ("Rahul, Priya
    and 12 others liked your Story" — spec's own example), instead of one
    row per like. Every other notification type is unaffected.
  - `LoginScreen.tsx`'s wordmark now matches the real brand logo — mixed
    case ("Kat" off-white + "kee" amber), not all-caps solid amber — and
    its subtitle is the real tagline ("Story that connects."), not a
    placeholder. See `../BRAND.md` for the full name/tagline/color
    reference this reads from.
  - Still open after this pass (see "Phase 13 specifically" below): DM
    per-message delivery states (Sending/Sent/Delivered/Read/Failed), and
    drag-and-drop reordering of Highlights or their contents.
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
  Home, Create (camera + editor), Activity, and DM are now all real too
  (see below) — the Profile tab shows the real authenticated user fetched
  from `/api/v1/auth/me`.
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
  recorded through `POST /api/v1/stories/:id/view`, and the resulting
  count is shown live (visible to any authorized viewer, not just the
  owner) — who's actually behind that number is a separate, strictly
  owner-only door (`GET /api/v1/stories/:id/viewers`, surfaced as a tap
  target only on your own Story). The gesture set and engagement rail
  live in `src/screens/story/StoryFeed.tsx`, shared by two callers: this
  screen (reached from a Story ring on your own or another user's
  profile, a notification, or a DM share — each has a real "back" to
  return to) and Home itself.
- `src/screens/home/HomeScreen.tsx` — Home *is* the Story feed (spec
  sections 4-6): it fetches `GET /api/v1/stories/feed/home` (Phase 6's
  ranked endpoint — followed creators plus real discovery, not just the
  follow graph) and renders `StoryFeed` directly, full-screen and
  auto-advancing from the moment Home opens — zero taps needed, not a
  tray you tap into. Swiping/tapping past the last creator shows a
  "you're all caught up" end state instead of navigating away, since
  Home has nowhere to go back to.
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
  Delete for your own Story; Not Interested (Phase 6 — actually excludes
  that creator from your `feed/home`, not just a UI acknowledgment),
  Mute, and Block for someone else's. "Report" is still left out — it
  needs a moderation queue that doesn't exist (Phase 11).
- The right-side action rail (Heart with live count, Comment with live
  count, Share, More) on the Story viewer is real, not decorative — spec
  section 5.
- `src/api/events.ts` + real emission throughout `StoryViewerScreen.tsx`:
  `creator_impression`/`creator_sequence_started` on arriving at a
  creator, `story_impression` per Story shown, `watch_duration` +
  `qualified_view` (≥2s, per spec section 13) computed from real elapsed
  time on leaving a Story, `story_complete` only on a natural
  progress-bar finish (vs. `story_next`/`story_previous` for a tap and
  `creator_swipe_next`/`creator_swipe_previous` for a swipe — genuinely
  distinguished, not the same event relabeled), `creator_sequence_
  continued`/`creator_sequence_completed`, `quick_creator_skip` (spec
  section 8's negative signal — leaving a creator within 1.5s of
  arriving), and `comment_open`. `profile_visit` needs no client
  emission at all — the backend records it server-side, more reliably
  than trusting the client (see `backend/README.md`).
- `src/screens/activity/ActivityScreen.tsx` — a real notification list
  (spec section 31) fetched from the Phase 7 backend, grouped into
  Today/Earlier sections, with a Katkee-amber unread dot per row, pull to
  refresh, and pagination (`onEndReached` loads the next page). Tapping a
  like/comment notification opens that Story directly in the viewer (the
  recipient of those two types is always the Story's owner, so the
  viewer's own username is the correct `creators` entry — no extra lookup
  needed); tapping a follow, follow_request, or mention notification opens
  the actor's profile instead — see "Phase 7 specifically" for why mention
  doesn't always open the Story itself. "Mark all read" appears whenever
  the loaded page has an unread row.
- `src/state/NotificationsContext.tsx` — shares the unread count between
  `ActivityScreen` and a new amber badge on the Activity tab icon in
  `BottomTabBar.tsx`, polling `GET /api/v1/notifications/unread-count`
  every 20s while signed in (there's no push/websocket channel available
  in this sandbox — see `backend/README.md`).
- `src/navigation/types.ts` — `MainTabParamList`'s `Search` entry is now
  typed with `NavigatorScreenParams<SearchStackParamList>` so a sibling tab
  (Activity) can deep-link into Search's nested `UserProfile` screen via
  `navigation.navigate("Search", { screen: "UserProfile", params: {...} })`
  — the standard React Navigation pattern for reaching a screen nested
  inside a different tab than the one you're navigating from.
- `src/navigation/DMStack.tsx` — the DM tab is now its own stack
  (`DMInbox` → `Conversation` / `SendStory`), the same pattern as
  `SearchStack.tsx`.
- `src/screens/dm/DMInboxScreen.tsx` — a real conversation list fetched
  from the Phase 8 backend: other participant, a last-message preview
  ("You: " prefix for your own, "Shared a Story" for a story-only
  message), and an unread dot, pull-to-refresh, tap to open the thread.
- `src/screens/dm/ConversationScreen.tsx` — a real message thread: an
  `inverted` `FlatList` kept in the backend's own newest-first order (so
  "load older" is just `onEndReached` on the same list, no reversing),
  a composer that actually posts via `POST
  /api/v1/conversations/:id/messages`, mark-read on focus, and a 4s poll
  for new messages while the screen is open (see "Phase 8 specifically").
  A shared-Story bubble resolves its real owner via the new
  `GET /api/v1/stories/:id/owner` and opens it in `StoryViewer`,
  falling back to doing nothing if the Story's no longer accessible.
- `src/screens/dm/SendStoryScreen.tsx` — the "Send to a Katkee user" leg
  of the Share sheet: search for someone, tap to open (or reuse) the
  conversation with them and send the Story as a message. Reached from
  `ShareSheet.tsx` via a root → `Main` → `DM` → `SendStory` deep link
  (`StoryViewerScreen.tsx` holds the root-level navigation object;
  `ShareSheet` itself stays navigation-agnostic via an `onSendToUser`
  callback prop, the same pattern as its existing `onClose`).
- `src/state/DMContext.tsx` — mirrors `NotificationsContext.tsx` exactly:
  shares the DM tab's own unread count (independent of Activity's) with a
  matching amber badge on the DM tab icon, polling
  `GET /api/v1/conversations/unread-count` every 20s.
- `src/api/stories.ts`'s `getStoryOwnerUsername()` — the Phase 8 backend
  addition (`GET /api/v1/stories/:id/owner`) used by both the DM
  shared-Story bubble and, retroactively, `ActivityScreen.tsx`'s mention
  notifications (see "Phase 7 specifically" above).
- `src/components/HighlightsRow.tsx` — the row of Highlight bubbles under
  a profile's bio (spec section 35), rendered on both `ProfileScreen.tsx`
  (your own, with a leading "+ New" bubble) and `UserProfileScreen.tsx`
  (theirs, gated the same way the backend gates it — a private account's
  Highlights just don't load for a non-follower). A bubble's cover is a
  real thumbnail (`Image` with an `Authorization` header, the same
  pattern `StoryViewerScreen.tsx` already used), not a placeholder.
- `src/screens/highlight/HighlightEditorScreen.tsx` — create (no
  `highlightId`) or edit (rename/replace items/delete) a Highlight: a
  title field and a tap-to-select grid built from
  `GET /api/v1/stories/mine/archive` — every Story you've ever published,
  expired or not, which is the entire reason an Archive listing exists
  now (see backend/README.md's Phase 9 section). Selection order becomes
  the Highlight's item order, shown as a numbered badge per selected
  thumbnail.
- `src/screens/highlight/HighlightViewerScreen.tsx` — sequential,
  view-only playback of a Highlight's items, real media and a real
  per-item progress bar, reached by tapping a bubble. Deliberately its
  own, simpler screen rather than a mode on `StoryViewerScreen.tsx` — see
  "Phase 9 specifically" for why.
- `UserProfileScreen.tsx` also gained a real **Message** button next to
  Follow, now that DMs exist (Phase 8) — it opens or reuses the 1:1
  conversation with that user and navigates straight into it.
- `src/components/ReportSheet.tsx` — a shared reason-picker bottom sheet
  (the 7 backend-defined reasons, an optional details field) for
  reporting a Story, a comment, or a user account, posting a real
  `POST /api/v1/reports` that lands in the Phase 10 backend's moderation
  queue. React Native's built-in `Alert` can't reasonably list 7 options,
  so this is a small Modal in the same style as `ShareSheet.tsx`, not a
  new UI pattern.
- `StoryMoreMenu.tsx` gained a real **Report** row for someone else's
  Story (the placeholder note that used to be here — "needs a moderation
  queue that doesn't exist" — is exactly what Phase 10 built).
  `UserProfileScreen.tsx` gained a small **Report this account** link.
  `CommentsSheet.tsx` gained a **Report** action per comment that isn't
  your own, alongside the existing Delete.
- `src/config/env.ts` — a real dev/production split for the backend URL,
  selected automatically by React Native's own `__DEV__` global (true in
  a Metro/debug build, false in a release build) — no extra native module
  needed just to pick a URL. `api/client.ts`'s `API_BASE_URL` now reads
  from this instead of a hardcoded `localhost:4000`. Set
  `production.apiBaseUrl` to your real deployed backend's HTTPS domain
  (see `../DEPLOYMENT.md`) before making a release build.
- `src/components/ErrorBoundary.tsx` — a top-level crash boundary
  (wraps everything in `App.tsx`, outside even `AuthProvider`) so an
  unexpected render error shows a real, recoverable screen instead of a
  blank one. Reports through `src/crashReporting.ts`, which is inert
  (just `console.error`s) until you wire in a real service — that file's
  own comment is the exact `npm install`/wizard sequence for Sentry, the
  standard choice for React Native.
- `src/components/DeleteAccountSheet.tsx` — real, password-confirmed,
  in-app account deletion, reachable from `ProfileScreen.tsx`. This isn't
  optional polish: App Store review guideline 5.1.1(v) requires an
  in-app deletion path for any app that supports account creation, and a
  submission is rejected outright without one. Calls the Phase 12 backend
  endpoint through a new `AuthContext.deleteAccount()`, which clears
  local tokens and returns to signed-out on success — the same ending
  state as `logout()`, reached by a genuinely different, irreversible
  action.

### Phase 13 specifically

- **DM delivery states (Sending/Sent/Delivered/Read/Failed) aren't built.**
  `ConversationScreen.tsx` still has only a local `sending` busy flag and
  read-tracking — a real per-message status model needs a backend schema
  change (a `status` column plus a way to observe delivery, not just
  send/read), which is a bigger, separate slice than this pass covers.
- **Drag-and-drop reordering isn't built** — neither reordering
  Highlights themselves nor reordering content within one.
  `HighlightEditorScreen.tsx`'s selection order (tap order → numbered
  badge) is the only ordering control that exists; picking it up and
  dropping it elsewhere needs real gesture-drag code this pass doesn't
  add.
- **Story Insights is the viewer list and the count, not the full spec.**
  `getStoryViewers`/`StoryViewersSheet.tsx` give an owner the real "who
  watched" list this session added, and the count is now public. What's
  still missing: a Views-vs-Viewers distinction, completion %, and the
  discovery/following/profile-visit source breakdown — real work exists
  for all of it already (`recommendation_events` — see
  `backend/README.md`'s Phase 6/7 notes) but assembling it into an
  owner-facing Insights screen is future work, not done here.
- **Archive has no full-screen viewer for an individual expired Story** —
  tapping a thumbnail selects it (for a Highlight or deletion) rather than
  opening playback. `StoryFeed.tsx`'s pipeline only ever fetches *active*
  Stories (see `getMyActiveStories`/`getUserActiveStories`); a real
  expired-Story viewer is a separate feature this pass doesn't build.

### Phase 12 specifically

- **No new native modules, no ios/android folders yet.** Everything
  Phase 12 needed was achievable in plain TypeScript/React Native — see
  `../DEPLOYMENT.md` for the real bootstrap step (`npx
  @react-native-community/cli@latest init`) that finally creates those,
  on your own machine, when you're ready to build for real.
- **Crash reporting is a real integration point, not a real crash
  reporter.** `crashReporting.ts` is inert until you actually run `npm
  install @sentry/react-native` (or swap in Bugsnag/Crashlytics) — see
  that file's own comment for the exact steps. Shipping a hardcoded
  Sentry DSN (or any real credential) into this repo would be a real
  security mistake, not a shortcut worth taking to look more "done."

### Phase 11 specifically

- **No new files, no new UI — and that's not a gap.** Phase 11 was the
  backend's production hardening (rate limiting, structured logging, a
  real DB-backed health check, startup config validation — see
  backend/README.md's Phase 11 section). None of that needed a mobile
  change because the error-handling plumbing built all the way back in
  Phase 1 already does the right thing by construction: `api/client.ts`'s
  `request()` already turns any non-2xx JSON response's `message` field
  into an `ApiError`, and every screen that calls `login`/`signup`
  already catches `ApiError` and shows `err.message` — so a 429 rate-limit
  response (`{"error":"http_error","message":"Too many requests — try
  again in 898s."}`) already surfaces to the user correctly, verified by
  reading that code path rather than assumed. That's a real payoff of
  having kept error shapes consistent across nine prior phases, not
  something added for Phase 11 specifically.

### Phase 10 specifically

- **No mobile moderator queue.** The backend's
  `GET /api/v1/moderation/reports` and resolve/suspend endpoints are
  real and tested, but there's no admin screen in this app to drive them
  — moderators are expected to be a tiny internal cohort, and building a
  dedicated review UI for that audience didn't earn its place in this
  pass over the user-facing Report flow itself. See backend/README.md's
  Phase 10 section for the same call spelled out on that side.
- **Reporting doesn't visibly change what you see afterward.** Filing a
  report shows a "thanks, we'll review this" confirmation and nothing
  else — it doesn't hide the reported content, mute the account, or
  otherwise change your own feed (that's what Block/Mute are for, and
  they're unaffected by this). A report is a signal to moderators, not a
  personal filter.

### Phase 9 specifically

- **Highlight playback is view-only — no like, comment, share, or view
  recording.** `StoryViewerScreen.tsx`'s equivalents all go through the
  *normal* per-Story endpoints (`getStoryDetail`, `recordStoryView`,
  `likeStory`, …), every one of which enforces the 24h expiry a Highlight
  exists specifically to outlive — reusing them here would have meant
  threading an expiry-bypass through each one individually on the
  backend. A Highlight is about persisting visibility, not full
  interactive parity with a live Story, so this pass keeps
  `HighlightViewerScreen.tsx` deliberately read-only; it's real, tested
  playback, just a narrower feature than the live viewer.
- **No drag-to-reorder in the editor.** Item order is just "the order you
  tapped things in," shown live as numbered badges — real and
  deterministic, but not a drag handle. Re-ordering an existing Highlight
  today means deselecting and reselecting in the order you want.
- **The Archive picker loads one page (50 Stories, the backend's page-size
  cap) with no "load more."** A prolific account's older Stories past
  that first page aren't reachable from the picker yet — a real gap, not
  a silent one.

### Phase 8 specifically

- **Messaging is polled, not pushed.** An open conversation polls every
  4s for new messages (tighter than Activity/DM's 20s badge polling,
  since the user is actively looking at the screen) — there's no
  push/websocket channel in this sandbox (see backend/README.md). A real
  chat product would want a persistent connection; this is the honest
  approximation available here, not a stub.
- **A "Shared a Story" bubble that's no longer accessible just does
  nothing when tapped**, rather than showing an error — the owner-lookup
  call fails the same way `getStoryForViewer` would for any expired,
  deleted, or since-privacy-changed Story, and silently no-opping felt
  better than surfacing a confusing error for something the recipient
  has no way to act on anyway.
- **Group DMs aren't here** — see backend/README.md for why the schema
  itself is 1:1-only for this pass, not just the UI.
- **No typing indicator, read receipts beyond the unread dot, or message
  deletion/editing.** The spec's DM sections don't call for the first two
  as hard requirements the way the core send/receive/share loop is, and
  message deletion wasn't in this pass's scope — a real, testable slice
  (send, receive, share a Story, know what's unread) over a wider shallow
  one.

### Phase 7 specifically

- **A mention notification on a Story you don't own couldn't deep-link
  straight to that Story — fixed in Phase 8.** For like/comment
  notifications the recipient is always the Story's owner, so the
  viewer's own username was always enough to reopen it. A mention's
  recipient is just whoever got @-mentioned in a comment, though — the
  Story underneath it could belong to anyone — and there was no
  "look up a Story's owner by id" call. Phase 8 added one
  (`GET /api/v1/stories/:id/owner`, needed for the DM shared-Story bubble
  anyway) and wired it into `ActivityScreen.tsx`'s mention handler; it
  falls back to opening the actor's profile only if that lookup itself
  fails (e.g. the Story has since expired).
- **There's no screen for managing incoming follow requests yet.** The
  backend's `GET /api/v1/follow-requests` /
  `POST /api/v1/follow-requests/:id/accept|decline` have existed since
  Phase 2, but no mobile screen was ever built against them. Tapping a
  `follow_request` notification opens the requester's profile — useful,
  but not the same as an actual request-management inbox, which is a real
  gap worth closing in a later pass.
- **The unread badge is polled, not pushed**, per the
  `NotificationsContext.tsx` note above — a 20s worst-case staleness
  window, not a stub.

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

### Phase 6 specifically

- **`follow_after_story` isn't emitted at all.** It would need correlating
  "the viewer just followed someone" (which happens in
  `UserProfileScreen.tsx`, a completely different screen) with "they were
  recently viewing that creator's Story" — real attribution logic that
  doesn't exist yet, and guessing at it felt worse than leaving the event
  out. `repeat_creator_visit` similarly isn't client-emitted — the
  backend already derives it correctly from real `story_impression`
  timestamps spread across days (see `backend/README.md`), so a
  redundant client event would just be double-bookkeeping.
- **`story_replay` isn't emitted.** There's no "go back to the start of a
  Story you've already finished" affordance in this viewer (tapping left
  only moves to the previous Story in the sequence, never re-plays the
  current one from 0) — nothing to attach the event to yet.
- **Every event call is fire-and-forget** (`recordEvent(...).catch(() =>
  undefined)`) — a dropped analytics call degrades ranking quality over
  time, never the viewing experience in the moment. That's a deliberate
  tradeoff, not an oversight.

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
