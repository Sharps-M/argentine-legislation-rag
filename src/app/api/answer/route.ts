import type { NextRequest } from "next/server";

import { getChatModel } from "@/ai/chat";
import { getEmbedder } from "@/ai/embedder";
import { answerResponse } from "@/answers/http";
import { getDb } from "@/db/client";
import { getEnv } from "@/env";
import { searchChunks } from "@/search/search";
import { clientOf, createAnswerLimits, type AnswerLimits } from "@/server/rate-limit";

/** One count for the whole process, created on the first question. */
let limits: AnswerLimits | undefined;

/**
 * `GET /api/answer?q=...&lang=es&type=Ley&from=2024&to=2026`
 *
 * Streams the answer as server-sent events. Takes the same parameters as
 * `/api/search`, plus `lang`: the language to answer in (`es` or `en`), guessed
 * from the question when left out.
 *
 * Gives at most `ANSWER_LIMIT_PER_CLIENT` answers per minute to each client and
 * `ANSWER_LIMIT_TOTAL` to everyone; past that, `429` with `Retry-After`.
 */
export async function GET(request: NextRequest) {
  const embedder = getEmbedder();
  const env = getEnv();
  limits ??= createAnswerLimits({
    perClient: env.ANSWER_LIMIT_PER_CLIENT,
    total: env.ANSWER_LIMIT_TOTAL,
  });

  return answerResponse(
    request.nextUrl.searchParams,
    {
      search: (query, options) => searchChunks(getDb(), embedder, query, options),
      chat: getChatModel,
    },
    { signal: request.signal, client: clientOf(request.headers), limits },
  );
}
