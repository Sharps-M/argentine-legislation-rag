import {
  and,
  cosineDistance,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";

import type { Embedder } from "@/ai/embedder";
import type { Database } from "@/db/client";
import { chunks, regulations, regulationTexts } from "@/db/schema";
import { regulationName } from "@/embeddings/input";

import { findReferences, type RegulationReference } from "./references";

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
  /**
   * How many candidates the index keeps while it walks its graph (pgvector's
   * `hnsw.ef_search`). Higher finds more of the true nearest chunks and takes
   * longer.
   */
  efSearch?: number;
  /**
   * Drop the chunks found by meaning whose similarity is below this value.
   * Without it the search always returns its nearest chunks, however far they
   * are: asked about something no regulation covers, it would answer with
   * whatever is least unrelated. `0` keeps everything.
   */
  minSimilarity?: number;
  /**
   * Regulations the question cites by number. Their chunks come first,
   * whatever the similarity search finds. `searchChunks` fills this in.
   */
  references?: RegulationReference[];
};

/**
 * Chosen by measuring (docs/evaluacion.md): the first chunk of the right
 * regulation scored 0.59 or more in every question, and questions about
 * subjects the corpus does not cover stayed at 0.561 or less. The window is
 * narrow; run `npm run eval -- --floors` again when the corpus changes.
 */
export const DEFAULT_MIN_SIMILARITY = 0.57;

/**
 * Whether a result is close enough to be shown. A regulation cited by number
 * always is: it was asked for by name.
 */
export const isCloseEnough = (
  hit: Pick<SearchHit, "match" | "similarity">,
  minSimilarity: number,
) => hit.match === "reference" || hit.similarity >= minSimilarity;

/** Regulations looked up per citation; the most recent ones win. */
const MAX_REGULATIONS_PER_REFERENCE = 3;

/**
 * Chosen by measuring (docs/evaluacion.md): with pgvector's own default, 40,
 * the index missed answers the exact search finds; from 100 on it finds the
 * same ones, in about 5 ms instead of 130.
 */
export const DEFAULT_EF_SEARCH = 100;
export const MAX_EF_SEARCH = 1000;

export type SearchHit = {
  chunkId: number;
  /**
   * Why the chunk is here: `reference` when the question cites its regulation
   * by number, `semantic` when it is close in meaning.
   */
  match: "reference" | "semantic";
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
 * Returns the chunks that answer the question, best first.
 *
 * Two searches are combined. If the question cites a regulation by number
 * ("Decreto 833/2026"), that regulation is looked up directly and its chunks
 * go first. The rest are the chunks closest in meaning: the question is
 * embedded with the same model as the chunks and compared by cosine distance.
 * Filters run in the same SQL queries.
 */
export async function searchChunks(
  db: Database,
  embedder: Embedder,
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  let vector: number[] | undefined;
  try {
    [vector] = await embedder.embed([query]);
  } catch (cause) {
    throw new QueryEmbeddingError(embedder.model, cause);
  }
  if (!vector) throw new QueryEmbeddingError(embedder.model, "no vector returned");

  return searchByVector(db, embedder.model, vector, {
    references: findReferences(query),
    ...options,
  });
}

/**
 * The database side of the search: the chunks closest to a vector that was
 * produced by `model`, best first.
 */
export async function searchByVector(
  db: Database,
  model: string,
  vector: number[],
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  if (!(minSimilarity >= 0 && minSimilarity <= 1)) {
    throw new RangeError(`minSimilarity must be between 0 and 1, got ${minSimilarity}`);
  }

  const efSearch = options.efSearch ?? DEFAULT_EF_SEARCH;
  if (!Number.isInteger(efSearch) || efSearch < 1 || efSearch > MAX_EF_SEARCH) {
    throw new RangeError(
      `efSearch must be a whole number between 1 and ${MAX_EF_SEARCH}, got ${efSearch}`,
    );
  }

  const distance = cosineDistance(chunks.embedding, vector);

  const filters: SQL[] = [];
  if (options.types?.length) {
    filters.push(
      inArray(
        sql`lower(${regulations.type})`,
        options.types.map((type) => type.trim().toLowerCase()),
      ),
    );
  }
  if (options.yearFrom !== undefined) {
    filters.push(gte(regulations.enactedOn, `${options.yearFrom}-01-01`));
  }
  if (options.yearTo !== undefined) {
    filters.push(lte(regulations.enactedOn, `${options.yearTo}-12-31`));
  }

  const embedded = [
    isNotNull(chunks.embedding),
    // Vectors from another model live in a different space: never compare them.
    eq(chunks.embeddingModel, model),
  ];

  const { cited, semantic } = await db.transaction(async (tx) => {
    const selectHits = (conditions: (SQL | undefined)[], order: SQL, count: number) =>
      tx
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
        .where(and(...embedded, ...filters, ...conditions))
        .orderBy(order)
        .limit(count);

    // 1. Regulations cited by number: an exact lookup, not a similarity guess.
    const citedIds: number[] = [];
    for (const reference of options.references ?? []) {
      const rows = await tx
        .select({ id: regulations.id })
        .from(regulations)
        .where(
          and(
            eq(regulations.type, reference.type),
            eq(regulations.number, reference.number),
            reference.year === undefined
              ? undefined
              : and(
                  gte(regulations.enactedOn, `${reference.year}-01-01`),
                  lte(regulations.enactedOn, `${reference.year}-12-31`),
                ),
            ...filters,
          ),
        )
        // "Decreto 282" with no year is ambiguous: prefer the one in force.
        .orderBy(sql`${desc(regulations.enactedOn)} nulls last`)
        .limit(MAX_REGULATIONS_PER_REFERENCE);

      citedIds.push(...rows.map((row) => row.id));
    }

    const cited =
      citedIds.length === 0
        ? []
        : await selectHits(
            [inArray(chunks.regulationId, citedIds)],
            // "+ 0" keeps the vector index out of this query: the rows are
            // already picked by regulation, and there are only a few of them.
            sql`(${distance}) + 0`,
            Math.ceil(limit / 2),
          );

    // 2. Chunks closest in meaning.
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
    } else {
      // `set` takes no parameters; the value was checked to be an integer above.
      await tx.execute(sql.raw(`set local hnsw.ef_search = ${efSearch}`));
    }

    const semantic = await selectHits([], sql`${distance}`, limit);

    return { cited, semantic };
  });

  type Row = (typeof semantic)[number];
  const toHit = (row: Row, match: SearchHit["match"]): SearchHit => ({
    chunkId: row.chunkId,
    match,
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
  });

  // The cited regulation takes at most half of the results; the rest stays
  // open to what the question is about.
  const citedChunks = new Set(cited.map((row) => row.chunkId));

  return [
    ...cited.map((row) => toHit(row, "reference")),
    ...semantic
      .filter((row) => !citedChunks.has(row.chunkId))
      .map((row) => toHit(row, "semantic")),
  ]
    .filter((hit) => isCloseEnough(hit, minSimilarity))
    .slice(0, limit);
}
