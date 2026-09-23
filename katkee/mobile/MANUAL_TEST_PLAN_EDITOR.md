# Manual test plan: Story Editor

Covers `StoryEditorScreen.tsx` and everything it composes: `DraggableCanvasObject`,
`OverlayBody`, `OverlayAdjustSheet`, `StickerSheet`, `TextToolModal`,
`DrawingCanvas`, `CropGestureLayer`, and the live viewers
(`StoryFeed`/`ArchivedStoryViewerScreen`/`HighlightViewerScreen`) that
render what gets published. Same caveat as the camera plan: none of this
has run on a device. Requires **two real accounts** on two devices (or one
device + one simulator) for the mention section.

## 1. Text objects

- [ ] Tap "Text" → keyboard opens immediately, cursor is active.
- [ ] Type a caption, tap a style chip (all 8: Clean/Bold/Classic/Modern/
      Typewriter/Outline/Soft/Highlight) → the preview text visibly
      changes style live, before tapping Done.
- [ ] Change color, alignment (left/center/right), and size (A−/A+) live,
      each visibly updating the preview.
- [ ] Toggle the background on/off — text gets a translucent backing.
- [ ] Type a caption long enough to need multiple lines → it **wraps**
      within the canvas rather than running off-screen.
- [ ] Tap Done → the text appears on the canvas at center, selected
      styling intact.
- [ ] Open the keyboard on a small-screen device → confirm Done and every
      style/align/color/size control stay visible and reachable (not
      covered by the keyboard).
- [ ] Double-tap the placed text → the same editor reopens with the exact
      same text/style/color/align/size/background restored, not reset to
      defaults.

## 2. The shared gesture model — every object type

Repeat this block for **text, an emoji, a sticker, a mention, a location
chip, and a date/time chip** — one gesture implementation should behave
identically for all six:

- [ ] One-finger drag moves the object 1:1 with the finger, no lag or
      overshoot.
- [ ] Two-finger pinch resizes continuously (no fixed size steps).
- [ ] Two-finger rotate works *simultaneously* with pinch (both at once,
      not one-then-the-other).
- [ ] A quick tap (no movement) selects the object and opens
      **OverlayAdjustSheet** — confirm the nudge (↑↓←→), size (−/+), and
      rotate (↺/↻) buttons each move/resize/rotate the *same* selected
      object, matching what the gesture would have done.
- [ ] From OverlayAdjustSheet, Delete removes the object; for a text
      object, "Edit Text" reopens the full text style editor.
- [ ] Drag the object onto the bottom trash zone → the zone highlights and
      the object deletes on release; dragging *near but not onto* it does
      not delete.
- [ ] Drag the object hard toward every edge (top/bottom/left/right) →
      confirm it **stops before disappearing** (safe-bounds clamp) and can
      still be tapped/selected afterward — it must never become
      unreachable.
- [ ] Place several different objects at once (e.g. two text objects, an
      emoji, and a sticker) → confirm dragging one never moves, resizes,
      or deletes another; each object's gesture is fully independent.

## 3. Stickers, mentions, location, date/time

- [ ] Emoji tab: tapping any emoji adds it to the canvas immediately.
- [ ] Stickers tab: tapping any Katkee sticker adds it to the canvas.
- [ ] Date/Time tab: the day/hour/minute steppers each change the live
      preview text; "Add as date sticker" and "Add as time sticker" place
      the currently-configured date/time (not always "right now").
- [ ] Location tab: typing a label and tapping Add places a location chip
      with that exact text.
- [ ] Location tab, "Use current location": **confirm the OS location
      permission prompt appears only at this exact tap** — never on
      opening the editor, never on opening the sticker sheet, never on
      any other tab. Grant it → a coarse, rounded coordinate label
      appears (not a precise address — there's no reverse-geocoding
      configured), editable before adding.
- [ ] Mention tab: type 2+ characters → live search results appear
      (debounced, not one request per keystroke). Open the keyboard here
      too and confirm the results list isn't hidden behind it.
- [ ] Tap a search result → a mention chip is added showing that user's
      current display name/username.

### Mentions end-to-end (needs a second real account)

- [ ] Account A mentions Account B, publishes the Story.
- [ ] On Account B's device, view the Story → the mention renders as
      `@username` and is tappable.
- [ ] Tap the mention → navigates to Account B's own real profile (not a
      dead link, not someone else's).
- [ ] Have Account B rename their username → reload/reopen the same
      published Story → the mention now shows the **new** username
      (resolved live, not baked in at publish time).
- [ ] Have a third Account C block Account B (or vice versa) → Account C
      opens the same Story → the mention is **gone entirely**, not shown
      grayed out or broken.
