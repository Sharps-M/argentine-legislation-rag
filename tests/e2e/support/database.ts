import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/** The database the browser tests fill: never the one with the real corpus. */
export const E2E_DATABASE = "normativa_e2e";

/**
 * Where the main database is: `DATABASE_URL` from the environment, or from
 * `.env`. Only that line is read from `.env`: the rest (an API key, for one)
 * stays out of the tests.
 */
function mainDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (existsSync(".env")) {
    const url = parseEnv(readFileSync(".env", "utf8")).DATABASE_URL;
    if (url) return url;
  }
  throw new Error(
    "DATABASE_URL is not set: the browser tests need the PostgreSQL server of `docker compose up -d db`.",
  );
}

/**
 * The browser tests run on a database of their own, on the same server as the
 * main one: `normativa_e2e`, created if it is missing. `E2E_DATABASE_URL`
 * points them somewhere else.
 */
export function e2eDatabaseUrls(): { main: string; e2e: string } {
  const main = mainDatabaseUrl();
  if (process.env.E2E_DATABASE_URL) return { main, e2e: process.env.E2E_DATABASE_URL };

  const e2e = new URL(main);
  e2e.pathname = `/${E2E_DATABASE}`;
  return { main, e2e: e2e.toString() };
}
