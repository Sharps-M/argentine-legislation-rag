import type { NextRequest } from "next/server";

import { getEmbedder } from "@/ai/embedder";
import { getDb } from "@/db/client";
import { searchResponse } from "@/search/http";
import { searchChunks } from "@/search/search";

/** `GET /api/search?q=...&limit=8&type=Ley&from=2024&to=2026` */
export async function GET(request: NextRequest) {
  const embedder = getEmbedder();

  return searchResponse(
    request.nextUrl.searchParams,
    (query, options) => searchChunks(getDb(), embedder, query, options),
    embedder.model,
  );
}
