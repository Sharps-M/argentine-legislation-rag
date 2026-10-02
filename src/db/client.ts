import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getEnv } from "@/env";

import * as schema from "./schema";

type Sql = ReturnType<typeof postgres>;

// Reuse the connection pool across hot reloads in development.
const globalForDb = globalThis as unknown as { sql?: Sql };

export function getSql(): Sql {
  globalForDb.sql ??= postgres(getEnv().DATABASE_URL, {
    max: 10,
    connect_timeout: 5,
  });

  return globalForDb.sql;
}

export const getDb = () => drizzle(getSql(), { schema });
