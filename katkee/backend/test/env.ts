// Imported first by every test file so config.ts picks up the test
// database before anything else touches process.env.
process.env.PGDATABASE = process.env.PGDATABASE_TEST ?? "katkee_test";
