import { parseSearchParams } from "@/search/params";
import { QueryEmbeddingError } from "@/search/search";

import { answerQuestion, type AnswerDeps, type AnswerEvent } from "./answer";
import { isAnswerLanguage } from "./language";

const encoder = new TextEncoder();

/** One server-sent event: `event: <type>` and its data as JSON. */
export const formatEvent = (event: AnswerEvent): string => {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
};

/**
 * The HTTP side of an answer: validates the request and streams the answer as
 * server-sent events: `sources`, then `text` many times, then `done` or
 * `error`. Before the text, `asking` names each model as it is asked, and
 * `skipped` each one that could not answer, with how long it was waited for.
 * The last event says where the time went.
 *
 * - `400` the request is invalid (the body lists each problem)
 * - `503` the embedding model cannot be reached, so there was nothing to stream
 * - `200` the stream. A failure of the chat model arrives inside it, as an
 *   `error` event after the sources.
 */
export async function answerResponse(
  params: URLSearchParams,
  deps: AnswerDeps,
  signal?: AbortSignal,
): Promise<Response> {
  const request = parseSearchParams(params);
  const lang = params.get("lang")?.trim() || undefined;
  const issues = [
    ...(request.ok ? [] : request.issues),
    ...(lang === undefined || isAnswerLanguage(lang)
      ? []
      : [{ field: "lang", message: 'Invalid option: expected one of "es"|"en"' }]),
  ];

  if (!request.ok || issues.length > 0) {
    return Response.json({ error: "invalid_request", issues }, { status: 400 });
  }

  const events = answerQuestion(deps, request.query, {
    ...request.options,
    signal,
    ...(lang !== undefined && isAnswerLanguage(lang) && { language: lang }),
  });

  // The search runs before the first event. Waiting for it here keeps a plain
  // status code available for the one failure that happens before the stream.
  let first: IteratorResult<AnswerEvent, void>;
  try {
    first = await events.next();
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

  let pending: IteratorResult<AnswerEvent, void> | undefined = first;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = pending ?? (await events.next());
        pending = undefined;

        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(formatEvent(next.value)));
      } catch (error) {
        console.error(error);
        controller.error(error);
      }
    },
    // The reader went away: stop asking the model for more.
    async cancel() {
      await events.return();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Asks reverse proxies not to hold the answer back until it is complete.
      "X-Accel-Buffering": "no",
    },
  });
}
