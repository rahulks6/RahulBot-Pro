import { HttpError } from "../../http/errors";
import * as mediaRepo from "../media/media.repository";
import * as auditRepo from "../audit/audit.repository";
import * as permissionsService from "../admin/permissions.service";
import * as permissionsRepo from "../admin/permissions.repository";
import * as usersRepo from "../users/users.repository";
import * as flagsRepo from "../feature-flags/flags.repository";
import * as adsRepo from "./ads.repository";
import type { Campaign, CampaignStatus } from "./ads.repository";
import type { CreateAdvertiserInput, CreateCampaignInput, CreateCreativeInput, AdEventType } from "./dto";
import { assertSafeCtaUrl } from "./dto";

/** Any of the five ads.* permissions (or SUPER_ADMIN) is enough to *read* the ads console; specific mutations still gate on their own specific permission below. */
async function requireAnyAdsAccess(viewerId: string) {
  if (!(await flagsRepo.isEnabled("ADMIN_CONSOLE_ENABLED"))) throw new HttpError(404, "The Admin Console is currently disabled.");
  const user = await usersRepo.findUserById(viewerId);
  if (!user || user.role !== "admin") throw new HttpError(403, "Admin access required.");
  if (user.isPrimaryAdmin) return user;
  const granted = await permissionsRepo.listForUser(user.id);
  if (!granted.some((g) => g.permission.startsWith("ads."))) {
    throw new HttpError(403, "Missing required permission: an ads.* permission.");
  }
  return user;
}

export async function createAdvertiser(actorId: string, input: CreateAdvertiserInput) {
  const actor = await permissionsService.requirePermission(actorId, "ads.create");
  const advertiser = await adsRepo.createAdvertiser({ name: input.name, contactEmail: input.contactEmail, createdBy: actor.id });
  await auditRepo.record({ actorId: actor.id, action: "advertiser.create", targetType: "advertiser", targetId: advertiser.id });
  return advertiser;
}

export async function listAdvertisers(viewerId: string) {
  await requireAnyAdsAccess(viewerId);
  return adsRepo.listAdvertisers();
}

export async function createCampaign(actorId: string, input: CreateCampaignInput): Promise<Campaign> {
  const actor = await permissionsService.requirePermission(actorId, "ads.create");
  const advertiser = await adsRepo.findAdvertiserById(input.advertiserId);
  if (!advertiser) throw new HttpError(404, "Advertiser not found.");
  const campaign = await adsRepo.createCampaign({ ...input, createdBy: actor.id });
  await auditRepo.record({ actorId: actor.id, action: "campaign.create", targetType: "ad_campaign", targetId: campaign.id });
  return campaign;
}

export async function listCampaigns(viewerId: string, status?: CampaignStatus) {
  await requireAnyAdsAccess(viewerId);
  return adsRepo.listCampaigns(status);
}

export async function getCampaign(viewerId: string, campaignId: string) {
  await requireAnyAdsAccess(viewerId);
  const campaign = await adsRepo.findCampaignById(campaignId);
  if (!campaign) throw new HttpError(404, "Campaign not found.");
  const [creatives, analytics] = await Promise.all([
    adsRepo.listCreativesForCampaign(campaignId),
    adsRepo.getCampaignAnalytics(campaignId),
  ]);
  return { campaign, creatives, analytics };
}

export async function addCreative(actorId: string, campaignId: string, input: CreateCreativeInput) {
  const actor = await permissionsService.requirePermission(actorId, "ads.edit");
  const campaign = await adsRepo.findCampaignById(campaignId);
  if (!campaign) throw new HttpError(404, "Campaign not found.");
  if (campaign.status !== "draft") throw new HttpError(409, "Creatives can only be added while a campaign is in draft.");

  const media = await mediaRepo.findMediaById(input.mediaId);
  if (!media || media.ownerId !== actor.id) throw new HttpError(404, "Media not found.");
  if (media.status !== "ready") throw new HttpError(409, "This media isn't ready to use as an ad creative yet.");
  assertSafeCtaUrl(input.ctaUrl);

  const creative = await adsRepo.createCreative({ campaignId, ...input });
  await auditRepo.record({ actorId: actor.id, action: "creative.create", targetType: "ad_creative", targetId: creative.id, metadata: { campaignId } });
  return creative;
}

