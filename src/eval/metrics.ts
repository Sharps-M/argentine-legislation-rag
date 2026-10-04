import type { GoldQuestion, QuestionKind } from "./questions";

/**
 * Position (1 = first) of the first retrieved chunk that belongs to one of the
 * expected regulations, or `null` when none of them was retrieved.
 */
export function firstRelevantRank(
  retrieved: readonly number[],
  expected: readonly number[],
): number | null {
  const index = retrieved.findIndex((id) => expected.includes(id));
  return index === -1 ? null : index + 1;
}

/** Share of questions whose answer appears within the first `k` results. */
export function recallAtK(ranks: readonly (number | null)[], k: number): number {
  if (ranks.length === 0) return 0;
  return ranks.filter((rank) => rank !== null && rank <= k).length / ranks.length;
}

/**
 * Mean reciprocal rank: the average of 1/rank, counting a miss as 0. It rewards
 * putting the right answer near the top, not just somewhere in the list.
 */
export function meanReciprocalRank(ranks: readonly (number | null)[]): number {
  if (ranks.length === 0) return 0;
  return (
    ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length
  );
}

export type QuestionResult = GoldQuestion & { rank: number | null };

export type Metrics = {
  questions: number;
  /** Recall at each requested `k`, keyed by `k`. */
  recall: Record<number, number>;
  mrr: number;
};

export type EvalReport = {
  results: QuestionResult[];
  overall: Metrics;
  byKind: Partial<Record<QuestionKind, Metrics>>;
};

const metricsFor = (results: QuestionResult[], ks: readonly number[]): Metrics => {
  const ranks = results.map((result) => result.rank);

  return {
    questions: results.length,
    recall: Object.fromEntries(ks.map((k) => [k, recallAtK(ranks, k)])),
    mrr: meanReciprocalRank(ranks),
  };
};

/**
 * Runs every question through `retrieve` (which returns the regulation id of
 * each retrieved chunk, best first) and scores the outcome.
 */
export async function evaluate(
  questions: readonly GoldQuestion[],
  retrieve: (question: string) => Promise<number[]>,
  ks: readonly number[] = [1, 3, 5, 10],
): Promise<EvalReport> {
  const results: QuestionResult[] = [];

  // One at a time: the embedding model serves a single local machine.
  for (const question of questions) {
    const retrieved = await retrieve(question.question);
    results.push({
      ...question,
      rank: firstRelevantRank(retrieved, question.expected),
    });
  }

  const kinds = [...new Set(results.map((result) => result.kind))];

  return {
    results,
    overall: metricsFor(results, ks),
    byKind: Object.fromEntries(
      kinds.map((kind) => [
        kind,
        metricsFor(
          results.filter((result) => result.kind === kind),
          ks,
        ),
      ]),
    ),
  };
}
