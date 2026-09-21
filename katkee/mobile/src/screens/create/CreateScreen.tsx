import React from "react";
import { EmptyState } from "../../components/EmptyState";

/** Camera capture + Story editor ship in Phase 3. */
export function CreateScreen(): React.JSX.Element {
  return (
    <EmptyState
      title="Create isn't live yet"
      message="Camera capture and the Story editor are the next phase of the build."
    />
  );
}
