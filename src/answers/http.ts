import type { AnswerLimits } from "@/server/rate-limit";
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
 * When the sources found do not answer, `rewritten` says how the question was
 * searched again and, if that found something, a second `sources` follows.
 * The last event says where the time went.
 *
 * - `400` the request is invalid (the body lists each problem)
 * - `429` too many answers in the last minute, from this client or from
 *   everyone: `Retry-After` says in how many seconds to try again
 * - `503` the embedding model cannot be reached, so there was nothing to stream
 * - `200` the stream. A failure of the chat model arrives inside it, as an
 *   `error` event after the sources.
 */
export type AnswerRequestContext = {
  signal?: AbortSignal;
  /** Who is asking, for the limit per client. */
  client?: string;
  /** Left out, any number of answers is given. */
  limits?: AnswerLimits;
};

export async function answerResponse(
  params: URLSearchParams,
  deps: AnswerDeps,
  { signal, client = "unknown", limits }: AnswerRequestContext = {},
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

  // After the validation: a request that was going to be refused anyway does
  // not use up a place.
  const admission = limits?.admit(client) ?? { ok: true };
  if (!admission.ok) {
    const seconds = Math.ceil(admission.retryAfterMs / 1000);
    return Response.json(
      {
        error: "rate_limited",
        limit: admission.limit,
        message:
          admission.limit === "client"
            ? `Too many questions in the last minute. Try again in ${seconds} s.`
            : `The service is answering too many questions right now. Try again in ${seconds} s.`,
        retryAfterSeconds: seconds,
      },
      { status: 429, headers: { "Retry-After": String(seconds) } },
    );
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
  // The reader can leave while an event is being waited for: what arrives
  // after that has nowhere to go, and is not an error.
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = pending ?? (await events.next());
        pending = undefined;
        if (cancelled) return;

        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(formatEvent(next.value)));
      } catch (error) {
        if (cancelled) return;
        console.error(error);
        controller.error(error);
      }
    },
    // The reader went away: stop asking the model for more.
    async cancel() {
      cancelled = true;
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
