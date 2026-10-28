import { describe, expect, it } from "vitest";

import {
  filterCount,
  queryFromParams,
  queryProblem,
  toSearch,
  type AskQuery,
} from "./ask-query";

const query = (overrides: Partial<AskQuery> = {}): AskQuery => ({
  q: "tope de servicios",
  type: null,
  from: null,
  to: null,
  ...overrides,
});

describe("queryFromParams", () => {
  it("reads the question and its filters from the address", () => {
    expect(
      queryFromParams(new URLSearchParams("q=+tope+&type=Decreto&from=2020&to=2026")),
    ).toEqual({ q: "tope", type: "Decreto", from: 2020, to: 2026 });
  });

  it("reads them as the page receives them too, taking the first of a repeated one", () => {
    expect(
      queryFromParams({ q: ["uno", "dos"], type: "Decreto/Ley", from: undefined }),
    ).toEqual({
      q: "uno",
      type: "Decreto/Ley",
      from: null,
      to: null,
    });
  });

  it("leaves out what is not valid instead of refusing the address", () => {
    expect(
      queryFromParams(new URLSearchParams("q=x&type=Resolución&from=1500&to=dos mil")),
    ).toEqual({ q: "x", type: null, from: null, to: null });
    expect(queryFromParams(new URLSearchParams("from=2020.5&to=2101"))).toEqual({
      q: "",
      type: null,
      from: null,
      to: null,
    });
  });

  it("cuts a question to what the search takes", () => {
    expect(queryFromParams({ q: "a".repeat(600) }).q).toHaveLength(500);
  });

  it("takes the first and last years the search accepts", () => {
    expect(queryFromParams({ from: "1810", to: "2100" })).toMatchObject({
      from: 1810,
      to: 2100,
    });
  });
});

describe("toSearch", () => {
  it("writes only what is set", () => {
    expect(toSearch(query())).toBe("?q=tope+de+servicios");
    expect(toSearch(query({ type: "Decreto/Ley", from: 2020, to: 2026 }))).toBe(
      "?q=tope+de+servicios&type=Decreto%2FLey&from=2020&to=2026",
    );
  });

  it("is empty without a question", () => {
    expect(toSearch(query({ q: "", type: "Ley" }))).toBe("");
  });

  it("reads back as it was written", () => {
    const written = query({ q: "¿Qué dispone la Ley 27.818?", type: "Ley", to: 2026 });

    expect(queryFromParams(new URLSearchParams(toSearch(written)))).toEqual(written);
  });
});

describe("queryProblem", () => {
  it("asks for at least three characters", () => {
    expect(queryProblem(query({ q: "ab" }))).toBe("too_short");
    expect(queryProblem(query({ q: "abc" }))).toBeNull();
  });

  it("asks for the years in order", () => {
    expect(queryProblem(query({ from: 2026, to: 2020 }))).toBe("years_order");
    expect(queryProblem(query({ from: 2020, to: 2020 }))).toBeNull();
    expect(queryProblem(query({ from: 2026 }))).toBeNull();
  });
});

describe("filterCount", () => {
  it("counts the filters that are set", () => {
    expect(filterCount(query())).toBe(0);
    expect(filterCount(query({ type: "Ley", to: 2026 }))).toBe(2);
  });
});
