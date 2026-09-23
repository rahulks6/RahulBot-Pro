# Manual test plan: Camera (`CameraScreen.tsx`)

Everything in this module is correct-by-inspection TypeScript, written
against `react-native-vision-camera`'s real v4 API, but has never run —
this sandbox has no device, simulator, or `npm install` access (see
`README.md`). Run this checklist on a real device after bootstrapping the
native project (see README's "To actually run this" section) before
trusting any of it. Test on both iOS and Android, and on at least one
older/lower-spec device if available — hand-rolled `PanResponder`
multitouch math is exactly the kind of code that behaves differently
across devices.

Check off each row only after confirming it on-device, not by reading
the code.

## 1. Permissions

- [ ] Fresh install, first launch of Camera: OS permission prompts for
      camera and microphone appear.
- [ ] Deny both → the screen shows "Camera access needed" (`EmptyState`),
      not a crash or a blank screen.
- [ ] From denied, grant permission in OS Settings, background and
      foreground the app (or re-enter the Camera tab) → the screen
      recovers to the live preview without needing to restart the app.
- [ ] Deny only microphone, allow camera → decide/confirm what the screen
      shows (currently: same "Camera access needed" state, since photo
      capture doesn't strictly need mic — if this is wrong on-device,
      it's a real bug to fix, not a spec question).

## 2. Basic capture

- [ ] Tap-and-release the capture button quickly → a photo is taken and
      the app navigates to the Story editor with that photo.
- [ ] Press-and-hold the capture button → recording starts (red badge +
      timer appear) after the ~250ms hold delay, not instantly on touch
      down.
- [ ] Release after a few seconds → recording stops, the app navigates to
      the editor with that video.
- [ ] Record for the full 60 seconds → recording auto-stops at the limit
      and still navigates to the editor correctly.
- [ ] Timer toggle (Timer → 3s → 10s → off) delays a **photo** capture by
      that many seconds before the shutter actually fires; the delay is
      visible/expected, not silent.

## 3. Zoom

- [ ] Two-finger pinch out/in anywhere on the preview zooms smoothly and
      continuously (no visible steps/jumps), clamped at the device's own
      min/max zoom (`device.minZoom`/`maxZoom`).
- [ ] Zoom badge ("Nx") appears during a pinch and fades out after
      release; the number tracks the actual zoom level in real time.
- [ ] **One-finger record-and-drag-to-zoom**: press-and-hold the capture
      button to start recording, then without lifting, drag the same
      finger up → zoom increases smoothly; drag down → zoom decreases.
      Confirm this works *while already recording*, not just at the
      start of the gesture.
- [ ] During that same drag-to-zoom, confirm no other gesture (tap-focus,
      filter change, flip) is triggered by the vertical motion — only
      zoom.
- [ ] Zoom set via pinch persists correctly into a photo taken immediately
      after (not reset to 1x).

## 4. Focus and flip

- [ ] A single tap on the preview (not on the capture button) shows a
      focus indicator at the tapped point and the image visibly refocuses
      there.
- [ ] A double-tap on the preview flips front/back camera.
- [ ] The dedicated Flip button also flips front/back camera.
- [ ] After flipping, tap-focus and pinch-zoom both still work correctly
      on the new camera.
- [ ] Flash toggle actually changes flash behavior on a real photo capture
      (on = fires flash, off = doesn't) — this can only be confirmed
      on-device, a simulator won't show it.

## 5. Gallery import

- [ ] Gallery button opens the native photo/video picker.
- [ ] Selecting a photo goes straight to the Story editor with that photo,
      one tap, no intermediate screen.
- [ ] Selecting a video does the same, and the editor correctly detects
      it as a video (audio mute control appears, video plays in preview).
- [ ] Cancelling the picker returns cleanly to the camera preview (no
      crash, no stuck loading state).

## 6. Interruptions

- [ ] Background the app mid-recording (e.g. incoming call) → confirm
      what actually happens (recording should stop cleanly, not corrupt
      or hang) and fix if it doesn't.
- [ ] Rotate the device during preview/recording, if the app doesn't lock
      orientation — confirm the preview doesn't distort or crash.
