import postgres from "postgres";

/** More regulations than any test loads: the database holds real data. */
const MAX_TEST_ROWS = 500;

/**
 * The integration tests empty the `regulations` table (and, with it, texts,
 * chunks and embeddings). This refuses to run them against a database that
 * holds a real ingestion, which takes hours to rebuild.
 */
export default async function guardRealData() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");

  const sql = postgres(url, { max: 1, connect_timeout: 5 });

  try {
    const [table] = await sql<{ exists: boolean }[]>`
      select to_regclass('public.regulations') is not null as exists
    `;
    if (!table?.exists) return;

    const [row] = await sql<{ total: number }[]>`
      select count(*)::int as total from regulations
    `;
    const total = row?.total ?? 0;

    if (total > MAX_TEST_ROWS && process.env.ALLOW_DESTRUCTIVE_TESTS !== "1") {
      throw new Error(
        `The database holds ${total} regulations. The integration tests delete them all.\n` +
          "Point DATABASE_URL to an empty test database, or set ALLOW_DESTRUCTIVE_TESTS=1 to run them anyway.",
      );
    }
  } finally {
    await sql.end();
  }
}
