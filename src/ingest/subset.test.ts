import { describe, expect, it } from "vitest";

import type { NewRegulation } from "@/db/schema";

import { effectiveDate, matchesSubset, yearsAgo } from "./subset";

const regulation = (overrides: Partial<NewRegulation> = {}): NewRegulation => ({
  id: 1,
  type: "Decreto",
  enactedOn: "2023-06-15",
  gazetteDate: "2023-06-20",
  ...overrides,
});

describe("matchesSubset", () => {
  it("keeps everything when there is no filter", () => {
    expect(matchesSubset(regulation(), { types: [], since: null })).toBe(true);
  });

  it("filters by type, ignoring case and accents", () => {
    const filter = { types: ["ley", "decreto"], since: null };

    expect(matchesSubset(regulation({ type: "Decreto" }), filter)).toBe(true);
    expect(matchesSubset(regulation({ type: "LEY" }), filter)).toBe(true);
    expect(matchesSubset(regulation({ type: "Resolución" }), filter)).toBe(false);
    expect(
      matchesSubset(regulation({ type: "Resolución" }), {
        types: ["resolucion"],
        since: null,
      }),
    ).toBe(true);
  });

  it("does not match a type that merely contains the wanted one", () => {
    const filter = { types: ["Decreto"], since: null };

    expect(matchesSubset(regulation({ type: "Decreto/Ley" }), filter)).toBe(false);
  });

  it("filters by date, including the boundary day", () => {
    const filter = { types: [], since: "2023-06-15" };

    expect(matchesSubset(regulation({ enactedOn: "2023-06-15" }), filter)).toBe(true);
    expect(matchesSubset(regulation({ enactedOn: "2023-06-14" }), filter)).toBe(false);
  });

  it("falls back to the gazette date and drops undated regulations", () => {
    const filter = { types: [], since: "2023-01-01" };

    expect(
      matchesSubset(regulation({ enactedOn: null, gazetteDate: "2023-03-01" }), filter),
    ).toBe(true);
    expect(
      matchesSubset(regulation({ enactedOn: null, gazetteDate: null }), filter),
    ).toBe(false);
  });
});

describe("effectiveDate", () => {
  it("prefers the enactment date", () => {
    expect(effectiveDate(regulation())).toBe("2023-06-15");
    expect(effectiveDate(regulation({ enactedOn: null }))).toBe("2023-06-20");
    expect(
      effectiveDate(regulation({ enactedOn: null, gazetteDate: null })),
    ).toBeNull();
  });
});

describe("yearsAgo", () => {
  it("subtracts whole years from a given day", () => {
    expect(yearsAgo(5, new Date("2026-10-02T12:00:00Z"))).toBe("2021-10-02");
  });
});
