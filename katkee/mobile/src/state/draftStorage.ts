/**
 * Crash-safe autosave for an in-progress Story edit (spec section 42's
 * publish flow: "prepare media → persist local draft → upload → process →
 * publish" — a distinct step, not just "keep it in React state until
 * Share is tapped"). Keyed by the source media's own URI, since that's
 * the one stable thing available both when a draft is saved and when
 * StoryEditorScreen re-mounts on that same file after a crash or reload.
 * Same AsyncStorage-behind-an-interface pattern as tokenStorage.ts.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { StoryDraft } from "../models/storyDraft";

const KEY_PREFIX = "katkee.draft.";

function keyFor(mediaUri: string): string {
  return `${KEY_PREFIX}${mediaUri}`;
}

export interface SavedDraft {
  draft: StoryDraft;
  audience: "public" | "followers";
  mimeType: string;
  savedAt: string;
}

export async function savePendingDraft(mediaUri: string, saved: SavedDraft): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(mediaUri), JSON.stringify(saved));
  } catch {
    // Autosave is a safety net, not the primary path — a write failure here shouldn't interrupt editing.
  }
}

export async function loadPendingDraft(mediaUri: string): Promise<SavedDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(mediaUri));
    if (!raw) return null;
    return JSON.parse(raw) as SavedDraft;
  } catch {
    return null;
  }
}

export async function clearPendingDraft(mediaUri: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(mediaUri));
  } catch {
    // Best-effort — a stale leftover entry only ever offers a (harmless) restore prompt for a since-published/discarded Story.
  }
}
