import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

export type SqlParam = SQLInputValue | boolean | undefined;
export type Row = Record<string, unknown>;

function normalize(params: SqlParam[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

/**
 * Thin typed wrapper around Node's built-in SQLite (`node:sqlite`).
 *
 * All statements are parameterised; SQL text is never assembled from user
 * input. Transactions nest via savepoints so a failed import rolls back
 * completely (spec §9: "do not partially corrupt projects").
 */
export class Database {
  readonly raw: DatabaseSync;
  /** File path, or ':memory:'. */
  readonly path: string;
  private depth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    const result = this.raw.prepare(sql).run(...normalize(params));
    return { changes: Number(result.changes) };
  }

  get<T = Row>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.raw.prepare(sql).get(...normalize(params)) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlParam[]): T[] {
    return this.raw.prepare(sql).all(...normalize(params)) as T[];
  }

  scalar<T = number>(sql: string, ...params: SqlParam[]): T | undefined {
    const row = this.raw.prepare(sql).get(...normalize(params)) as Row | undefined;
    if (!row) return undefined;
    const first = Object.values(row)[0];
    return first as T;
  }

  /** Insert a row from a plain object. Column names come from code, never from user input. */
  insert(table: string, values: Record<string, SqlParam>): void {
    const cols = Object.keys(values);
    assertIdentifier(table);
    cols.forEach(assertIdentifier);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    this.run(sql, ...cols.map((c) => values[c]));
  }

  /** Update selected columns of one row by id. */
  update(table: string, id: string, values: Record<string, SqlParam>): number {
    const cols = Object.keys(values);
    if (cols.length === 0) return 0;
    assertIdentifier(table);
    cols.forEach(assertIdentifier);
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    return this.run(sql, ...cols.map((c) => values[c]), id).changes;
  }

  transaction<T>(fn: () => T): T {
    const name = `sp_${this.depth}`;
    if (this.depth === 0) this.raw.exec('BEGIN IMMEDIATE');
    else this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (this.depth === 0) this.raw.exec('COMMIT');
      else this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.depth--;
      if (this.depth === 0) this.raw.exec('ROLLBACK');
      else this.raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name: string): void {
  if (!IDENT.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
}
