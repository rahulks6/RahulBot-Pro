import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { HttpError } from "../../http/errors";
import * as mediaService from "./media.service";
import * as mediaRepo from "./media.repository";
import { mediaStorage } from "./instance";
import type { MediaRecord } from "./media.repository";

function toPublicMedia(media: MediaRecord) {
  return {
    id: media.id,
    kind: media.kind,
    mimeType: media.mimeType,
    byteSize: media.byteSize,
    width: media.width,
    height: media.height,
    durationMs: media.durationMs,
    status: media.status,
    createdAt: media.createdAt,
  };
}

async function requireOwnedMedia(id: string, viewerId: string): Promise<MediaRecord> {
  const media = await mediaRepo.findMediaById(id);
  // Media isn't attached to any Story/audience yet (that's Phase 4), so for
  // now it's owner-only — not the eventual visibility rule, just what's
  // correct to enforce before Stories exist to grant broader access.
  if (!media || media.ownerId !== viewerId) throw new HttpError(404, "Media not found.");
  return media;
}

export function registerMediaRoutes(router: Router): void {
  router.post(
    "/api/v1/media/photos",
    async (req, res) => {
      requireAuth(req);
      const media = await mediaService.receiveUpload(req, req.userId as string, "photo", mediaStorage);
      sendJson(res, 201, { media: toPublicMedia(media) });
    },
    { rawBody: true },
  );

  router.post(
    "/api/v1/media/videos",
    async (req, res) => {
      requireAuth(req);
      const media = await mediaService.receiveUpload(req, req.userId as string, "video", mediaStorage);
      sendJson(res, 201, { media: toPublicMedia(media) });
    },
    { rawBody: true },
  );

  router.get("/api/v1/media/:id", async (req, res) => {
    requireAuth(req);
    const media = await requireOwnedMedia(req.params.id as string, req.userId as string);
    sendJson(res, 200, { media: toPublicMedia(media) });
  });

  router.get("/api/v1/media/:id/file", async (req, res) => {
    requireAuth(req);
    const media = await requireOwnedMedia(req.params.id as string, req.userId as string);

    res.writeHead(200, {
      "Content-Type": media.mimeType,
      "Content-Length": media.byteSize,
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: `"${media.checksumSha256}"`,
    });

    const stream = mediaStorage.readStream(media.storageKey);
    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      res.on("finish", resolve);
      res.on("close", resolve);
      stream.pipe(res);
    });
  });
}
