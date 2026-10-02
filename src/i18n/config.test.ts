import { describe, expect, it } from "vitest";

import { defaultLocale, hasLocale, pickLocale } from "./config";

describe("hasLocale", () => {
  it("recognises supported locales only", () => {
    expect(hasLocale("es")).toBe(true);
    expect(hasLocale("en")).toBe(true);
    expect(hasLocale("fr")).toBe(false);
  });
});

describe("pickLocale", () => {
  it("falls back to the default locale without a header", () => {
    expect(pickLocale(null)).toBe(defaultLocale);
    expect(pickLocale("")).toBe(defaultLocale);
  });

  it("matches regional variants by their primary language", () => {
    expect(pickLocale("es-AR,es;q=0.9,en;q=0.8")).toBe("es");
    expect(pickLocale("en-US,en;q=0.9")).toBe("en");
  });

  it("honours quality values over header order", () => {
    expect(pickLocale("es;q=0.4,en;q=0.9")).toBe("en");
  });

  it("skips unsupported and disabled languages", () => {
    expect(pickLocale("fr-FR,de;q=0.8,en;q=0.5")).toBe("en");
    expect(pickLocale("en;q=0,es;q=0.1")).toBe("es");
    expect(pickLocale("fr,de")).toBe(defaultLocale);
  });
});
