import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { regulations } from "@/db/schema";

import type { RegulationStore } from "./ingest";

/**
 * Stores regulations in PostgreSQL. Existing rows (same InfoLEG id) are
 * updated in place, so the ingestion can be re-run safely.
 */
export function createRegulationStore(db: Database): RegulationStore {
  return {
    async upsertMany(rows) {
      if (rows.length === 0) return;

      await db
        .insert(regulations)
        .values(rows)
        .onConflictDoUpdate({
          target: regulations.id,
          set: {
            type: sql`excluded.type`,
            number: sql`excluded.number`,
            class: sql`excluded.class`,
            issuingBody: sql`excluded.issuing_body`,
            enactedOn: sql`excluded.enacted_on`,
            gazetteNumber: sql`excluded.gazette_number`,
            gazetteDate: sql`excluded.gazette_date`,
            gazettePage: sql`excluded.gazette_page`,
            title: sql`excluded.title`,
            topic: sql`excluded.topic`,
            summary: sql`excluded.summary`,
            notes: sql`excluded.notes`,
            originalTextUrl: sql`excluded.original_text_url`,
            updatedTextUrl: sql`excluded.updated_text_url`,
            amendedByCount: sql`excluded.amended_by_count`,
            amendsCount: sql`excluded.amends_count`,
            updatedAt: sql`now()`,
          },
        });
    },
  };
}
