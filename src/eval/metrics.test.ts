import { describe, expect, it } from "vitest";

import { evaluate, firstRelevantRank, meanReciprocalRank, recallAtK } from "./metrics";
import type { GoldQuestion } from "./questions";

describe("firstRelevantRank", () => {
  it("returns the position of the first chunk of an expected regulation", () => {
    expect(firstRelevantRank([10, 20, 30], [20])).toBe(2);
    expect(firstRelevantRank([10, 10, 20], [10])).toBe(1);
  });

  it("accepts any of several expected regulations", () => {
    expect(firstRelevantRank([10, 20, 30], [30, 20])).toBe(2);
  });

  it("returns null when none was retrieved", () => {
    expect(firstRelevantRank([10, 20], [99])).toBeNull();
    expect(firstRelevantRank([], [99])).toBeNull();
  });
});

describe("recallAtK", () => {
  const ranks = [1, 3, 6, null];

  it("counts the questions answered within the first k results", () => {
    expect(recallAtK(ranks, 1)).toBe(0.25);
    expect(recallAtK(ranks, 3)).toBe(0.5);
    expect(recallAtK(ranks, 5)).toBe(0.5);
    expect(recallAtK(ranks, 10)).toBe(0.75);
  });

  it("is zero without questions", () => {
    expect(recallAtK([], 5)).toBe(0);
  });
});

describe("meanReciprocalRank", () => {
  it("averages 1/rank and counts a miss as zero", () => {
    expect(meanReciprocalRank([1, 2, 4, null])).toBeCloseTo((1 + 0.5 + 0.25 + 0) / 4);
  });

  it("is 1 when every answer comes first", () => {
    expect(meanReciprocalRank([1, 1, 1])).toBe(1);
  });

  it("is zero without questions", () => {
    expect(meanReciprocalRank([])).toBe(0);
  });
});

describe("evaluate", () => {
  const questions: GoldQuestion[] = [
    { question: "primera", kind: "topic", expected: [1] },
    { question: "segunda", kind: "topic", expected: [2] },
    { question: "tercera", kind: "reference", expected: [3] },
    { question: "cuarta", kind: "reference", expected: [4] },
  ];

  const retrieved: Record<string, number[]> = {
    primera: [1, 9, 9],
    segunda: [9, 9, 2],
    tercera: [9, 3, 9],
    cuarta: [9, 9, 9],
  };

  it("scores every question, overall and by kind", async () => {
    const report = await evaluate(
      questions,
      async (question) => retrieved[question] ?? [],
      [1, 3],
    );

    expect(report.results.map((result) => result.rank)).toEqual([1, 3, 2, null]);
    expect(report.overall).toEqual({
      questions: 4,
      recall: { 1: 0.25, 3: 0.75 },
      mrr: (1 + 1 / 3 + 1 / 2 + 0) / 4,
    });
    expect(report.byKind.topic).toEqual({
      questions: 2,
      recall: { 1: 0.5, 3: 1 },
      mrr: (1 + 1 / 3) / 2,
    });
    expect(report.byKind.reference).toEqual({
      questions: 2,
      recall: { 1: 0, 3: 0.5 },
      mrr: 0.25,
    });
  });

  it("asks the questions one at a time, in order", async () => {
    const asked: string[] = [];
    let running = 0;

    await evaluate(questions, async (question) => {
      running += 1;
      expect(running).toBe(1);
      asked.push(question);
      await Promise.resolve();
      running -= 1;
      return [];
    });

    expect(asked).toEqual(["primera", "segunda", "tercera", "cuarta"]);
  });
});
