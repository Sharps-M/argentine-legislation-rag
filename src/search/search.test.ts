import { describe, expect, it } from "vitest";

import { byRelevance } from "./search";

describe("byRelevance", () => {
  const row = (chunkId: number, similarity: number) => ({ chunkId, similarity });

  it("puts the most similar chunk first", () => {
    const rows = [row(1, 0.6), row(2, 0.8), row(3, 0.7)];

    expect(rows.sort(byRelevance).map((item) => item.chunkId)).toEqual([2, 3, 1]);
  });

  it("orders chunks with the same similarity by id, whatever order they came in", () => {
    const one = [row(9, 0.5), row(4, 0.5), row(7, 0.8)];
    const other = [row(4, 0.5), row(7, 0.8), row(9, 0.5)];

    expect(one.sort(byRelevance).map((item) => item.chunkId)).toEqual([7, 4, 9]);
    expect(other.sort(byRelevance).map((item) => item.chunkId)).toEqual([7, 4, 9]);
  });
});
