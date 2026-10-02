import path from "node:path";

import { count, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb, getSql } from "@/db/client";
import { regulations } from "@/db/schema";
import { readInfolegCsv } from "@/ingest/csv";
import { ingestRegulations } from "@/ingest/ingest";
import { createRegulationStore } from "@/ingest/store";

const fixture = path.join("tests", "fixtures", "infoleg-sample.csv");
const everything = { types: [], since: null };

const db = getDb();
const store = createRegulationStore(db);

beforeEach(async () => {
  await db.delete(regulations);
});

afterAll(() => getSql().end());

describe("ingestion into PostgreSQL", () => {
  it("loads the sample CSV with its values intact", async () => {
    const report = await ingestRegulations(readInfolegCsv(fixture), store, {
      filter: everything,
    });

    expect(report).toMatchObject({ read: 4, rejected: 0, selected: 4 });

    const [row] = await db.select().from(regulations).where(eq(regulations.id, 374338));

    expect(row).toMatchObject({
      type: "Resolución",
      number: "794",
      class: null,
      issuingBody: "MINISTERIO DE ECONOMIA",
      enactedOn: "2022-11-03",
      gazetteNumber: 35041,
      topic: "IMPUESTO AL VALOR AGREGADO",
      updatedTextUrl: null,
      amendedByCount: 0,
      amendsCount: 2,
    });
  });

  it("is idempotent: running twice updates rows instead of duplicating them", async () => {
    await ingestRegulations(readInfolegCsv(fixture), store, { filter: everything });

    await store.upsertMany([
      { id: 374338, type: "Resolución", title: "TITULO CORREGIDO" },
    ]);
    await ingestRegulations(readInfolegCsv(fixture), store, { filter: everything });

    const [total] = await db.select({ value: count() }).from(regulations);
    const [row] = await db.select().from(regulations).where(eq(regulations.id, 374338));

    expect(total?.value).toBe(4);
    expect(row?.title).toBe("DISTRIBUCION LIMITE MAXIMO ANUAL");
  });

  it("applies the subset filter before writing", async () => {
    const report = await ingestRegulations(readInfolegCsv(fixture), store, {
      filter: { types: ["Comunicación"], since: "2022-01-01" },
    });

    const [total] = await db.select({ value: count() }).from(regulations);

    expect(report.selected).toBe(2);
    expect(total?.value).toBe(2);
  });
});
