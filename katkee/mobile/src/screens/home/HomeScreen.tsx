import React from "react";
import { EmptyState } from "../../components/EmptyState";

/**
 * The full-screen Story feed (gestures, progress bars, like/comment/share)
 * ships in Phase 5 once Story publishing (Phase 3-4) exists to feed it —
 * see the KATKEE build plan. This screen is real Phase 1 wiring (it will
 * mount inside the authenticated tab navigator and later fetch the ranked
 * feed from a real endpoint), not a placeholder pretending to be the feed.
 */
export function HomeScreen(): React.JSX.Element {
  return (
    <EmptyState
      title="No active Stories yet"
      message="Once people you follow post, their Stories will appear here."
    />
  );
}