/**
 * Every transition below is the same optimistic-locked, WHERE-guarded
 * single-statement UPDATE (ads.repository.ts's transitionStatus) — two
 * admins racing to review/pause/activate the same campaign can't both
 * "win," matching moderation.repository.ts's resolveReport concurrency
 * guarantee for the same class of race.
 */
async function requireTransition(
  actorId: string,
  permission: Parameters<typeof permissionsService.requirePermission>[1],
  campaignId: string,
  fromStatuses: CampaignStatus[],
  toStatus: CampaignStatus,
  action: string,
  extra: { reviewedBy?: string; rejectionReason?: string | null } = {},
): Promise<Campaign> {
  const actor = await permissionsService.requirePermission(actorId, permission);
  const won = await adsRepo.transitionStatus(campaignId, fromStatuses, toStatus, extra);
  if (!won) {
    const current = await adsRepo.findCampaignById(campaignId);
    if (!current) throw new HttpError(404, "Campaign not found.");
    throw new HttpError(409, `Campaign is '${current.status}', which can't transition to '${toStatus}' this way.`);
  }
  await auditRepo.record({ actorId: actor.id, action, targetType: "ad_campaign", targetId: campaignId });
  const updated = await adsRepo.findCampaignById(campaignId);
  if (!updated) throw new Error("Campaign not found immediately after updating it");
  return updated;
}

export async function submitForReview(actorId: string, campaignId: string): Promise<Campaign> {
  const creatives = await adsRepo.listCreativesForCampaign(campaignId);
  if (creatives.length === 0) throw new HttpError(409, "Add at least one creative before submitting for review.");
  return requireTransition(actorId, "ads.edit", campaignId, ["draft"], "pending_review", "campaign.submit_for_review");
}

export async function approveCampaign(actorId: string, campaignId: string): Promise<Campaign> {
  const actor = await permissionsService.requirePermission(actorId, "ads.review");
  const won = await adsRepo.transitionStatus(campaignId, ["pending_review"], "approved", { reviewedBy: actor.id });
  if (!won) throw new HttpError(409, "Campaign isn't pending review.");
  await auditRepo.record({ actorId: actor.id, action: "campaign.approve", targetType: "ad_campaign", targetId: campaignId });
  return (await adsRepo.findCampaignById(campaignId)) as Campaign;
}

export async function rejectCampaign(actorId: string, campaignId: string, reason: string): Promise<Campaign> {
  const actor = await permissionsService.requirePermission(actorId, "ads.review");
  const won = await adsRepo.transitionStatus(campaignId, ["pending_review"], "rejected", { reviewedBy: actor.id, rejectionReason: reason });
  if (!won) throw new HttpError(409, "Campaign isn't pending review.");
  await auditRepo.record({ actorId: actor.id, action: "campaign.reject", targetType: "ad_campaign", targetId: campaignId, metadata: { reason } });
  return (await adsRepo.findCampaignById(campaignId)) as Campaign;
}

export async function activateCampaign(actorId: string, campaignId: string): Promise<Campaign> {
  return requireTransition(actorId, "ads.edit", campaignId, ["approved", "paused"], "active", "campaign.activate");
}

export async function pauseCampaign(actorId: string, campaignId: string): Promise<Campaign> {
  return requireTransition(actorId, "ads.pause", campaignId, ["active"], "paused", "campaign.pause");
}

export async function completeCampaign(actorId: string, campaignId: string): Promise<Campaign> {
  return requireTransition(actorId, "ads.pause", campaignId, ["active", "paused"], "completed", "campaign.complete");
}

export async function getCampaignAnalytics(viewerId: string, campaignId: string) {
  await permissionsService.requirePermission(viewerId, "ads.analytics.read");
  const campaign = await adsRepo.findCampaignById(campaignId);
  if (!campaign) throw new HttpError(404, "Campaign not found.");
  return adsRepo.getCampaignAnalytics(campaignId);
}

export async function getAdSettings(viewerId: string) {
  await requireAnyAdsAccess(viewerId);
  return adsRepo.getAdSettings();
}

