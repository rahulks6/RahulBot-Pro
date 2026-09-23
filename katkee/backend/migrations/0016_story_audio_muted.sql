-- StoryEditorScreen's mute/unmute toggle (spec section 44: "original
-- recorded audio kept by default with a simple mute/unmute control that
-- affects the published Story") only ever controlled the editor's own
-- preview playback — publishStory never sent it, so a muted preview still
-- published with audio on. Same class of bug migration 0015 fixed for
-- overlays/filter/drawing, for the same reason: real UI, discarded state.
ALTER TABLE stories ADD COLUMN audio_muted BOOLEAN NOT NULL DEFAULT false;