- [ ] Delete Account B's account entirely → any other viewer opening the
      Story sees no mention at all.

## 4. Drawing

- [ ] Tap Draw → the toolbar (Pen/Marker/Highlighter/Eraser, colors, size,
      Undo/Redo, Done) appears; existing overlays are still visible but
      no longer draggable while in this mode.
- [ ] Draw a stroke with each tool → Pen is thin/solid, Marker is
      thicker/solid, Highlighter is wide/translucent.
- [ ] Change color and size mid-session → the next stroke drawn uses the
      new values; already-drawn strokes don't change retroactively.
- [ ] Undo removes the most recent stroke (or erase); Redo brings it back;
      confirm the stack order is correct after several undo/redo cycles.
- [ ] Eraser: dragging over a stroke removes that whole stroke; dragging
      over empty canvas does nothing.
- [ ] Tap Done → drawings persist and render in the exact position drawn
      once back in the normal (non-draw) editor view.

## 5. Filters and crop

- [ ] Tap through the filter chip strip → the preview tint changes
      immediately per chip.
- [ ] Swipe left/right directly on the media (not on the chip strip) →
      filter cycles the same way, and the filter's name briefly flashes
      on screen then fades.
- [ ] Start dragging a text/sticker object, then continue the same motion
      as a horizontal swipe → confirm the **object moves**, the filter
      does **not** change (gesture-conflict check: the object's own
      gesture must win over the swipe-filter layer).
- [ ] Tap Crop → pinch to zoom in/out and drag to reposition; confirm you
      can never pan far enough to reveal empty space at any edge.
- [ ] Tap Done on Crop → the same zoom/pan framing is what's shown back in
      the normal editor (not reset).
- [ ] Publish, then reopen the published Story as a viewer → the exact
      same crop framing renders (preview-accuracy check).

## 6. Video-specific

- [ ] With a recorded video loaded, toggle "Audio on"/"Muted" → the
      editor's own preview audio actually mutes/unmutes.
- [ ] Publish once muted, once unmuted (two separate Stories) → confirm
      each published Story's playback matches what was chosen, not always
      one or the other.
- [ ] Zoom while recording (see camera plan §3), then check the
      **published** video: audio should still be in sync with the video
      throughout, not drifting — this is the one thing only real-device
      testing can actually confirm.
- [ ] Overlays placed over a video stay visually anchored in the same
      spot for the video's entire duration (they're static per spec, not
      animated/keyframed — confirm they don't drift or jump).

## 7. Publish reliability and draft recovery

- [ ] Tap Share Story with no network connectivity → "Couldn't publish" /
      similar error appears with a Retry button; every overlay, drawing
      stroke, filter, crop, caption, and audience choice is still intact
      underneath (not reset).
- [ ] Reconnect network, tap Retry → publish succeeds without needing to
      redo any edits.
- [ ] Mid-edit (some text placed, a filter chosen), force-quit the app
      entirely, relaunch, and navigate back into editing that exact same
      captured photo/video → the in-progress edits are restored
      automatically (crash-safe local draft).
- [ ] After a successful publish, confirm that same crash-recovery data is
      cleared (relaunching and reopening that file again should **not**
      re-offer the old, now-published draft).
- [ ] Tap the ✕ close button with meaningful edits present → a
      "Discard Story?" confirmation appears; confirm "Discard" clears the
      autosaved draft too (doesn't linger for a future accidental
      restore).

## 8. Accessibility (VoiceOver / TalkBack)

- [ ] Turn on the device's screen reader. Swipe through the camera and
      editor screens — every icon-only button (flash, timer, flip, close,
      Text, Stickers, Draw, Crop, mute, filter chips, style/align/color/
      size controls, draw tool controls) announces a meaningful label,
      not "button" or nothing.
- [ ] With the screen reader active, focus a canvas object and use its
      standard activation gesture (not a raw drag) → confirm
      OverlayAdjustSheet actually opens (this is the one thing that can't
      be verified any other way — it depends on the OS routing the
      accessibility action correctly, not just the app declaring it).
- [ ] From OverlayAdjustSheet with the screen reader on, activate each
      nudge/scale/rotate/Delete button → confirm each one actually
      performs the action a sighted user would get from the gesture.
- [ ] On the camera screen, use the screen reader's activation gesture on
      the capture button once (photo) and use its actions menu to trigger
      the "Record video" action → confirm both work without ever
      performing the raw hold-and-drag gesture.
- [ ] Turn on the OS "Reduce Motion" setting → double-tap-like a Story in
      the viewer (if applicable) and confirm animations that are purely
      decorative are shortened/instant, while the auto-advance progress
      timing is unaffected (it's functional, not decorative).
