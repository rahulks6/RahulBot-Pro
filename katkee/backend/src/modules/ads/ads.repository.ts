import { nullable, query, queryOne, type Row } from "../../db/psql";

export type CampaignStatus = "draft" | "pending_review" | "approved" | "rejected" | "active" | "paused" | "completed";

export interface Advertiser {
  id: string;
  name: string;
  contactEmail: string | null;
  createdBy: string;
  createdAt: string;
}

function mapAdvertiser(row: Row): Advertiser {
  return {
    id: row.id as string,
    name: row.name as string,
    contactEmail: (row.contact_email as string | null) ?? null,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
  };
}

export async function createAdvertiser(input: { name: string; contactEmail: string | null; createdBy: string }): Promise<Advertiser> {
  const row = await queryOne(
    `INSERT INTO advertisers (name, contact_email, created_by)
     VALUES (:'name', ${nullable("contact_email")}, :'created_by')
     RETURNING id, name, contact_email, created_by, created_at`,
    { name: input.name, contact_email: input.contactEmail ?? "", created_by: input.createdBy },
  );
  if (!row) throw new Error("Insert did not return a row");
  return mapAdvertiser(row);
}

export async function listAdvertisers(): Promise<Advertiser[]> {
  const rows = await query(`SELECT id, name, contact_email, created_by, created_at FROM advertisers ORDER BY created_at DESC`, {});
  return rows.map(mapAdvertiser);
}

export async function findAdvertiserById(id: string): Promise<Advertiser | null> {
  const row = await queryOne(`SELECT id, name, contact_email, created_by, created_at FROM advertisers WHERE id = :'id'`, { id });
  return row ? mapAdvertiser(row) : null;
}

