/**
 * Truncates the test database before each `npm test` run (wired as the
 * "pretest" npm lifecycle script). Needed once enough test runs had
 * accumulated: every test creates real `test_*` users and never deletes
 * them, so `search.test.ts`'s substring query eventually stopped finding
 * its own freshly-created user within the default 20-row page — not a
 * Phase 5 regression, but a real test-hygiene gap this session's repeated
 * `npm test` runs finally exposed.
 *
 * process.env.PGDATABASE is set before the dynamic require below (not a
 * static import) so config.ts — which reads it at module-load time —
 * sees the override; see test/env.ts for the same reasoning.
 */
process.env.PGDATABASE = process.env.PGDATABASE_TEST ?? "katkee_test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { query } = require("../src/db/psql") as typeof import("../src/db/psql");

async function main(): Promise<void> {
  // TRUNCATE ... CASCADE reaches every table with a (possibly transitive)
  // foreign key back to users — which is all of them in this schema — so
  // nothing else needs to be listed here as new per-test entity data.
  //
  // feature_flags and ad_settings (migrations 0024/0025) are the one
  // exception: their nullable `updated_by` FK to users makes them CASCADE
  // targets too, so this wipes their seeded default rows along with real
  // user data — unlike everything else here, those are singleton app
  // config, not per-test entities, and every flag-gated route depends on
  // them existing. Reseed them the same way their migrations originally
  // did, right after the truncate.
  await query("TRUNCATE users CASCADE;");
  await query(
    `INSERT INTO feature_flags (key, enabled) VALUES
       ('ADMIN_CONSOLE_ENABLED', true),
       ('ADS_ENABLED', false),
       ('SPONSORED_STORIES_ENABLED', false),
       ('AD_REPORTING_ENABLED', false)`,
  );
  await query("INSERT INTO ad_settings (id) VALUES (1);");
  console.log(`Test database (${process.env.PGDATABASE}) reset.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
