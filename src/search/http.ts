import { parseSearchParams } from "./params";
import {
  DEFAULT_MIN_SIMILARITY,
  DEFAULT_VERSION_SIMILARITY,
  QueryEmbeddingError,
  type SearchHit,
  type SearchOptions,
} from "./search";

export type SearchFn = (query: string, options: SearchOptions) => Promise<SearchHit[]>;

export type SearchResponseBody = {
  query: string;
  model: string;
  /** How close a chunk had to be to count; explains an empty list. */
  minSimilarity: number;
  /**
   * How alike two texts had to be for an earlier regulation to be listed under
   * a newer one (`earlierVersions`); `null` when every chunk is listed on its own.
   */
  versionSimilarity: number | null;
  results: SearchHit[];
};

/**
 * The HTTP side of the search: validates the request, runs the search it is
 * given and maps the outcome to a status code.
 *
 * - `400` the request is invalid (the body lists each problem)
 * - `503` the embedding model cannot be reached
 * - `200` results, best first (an empty list is a valid answer: no regulation
 *   is close enough to the question)
 */
export async function searchResponse(
  params: URLSearchParams,
  search: SearchFn,
  model: string,
): Promise<Response> {
  const request = parseSearchParams(params);

  if (!request.ok) {
    return Response.json(
      { error: "invalid_request", issues: request.issues },
      { status: 400 },
    );
  }

  try {
    const results = await search(request.query, request.options);
    const body: SearchResponseBody = {
      query: request.query,
      model,
      minSimilarity: request.options.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
      versionSimilarity:
        request.options.versionSimilarity === undefined
          ? DEFAULT_VERSION_SIMILARITY
          : request.options.versionSimilarity,
      results,
    };

    return Response.json(body);
  } catch (error) {
    if (error instanceof QueryEmbeddingError) {
      console.error(error.message, error.cause);

      return Response.json(
        {
          error: "embeddings_unavailable",
          message: "The embedding model is not reachable. Is Ollama running?",
        },
        { status: 503 },
      );
    }

    throw error;
  }
}
