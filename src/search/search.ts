import {
  and,
  cosineDistance,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";

import type { Embedder } from "@/ai/embedder";
import type { Database } from "@/db/client";
import { chunks, regulations, regulationTexts } from "@/db/schema";
import { regulationName } from "@/embeddings/input";

export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 20;

export type SearchFilters = {
  /** Regulation types to keep ("Ley", "Decreto"), matched case-insensitively. */
  types?: string[];
  /** Keep regulations enacted in this year or later. */
  yearFrom?: number;
  /** Keep regulations enacted in this year or earlier. */
  yearTo?: number;
};

export type SearchOptions = SearchFilters & {
  /** How many chunks to return. */
  limit?: number;
  /**
   * Compare the question with every chunk instead of using the index. Slower,
   * but exact: it tells apart what the model cannot find from what the
   * approximate index skipped.
   */
  exact?: boolean;
};

export type SearchHit = {
  chunkId: number;
  /** Cosine similarity between the question and the chunk: 1 is identical. */
  similarity: number;
  section: string;
  label: string | null;
  content: string;
  regulation: {
    id: number;
    type: string;
    number: string | null;
    /** "Decreto 282/2026", "Ley 27817". */
    name: string;
    title: string | null;
    topic: string | null;
    enactedOn: string | null;
    /** `updated`, `original` or `summary` (InfoLEG publishes no full text). */
    textSource: string | null;
    /** Where the text was read from, or the regulation's page on InfoLEG. */
    url: string;
  };
};

/** The question could not be turned into a vector: the model is not reachable. */
export class QueryEmbeddingError extends Error {
  constructor(model: string, cause: unknown) {
    super(`Could not embed the question with "${model}".`, { cause });
    this.name = "QueryEmbeddingError";
  }
}

/** The regulation's record on InfoLEG, for regulations without a text URL. */
export const infolegUrl = (regulationId: number) =>
  `https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=${regulationId}`;

/**
 * Returns the chunks closest in meaning to the question, best first.
 *
 * The question is embedded with the same model as the chunks and compared by
 * cosine distance. Filters run in the same SQL query as the similarity search.
 */
export async function searchChunks(
  db: Database,
  embedder: Embedder,
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

  let vector: number[] | undefined;
  try {
    [vector] = await embedder.embed([query]);
  } catch (cause) {
    throw new QueryEmbeddingError(embedder.model, cause);
  }
  if (!vector) throw new QueryEmbeddingError(embedder.model, "no vector returned");

  const distance = cosineDistance(chunks.embedding, vector);

  const conditions = [
    isNotNull(chunks.embedding),
    // Vectors from another model live in a different space: never compare them.
    eq(chunks.embeddingModel, embedder.model),
  ];
  if (options.types?.length) {
    conditions.push(
      inArray(
        sql`lower(${regulations.type})`,
        options.types.map((type) => type.trim().toLowerCase()),
      ),
    );
  }
  if (options.yearFrom !== undefined) {
    conditions.push(gte(regulations.enactedOn, `${options.yearFrom}-01-01`));
  }
  if (options.yearTo !== undefined) {
    conditions.push(lte(regulations.enactedOn, `${options.yearTo}-12-31`));
  }

  const rows = await db.transaction(async (tx) => {
    // An approximate index returns its nearest candidates first and the
    // filters are applied afterwards, so a selective filter ("laws only")
    // could leave fewer rows than asked. Iterative scans (pgvector 0.8+) keep
    // walking the index until the limit is filled, still in distance order.
    try {
      await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);
    } catch (cause) {
      throw new Error(
        "The search needs pgvector 0.8 or newer (iterative index scans). Check the version reported by /api/health.",
        { cause },
      );
    }

    if (options.exact) {
      await tx.execute(sql`set local enable_indexscan = off`);
    }

    return tx
      .select({
        chunkId: chunks.id,
        similarity: sql<number>`1 - (${distance})`.mapWith(Number),
        section: chunks.section,
        label: chunks.label,
        content: chunks.content,
        regulationId: regulations.id,
        type: regulations.type,
        number: regulations.number,
        title: regulations.title,
        topic: regulations.topic,
        enactedOn: regulations.enactedOn,
        textSource: regulationTexts.source,
        sourceUrl: regulationTexts.sourceUrl,
      })
      .from(chunks)
      .innerJoin(regulations, eq(regulations.id, chunks.regulationId))
      .leftJoin(regulationTexts, eq(regulationTexts.regulationId, regulations.id))
      .where(and(...conditions))
      .orderBy(distance)
      .limit(limit);
  });

  return rows.map((row) => ({
    chunkId: row.chunkId,
    similarity: row.similarity,
    section: row.section,
    label: row.label,
    content: row.content,
    regulation: {
      id: row.regulationId,
      type: row.type,
      number: row.number,
      name: regulationName(row),
      title: row.title,
      topic: row.topic,
      enactedOn: row.enactedOn,
      textSource: row.textSource,
      url: row.sourceUrl ?? infolegUrl(row.regulationId),
    },
  }));
}
