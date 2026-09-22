// Imported first by every test file so config.ts picks up test-specific
// settings before anything else touches process.env.
import * as os from "node:os";
import * as path from "node:path";

process.env.PGDATABASE = process.env.PGDATABASE_TEST ?? "katkee_test";
process.env.MEDIA_STORAGE_ROOT = process.env.MEDIA_STORAGE_ROOT_TEST ?? path.join(os.tmpdir(), "katkee-test-media");

// Generous by default so the dozens of signups most test files make
// against the same loopback "IP" don't trip Phase 10's rate limiter —
// test/rateLimiting.test.ts sets its own much tighter values (before this
// file's process even imports config/env.ts — Node's test runner isolates
// each test file into its own process) to actually exercise a real 429.
process.env.RATE_LIMIT_AUTH_MAX ??= "100000";
process.env.RATE_LIMIT_GLOBAL_MAX ??= "1000000";
