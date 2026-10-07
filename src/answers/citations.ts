/** "[1]", "[1, 3]" and "[2][4]" in an answer. */
const CITATION = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;

export type Citations = {
  /** Numbers of the sources the answer points at, in order, without repeats. */
  cited: number[];
  /** Numbers the answer uses that are not among the sources. */
  unknown: number[];
};

/**
 * Reads the citations out of an answer and checks them against the sources it
 * was given, numbered 1 to `sourceCount`.
 *
 * A citation of a source that does not exist is the one mistake that can be
 * detected without reading the law: it is reported, not hidden.
 */
export function findCitations(answer: string, sourceCount: number): Citations {
  const cited = new Set<number>();
  const unknown = new Set<number>();

  for (const match of answer.matchAll(CITATION)) {
    for (const written of (match[1] ?? "").split(",")) {
      const n = Number.parseInt(written, 10);
      if (n >= 1 && n <= sourceCount) cited.add(n);
      else unknown.add(n);
    }
  }

  const ascending = (a: number, b: number) => a - b;
  return { cited: [...cited].sort(ascending), unknown: [...unknown].sort(ascending) };
}
