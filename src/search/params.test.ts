import { describe, expect, it } from "vitest";

import { parseSearchParams } from "./params";

const parse = (query: string) => parseSearchParams(new URLSearchParams(query));

describe("parseSearchParams", () => {
  it("accepts a question and applies the default limit", () => {
    expect(parse("q=convenio de seguridad social")).toEqual({
      ok: true,
      query: "convenio de seguridad social",
      options: { limit: 8 },
    });
  });

  it("trims the question", () => {
    expect(parse("q=%20%20combustibles%20%20")).toMatchObject({
      query: "combustibles",
    });
  });

  it("reads the limit, the types and the years", () => {
    expect(
      parse("q=combustibles&limit=5&type=Ley&type=Decreto&from=2024&to=2026"),
    ).toEqual({
      ok: true,
      query: "combustibles",
      options: { limit: 5, types: ["Ley", "Decreto"], yearFrom: 2024, yearTo: 2026 },
    });
  });

  it("accepts comma-separated types", () => {
    expect(parse("q=combustibles&type=Ley,%20Decreto")).toMatchObject({
      options: { types: ["Ley", "Decreto"] },
    });
  });

  it("treats empty values as absent", () => {
    expect(parse("q=combustibles&limit=&type=&from=&to=")).toEqual({
      ok: true,
      query: "combustibles",
      options: { limit: 8 },
    });
  });

  it.each([
    ["a missing question", "", "q"],
    ["a question that is too short", "q=ab", "q"],
    ["a question that is too long", `q=${"a".repeat(501)}`, "q"],
    ["a limit of zero", "q=combustibles&limit=0", "limit"],
    ["a limit above the maximum", "q=combustibles&limit=21", "limit"],
    ["a limit that is not a number", "q=combustibles&limit=many", "limit"],
    ["a year that is not a year", "q=combustibles&from=26", "from"],
    ["a year that is not a whole number", "q=combustibles&to=2026.5", "to"],
    ["a range that ends before it starts", "q=combustibles&from=2026&to=2024", "from"],
    ["too many types", "q=combustibles&type=a,b,c,d,e,f", "type"],
  ])("rejects %s", (_case, query, field) => {
    const result = parse(query);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toContain(field);
    }
  });

  it("lists every problem at once", () => {
    const result = parse("q=ab&limit=0");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field).sort()).toEqual(["limit", "q"]);
    }
  });
});
