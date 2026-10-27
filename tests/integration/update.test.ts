import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb, getSql } from "@/db/client";
import {
  chunks,
  regulations,
  regulationTexts,
  updateRuns,
  type NewRegulation,
} from "@/db/schema";
import { createRegulationStore } from "@/ingest/store";
import { compareRegulation } from "@/update/changes";
import { latestRuns, recordRun } from "@/update/status";
import { forgetVectors, loadSnapshots, regulationsWithoutText } from "@/update/store";

const db = getDb();

const vector = Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0));

beforeEach(async () => {
  await db.delete(regulations);
  await db.insert(regulations).values([
    {
      id: 1,
      type: "Ley",
      number: "14346",
      enactedOn: "1954-09-27",
      title: "MALOS TRATOS",
      topic: "ANIMALES",
      originalTextUrl: "http://example.test/1.htm",
      amendedByCount: 0,
      notes: "no la mira",
    },
    { id: 2, type: "Ley", number: "27330", enactedOn: "2016-11-30" },
    { id: 3, type: "Decreto", number: "552", enactedOn: "2026-06-29" },
  ]);
  await db.insert(regulationTexts).values({
    regulationId: 1,
    source: "original",
    content: "texto",
    contentHash: "hash",
  });
  await db.insert(chunks).values(
    [1, 1, 2].map((regulationId, ordinal) => ({
      regulationId,
      ordinal,
      section: "article",
      content: `fragmento ${ordinal}`,
      embedding: vector,
      embeddingModel: "bge-m3",
    })),
  );
});

afterAll(() => getSql().end());

describe("what the update reads and writes in PostgreSQL", () => {
  it("reads every stored regulation with the fields it compares", async () => {
    const snapshots = await loadSnapshots(db);

    expect([...snapshots.keys()].sort()).toEqual([1, 2, 3]);
    expect(snapshots.get(1)).toEqual({
      id: 1,
      updatedTextUrl: null,
      originalTextUrl: "http://example.test/1.htm",
      amendedByCount: 0,
      summary: null,
      type: "Ley",
      number: "14346",
      enactedOn: "1954-09-27",
      topic: "ANIMALES",
      title: "MALOS TRATOS",
    });
  });

  it("compares what it read with the dataset row as stored, without false changes", async () => {
    const [stored] = await db.select().from(regulations).where(eq(regulations.id, 1));
    const snapshot = (await loadSnapshots(db)).get(1)!;
    // The dataset never has the timestamps the database adds.
    const row = { ...stored! } as Partial<NonNullable<typeof stored>>;
    delete row.createdAt;
    delete row.updatedAt;

    expect(compareRegulation(snapshot, row as NewRegulation)).toBeNull();
  });

  it("finds the regulations that have no text yet", async () => {
    expect(await regulationsWithoutText(db)).toEqual([2, 3]);
  });

  it("forgets the vectors of the regulations it is given, and only those", async () => {
    expect(await forgetVectors(db, [1, 3])).toBe(2);

    const pending = await db
      .select({ regulationId: chunks.regulationId })
      .from(chunks)
      .where(isNull(chunks.embedding));
    expect(pending.map((row) => row.regulationId)).toEqual([1, 1]);

    const kept = await db.select().from(chunks).where(eq(chunks.regulationId, 2));
    expect(kept[0]?.embeddingModel).toBe("bge-m3");
  });

  it("forgets nothing when given nothing", async () => {
    expect(await forgetVectors(db, [])).toBe(0);
  });

  it("stores a change through the same upsert as the load", async () => {
    await createRegulationStore(db).upsertMany([
      {
        id: 1,
        type: "Ley",
        number: "14346",
        amendedByCount: 2,
        updatedTextUrl: "http://x.test/a",
      },
    ]);

    const snapshot = (await loadSnapshots(db)).get(1);
    expect(snapshot).toMatchObject({
      amendedByCount: 2,
      updatedTextUrl: "http://x.test/a",
    });
  });
});

describe("the record of the update runs", () => {
  beforeEach(async () => {
    await db.delete(updateRuns);
  });

  const run = (
    finishedAt: string,
    outcome: "ok" | "failed",
    error: string | null = null,
  ) => ({
    startedAt: new Date(new Date(finishedAt).getTime() - 60_000),
    finishedAt: new Date(finishedAt),
    outcome,
    datasetChanged: outcome === "ok" ? true : null,
    added: outcome === "ok" ? 4 : 0,
    changed: 0,
    error,
  });

  it("has nothing before the first run", async () => {
    expect(await latestRuns(db)).toEqual({ lastSuccess: null, lastAttempt: null });
  });

  it("gives the last run that finished and the last that ran, whatever the order they were written in", async () => {
    await recordRun(db, run("2026-11-08T09:00:00Z", "ok"));
    await recordRun(db, run("2026-11-10T09:00:00Z", "failed", "Ollama is not running"));
    await recordRun(db, run("2026-11-01T09:00:00Z", "ok"));

    const { lastSuccess, lastAttempt } = await latestRuns(db);

    expect(lastSuccess?.finishedAt.toISOString()).toBe("2026-11-08T09:00:00.000Z");
    expect(lastSuccess).toMatchObject({
      outcome: "ok",
      datasetChanged: true,
      added: 4,
    });
    expect(lastAttempt).toMatchObject({
      outcome: "failed",
      datasetChanged: null,
      error: "Ollama is not running",
    });
  });
});
