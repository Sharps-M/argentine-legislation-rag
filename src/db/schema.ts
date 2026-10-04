import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Size of the embedding vectors. It is a property of the embedding model
 * (bge-m3 produces 1,024 dimensions) and of the column: changing the model for
 * one with another size needs a migration and a full re-embedding.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * A regulation (law, decree, resolution...) as published by InfoLEG.
 *
 * The primary key is InfoLEG's own identifier (`id_norma`), so re-running the
 * ingestion updates rows in place instead of duplicating them.
 */
export const regulations = pgTable(
  "regulations",
  {
    id: integer("id").primaryKey(),
    type: text("type").notNull(),
    number: text("number"),
    class: text("class"),
    issuingBody: text("issuing_body"),
    enactedOn: date("enacted_on"),
    gazetteNumber: integer("gazette_number"),
    gazetteDate: date("gazette_date"),
    gazettePage: integer("gazette_page"),
    title: text("title"),
    topic: text("topic"),
    summary: text("summary"),
    notes: text("notes"),
    originalTextUrl: text("original_text_url"),
    updatedTextUrl: text("updated_text_url"),
    amendedByCount: integer("amended_by_count").notNull().default(0),
    amendsCount: integer("amends_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("regulations_type_idx").on(table.type),
    index("regulations_enacted_on_idx").on(table.enactedOn),
  ],
);

export type Regulation = typeof regulations.$inferSelect;
export type NewRegulation = typeof regulations.$inferInsert;

/**
 * The plain text of a regulation, extracted from its InfoLEG page, or built
 * from its title and summary when InfoLEG publishes no full text for it.
 */
export const regulationTexts = pgTable("regulation_texts", {
  regulationId: integer("regulation_id")
    .primaryKey()
    .references(() => regulations.id, { onDelete: "cascade" }),
  /** `updated` (consolidated text), `original` (as published) or `summary`. */
  source: text("source").notNull(),
  sourceUrl: text("source_url"),
  content: text("content").notNull(),
  /** SHA-256 of `content`: tells whether a re-fetched page actually changed. */
  contentHash: text("content_hash").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A retrieval unit: one article, or a slice of a preamble or annex. */
export const chunks = pgTable(
  "chunks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    regulationId: integer("regulation_id")
      .notNull()
      .references(() => regulations.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    section: text("section").notNull(),
    label: text("label"),
    content: text("content").notNull(),
    /** `null` until `npm run embed` processes the chunk. */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    /** Model that produced `embedding`: vectors from different models never mix. */
    embeddingModel: text("embedding_model"),
  },
  (table) => [
    uniqueIndex("chunks_regulation_ordinal_idx").on(table.regulationId, table.ordinal),
    // Approximate nearest-neighbour search by cosine distance.
    index("chunks_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export type RegulationText = typeof regulationTexts.$inferSelect;
export type NewRegulationText = typeof regulationTexts.$inferInsert;
export type ChunkRow = typeof chunks.$inferSelect;
