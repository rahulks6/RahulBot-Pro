import { API_BASE_URL, ApiError, apiGet } from "./client";

export interface UploadedMedia {
  id: string;
  kind: "photo" | "video";
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: "processing" | "ready" | "failed";
  createdAt: string;
}

export type UploadProgressState = "preparing" | "uploading" | "processing" | "published" | "failed";

/**
 * The backend accepts a raw binary body (no multipart parser is available
 * server-side — see backend/README.md), so a captured/picked file is read
 * as a Blob first. React Native's fetch/XHR polyfill resolves a local
 * `file://`/`content://`/`ph://` URI's bytes into a real Blob without any
 * extra package — this isn't a workaround, it's the documented mechanism.
 */
async function fileUriToBlob(uri: string): Promise<Blob> {
  const response = await fetch(uri);
  return response.blob();
}

async function uploadBlob(path: string, blob: Blob, mimeType: string, accessToken: string): Promise<UploadedMedia> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": mimeType, Authorization: `Bearer ${accessToken}` },
    body: blob,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const message = typeof json?.message === "string" ? json.message : "Upload failed.";
    throw new ApiError(res.status, message, json?.fields);
  }
  return json.media as UploadedMedia;
}

export async function uploadPhoto(localUri: string, mimeType: string, accessToken: string): Promise<UploadedMedia> {
  const blob = await fileUriToBlob(localUri);
  return uploadBlob("/api/v1/media/photos", blob, mimeType, accessToken);
}

export async function uploadVideo(localUri: string, mimeType: string, accessToken: string): Promise<UploadedMedia> {
  const blob = await fileUriToBlob(localUri);
  return uploadBlob("/api/v1/media/videos", blob, mimeType, accessToken);
}

/** Media access is owner-only unless it's attached to a Story the caller can see (backend Phase 4 rule). */
export async function getMedia(mediaId: string, accessToken: string): Promise<UploadedMedia> {
  const res = await apiGet<{ media: UploadedMedia }>(`/api/v1/media/${mediaId}`, accessToken);
  return res.media;
}
