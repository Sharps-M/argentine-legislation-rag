import type { NewRegulation } from "@/db/schema";

export type SubsetFilter = {
  /** Regulation types to keep (matched case- and accent-insensitively). Empty = all. */
  types: string[];
  /** Keep regulations enacted on or after this date (YYYY-MM-DD). `null` = no limit. */
  since: string | null;
};

export const normalizeType = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();

/**
 * The date a regulation is filtered by: when it was enacted, or when it was
 * published in the official gazette if the enactment date is missing.
 */
export const effectiveDate = (regulation: NewRegulation): string | null =>
  regulation.enactedOn ?? regulation.gazetteDate ?? null;

export function matchesSubset(
  regulation: NewRegulation,
  filter: SubsetFilter,
): boolean {
  if (filter.types.length > 0) {
    const wanted = filter.types.map(normalizeType);
    if (!wanted.includes(normalizeType(regulation.type))) return false;
  }

  if (filter.since) {
    const date = effectiveDate(regulation);
    // ISO dates compare correctly as strings. Undated regulations are left out.
    if (!date || date < filter.since) return false;
  }

  return true;
}

/** `years` years before `today`, as YYYY-MM-DD. */
export function yearsAgo(years: number, today: Date = new Date()): string {
  const date = new Date(
    Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate()),
  );
  return date.toISOString().slice(0, 10);
}
