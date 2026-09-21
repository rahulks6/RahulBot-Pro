// Imported first by every test file so config.ts picks up test-specific
// settings before anything else touches process.env.
import * as os from "node:os";
import * as path from "node:path";

process.env.PGDATABASE = process.env.PGDATABASE_TEST ?? "katkee_test";
process.env.MEDIA_STORAGE_ROOT = process.env.MEDIA_STORAGE_ROOT_TEST ?? path.join(os.tmpdir(), "katkee-test-media");
