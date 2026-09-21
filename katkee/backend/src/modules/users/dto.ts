import { ValidationError } from "../auth/dto";
import type { UpdateProfileInput } from "./profiles.service";

const MAX_BIO_LENGTH = 150;

export function parseUpdateProfileInput(body: unknown): UpdateProfileInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const result: UpdateProfileInput = {};

  if (b.displayName !== undefined) {
    if (typeof b.displayName !== "string" || b.displayName.trim().length < 1 || b.displayName.trim().length > 60) {
      errors.displayName = "Display name must be 1-60 characters.";
    } else {
      result.displayName = b.displayName.trim();
    }
  }

  if (b.bio !== undefined) {
    if (typeof b.bio !== "string" || b.bio.length > MAX_BIO_LENGTH) {
      errors.bio = `Bio must be at most ${MAX_BIO_LENGTH} characters.`;
    } else {
      result.bio = b.bio;
    }
  }

  if (b.isPrivate !== undefined) {
    if (typeof b.isPrivate !== "boolean") {
      errors.isPrivate = "isPrivate must be a boolean.";
    } else {
      result.isPrivate = b.isPrivate;
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return result;
}

export function parseSearchQuery(q: string | undefined): string {
  const term = (q ?? "").trim();
  if (term.length < 1 || term.length > 60) {
    throw new ValidationError({ q: "q must be 1-60 characters." });
  }
  return term;
}
