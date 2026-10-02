import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { chunks, regulations, regulationTexts } from "@/db/schema";

import type { PageCache, RegulationRef, TextStore } from "./pipeline";

export const HTML_CACHE_DIR = path.join("data", "infoleg", "html");

/** Stores downloaded pages as files, one per regulation and source. */
export function createFileCache(directory: string = HTML_CACHE_DIR): PageCache {
  const fileFor = (regulationId: number, source: string) =>
    path.join(directory, `${regulationId}.${source}.htm`);

  return {
    async read(regulationId, source) {
      try {
        return new Uint8Array(await readFile(fileFor(regulationId, source)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(regulationId, source, bytes) {
      await mkdir(directory, { recursive: true });
      await writeFile(fileFor(regulationId, source), bytes);
    },
  };
}

export function createTextStore(db: Database): TextStore {
  return {
    async currentHash(regulationId) {
      const [row] = await db
        .select({ contentHash: regulationTexts.contentHash })
        .from(regulationTexts)
        .where(eq(regulationTexts.regulationId, regulationId));

      return row?.contentHash ?? null;
    },

    // The text and its chunks change together or not at all.
    async save(regulationId, text, newChunks) {
      await db.transaction(async (tx) => {
        await tx
          .insert(regulationTexts)
          .values({ regulationId, ...text })
          .onConflictDoUpdate({
            target: regulationTexts.regulationId,
            set: { ...text, fetchedAt: sql`now()` },
          });

        await tx.delete(chunks).where(eq(chunks.regulationId, regulationId));

        if (newChunks.length > 0) {
          await tx
            .insert(chunks)
            .values(newChunks.map((chunk) => ({ regulationId, ...chunk })));
        }
      });
    },
  };
}

const REF_COLUMNS = {
  id: regulations.id,
  type: regulations.type,
  number: regulations.number,
  title: regulations.title,
  topic: regulations.topic,
  summary: regulations.summary,
  originalTextUrl: regulations.originalTextUrl,
  updatedTextUrl: regulations.updatedTextUrl,
};

export type RegulationSelection = {
  /** Only these regulations. */
  ids?: number[];
  /** Include regulations that already have a text. */
  includeDone?: boolean;
  limit?: number;
};

/** Regulations to process, oldest id first so runs are repeatable. */
export async function selectRegulations(
  db: Database,
  selection: RegulationSelection = {},
): Promise<RegulationRef[]> {
  const query = db
    .select(REF_COLUMNS)
    .from(regulations)
    .leftJoin(regulationTexts, eq(regulationTexts.regulationId, regulations.id))
    .where(
      and(
        selection.ids?.length ? inArray(regulations.id, selection.ids) : undefined,
        selection.includeDone ? undefined : isNull(regulationTexts.regulationId),
      ),
    )
    .orderBy(regulations.id)
    .$dynamic();

  if (selection.limit !== undefined) return query.limit(selection.limit);

  return query;
}
