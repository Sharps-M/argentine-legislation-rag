import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { asc, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getDb, getSql } from "@/db/client";
import { chunks, regulations, regulationTexts } from "@/db/schema";
import { processTexts } from "@/texts/pipeline";
import { createFileCache, createTextStore, selectRegulations } from "@/texts/store";

const db = getDb();
const store = createTextStore(db);

const noNetwork = async () => {
  throw new Error("the network must not be used in this test");
};

let cacheDir: string;

beforeAll(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), "infoleg-html-"));
  // Ley 27817, as downloaded from InfoLEG.
  await copyFile(
    path.join("tests", "fixtures", "html", "427766.htm"),
    path.join(cacheDir, "427766.original.htm"),
  );
});

beforeEach(async () => {
  await db.delete(regulations);
  await db.insert(regulations).values([
    {
      id: 427766,
      type: "Ley",
      number: "27817",
      originalTextUrl:
        "http://servicios.infoleg.gob.ar/infolegInternet/anexos/425000-429999/427766/norma.htm",
    },
    {
      id: 500001,
      type: "Decreto",
      number: "99",
      title: "DESIGNACION",
      topic: "MINISTERIO DE PRUEBA",
      summary: "DASE POR DESIGNADO UN FUNCIONARIO DE PRUEBA.",
    },
  ]);
});

afterAll(async () => {
  await getSql().end();
  await rm(cacheDir, { recursive: true, force: true });
});

const run = async (options = {}) =>
  processTexts(
    await selectRegulations(db, { includeDone: true }),
    { fetchPage: noNetwork, cache: createFileCache(cacheDir), store },
    { onlyCached: true, ...options },
  );

describe("regulation texts in PostgreSQL", () => {
  it("stores the text and one chunk per part of a real law", async () => {
    const report = await run();

    expect(report).toMatchObject({
      processed: 2,
      fromCache: 1,
      summaries: 1,
      saved: 2,
      failed: 0,
    });

    const [text] = await db
      .select()
      .from(regulationTexts)
      .where(eq(regulationTexts.regulationId, 427766));
    const rows = await db
      .select()
      .from(chunks)
      .where(eq(chunks.regulationId, 427766))
      .orderBy(asc(chunks.ordinal));

    expect(text).toMatchObject({ source: "original" });
    expect(text?.content).toMatch(/^CONVENIOS\n\nLey 27817/);
    expect(text?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.map((row) => [row.ordinal, row.section, row.label])).toEqual([
      [0, "preamble", null],
      [1, "article", "Artículo 1"],
      [2, "article", "Artículo 2"],
      [3, "closing", null],
      [4, "closing", null],
    ]);
    expect(rows[1]?.content).toContain("REPÚBLICA DE SAN MARINO");
  });

  it("stores a summary chunk for a regulation without a published text", async () => {
    await run();

    const rows = await db.select().from(chunks).where(eq(chunks.regulationId, 500001));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ section: "summary", label: null });
    expect(rows[0]?.content).toContain("DASE POR DESIGNADO");
  });

  it("is idempotent, and replaces the chunks when forced", async () => {
    await run();
    const second = await run();
    const forced = await run({ force: true, maxChars: 200 });

    const [total] = await db
      .select({ value: count() })
      .from(chunks)
      .where(eq(chunks.regulationId, 427766));

    expect(second).toMatchObject({ unchanged: 2, saved: 0 });
    expect(forced).toMatchObject({ saved: 2 });
    expect(total?.value).toBeGreaterThan(5);
  });

  it("selects only regulations without a text unless asked otherwise", async () => {
    await run();
    await db.insert(regulations).values({ id: 500002, type: "Ley" });

    const pending = await selectRegulations(db);
    const limited = await selectRegulations(db, { includeDone: true, limit: 2 });
    const byId = await selectRegulations(db, { includeDone: true, ids: [427766] });

    expect(pending.map((regulation) => regulation.id)).toEqual([500002]);
    expect(limited.map((regulation) => regulation.id)).toEqual([427766, 500001]);
    expect(byId.map((regulation) => regulation.id)).toEqual([427766]);
  });

  it("removes the text and chunks with their regulation", async () => {
    await run();
    await db.delete(regulations).where(eq(regulations.id, 427766));

    const [texts] = await db.select({ value: count() }).from(regulationTexts);
    const [left] = await db.select({ value: count() }).from(chunks);

    expect(texts?.value).toBe(1);
    expect(left?.value).toBe(1);
  });
});
