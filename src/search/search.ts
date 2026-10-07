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
import { groupVersions, type VersionLinkage } from "./versions";

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
   * Chunks of different regulations, enacted on different days, whose texts
   * are at least this similar (0 to 1) are listed together: the most recent
   * leads, with the others under it. `null` lists every chunk on its own.
   */
  versionSimilarity?: number | null;
  /** To which member of a group a chunk is compared; see `VersionLinkage`. */
  versionLinkage?: VersionLinkage;
  /**
   * Regulations the question cites by number. Their chunks come first,
   * whatever the similarity search finds. `searchChunks` fills this in.
   */
  references?: RegulationReference[];
};

/**
 * Chosen by measuring (docs/evaluacion.md), and already moved once: it was
 * 0.57 with 41,000 chunks and had to come down when the corpus grew fivefold.
 * With 0.55 every right answer of the evaluation is kept (the lowest scores
 * 0.566) and every question about a subject the corpus does not cover is
 * rejected (the highest scores 0.533). Run `npm run eval -- --floors` again
 * whenever the corpus or the model changes.
 */
export const DEFAULT_MIN_SIMILARITY = 0.55;

/**
 * Whether a result is close enough to be shown. A regulation cited by number
 * always is: it was asked for by name.
 */
export const isCloseEnough = (
  hit: Pick<SearchHit, "match" | "similarity">,
  minSimilarity: number,
) => hit.match === "reference" || hit.similarity >= minSimilarity;

/**
 * Best first. The database already returns the rows by distance; this settles
 * the order of chunks with exactly the same similarity, which the database
 * leaves open and which changed between the index and the exact scan.
 */
export const byRelevance = (
  a: { similarity: number; chunkId: number },
  b: { similarity: number; chunkId: number },
) => b.similarity - a.similarity || a.chunkId - b.chunkId;

/**
 * Chosen by measuring (docs/evaluacion.md). Linked by chain at 0.95, the latest
 * issue of a reissued provision leads: recall@1 went from 64% to 82%, while the
 * questions that ask for an earlier issue were found as often as before. Linked
 * by the best chunk of each group, the same threshold cut a series into several
 * groups and gained half as much.
 *
 * `null` turns the grouping off. Run `npm run eval -- --versions-sweep` again
 * whenever the corpus or the model changes.
 */
export const DEFAULT_VERSION_SIMILARITY: number | null = 0.95;
export const DEFAULT_VERSION_LINKAGE: VersionLinkage = "chain";

/** How many chunks are compared when looking for versions of one provision. */
const VERSION_POOL = 100;

/** Regulations looked up per citation; the most recent ones win. */
const MAX_REGULATIONS_PER_REFERENCE = 3;

/**
 * Chosen by measuring (docs/evaluacion.md): with pgvector's own default, 40,
 * the index missed answers the exact search finds; from 100 on it finds the
 * same ones, in about 5 ms instead of 130.
 */
export const DEFAULT_EF_SEARCH = 100;
export const MAX_EF_SEARCH = 1000;

/**
 * An older regulation with nearly the same text as a search result. It says
 * the texts are alike, not that the newer one replaced it: the dataset does not
 * tell which regulation repealed which.
 */
export type EarlierVersion = {
  chunkId: number;
  regulationId: number;
  /** "Decreto 294/2025". */
  name: string;
  enactedOn: string | null;
  url: string;
  /** Similarity with the question. */
  similarity: number;
  /** Similarity between its text and the text of the result it sits under. */
  textSimilarity: number;
};

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
  /**
   * Older regulations with the same provision, most recent first. Empty unless
   * versions are being grouped.
   */
  earlierVersions: EarlierVersion[];
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

  const versionSimilarity =
    options.versionSimilarity === undefined
      ? DEFAULT_VERSION_SIMILARITY
      : options.versionSimilarity;
  if (
    versionSimilarity !== null &&
    !(versionSimilarity > 0 && versionSimilarity <= 1)
  ) {
    throw new RangeError(
      `versionSimilarity must be above 0 and at most 1, got ${versionSimilarity}`,
    );
  }
  // Versions of a provision sit a few places apart: look further than `limit`.
  const pool = versionSimilarity === null ? limit : Math.max(limit, VERSION_POOL);

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

    const semantic = await selectHits([], sql`${distance}`, pool);

    return { cited: cited.sort(byRelevance), semantic: semantic.sort(byRelevance) };
  });

  type Row = (typeof semantic)[number];
  const urlOf = (row: Row) => row.sourceUrl ?? infolegUrl(row.regulationId);
  const toHit = (
    row: Row,
    match: SearchHit["match"],
    earlierVersions: EarlierVersion[] = [],
  ): SearchHit => ({
    chunkId: row.chunkId,
    match,
    similarity: row.similarity,
    section: row.section,
    label: row.label,
    content: row.content,
    earlierVersions,
    regulation: {
      id: row.regulationId,
      type: row.type,
      number: row.number,
      name: regulationName(row),
      title: row.title,
      topic: row.topic,
      enactedOn: row.enactedOn,
      textSource: row.textSource,
      url: urlOf(row),
    },
  });

  // The cited regulation takes at most half of the results; the rest stays
  // open to what the question is about.
  const citedChunks = new Set(cited.map((row) => row.chunkId));
  const close = semantic.filter(
    (row) =>
      !citedChunks.has(row.chunkId) &&
      isCloseEnough({ match: "semantic", similarity: row.similarity }, minSimilarity),
  );

  let semanticHits: SearchHit[];
  if (versionSimilarity === null || close.length < 2) {
    semanticHits = close.map((row) => toHit(row, "semantic"));
  } else {
    // The vectors are fetched only here: grouping needs to compare the texts
    // with each other, not with the question.
    const vectors = new Map(
      (
        await db
          .select({ id: chunks.id, embedding: chunks.embedding })
          .from(chunks)
          .where(
            inArray(
              chunks.id,
              close.map((row) => row.chunkId),
            ),
          )
      ).map((row) => [row.id, row.embedding ?? []] as const),
    );

    semanticHits = groupVersions(
      close.map((row) => ({ ...row, embedding: vectors.get(row.chunkId) ?? [] })),
      versionSimilarity,
      options.versionLinkage ?? DEFAULT_VERSION_LINKAGE,
    ).map(({ leader, others }) =>
      toHit(
        leader,
        "semantic",
        others.map(({ item, textSimilarity }) => ({
          chunkId: item.chunkId,
          regulationId: item.regulationId,
          name: regulationName(item),
          enactedOn: item.enactedOn,
          url: urlOf(item),
          similarity: item.similarity,
          textSimilarity,
        })),
      ),
    );
  }

  return [...cited.map((row) => toHit(row, "reference")), ...semanticHits].slice(
    0,
    limit,
  );
}
