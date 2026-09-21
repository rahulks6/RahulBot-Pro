import React from "react";
import { EmptyState } from "../../components/EmptyState";

/** People search ships in Phase 2 alongside the follow system it depends on. */
export function SearchScreen(): React.JSX.Element {
  return <EmptyState title="Search" message="Search for people will be available once the follow system ships." />;
}
