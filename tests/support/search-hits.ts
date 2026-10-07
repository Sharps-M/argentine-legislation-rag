import type { SearchHit } from "@/search/search";

/** A search result with sensible values; pass only what the test is about. */
export function searchHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    chunkId: 1,
    match: "semantic",
    similarity: 0.7,
    section: "article",
    label: "Artículo 3",
    content:
      "La retribución no deberá superar el monto de PESOS NOVECIENTOS SIETE MIL NOVECIENTOS TREINTA Y CUATRO ($907.934).",
    earlierVersions: [],
    ...overrides,
    regulation: {
      id: 429383,
      type: "Decreto",
      number: "832",
      name: "Decreto 832/2026",
      title: "ACTAS ACUERDO - HOMOLOGANSE",
      topic: "ACUERDOS",
      enactedOn: "2026-08-28",
      textSource: "original",
      url: "http://example.test/429383.htm",
      ...overrides.regulation,
    },
  };
}

export function earlierVersion(
  name: string,
  enactedOn: string | null,
  regulationId = 1,
) {
  return {
    chunkId: regulationId,
    regulationId,
    name,
    enactedOn,
    url: `http://example.test/${regulationId}.htm`,
    similarity: 0.69,
    textSimilarity: 0.96,
  };
}
