import React from "react";
import { EmptyState } from "../../components/EmptyState";

/** Real notifications ship in Phase 7, once likes/comments/follows exist to notify about. */
export function ActivityScreen(): React.JSX.Element {
  return <EmptyState title="No activity yet" message="Likes, comments, and follows will show up here." />;
}
