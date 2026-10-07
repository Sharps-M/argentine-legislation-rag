import { describe, expect, it } from "vitest";

import { findDates, statesDate } from "./dates";

describe("findDates", () => {
  it("reads a date in words, with or without the ordinal sign", () => {
    expect(findDates("a partir del 1° de junio de 2026")).toEqual([
      { year: 2026, month: 6, day: 1 },
    ]);
    expect(findDates("del 1º de junio de 2026")).toEqual([
      { year: 2026, month: 6, day: 1 },
    ]);
    expect(findDates("el 1ro de junio del 2026")).toEqual([
      { year: 2026, month: 6, day: 1 },
    ]);
    expect(findDates("acta acuerdo del 28 de mayo de 2026")).toEqual([
      { year: 2026, month: 5, day: 28 },
    ]);
  });

  it("reads a month and a year with no day", () => {
    expect(findDates("vigente desde junio de 2026")).toEqual([
      { year: 2026, month: 6 },
    ]);
    expect(findDates("Diciembre 2023")).toEqual([{ year: 2023, month: 12 }]);
  });

  it("knows every month, and both spellings of September", () => {
    const months = [
      "enero",
      "febrero",
      "marzo",
      "abril",
      "mayo",
      "junio",
      "julio",
      "agosto",
      "septiembre",
      "octubre",
      "noviembre",
      "diciembre",
    ];

    expect(
      months.map((month) => findDates(`el 2 de ${month} de 2020`)[0]?.month),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(findDates("3 de setiembre de 1998")).toEqual([
      { year: 1998, month: 9, day: 3 },
    ]);
  });

  it("reads dates in English, either way round", () => {
    expect(findDates("the cap as of June 1, 2026")).toEqual([
      { year: 2026, month: 6, day: 1 },
    ]);
    expect(findDates("from 1 June 2026")).toEqual([{ year: 2026, month: 6, day: 1 }]);
    expect(findDates("the 1st of June 2026")).toEqual([
      { year: 2026, month: 6, day: 1 },
    ]);
    expect(findDates("in force since December 2023")).toEqual([
      { year: 2023, month: 12 },
    ]);
  });

  it("reads a date in figures, day first", () => {
    expect(findDates("e. 01/07/2026 N° 46118/26 v. 01/07/2026")).toEqual([
      { year: 2026, month: 7, day: 1 },
    ]);
    expect(findDates("el 3-12-2019")).toEqual([{ year: 2019, month: 12, day: 3 }]);
  });

  it("gives each date once, in the order they are written", () => {
    expect(
      findDates(
        "a partir del 1° de junio de 2026, del 1° de julio de 2026 y, otra vez, del 1° de junio de 2026",
      ),
    ).toEqual([
      { year: 2026, month: 6, day: 1 },
      { year: 2026, month: 7, day: 1 },
    ]);
    expect(findDates("on 2 May 2020 and el 1° de abril de 2019")).toEqual([
      { year: 2020, month: 5, day: 2 },
      { year: 2019, month: 4, day: 1 },
    ]);
  });

  it("keeps a month and a day of that month as two dates", () => {
    expect(findDates("en junio de 2026, desde el 1° de junio de 2026")).toEqual([
      { year: 2026, month: 6 },
      { year: 2026, month: 6, day: 1 },
    ]);
  });

  it("does not take other numbers for dates", () => {
    expect(findDates("Decreto 833/2026")).toEqual([]);
    expect(findDates("la suma de $1.598.124")).toEqual([]);
    expect(findDates("IF-2026-61313492-APN-DNC#MCH")).toEqual([]);
    expect(findDates("el año 2026")).toEqual([]);
    expect(findDates("el 1° de junio")).toEqual([]);
    expect(findDates("el expediente 12/05/20261")).toEqual([]);
    expect(findDates("el legajo 112/05/2026")).toEqual([]);
    expect(findDates("mayo de 20261")).toEqual([]);
  });

  it("does not find a month inside another word", () => {
    expect(findDates("el primero de submarzo de 2026")).toEqual([]);
    expect(findDates("dismay 2026")).toEqual([]);
  });

  it("drops what cannot be a date", () => {
    expect(findDates("el 45 de mayo de 2026")).toEqual([]);
    expect(findDates("31/13/2026")).toEqual([]);
    expect(findDates("mayo de 0026")).toEqual([]);
    expect(findDates("mayo de 9026")).toEqual([]);
    expect(findDates("el 0 de mayo de 2026")).toEqual([]);
    expect(findDates("0/5/2026 y 5/0/2026")).toEqual([]);
  });
});

describe("statesDate", () => {
  const article =
    "no deberá superar el monto de $871.825 a partir del 1° de junio de 2026 y de $891.005 a partir del 1° de julio de 2026";

  it("is true when the text states the day asked for", () => {
    expect(statesDate(article, [{ year: 2026, month: 7, day: 1 }])).toBe(true);
    expect(statesDate(article, findDates("desde el 01/06/2026"))).toBe(true);
  });

  it("is false for another day, month or year", () => {
    expect(statesDate(article, [{ year: 2026, month: 6, day: 2 }])).toBe(false);
    expect(statesDate(article, [{ year: 2026, month: 9, day: 1 }])).toBe(false);
    expect(statesDate(article, [{ year: 2025, month: 6, day: 1 }])).toBe(false);
  });

  it("takes any day of the month when no day was asked for", () => {
    expect(statesDate(article, [{ year: 2026, month: 6 }])).toBe(true);
    expect(statesDate(article, [{ year: 2026, month: 8 }])).toBe(false);
  });

  it("does not take a month for the day asked for", () => {
    expect(statesDate("vigente desde junio de 2026", findDates("1/6/2026"))).toBe(
      false,
    );
  });

  it("is true when any of several dates is stated", () => {
    expect(
      statesDate(article, [
        { year: 2020, month: 1, day: 1 },
        { year: 2026, month: 6, day: 1 },
      ]),
    ).toBe(true);
  });

  it("is false when no date was asked for", () => {
    expect(statesDate(article, [])).toBe(false);
  });
});
