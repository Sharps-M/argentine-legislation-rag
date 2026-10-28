import {
  MAX_QUERY_LENGTH,
  MAX_YEAR,
  MIN_QUERY_LENGTH,
  MIN_YEAR,
} from "@/search/query-limits";

/** The regulation types the corpus holds (decision 29), as InfoLEG names them. */
export const CORPUS_TYPES = ["Ley", "Decreto", "Decreto/Ley"] as const;
export type CorpusType = (typeof CORPUS_TYPES)[number];

/** A question and its filters: what the address of the page says. */
export type AskQuery = {
  q: string;
  type: CorpusType | null;
  from: number | null;
  to: number | null;
};

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

const first = (params: Params, name: string): string | undefined => {
  if (params instanceof URLSearchParams) return params.get(name) ?? undefined;
  const value = params[name];
  return Array.isArray(value) ? value[0] : value;
};

const year = (written: string | undefined): number | null => {
  const value = Number(written?.trim());
  return Number.isInteger(value) && value >= MIN_YEAR && value <= MAX_YEAR
    ? value
    : null;
};

/**
 * Reads a question and its filters from an address, as the page or a link
 * wrote it. What is not valid is left out, never refused: a link with a typo
 * still opens the page, without the filter it got wrong.
 */
export function queryFromParams(params: Params): AskQuery {
  const type = first(params, "type")?.trim();
  return {
    q: (first(params, "q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    type: (CORPUS_TYPES as readonly string[]).includes(type ?? "")
      ? (type as CorpusType)
      : null,
    from: year(first(params, "from")),
    to: year(first(params, "to")),
  };
}

/** The address for a question: "?q=...&type=Ley&from=2020". Empty for no question. */
export function toSearch(query: AskQuery): string {
  if (!query.q) return "";
  const params = new URLSearchParams({ q: query.q });
  if (query.type) params.set("type", query.type);
  if (query.from !== null) params.set("from", String(query.from));
  if (query.to !== null) params.set("to", String(query.to));
  return `?${params}`;
}

/** What is wrong with a question before it is sent, if anything. */
export function queryProblem(query: AskQuery): "too_short" | "years_order" | null {
  if (query.q.length < MIN_QUERY_LENGTH) return "too_short";
  if (query.from !== null && query.to !== null && query.from > query.to) {
    return "years_order";
  }
  return null;
}

/** How many filters are set: shown next to the word "Filters". */
export const filterCount = (query: AskQuery) =>
  [query.type, query.from, query.to].filter((value) => value !== null).length;
