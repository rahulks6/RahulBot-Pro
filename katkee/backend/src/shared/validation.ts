import { HttpError } from "../http/errors";

export const USERNAME_RE = /^[a-z0-9_.]{3,30}$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function parseUsernameParam(value: string | undefined): string {
  const username = (value ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, "Invalid username.");
  }
  return username;
}
