import { date, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
