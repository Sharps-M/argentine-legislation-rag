import { yearsAgo, type SubsetFilter } from "@/ingest/subset";

/**
 * The regulations the corpus keeps (decisions 11 and 29): every law and
 * decree-law, whatever its date, and the decrees of the last five years.
 */
export const corpusSubset = (today: Date = new Date()): SubsetFilter[] => [
  { types: ["Ley", "Decreto/Ley"], since: null },
  { types: ["Decreto"], since: yearsAgo(5, today) },
];
