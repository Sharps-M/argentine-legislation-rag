import type { NewRegulation } from "@/db/schema";

import { parseInfolegRow } from "./infoleg-row";
import { effectiveDate, matchesSubset, type SubsetFilter } from "./subset";

/** Where validated regulations are written. Swappable, so the pipeline is testable. */
export type RegulationStore = {
  upsertMany: (regulations: NewRegulation[]) => Promise<void>;
};

export type IngestOptions = {
  filter: SubsetFilter;
  /** Rows written per database round trip. */
  batchSize?: number;
  /** Stop after this many rows have been selected (useful for a quick trial). */
  limit?: number;
  /** How many rejected rows to keep as examples in the report. */
  maxRejectedExamples?: number;
};

export type IngestReport = {
  read: number;
  rejected: number;
  filteredOut: number;
  selected: number;
  /** Rejection reason -> number of rows. */
  rejectionReasons: Record<string, number>;
  rejectedExamples: { line: number; id: string; reasons: string[] }[];
  /** Selected rows per regulation type. */
  byType: Record<string, number>;
  /** Selected rows per year of the effective date (`unknown` when undated). */
  byYear: Record<string, number>;
};

const increment = (counter: Record<string, number>, key: string) => {
  counter[key] = (counter[key] ?? 0) + 1;
};

/**
 * Validates, filters and stores a stream of raw InfoLEG records.
 *
 * Pass `store: null` for a dry run that only produces the report.
 */
export async function ingestRegulations(
  records: AsyncIterable<Record<string, unknown>>,
  store: RegulationStore | null,
  options: IngestOptions,
): Promise<IngestReport> {
  const { filter, batchSize = 500, limit, maxRejectedExamples = 10 } = options;

  const report: IngestReport = {
    read: 0,
    rejected: 0,
    filteredOut: 0,
    selected: 0,
    rejectionReasons: {},
    rejectedExamples: [],
    byType: {},
    byYear: {},
  };

  let batch: NewRegulation[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    await store?.upsertMany(batch);
    batch = [];
  };

  for await (const record of records) {
    if (limit !== undefined && report.selected >= limit) break;

    report.read += 1;
    const parsed = parseInfolegRow(record);

    if (!parsed.ok) {
      report.rejected += 1;
      for (const reason of parsed.reasons) increment(report.rejectionReasons, reason);

      if (report.rejectedExamples.length < maxRejectedExamples) {
        report.rejectedExamples.push({
          // +1 for the header line.
          line: report.read + 1,
          id: String(record.id_norma ?? ""),
          reasons: parsed.reasons,
        });
      }
      continue;
    }

    if (!matchesSubset(parsed.regulation, filter)) {
      report.filteredOut += 1;
      continue;
    }

    report.selected += 1;
    increment(report.byType, parsed.regulation.type);
    increment(
      report.byYear,
      effectiveDate(parsed.regulation)?.slice(0, 4) ?? "unknown",
    );

    batch.push(parsed.regulation);
    if (batch.length >= batchSize) await flush();
  }

  await flush();

  return report;
}
