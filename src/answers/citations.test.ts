import { describe, expect, it } from "vitest";

import { findCitations } from "./citations";

describe("findCitations", () => {
  it("finds the sources an answer points at, once each and in order", () => {
    const answer = "El tope es de $907.934 [2]. Rige desde agosto [1][2].";

    expect(findCitations(answer, 3)).toEqual({ cited: [1, 2], unknown: [] });
  });

  it("reads several numbers inside one pair of brackets", () => {
    expect(findCitations("Lo dicen dos decretos [1, 3].", 3).cited).toEqual([1, 3]);
    expect(findCitations("Lo dicen dos decretos [1,3].", 3).cited).toEqual([1, 3]);
  });

  it("reports the numbers that are not among the sources", () => {
    expect(findCitations("Según [4] y [1], y también [0].", 3)).toEqual({
      cited: [1],
      unknown: [0, 4],
    });
  });

  it("finds nothing in an answer without citations", () => {
    expect(findCitations("Las fuentes no tratan ese tema.", 3)).toEqual({
      cited: [],
      unknown: [],
    });
  });

  it("does not take other brackets for citations", () => {
    const answer = "El inciso [a] del artículo 5° [sic] y el expediente [2026-123].";

    expect(findCitations(answer, 3)).toEqual({ cited: [], unknown: [] });
  });
});
