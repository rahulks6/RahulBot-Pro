/**
 * Postgres access layer built on the `psql` CLI via child_process instead of
 * a driver package (`pg`). This sandbox's network policy blocks
 * registry.npmjs.org, so no npm dependency can be installed here — this is
 * the one way to talk to a real Postgres database using only what already
 * ships with Node and this OS image.
 *
 * It is a real, safe, working data layer today: parameters are passed to
 * psql via `-v name=value` (argv, never shell/string concatenation) and
 * referenced in SQL as `:'name'`, which psql itself SQL-quotes — the same
 * mechanism the official docs recommend for scripted psql input. SQL text
 * passed to `query()` must always be a static string literal written by a
 * developer, never built by concatenating request data.
 *
 * Once npm access is available, swap this module for the `pg` driver
 * (connection pooling, binary protocol, real transactions across
 * statements). Every call site here goes through `query()`, so that swap
 * touches only this file.
 */
import { execFile } from "node:child_process";
import { config } from "../config/env";

const FIELD_SEP = "\u0001";
const RECORD_SEP = "\u0002";
const NULL_TOKEN = "\u0003KATKEE_NULL\u0003";
const FORBIDDEN_CHARS = [FIELD_SEP, RECORD_SEP, "\u0003"];

export type SqlValue = string | number | boolean | null;
export type SqlParams = Record<string, SqlValue>;
export type Row = Record<string, string | null>;

export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly detail: string,
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

function toParamString(value: SqlValue): string {
  if (value === null) return "";
  const str = typeof value === "boolean" ? String(value) : String(value);
  for (const forbidden of FORBIDDEN_CHARS) {
    if (str.includes(forbidden)) {
      throw new Error("Query parameter contains a reserved control character");
    }
  }
  return str;
}

function parseOutput(stdout: string): Row[] {
  const trimmed = stdout.replace(/\n$/, "");
  if (trimmed.length === 0) return [];
  const records = trimmed.split(RECORD_SEP);
  const header = (records[0] ?? "").split(FIELD_SEP);
  const rows: Row[] = [];
  for (let i = 1; i < records.length; i++) {
    const values = (records[i] ?? "").split(FIELD_SEP);
    const row: Row = {};
    header.forEach((col, idx) => {
      const raw = values[idx] ?? "";
      row[col] = raw === NULL_TOKEN ? null : raw;
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Run one static SQL statement (or a single-statement CTE) against Postgres
 * and return its rows as strings (Postgres text output) — callers cast to
 * the types they expect. `sql` must be a literal written in source, never
 * built from request input; pass values through `params` and reference them
 * in `sql` as `:'name'` so psql SQL-quotes them for you.
 */
export async function query(sql: string, params: SqlParams = {}): Promise<Row[]> {
  const args: string[] = [
    "-h",
    config.db.host,
    "-p",
    String(config.db.port),
    "-U",
    config.db.user,
    "-d",
    config.db.database,
    "-X",
    "-q",
    "-A",
    "-F",
    FIELD_SEP,
    "-R",
    RECORD_SEP,
    "-v",
    "ON_ERROR_STOP=1",
    "-P",
    `null=${NULL_TOKEN}`,
    "-P",
    "footer=off",
  ];

  for (const [key, value] of Object.entries(params)) {
    args.push("-v", `${key}=${toParamString(value)}`);
  }

  return new Promise<Row[]>((resolve, reject) => {
    const child = execFile(
      "psql",
      args,
      { env: { ...process.env, PGPASSWORD: config.db.password }, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new DatabaseError("Database query failed", stderr.trim() || error.message));
          return;
        }
        try {
          resolve(parseOutput(stdout));
        } catch (parseError) {
          reject(new DatabaseError("Failed to parse database response", String(parseError)));
        }
      },
    );
    child.stdin?.write(sql.endsWith(";") ? sql : `${sql};`);
    child.stdin?.end();
  });
}

export async function queryOne(sql: string, params: SqlParams = {}): Promise<Row | null> {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/**
 * A `null` param is sent to psql as an empty string (there's no way to pass
 * a bare SQL NULL through `-v`), so a plain `:'name'` would insert/compare
 * against `''` instead of NULL. Wrap any parameter that can legitimately be
 * null with `nullable("name")` in the SQL text instead of `:'name'` — it
 * collapses an empty string to SQL NULL via NULLIF, which is safe here
 * because none of this schema's nullable text columns treat "" and NULL as
 * meaningfully different values.
 */
export function nullable(paramName: string, castType?: string): string {
  const cast = castType ? `::${castType}` : "";
  return `NULLIF(:'${paramName}', '')${cast}`;
}
