/** Best-effort fallback when a picker/camera library doesn't hand back a MIME type directly. */
export function guessMimeTypeFromUri(uri: string, kind: "photo" | "video"): string {
  const lower = uri.toLowerCase();
  if (kind === "photo") {
    if (lower.endsWith(".png")) return "image/png";
    return "image/jpeg"; // vision-camera's default photo format
  }
  if (lower.endsWith(".mov")) return "video/quicktime"; // iOS's AVFoundation default container
  return "video/mp4"; // Android's default container
}
