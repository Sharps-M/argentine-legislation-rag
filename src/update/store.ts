import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { chunks, regulations, regulationTexts } from "@/db/schema";

import { CONTEXT_FIELDS, TEXT_FIELDS, type Snapshot } from "./changes";
import { NOTHING_UNFINISHED, type Unfinished } from "./update";

/** Where each update writes its report, and what it left unfinished. */
export const UPDATES_DIR = path.join("data", "updates");

/** Every stored regulation, with only what the update compares. */
export async function loadSnapshots(db: Database): Promise<Map<number, Snapshot>> {
  const columns = Object.fromEntries(
    ["id", ...TEXT_FIELDS, ...CONTEXT_FIELDS].map((field) => [
      field,
      regulations[field as keyof Snapshot],
    ]),
  ) as { [K in keyof Snapshot]: (typeof regulations)[K] };

  const rows = await db.select(columns).from(regulations);
  return new Map(rows.map((row) => [row.id, row]));
}

/** Stored regulations that have no text yet: new ones, or ones whose page failed. */
export async function regulationsWithoutText(db: Database): Promise<number[]> {
  const rows = await db
    .select({ id: regulations.id })
    .from(regulations)
    .leftJoin(regulationTexts, eq(regulationTexts.regulationId, regulations.id))
    .where(isNull(regulationTexts.regulationId))
    .orderBy(regulations.id);
  return rows.map((row) => row.id);
}

/** Forgets the vectors of these regulations' chunks, so they are embedded again. */
export async function forgetVectors(db: Database, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(chunks)
    .set({ embedding: sql`null`, embeddingModel: sql`null` })
    .where(inArray(chunks.regulationId, ids))
    .returning({ id: chunks.id });
  return rows.length;
}

/** The unfinished work of an update, in a file next to its reports. */
export function unfinishedFile(directory: string = UPDATES_DIR) {
  const file = path.join(directory, "unfinished.json");

  return {
    async load(): Promise<Unfinished> {
      try {
        const saved = JSON.parse(await readFile(file, "utf8")) as Partial<Unfinished>;
        return {
          refetch: saved.refetch ?? [],
          rechunk: saved.rechunk ?? [],
          revector: saved.revector ?? [],
        };
      } catch {
        return NOTHING_UNFINISHED;
      }
    },
    async save(work: Unfinished): Promise<void> {
      await mkdir(directory, { recursive: true });
      await writeFile(file, `${JSON.stringify(work, null, 2)}\n`);
    },
  };
}
