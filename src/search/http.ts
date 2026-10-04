import { parseSearchParams } from "./params";
import { QueryEmbeddingError, type SearchHit, type SearchOptions } from "./search";

export type SearchFn = (query: string, options: SearchOptions) => Promise<SearchHit[]>;

export type SearchResponseBody = {
  query: string;
  model: string;
  results: SearchHit[];
};

/**
 * The HTTP side of the search: validates the request, runs the search it is
 * given and maps the outcome to a status code.
 *
 * - `400` the request is invalid (the body lists each problem)
 * - `503` the embedding model cannot be reached
 * - `200` results, best first (an empty list is a valid answer)
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
    const body: SearchResponseBody = { query: request.query, model, results };

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
