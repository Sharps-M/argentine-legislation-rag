import type { SearchHit } from "@/search/search";

/** How many chunks are handed to the model: enough to answer, few enough to read. */
export const MAX_SOURCES = 8;
/** Earlier regulations named under a source; a long series adds nothing more. */
export const MAX_EARLIER = 6;

/**
 * A chunk as the model and the reader see it: numbered, so an answer can point
 * at it with `[n]`.
 */
export type AnswerSource = {
  /** The number used in citations, starting at 1. */
  n: number;
  chunkId: number;
  /** InfoLEG id of the regulation the chunk belongs to. */
  regulationId: number;
  /** "Decreto 832/2026 · Artículo 3" */
  title: string;
  /** ISO date the regulation was enacted, when known. */
  enactedOn: string | null;
  /** "ACUERDOS / HOMOLOGACION": what the regulation is about. */
  subject: string | null;
  url: string;
  content: string;
  /** Only the official abstract of the regulation is published, not its text. */
  abstractOnly: boolean;
  /** Why the search returned it: cited by number, or close in meaning. */
  match: SearchHit["match"];
  similarity: number;
  /** Older regulations with nearly the same text, newest first. */
  earlier: {
    regulationId: number;
    name: string;
    enactedOn: string | null;
    url: string;
  }[];
  /** How many more there are beyond the ones listed in `earlier`. */
  earlierOmitted: number;
};

/** Numbers the search results, best first, keeping at most `max`. */
export function toSources(
  hits: readonly SearchHit[],
  max = MAX_SOURCES,
): AnswerSource[] {
  return hits.slice(0, max).map((hit, index) => ({
    n: index + 1,
    chunkId: hit.chunkId,
    regulationId: hit.regulation.id,
    title: [hit.regulation.name, hit.label].filter(Boolean).join(" · "),
    enactedOn: hit.regulation.enactedOn,
    subject:
      [hit.regulation.topic, hit.regulation.title].filter(Boolean).join(" / ") || null,
    url: hit.regulation.url,
    content: hit.content,
    abstractOnly: hit.regulation.textSource === "summary",
    match: hit.match,
    similarity: hit.similarity,
    earlier: hit.earlierVersions.slice(0, MAX_EARLIER).map((version) => ({
      regulationId: version.regulationId,
      name: version.name,
      enactedOn: version.enactedOn,
      url: version.url,
    })),
    earlierOmitted: Math.max(0, hit.earlierVersions.length - MAX_EARLIER),
  }));
}
