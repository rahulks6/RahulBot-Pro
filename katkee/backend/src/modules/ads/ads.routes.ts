import type { Router } from "../../http/router";
import { requireAuth } from "../../http/middleware/auth.middleware";
import { sendJson } from "../../http/respond";
import { HttpError } from "../../http/errors";
import { parseQueryString } from "../../http/pagination";
import { ValidationError } from "../auth/dto";
import {
  parseCreateAdvertiserInput,
  parseCreateCampaignInput,
  parseCreateCreativeInput,
  parseRecordAdEventInput,
} from "./dto";
import type { CampaignStatus } from "./ads.repository";
import * as adsService from "./ads.service";

const CAMPAIGN_STATUSES: CampaignStatus[] = ["draft", "pending_review", "approved", "rejected", "active", "paused", "completed"];

function parseRejectReason(body: unknown): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (!reason) throw new ValidationError({ reason: "reason is required to reject a campaign." });
  return reason;
}

export function registerAdsRoutes(router: Router): void {
  // --- Admin Console: campaign/creative management, permission-gated ------

  router.post("/api/v1/admin/console/ads/advertisers", async (req, res) => {
    requireAuth(req);
    const input = parseCreateAdvertiserInput(req.body);
    const advertiser = await adsService.createAdvertiser(req.userId as string, input);
    sendJson(res, 201, { advertiser });
  });

  router.get("/api/v1/admin/console/ads/advertisers", async (req, res) => {
    requireAuth(req);
    const advertisers = await adsService.listAdvertisers(req.userId as string);
    sendJson(res, 200, { advertisers });
  });

  router.post("/api/v1/admin/console/ads/campaigns", async (req, res) => {
    requireAuth(req);
    const input = parseCreateCampaignInput(req.body);
    const campaign = await adsService.createCampaign(req.userId as string, input);
    sendJson(res, 201, { campaign });
  });

  router.get("/api/v1/admin/console/ads/campaigns", async (req, res) => {
    requireAuth(req);
    const query = parseQueryString(req.url ?? "");
    const statusParam = query.status;
    if (statusParam && !CAMPAIGN_STATUSES.includes(statusParam as CampaignStatus)) {
      throw new HttpError(422, `status must be one of: ${CAMPAIGN_STATUSES.join(", ")}.`);
    }
    const campaigns = await adsService.listCampaigns(req.userId as string, statusParam as CampaignStatus | undefined);
    sendJson(res, 200, { campaigns });
  });

  router.get("/api/v1/admin/console/ads/campaigns/:id", async (req, res) => {
    requireAuth(req);
    const result = await adsService.getCampaign(req.userId as string, req.params.id as string);
    sendJson(res, 200, result);
  });

  router.post("/api/v1/admin/console/ads/campaigns/:id/creatives", async (req, res) => {
    requireAuth(req);
    const input = parseCreateCreativeInput(req.body);
    const creative = await adsService.addCreative(req.userId as string, req.params.id as string, input);
    sendJson(res, 201, { creative });
  });

  router.post("/api/v1/admin/console/ads/campaigns/:id/submit", async (req, res) => {
    requireAuth(req);
    const campaign = await adsService.submitForReview(req.userId as string, req.params.id as string);
    sendJson(res, 200, { campaign });
  });

  router.post("/api/v1/admin/console/ads/campaigns/:id/approve", async (req, res) => {
    requireAuth(req);
    const campaign = await adsService.approveCampaign(req.userId as string, req.params.id as string);
    sendJson(res, 200, { campaign });
  });

  router.post("/api/v1/admin/console/ads/campaigns/:id/reject", async (req, res) => {
    requireAuth(req);
    const reason = parseRejectReason(req.body);
    const campaign = await adsService.rejectCampaign(req.userId as string, req.params.id as string, reason);
    sendJson(res, 200, { campaign });
  });

  router.post("/api/v1/admin/console/ads/campaigns/:id/activate", async (req, res) => {
    requireAuth(req);
    const campaign = await adsService.activateCampaign(req.userId as string, req.params.id as string);
    sendJson(res, 200, { campaign });
  });

  router.post("/api/v1/admin/console/ads/campaigns/:id/pause", async (req, res) => {
    requireAuth(req);
    const campaign = await adsService.pauseCampaign(req.userId as string, req.params.id as string);
    sendJson(res, 200, { campaign });
  });

  router.post("/api/v1/admin/console/ads/campaigns/:id/complete", async (req, res) => {
    requireAuth(req);
    const campaign = await adsService.completeCampaign(req.userId as string, req.params.id as string);
    sendJson(res, 200, { campaign });
  });

  router.get("/api/v1/admin/console/ads/campaigns/:id/analytics", async (req, res) => {
    requireAuth(req);
    const analytics = await adsService.getCampaignAnalytics(req.userId as string, req.params.id as string);
    sendJson(res, 200, { analytics });
  });

  router.get("/api/v1/admin/console/ads/settings", async (req, res) => {
    requireAuth(req);
    const settings = await adsService.getAdSettings(req.userId as string);
    sendJson(res, 200, { settings });
  });

  router.post("/api/v1/admin/console/ads/settings", async (req, res) => {
    requireAuth(req);
    const b = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const minOrganicBetweenAds = Number(b.minOrganicBetweenAds);
    const maxAdsPerSession = Number(b.maxAdsPerSession);
    if (!Number.isInteger(minOrganicBetweenAds) || minOrganicBetweenAds < 0) {
      throw new HttpError(422, "minOrganicBetweenAds must be a non-negative integer.");
    }
    if (!Number.isInteger(maxAdsPerSession) || maxAdsPerSession < 0) {
      throw new HttpError(422, "maxAdsPerSession must be a non-negative integer.");
    }
    const settings = await adsService.setAdSettings(req.userId as string, { minOrganicBetweenAds, maxAdsPerSession });
    sendJson(res, 200, { settings });
  });

  // --- Consumer-facing (any authenticated user) ----------------------------

  router.post("/api/v1/ads/events", async (req, res) => {
    requireAuth(req);
    const input = parseRecordAdEventInput(req.body);
    await adsService.recordAdEvent(req.userId as string, input);
    sendJson(res, 204, undefined);
  });

  router.get("/api/v1/ads/:campaignId/why-this-ad", async (req, res) => {
    requireAuth(req);
    const info = await adsService.whyThisAd(req.params.campaignId as string);
    sendJson(res, 200, info);
  });
}
