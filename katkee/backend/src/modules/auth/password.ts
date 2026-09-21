/**
 * Password hashing using Node's built-in scrypt (node:crypto), not bcrypt —
 * bcrypt is an npm package and this sandbox cannot install one. scrypt is a
 * memory-hard KDF in the same family as bcrypt/argon2 and is a legitimate,
 * widely-used choice for password storage; Node's implementation is backed
 * by OpenSSL. Never stores or logs a plaintext password.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(plainTextPassword: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = (await scrypt(plainTextPassword, salt, KEY_LENGTH)) as Buffer;
  return `scrypt:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(plainTextPassword: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, saltHex, keyHex] = parts;
  const salt = Buffer.from(saltHex as string, "hex");
  const expectedKey = Buffer.from(keyHex as string, "hex");
  const derivedKey = (await scrypt(plainTextPassword, salt, expectedKey.length)) as Buffer;
  if (derivedKey.length !== expectedKey.length) return false;
  return timingSafeEqual(derivedKey, expectedKey);
}
