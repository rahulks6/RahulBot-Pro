import { join } from 'node:path';
import { loadDotEnv, readEnv } from '../config/env.ts';
import { Database } from '../db/database.ts';
import { migrate } from '../db/migrate.ts';

loadDotEnv();
const env = readEnv();
const db = new Database(join(env.dataDir, 'studio.sqlite'));
const result = migrate(db, undefined, { backupDir: join(env.dataDir, 'backups') });
console.log(
  result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Database is up to date.',
  `(schema version ${result.current})`,
);
if (result.backupPath) console.log(`Backup of the previous database: ${result.backupPath}`);
db.close();
