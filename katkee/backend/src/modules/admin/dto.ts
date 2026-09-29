import { ValidationError } from "../auth/dto";
import { USERNAME_RE } from "../../shared/validation";
import { PERMISSIONS } from "./permissions";

export interface UsernameOnlyInput {
  username: string;
}

export function parseUsernameOnlyInput(body: unknown): UsernameOnlyInput {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
  if (!USERNAME_RE.test(username)) throw new ValidationError({ username: "username is required." });
  return { username };
}

export interface GrantPermissionInput {
  permission: string;
}

export function parseGrantPermissionInput(body: unknown): GrantPermissionInput {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const permission = typeof b.permission === "string" ? b.permission : "";
  if (!(PERMISSIONS as readonly string[]).includes(permission)) {
    throw new ValidationError({ permission: `permission must be one of: ${PERMISSIONS.join(", ")}.` });
  }
  return { permission };
}
