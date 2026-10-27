import { describe, expect, it } from "vitest";

import { daysAgo, fill, longDate, plural, seconds } from "./format";

describe("fill", () => {
  it("puts each value in its place, as often as it appears", () => {
    expect(fill("{a} y {b}, otra vez {a}", { a: 1, b: "dos" })).toBe(
      "1 y dos, otra vez 1",
    );
  });

  it("leaves a name it was not given as written", () => {
    expect(fill("Hola {nombre}", {})).toBe("Hola {nombre}");
  });
});

describe("plural", () => {
  const forms = { one: "un monto", other: "{count} montos" };

  it("picks the form for the count, in each language", () => {
    expect(plural(forms, 1, "es")).toBe("un monto");
    expect(plural(forms, 3, "es")).toBe("3 montos");
    expect(plural({ one: "one amount", other: "{count} amounts" }, 1, "en")).toBe(
      "one amount",
    );
    expect(plural({ one: "one amount", other: "{count} amounts" }, 0, "en")).toBe(
      "0 amounts",
    );
  });
});

describe("seconds", () => {
  it("writes seconds with one decimal, as each language does", () => {
    expect(seconds(1234, "es")).toBe("1,2 s");
    expect(seconds(1234, "en")).toBe("1.2 s");
    expect(seconds(40, "es")).toBe("0,0 s");
  });
});

describe("daysAgo", () => {
  it("says how long ago, as each language does", () => {
    expect(daysAgo(0, "es")).toBe("hoy");
    expect(daysAgo(1, "es")).toBe("ayer");
    expect(daysAgo(3, "es")).toBe("hace 3 días");
    expect(daysAgo(0, "en")).toBe("today");
    expect(daysAgo(1, "en")).toBe("yesterday");
    expect(daysAgo(15, "en")).toBe("15 days ago");
  });
});

describe("longDate", () => {
  it("writes a date in words, on the day it says", () => {
    expect(longDate("2026-08-28", "es")).toBe("28 de agosto de 2026");
    expect(longDate("2026-08-28", "en")).toBe("August 28, 2026");
    expect(longDate("2026-01-01", "es")).toBe("1 de enero de 2026");
  });

  it("leaves what is not a date as it came", () => {
    expect(longDate("sin fecha", "es")).toBe("sin fecha");
  });
});
