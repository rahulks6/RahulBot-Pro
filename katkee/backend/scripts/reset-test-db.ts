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
  // nothing else needs to be listed here as new tables get added.
  await query("TRUNCATE users CASCADE;");
  console.log(`Test database (${process.env.PGDATABASE}) reset.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
