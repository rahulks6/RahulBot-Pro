import { HttpError } from "../../http/errors";
import * as auditRepo from "../audit/audit.repository";
import * as permissionsService from "../admin/permissions.service";
import * as flagsRepo from "./flags.repository";
import { isFlagKey, type FlagKey } from "./flags.repository";

/** Cheap, unauthenticated-safe reads for gating behavior elsewhere (ads module, recommendation feed). */
export function isEnabled(key: FlagKey): Promise<boolean> {
  return flagsRepo.isEnabled(key);
}

/** SUPER_ADMIN-only — flipping a flag is a whole-app behavior change, not a single admin's call to make alone. */
export async function listFlags(viewerId: string) {
  await permissionsService.requireSuperAdmin(viewerId);
  return flagsRepo.listAll();
}

export async function setFlag(viewerId: string, key: string, enabled: boolean) {
  const actor = await permissionsService.requireSuperAdmin(viewerId);
  if (!isFlagKey(key)) throw new HttpError(422, "Unknown feature flag.");
  await flagsRepo.setEnabled(key, enabled, actor.id);
  await auditRepo.record({
    actorId: actor.id,
    action: "feature_flag.set",
    targetType: "feature_flag",
    metadata: { key, enabled },
  });
  return flagsRepo.listAll();
}
