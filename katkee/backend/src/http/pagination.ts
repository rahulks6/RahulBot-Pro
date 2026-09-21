import { HttpError } from "./errors";

export interface Pagination {
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * OFFSET-based pagination — simple and correct for Phase 2's data volumes.
 * Worth revisiting as keyset pagination once real usage numbers exist and
 * OFFSET's linear scan cost on deep pages actually matters (see spec
 * section 52: "implementation can evolve as data grows").
 */
export function parsePagination(query: Record<string, string | undefined>): Pagination {
  const limitRaw = query.limit;
  const offsetRaw = query.offset;

  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    limit = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new HttpError(422, `limit must be an integer between 1 and ${MAX_LIMIT}.`);
    }
  }

  let offset = 0;
  if (offsetRaw !== undefined) {
    offset = Number.parseInt(offsetRaw, 10);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new HttpError(422, "offset must be a non-negative integer.");
    }
  }

  return { limit, offset };
}

export function parseQueryString(url: string): Record<string, string | undefined> {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return {};
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}
