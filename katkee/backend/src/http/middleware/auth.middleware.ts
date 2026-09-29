import { verifyAccessToken } from "../../modules/auth/tokens";
import { HttpError } from "../errors";
import type { KatkeeRequest } from "../router";

/** Extracts and verifies the Bearer access token, setting req.userId, or throws 401. */
export function requireAuth(req: KatkeeRequest): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing or malformed Authorization header.");
  }
  const token = header.slice("Bearer ".length);
  const claims = verifyAccessToken(token);
  if (!claims) {
    throw new HttpError(401, "Invalid or expired access token.");
  }
  req.userId = claims.sub;
}
