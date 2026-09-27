import { randomBytes } from 'node:crypto';

/** Short, prefixed, URL-safe random id, e.g. `shot_3kq9x0v2m1ab`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9)
    .toString('base64url')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}`;
}
