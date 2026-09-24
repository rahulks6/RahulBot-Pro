import { ValidationError } from "../auth/dto";

const MAX_NAME_LENGTH = 200;
const MAX_TEXT_LENGTH = 1000;
const ISO_COUNTRY_RE = /^[A-Z]{2}$/;
const LANGUAGE_RE = /^[a-z]{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

function requireNonBlankString(value: unknown, field: string, maxLength: number, errors: Record<string, string>): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    errors[field] = `${field} is required (max ${maxLength} characters).`;
    return "";
  }
  return value.trim();
}

function parseStringArray(value: unknown, field: string, pattern: RegExp, errors: Record<string, string>): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && pattern.test(v))) {
    errors[field] = `${field} must be an array of valid codes.`;
    return [];
  }
  return value;
}

export interface CreateAdvertiserInput {
  name: string;
  contactEmail: string | null;
}

export function parseCreateAdvertiserInput(body: unknown): CreateAdvertiserInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const name = requireNonBlankString(b.name, "name", MAX_NAME_LENGTH, errors);
  const contactEmail = typeof b.contactEmail === "string" && b.contactEmail.trim() ? b.contactEmail.trim() : null;
  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { name, contactEmail };
}

export interface CreateCampaignInput {
  advertiserId: string;
  name: string;
  targetCountries: string[];
  targetLanguages: string[];
  targetMinAge: number | null;
  targetMaxAge: number | null;
  targetInterests: string[];
}

export function parseCreateCampaignInput(body: unknown): CreateCampaignInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const advertiserId = typeof b.advertiserId === "string" ? b.advertiserId : "";
  if (!UUID_RE.test(advertiserId)) errors.advertiserId = "advertiserId must be a valid id.";

  const name = requireNonBlankString(b.name, "name", MAX_NAME_LENGTH, errors);
  const targetCountries = parseStringArray(b.targetCountries, "targetCountries", ISO_COUNTRY_RE, errors);
  const targetLanguages = parseStringArray(b.targetLanguages, "targetLanguages", LANGUAGE_RE, errors);
  const targetInterests = parseStringArray(b.targetInterests, "targetInterests", /^[a-z0-9_-]{1,40}$/, errors);

  let targetMinAge: number | null = null;
  if (b.targetMinAge !== undefined && b.targetMinAge !== null) {
    targetMinAge = Number(b.targetMinAge);
    if (!Number.isInteger(targetMinAge) || targetMinAge < 13 || targetMinAge > 100) errors.targetMinAge = "targetMinAge must be an integer between 13 and 100.";
  }
  let targetMaxAge: number | null = null;
  if (b.targetMaxAge !== undefined && b.targetMaxAge !== null) {
    targetMaxAge = Number(b.targetMaxAge);
    if (!Number.isInteger(targetMaxAge) || targetMaxAge < 13 || targetMaxAge > 100) errors.targetMaxAge = "targetMaxAge must be an integer between 13 and 100.";
  }
  if (targetMinAge !== null && targetMaxAge !== null && targetMinAge > targetMaxAge) {
    errors.targetMinAge = "targetMinAge must be <= targetMaxAge.";
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { advertiserId, name, targetCountries, targetLanguages, targetMinAge, targetMaxAge, targetInterests };
}

/**
 * A real safety check, not a formality: only http(s) absolute URLs are
 * accepted, so a creative's CTA can never carry a javascript:/data:/file:
 * URL or any other scheme a client might be tricked into treating as
 * "just a link."
 */
export function assertSafeCtaUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError({ ctaUrl: "ctaUrl must be a valid absolute URL." });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError({ ctaUrl: "ctaUrl must use http or https." });
  }
}

export interface CreateCreativeInput {
  mediaId: string;
  headline: string;
  bodyText: string;
  ctaLabel: string;
  ctaUrl: string;
}

export function parseCreateCreativeInput(body: unknown): CreateCreativeInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const mediaId = typeof b.mediaId === "string" ? b.mediaId : "";
  if (!UUID_RE.test(mediaId)) errors.mediaId = "mediaId must be a valid id.";

  const headline = requireNonBlankString(b.headline, "headline", 120, errors);
  const bodyText = typeof b.bodyText === "string" && b.bodyText.length <= MAX_TEXT_LENGTH ? b.bodyText.trim() : "";
  const ctaLabel = typeof b.ctaLabel === "string" && b.ctaLabel.trim() ? b.ctaLabel.trim().slice(0, 40) : "Learn More";
  const ctaUrl = requireNonBlankString(b.ctaUrl, "ctaUrl", 2000, errors);

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  assertSafeCtaUrl(ctaUrl);
  return { mediaId, headline, bodyText, ctaLabel, ctaUrl };
}

export type AdEventType = "impression" | "click" | "hide" | "report" | "why_this_ad_open";
const AD_EVENT_TYPES: AdEventType[] = ["impression", "click", "hide", "report", "why_this_ad_open"];

export interface RecordAdEventInput {
  campaignId: string;
  creativeId: string;
  eventType: AdEventType;
}

export function parseRecordAdEventInput(body: unknown): RecordAdEventInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const campaignId = typeof b.campaignId === "string" ? b.campaignId : "";
  if (!UUID_RE.test(campaignId)) errors.campaignId = "campaignId must be a valid id.";
  const creativeId = typeof b.creativeId === "string" ? b.creativeId : "";
  if (!UUID_RE.test(creativeId)) errors.creativeId = "creativeId must be a valid id.";
  const eventType = b.eventType as AdEventType;
  if (!AD_EVENT_TYPES.includes(eventType)) errors.eventType = `eventType must be one of: ${AD_EVENT_TYPES.join(", ")}.`;

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { campaignId, creativeId, eventType };
}