export async function setAdSettings(actorId: string, values: { minOrganicBetweenAds: number; maxAdsPerSession: number }) {
  const actor = await permissionsService.requireSuperAdmin(actorId);
  await adsRepo.setAdSettings(values, actor.id);
  await auditRepo.record({ actorId: actor.id, action: "ad_settings.update", metadata: values });
  return adsRepo.getAdSettings();
}

// --- Consumer-facing (any authenticated user) ------------------------------

export interface SponsoredSlot {
  campaignId: string;
  creativeId: string;
  mediaId: string;
  headline: string;
  bodyText: string;
  ctaLabel: string;
  ctaUrl: string;
}

/**
 * The whole "ads never influence organic ranking" guarantee (spec section
 * 28) lives in this function's isolation: it never reads a score, never
 * reads recommendation_events, and the feed-assembly caller (see
 * recommendation.service.ts) only ever *inserts* these slots between
 * already-ranked organic entries — it never reorders or removes one to
 * make room. If ads are disabled, unavailable, or there's no eligible
 * campaign, this returns an empty array and the feed is exactly what it
 * would have been with ads off entirely.
 */
export async function selectSponsoredSlots(viewerId: string, organicCount: number): Promise<SponsoredSlot[]> {
  const [adsEnabled, sponsoredEnabled] = await Promise.all([
    flagsRepo.isEnabled("ADS_ENABLED"),
    flagsRepo.isEnabled("SPONSORED_STORIES_ENABLED"),
  ]);
  if (!adsEnabled || !sponsoredEnabled) return [];

  const [campaigns, hiddenIds, settings] = await Promise.all([
    adsRepo.listActiveDeliverableCampaigns(),
    adsRepo.listHiddenCampaignIds(viewerId),
    adsRepo.getAdSettings(),
  ]);
  const hidden = new Set(hiddenIds);
  const eligible = campaigns.filter((c) => !hidden.has(c.id));
  if (eligible.length === 0 || settings.maxAdsPerSession <= 0) return [];

  // How many slots this feed's length actually supports, given the
  // server-configurable spacing — never hard-coded (spec section 37).
  const bySpacing = settings.minOrganicBetweenAds > 0 ? Math.floor(organicCount / (settings.minOrganicBetweenAds + 1)) : organicCount > 0 ? 1 : 0;
  const slotCount = Math.min(bySpacing, settings.maxAdsPerSession, eligible.length);
  if (slotCount <= 0) return [];

  const slots: SponsoredSlot[] = [];
  for (let i = 0; i < slotCount; i++) {
    const campaign = eligible[i % eligible.length] as Campaign;
    const creatives = await adsRepo.listCreativesForCampaign(campaign.id);
    const creative = creatives[0];
    if (!creative) continue;
    slots.push({
      campaignId: campaign.id,
      creativeId: creative.id,
      mediaId: creative.mediaId,
      headline: creative.headline,
      bodyText: creative.bodyText,
      ctaLabel: creative.ctaLabel,
      ctaUrl: creative.ctaUrl,
    });
  }
  return slots;
}

export async function recordAdEvent(viewerId: string, input: { campaignId: string; creativeId: string; eventType: AdEventType }): Promise<void> {
  const creative = await adsRepo.findCreativeById(input.creativeId);
  if (!creative || creative.campaignId !== input.campaignId) throw new HttpError(404, "Ad creative not found.");
  await adsRepo.recordEvent({ campaignId: input.campaignId, creativeId: input.creativeId, viewerId, eventType: input.eventType });
  if (input.eventType === "hide") {
    await adsRepo.hideCampaignForViewer(viewerId, input.campaignId);
  }
}

export interface WhyThisAd {
  countries: string[];
  languages: string[];
  minAge: number | null;
  maxAge: number | null;
  interests: string[];
}

/** Honest, non-fabricated targeting disclosure — literally the campaign's own stored targeting fields, nothing inferred or invented. */
export async function whyThisAd(campaignId: string): Promise<WhyThisAd> {
  const campaign = await adsRepo.findCampaignById(campaignId);
  if (!campaign) throw new HttpError(404, "Campaign not found.");
  return {
    countries: campaign.targetCountries,
    languages: campaign.targetLanguages,
    minAge: campaign.targetMinAge,
    maxAge: campaign.targetMaxAge,
    interests: campaign.targetInterests,
  };
}
