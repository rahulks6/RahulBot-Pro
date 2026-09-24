import { apiGet, apiPost } from "./client";

/**
 * Mirrors backend/src/modules/ads/{dto,ads.service}.ts — see the note atop
 * client.ts about keeping these in lockstep by hand. Consumer-facing only
 * (impression/click/hide/report/why-this-ad + the read-only targeting
 * disclosure); campaign/creative management lives in the web Admin Console
 * only, never in this app (spec: admin-managed ads, no advertiser
 * self-service portal in this mobile client).
 */
export type AdEventType = "impression" | "click" | "hide" | "report" | "why_this_ad_open";

export function recordAdEvent(
  input: { campaignId: string; creativeId: string; eventType: AdEventType },
  accessToken: string,
): Promise<void> {
  return apiPost("/api/v1/ads/events", input, accessToken);
}

export interface WhyThisAd {
  countries: string[];
  languages: string[];
  minAge: number | null;
  maxAge: number | null;
  interests: string[];
}

export function getWhyThisAd(campaignId: string, accessToken: string): Promise<WhyThisAd> {
  return apiGet(`/api/v1/ads/${campaignId}/why-this-ad`, accessToken);
}
