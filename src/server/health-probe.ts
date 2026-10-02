import { getSql } from "@/db/client";

import type { HealthProbe } from "./health";

/** Health probe backed by the real PostgreSQL connection. */
export const databaseProbe: HealthProbe = {
  async ping() {
    await getSql()`select 1`;
  },
  async vectorVersion() {
    const rows = await getSql()<{ extversion: string }[]>`
      select extversion from pg_extension where extname = 'vector'
    `;
    return rows[0]?.extversion ?? null;
  },
};
