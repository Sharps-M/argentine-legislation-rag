import { readFileSync } from "node:fs";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { createDb } from "@/db/client";
import { chunks, regulations } from "@/db/schema";
import { embedChunks } from "@/embeddings/pipeline";
import { createEmbeddingStore, vacuumChunks } from "@/embeddings/store";
import { chunkRegulation } from "@/texts/chunker";
import { decodeHtml, htmlToText } from "@/texts/html-to-text";

import { createHashingEmbedder } from "../support/hashing-embedder";
import { e2eDatabaseUrls } from "./support/database";

/** More regulations than the tests load: the database holds real data. */
const MAX_TEST_ROWS = 500;

/**
 * The regulations of the page in the tests: the nine pages kept as fixtures,
 * with what the tests need of their metadata, not all of it.
 */
const FIXTURES: { id: number; type: string; number: string; enactedOn: string }[] = [
  { id: 427766, type: "Ley", number: "27817", enactedOn: "2026-06-24" },
  { id: 427760, type: "Ley", number: "27814", enactedOn: "2026-06-24" },
  { id: 427187, type: "Ley", number: "27818", enactedOn: "2026-06-20" },
  { id: 425217, type: "Decreto", number: "282", enactedOn: "2026-04-27" },
  { id: 425100, type: "Decreto", number: "269", enactedOn: "2026-04-20" },
  { id: 429381, type: "Decreto", number: "829", enactedOn: "2026-08-28" },
  { id: 429383, type: "Decreto", number: "832", enactedOn: "2026-08-28" },
  { id: 429384, type: "Decreto", number: "833", enactedOn: "2026-08-28" },
  { id: 429385, type: "Decreto", number: "834", enactedOn: "2026-08-28" },
];

/** Creates the tests' own database if it is missing. */
async function createDatabase(main: string, e2e: string) {
  const name = decodeURIComponent(new URL(e2e).pathname.slice(1));
  if (new URL(main).pathname.slice(1) === name) return;

  const sql = postgres(main, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    const [found] = await sql`select 1 from pg_database where datname = ${name}`;
    if (!found) await sql.unsafe(`create database "${name.replaceAll('"', '""')}"`);
  } finally {
    await sql.end();
  }
}

/**
 * Before the browser tests: their own database, migrated, with the nine
 * fixture regulations cut into chunks and embedded by the fake model.
 */
export default async function setUpDatabase() {
  const { main, e2e } = e2eDatabaseUrls();
  await createDatabase(main, e2e);

  const sql = postgres(e2e, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });

    const [row] = await sql<{ total: number }[]>`
      select count(*)::int as total from regulations
    `;
    if ((row?.total ?? 0) > MAX_TEST_ROWS) {
      throw new Error(
        `${e2e} holds ${row?.total} regulations, and the browser tests delete them all. ` +
          "Point E2E_DATABASE_URL to a database of its own.",
      );
    }

    const db = createDb(sql);
    await db.delete(regulations);
    await vacuumChunks(db);
    for (const fixture of FIXTURES) {
      const html = decodeHtml(readFileSync(`tests/fixtures/html/${fixture.id}.htm`));
      await db.insert(regulations).values({
        ...fixture,
        topic: "PRUEBA",
        title: `${fixture.type} ${fixture.number}`,
      });
      await db.insert(chunks).values(
        chunkRegulation(htmlToText(html)).map((chunk) => ({
          regulationId: fixture.id,
          ...chunk,
        })),
      );
    }
    await embedChunks(createEmbeddingStore(db), createHashingEmbedder());
  } finally {
    await sql.end();
  }
}
