import { asc, count, eq, isNull, ne, or, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { chunks, regulations } from "@/db/schema";

import type { EmbeddingStore } from "./pipeline";

/** A chunk is pending when it has no vector, or one from another model. */
const isPending = (model: string) =>
  or(isNull(chunks.embedding), ne(chunks.embeddingModel, model));

export function createEmbeddingStore(db: Database): EmbeddingStore {
  return {
    pending(model, limit) {
      return db
        .select({
          id: chunks.id,
          label: chunks.label,
          content: chunks.content,
          type: regulations.type,
          number: regulations.number,
          enactedOn: regulations.enactedOn,
          topic: regulations.topic,
          title: regulations.title,
        })
        .from(chunks)
        .innerJoin(regulations, eq(regulations.id, chunks.regulationId))
        .where(isPending(model))
        .orderBy(asc(chunks.id))
        .limit(limit);
    },

    async countPending(model) {
      const [row] = await db
        .select({ value: count() })
        .from(chunks)
        .where(isPending(model));
      return row?.value ?? 0;
    },

    async save(model, vectors) {
      if (vectors.length === 0) return;

      await db.transaction(async (tx) => {
        for (const { id, embedding } of vectors) {
          await tx
            .update(chunks)
            .set({ embedding, embeddingModel: model })
            .where(eq(chunks.id, id));
        }
      });
    },
  };
}

/** Forgets every stored vector, so the next run embeds everything again. */
export async function resetEmbeddings(db: Database): Promise<void> {
  await db.update(chunks).set({ embedding: sql`null`, embeddingModel: sql`null` });
}

/**
 * Cleans up after a bulk load. Rows replaced or deleted stay in the table and
 * in the vector index until a vacuum removes them, and until then the index
 * wastes part of every search walking through them. `analyze` refreshes the
 * statistics the query planner uses.
 */
export async function vacuumChunks(db: Database): Promise<void> {
  await db.execute(sql.raw("vacuum (analyze) chunks"));
}
