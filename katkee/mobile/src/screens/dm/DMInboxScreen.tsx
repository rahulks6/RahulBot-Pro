import React from "react";
import { EmptyState } from "../../components/EmptyState";

/** DM Inbox ships in Phase 8. */
export function DMInboxScreen(): React.JSX.Element {
  return <EmptyState title="No messages yet" message="Conversations with people you follow will appear here." />;
}
