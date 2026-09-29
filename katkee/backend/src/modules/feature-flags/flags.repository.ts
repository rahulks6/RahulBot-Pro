import { query, queryOne } from "../../db/psql";

export const FLAG_KEYS = ["ADMIN_CONSOLE_ENABLED", "ADS_ENABLED", "SPONSORED_STORIES_ENABLED", "AD_REPORTING_ENABLED"] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

export function isFlagKey(value: unknown): value is FlagKey {
  return typeof value === "string" && (FLAG_KEYS as readonly string[]).includes(value);
}

/**
 * Server-configurable flags (migration 0024), read on every request path
 * they gate (the recommendation feed's ad-insertion step, the ads module's
 * own routes). No in-process caching: this codebase already accepts one
 * psql-shim round trip per DB read elsewhere (recommendation.service.ts's
 * own documented tradeoff), and flags change rarely enough that an admin
 * flipping one should take effect on literally the next request, not after
 * some cache TTL.
 */
export async function isEnabled(key: FlagKey): Promise<boolean> {
  const row = await queryOne(`SELECT enabled FROM feature_flags WHERE key = :'key'`, { key });
  return row?.enabled === "t";
}

export interface FlagRow {
  key: FlagKey;
  enabled: boolean;
  updatedAt: string;
}

export async function listAll(): Promise<FlagRow[]> {
  const rows = await query(`SELECT key, enabled, updated_at FROM feature_flags ORDER BY key ASC`, {});
  return rows.map((row) => ({ key: row.key as FlagKey, enabled: row.enabled === "t", updatedAt: row.updated_at as string }));
}

export async function setEnabled(key: FlagKey, enabled: boolean, updatedBy: string): Promise<void> {
  await query(`UPDATE feature_flags SET enabled = :'enabled', updated_by = :'updated_by', updated_at = now() WHERE key = :'key'`, {
    key,
    enabled,
    updated_by: updatedBy,
  });
}
