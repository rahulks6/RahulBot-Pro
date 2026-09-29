/**
 * One-time, idempotent bootstrap for the primary admin — the one account
 * that can grant/revoke moderator and admin access to everyone else (see
 * moderation.service.ts's requireAdmin/promoteUser/demoteUser), and the
 * one account nothing in the app itself can ever demote or suspend.
 *
 * There is deliberately no HTTP endpoint for this: creating the very
 * first admin from inside the app would mean either a hard-coded
 * account or a self-serve "make me admin" button, neither of which is
 * safe. Instead: sign up a normal account through the app first, set
 * PRIMARY_ADMIN_EMAIL to that account's email, then run this script
 * once (`npm run seed:admin`).
 *
 * Safe to run any number of times: if a primary admin already exists,
 * it does nothing and says so — it never moves primary-admin status
 * from one account to another. Migration 0020's unique partial index
 * on is_primary_admin is the real backstop for that; this is the
 * friendly, specific message explaining why nothing changed.
 */
import { config } from "../src/config/env";
import * as usersRepo from "../src/modules/users/users.repository";

async function main(): Promise<void> {
  const email = config.admin.primaryAdminEmail;
  if (!email) {
    console.log("PRIMARY_ADMIN_EMAIL is not set — nothing to do. Set it in .env and re-run this script to seed a primary admin.");
    return;
  }

  const existing = await usersRepo.findPrimaryAdmin();
  if (existing) {
    if (existing.email === email) {
      console.log(`${email} is already the primary admin — nothing to do.`);
    } else {
      console.log(
        `A primary admin already exists (${existing.email}) — PRIMARY_ADMIN_EMAIL (${email}) was ignored. ` +
          `The app never moves primary-admin status between accounts automatically.`,
      );
    }
    return;
  }

  const user = await usersRepo.findUserByEmail(email);
  if (!user) {
    console.log(`No account with email ${email} exists yet. Sign up through the app first, then re-run this script.`);
    return;
  }

  await usersRepo.grantPrimaryAdmin(user.id);
  console.log(`${user.username} (${email}) is now the primary admin.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
