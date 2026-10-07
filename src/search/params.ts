import { z } from "zod";

import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, type SearchOptions } from "./search";

export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 500;

const year = z.coerce.number().int().min(1810).max(2100);

const schema = z
  .object({
    q: z.string().trim().min(MIN_QUERY_LENGTH).max(MAX_QUERY_LENGTH),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_LIMIT)
      .default(DEFAULT_SEARCH_LIMIT),
    type: z.array(z.string().trim().min(1).max(40)).max(5),
    from: year.optional(),
    to: year.optional(),
    min_similarity: z.coerce.number().min(0).max(1).optional(),
    versions: z.union([z.literal("off"), z.coerce.number().gt(0).max(1)]).optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    path: ["from"],
    message: "`from` must not be later than `to`",
  });

export type SearchRequestIssue = { field: string; message: string };

export type ParsedSearchRequest =
  | {
      ok: true;
      query: string;
      options: Required<Pick<SearchOptions, "limit">> & SearchOptions;
    }
  | { ok: false; issues: SearchRequestIssue[] };

/**
 * Validates the query string of a search request:
 * `?q=...&limit=8&type=Ley&type=Decreto&from=2024&to=2026&min_similarity=0.6`.
 *
 * `type` can be repeated or comma-separated. `versions` is how alike two texts
 * must be to be listed together, or `off`. Empty values count as absent.
 */
export function parseSearchParams(params: URLSearchParams): ParsedSearchRequest {
  const optional = (name: string) => params.get(name)?.trim() || undefined;

  const result = schema.safeParse({
    q: params.get("q") ?? "",
    limit: optional("limit"),
    type: params
      .getAll("type")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
    from: optional("from"),
    to: optional("to"),
    min_similarity: optional("min_similarity"),
    versions: optional("versions"),
  });

  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        field: String(issue.path[0] ?? "request"),
        message: issue.message,
      })),
    };
  }

  const {
    q,
    limit,
    type,
    from,
    to,
    min_similarity: minSimilarity,
    versions,
  } = result.data;

  return {
    ok: true,
    query: q,
    options: {
      limit,
      ...(type.length > 0 && { types: type }),
      ...(from !== undefined && { yearFrom: from }),
      ...(to !== undefined && { yearTo: to }),
      ...(minSimilarity !== undefined && { minSimilarity }),
      ...(versions !== undefined && {
        versionSimilarity: versions === "off" ? null : versions,
      }),
    },
  };
}
