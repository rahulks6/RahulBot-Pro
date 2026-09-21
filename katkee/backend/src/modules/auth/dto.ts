/**
 * Hand-rolled request validation (no zod/class-validator — see package.json
 * networkSandboxLimitation). Each validator returns a typed, narrowed value
 * or throws ValidationError with a field-level message.
 */
export class ValidationError extends Error {
  constructor(public readonly fieldErrors: Record<string, string>) {
    super("Validation failed");
    this.name = "ValidationError";
  }
}

const USERNAME_RE = /^[a-z0-9_.]{3,30}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface SignupInput {
  username: string;
  email: string;
  password: string;
  displayName: string;
}

export function parseSignupInput(body: unknown): SignupInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const password = typeof b.password === "string" ? b.password : "";
  const displayName = typeof b.displayName === "string" ? b.displayName.trim() : "";

  if (!USERNAME_RE.test(username)) {
    errors.username = "Username must be 3-30 characters: lowercase letters, numbers, '.', or '_'.";
  }
  if (!EMAIL_RE.test(email)) {
    errors.email = "Must be a valid email address.";
  }
  if (password.length < 8) {
    errors.password = "Password must be at least 8 characters.";
  }
  if (password.length > 200) {
    errors.password = "Password is too long.";
  }
  if (displayName.length < 1 || displayName.length > 60) {
    errors.displayName = "Display name must be 1-60 characters.";
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { username, email, password, displayName };
}

export interface LoginInput {
  email: string;
  password: string;
}

export function parseLoginInput(body: unknown): LoginInput {
  const errors: Record<string, string> = {};
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const password = typeof b.password === "string" ? b.password : "";

  if (!EMAIL_RE.test(email)) errors.email = "Must be a valid email address.";
  if (!password) errors.password = "Password is required.";

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { email, password };
}

export interface RefreshInput {
  refreshToken: string;
}

export function parseRefreshInput(body: unknown): RefreshInput {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const refreshToken = typeof b.refreshToken === "string" ? b.refreshToken : "";
  if (!refreshToken) throw new ValidationError({ refreshToken: "refreshToken is required." });
  return { refreshToken };
}
