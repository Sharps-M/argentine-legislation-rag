import type { NextRequest } from "next/server";

import { getChatModel } from "@/ai/chat";
import { getEmbedder } from "@/ai/embedder";
import { answerResponse } from "@/answers/http";
import { getDb } from "@/db/client";
import { searchChunks } from "@/search/search";

/**
 * `GET /api/answer?q=...&lang=es&type=Ley&from=2024&to=2026`
 *
 * Streams the answer as server-sent events. Takes the same parameters as
 * `/api/search`, plus `lang`: the language to answer in (`es` or `en`), guessed
 * from the question when left out.
 */
export async function GET(request: NextRequest) {
  const embedder = getEmbedder();

  return answerResponse(
    request.nextUrl.searchParams,
    {
      search: (query, options) => searchChunks(getDb(), embedder, query, options),
      chat: getChatModel,
    },
    request.signal,
  );
}
