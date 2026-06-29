/**
 * Neon Postgres client (replaces the former Supabase service-role client).
 *
 * Why Neon: the free tier auto-suspends compute when idle but resumes on the
 * next query in ~0.5s — there is no manual "unpause" step and projects aren't
 * deleted for inactivity, which is what made Supabase's free tier painful.
 *
 * Access model: we connect with the Neon owner role over Neon's serverless
 * HTTP driver. There is no PostgREST / anon key in this stack, so the old
 * "RLS-on-with-no-policies" trick is unnecessary — every query in the app is
 * already scoped by `user_id` in the WHERE clause at the route/store layer.
 *
 * The HTTP driver (`neon()`) is the right fit for Vercel serverless: no TCP
 * connection to keep warm, each query is a stateless fetch. All queries in
 * this codebase are single statements, which is exactly what it supports.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | null = null;

/**
 * Lazily-constructed singleton SQL client. Reads `DATABASE_URL` (the Neon
 * connection string, pooled `-pooler` host recommended for serverless).
 *
 * Usage:
 *   const sql = getSql();
 *   const rows = await sql`select * from users where id = ${userId}`;          // tagged template
 *   const rows = await sql.query("select * from users where id = $1", [id]);   // dynamic/bulk
 *
 * Both forms return an array of row objects; errors throw (no `{data, error}`).
 */
export function getSql(): NeonQueryFunction<false, false> {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not configured (Neon connection string)");
  }
  _sql = neon(url);
  return _sql;
}

/** Format a number[] embedding as a pgvector literal: [0.1,0.2,...].
 *  pgvector parses this when the placeholder is cast `::vector(N)`. A plain
 *  JS array would be serialized as a Postgres array `{...}` and rejected. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/** Serialize a value bound for a jsonb column. Returns null (→ SQL NULL) for
 *  nullish input, otherwise a JSON string to be cast `::jsonb` at the call
 *  site. Passing a raw JS array to the driver would become a Postgres array,
 *  not jsonb — so jsonb params must always go through here. */
export function toJsonb(v: unknown): string | null {
  return v == null ? null : JSON.stringify(v);
}

/**
 * Build a multi-row VALUES clause for bulk inserts via `sql.query`.
 *
 *   const { text, params } = buildValues([[a, b], [c, d]]);
 *   // text = "($1,$2),($3,$4)"  params = [a, b, c, d]
 *   await sql.query(`insert into t (x, y) values ${text}`, params);
 *
 * `colCasts` optionally appends a cast to each column position, e.g.
 * `["", "", "::vector(1536)"]` to cast the third column of every tuple.
 */
export function buildValues(
  rows: unknown[][],
  colCasts?: string[]
): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((val, ci) => {
      params.push(val);
      return `$${params.length}${colCasts?.[ci] ?? ""}`;
    });
    return `(${placeholders.join(",")})`;
  });
  return { text: tuples.join(","), params };
}
