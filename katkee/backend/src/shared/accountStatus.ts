import { HttpError } from "../http/errors";
import * as usersRepo from "../modules/users/users.repository";

/**
 * The RESTRICTED account state (migration 0023) is deliberately checked
 * only at these specific action points — publishing a Story, posting a
 * comment, starting a brand-new DM conversation — never at login, token
 * refresh, or reading anything. A restricted user keeps browsing normally;
 * they just can't create new public-facing content or contact someone new
 * until a moderator lifts the restriction (see moderation.service.ts's
 * restrictUserByUsername/unrestrictUserByUsername).
 */
export async function assertNotRestricted(userId: string, action: string): Promise<void> {
  const user = await usersRepo.findUserById(userId);
  if (user?.accountStatus === "restricted") {
    throw new HttpError(403, `Your account is restricted and can't ${action} right now.`);
  }
}