export interface Campaign {
  id: string;
  advertiserId: string;
  name: string;
  status: CampaignStatus;
  dailyBudgetCents: number | null;
  startsAt: string | null;
  endsAt: string | null;
  targetCountries: string[];
  targetLanguages: string[];
  targetMinAge: number | null;
  targetMaxAge: number | null;
  targetInterests: string[];
  createdBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const CAMPAIGN_COLUMNS =
  "id, advertiser_id, name, status, daily_budget_cents, starts_at, ends_at, target_countries, target_languages, " +
  "target_min_age, target_max_age, target_interests, created_by, reviewed_by, reviewed_at, rejection_reason, created_at, updated_at";

/** Same jsonb-array-of-strings convention stories.repository.ts's overlays/drawing columns already use (see its parseJsonArray). */
function parseStringArrayJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function mapCampaign(row: Row): Campaign {
  return {
    id: row.id as string,
    advertiserId: row.advertiser_id as string,
    name: row.name as string,
    status: row.status as CampaignStatus,
    dailyBudgetCents: row.daily_budget_cents === null ? null : Number(row.daily_budget_cents),
    startsAt: (row.starts_at as string | null) ?? null,
    endsAt: (row.ends_at as string | null) ?? null,
    targetCountries: parseStringArrayJson(row.target_countries),
    targetLanguages: parseStringArrayJson(row.target_languages),
    targetMinAge: row.target_min_age === null ? null : Number(row.target_min_age),
    targetMaxAge: row.target_max_age === null ? null : Number(row.target_max_age),
    targetInterests: parseStringArrayJson(row.target_interests),
    createdBy: row.created_by as string,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    rejectionReason: (row.rejection_reason as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createCampaign(input: {
  advertiserId: string;
  name: string;
  createdBy: string;
  targetCountries: string[];
  targetLanguages: string[];
  targetMinAge: number | null;
  targetMaxAge: number | null;
  targetInterests: string[];
}): Promise<Campaign> {
  const row = await queryOne(
    `INSERT INTO ad_campaigns (advertiser_id, name, created_by, target_countries, target_languages, target_min_age, target_max_age, target_interests)
     VALUES (:'advertiser_id', :'name', :'created_by', :'target_countries'::jsonb, :'target_languages'::jsonb, ${nullable("target_min_age", "int")}, ${nullable("target_max_age", "int")}, :'target_interests'::jsonb)
     RETURNING ${CAMPAIGN_COLUMNS}`,
    {
      advertiser_id: input.advertiserId,
      name: input.name,
      created_by: input.createdBy,
      target_countries: JSON.stringify(input.targetCountries),
      target_languages: JSON.stringify(input.targetLanguages),
      target_min_age: input.targetMinAge ?? "",
      target_max_age: input.targetMaxAge ?? "",
      target_interests: JSON.stringify(input.targetInterests),
    },
  );
  if (!row) throw new Error("Insert did not return a row");
  return mapCampaign(row);
}

export async function findCampaignById(id: string): Promise<Campaign | null> {
  const row = await queryOne(`SELECT ${CAMPAIGN_COLUMNS} FROM ad_campaigns WHERE id = :'id'`, { id });
  return row ? mapCampaign(row) : null;
}

export async function listCampaigns(status?: CampaignStatus): Promise<Campaign[]> {
  const rows = status
    ? await query(`SELECT ${CAMPAIGN_COLUMNS} FROM ad_campaigns WHERE status = :'status' ORDER BY created_at DESC`, { status })
    : await query(`SELECT ${CAMPAIGN_COLUMNS} FROM ad_campaigns ORDER BY created_at DESC`, {});
  return rows.map(mapCampaign);
}

/** Every ACTIVE campaign whose flight window (if any) covers right now — the real delivery-eligibility candidate set. */
export async function listActiveDeliverableCampaigns(): Promise<Campaign[]> {
  const rows = await query(
    `SELECT ${CAMPAIGN_COLUMNS} FROM ad_campaigns
     WHERE status = 'active'
       AND (starts_at IS NULL OR starts_at <= now())
       AND (ends_at IS NULL OR ends_at > now())
     ORDER BY created_at ASC`,
    {},
  );
  return rows.map(mapCampaign);
}

/**
 * Every status transition is a single-statement, WHERE-guarded UPDATE —
 * the same optimistic-locking shape moderation.repository.ts's
 * resolveReport uses, so two admins racing to review/pause the same
 * campaign can't both "win."
 */
export async function transitionStatus(
  id: string,
  fromStatuses: CampaignStatus[],
  toStatus: CampaignStatus,
  extra: { reviewedBy?: string; rejectionReason?: string | null } = {},
): Promise<boolean> {
  const fromList = fromStatuses.map((s) => `'${s}'`).join(", ");
  const setReview = extra.reviewedBy
    ? `, reviewed_by = :'reviewed_by', reviewed_at = now()`
    : "";
  const setRejection = extra.rejectionReason !== undefined ? `, rejection_reason = ${nullable("rejection_reason")}` : "";
  const rows = await query(
    `UPDATE ad_campaigns
     SET status = :'to_status', updated_at = now()${setReview}${setRejection}
     WHERE id = :'id' AND status IN (${fromList})
     RETURNING id`,
    { id, to_status: toStatus, reviewed_by: extra.reviewedBy ?? "", rejection_reason: extra.rejectionReason ?? "" },
  );
  return rows.length > 0;
}

export interface Creative {
  id: string;
  campaignId: string;
  mediaId: string;
  headline: string;
  bodyText: string;
  ctaLabel: string;
  ctaUrl: string;
  createdAt: string;
}

function mapCreative(row: Row): Creative {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    mediaId: row.media_id as string,
    headline: row.headline as string,
    bodyText: row.body_text as string,
    ctaLabel: row.cta_label as string,
    ctaUrl: row.cta_url as string,
    createdAt: row.created_at as string,
  };
}

export async function createCreative(input: {
  campaignId: string;
  mediaId: string;
  headline: string;
  bodyText: string;
  ctaLabel: string;
  ctaUrl: string;
}): Promise<Creative> {
  const row = await queryOne(
    `INSERT INTO ad_creatives (campaign_id, media_id, headline, body_text, cta_label, cta_url)
     VALUES (:'campaign_id', :'media_id', :'headline', :'body_text', :'cta_label', :'cta_url')
     RETURNING id, campaign_id, media_id, headline, body_text, cta_label, cta_url, created_at`,
    {
      campaign_id: input.campaignId,
      media_id: input.mediaId,
      headline: input.headline,
      body_text: input.bodyText,
      cta_label: input.ctaLabel,
      cta_url: input.ctaUrl,
    },
  );
  if (!row) throw new Error("Insert did not return a row");
  return mapCreative(row);
}

export async function listCreativesForCampaign(campaignId: string): Promise<Creative[]> {
  const rows = await query(
    `SELECT id, campaign_id, media_id, headline, body_text, cta_label, cta_url, created_at
     FROM ad_creatives WHERE campaign_id = :'campaign_id' ORDER BY created_at ASC`,
    { campaign_id: campaignId },
  );
  return rows.map(mapCreative);
}

export async function findCreativeById(id: string): Promise<Creative | null> {
  const row = await queryOne(
    `SELECT id, campaign_id, media_id, headline, body_text, cta_label, cta_url, created_at FROM ad_creatives WHERE id = :'id'`,
    { id },
  );
  return row ? mapCreative(row) : null;
}

export type AdEventType = "impression" | "click" | "hide" | "report" | "why_this_ad_open";

export async function recordEvent(input: {
  campaignId: string;
  creativeId: string;
  viewerId: string;
  eventType: AdEventType;
}): Promise<void> {
  await query(
    `INSERT INTO ad_events (campaign_id, creative_id, viewer_id, event_type)
     VALUES (:'campaign_id', :'creative_id', :'viewer_id', :'event_type')`,
    { campaign_id: input.campaignId, creative_id: input.creativeId, viewer_id: input.viewerId, event_type: input.eventType },
  );
}

export interface CampaignAnalytics {
  impressions: number;
  clicks: number;
  hides: number;
  reports: number;
}

/** Real counts from real ad_events rows — never fabricated (spec's own explicit requirement). */
export async function getCampaignAnalytics(campaignId: string): Promise<CampaignAnalytics> {
  const rows = await query(
    `SELECT event_type, COUNT(*) AS n FROM ad_events WHERE campaign_id = :'campaign_id' GROUP BY event_type`,
    { campaign_id: campaignId },
  );
  const counts: CampaignAnalytics = { impressions: 0, clicks: 0, hides: 0, reports: 0 };
  for (const row of rows) {
    const n = Number(row.n ?? 0);
    if (row.event_type === "impression") counts.impressions = n;
    else if (row.event_type === "click") counts.clicks = n;
    else if (row.event_type === "hide") counts.hides = n;
    else if (row.event_type === "report") counts.reports = n;
  }
  return counts;
}

export async function hideCampaignForViewer(viewerId: string, campaignId: string): Promise<void> {
  await query(
    `INSERT INTO ad_hidden (viewer_id, campaign_id) VALUES (:'viewer_id', :'campaign_id') ON CONFLICT DO NOTHING`,
    { viewer_id: viewerId, campaign_id: campaignId },
  );
}

export async function listHiddenCampaignIds(viewerId: string): Promise<string[]> {
  const rows = await query(`SELECT campaign_id FROM ad_hidden WHERE viewer_id = :'viewer_id'`, { viewer_id: viewerId });
  return rows.map((r) => r.campaign_id as string);
}

export interface AdSettings {
  minOrganicBetweenAds: number;
  maxAdsPerSession: number;
}

export async function getAdSettings(): Promise<AdSettings> {
  const row = await queryOne(`SELECT min_organic_between_ads, max_ads_per_session FROM ad_settings WHERE id = 1`, {});
  return {
    minOrganicBetweenAds: Number(row?.min_organic_between_ads ?? 5),
    maxAdsPerSession: Number(row?.max_ads_per_session ?? 3),
  };
}

export async function setAdSettings(values: { minOrganicBetweenAds: number; maxAdsPerSession: number }, updatedBy: string): Promise<void> {
  await query(
    `UPDATE ad_settings SET min_organic_between_ads = :'min_organic_between_ads', max_ads_per_session = :'max_ads_per_session',
       updated_by = :'updated_by', updated_at = now() WHERE id = 1`,
    { min_organic_between_ads: values.minOrganicBetweenAds, max_ads_per_session: values.maxAdsPerSession, updated_by: updatedBy },
  );
}
