import { describe, expect, it } from "vitest";

import { findReferences } from "./references";

const today = new Date("2026-10-04T12:00:00Z");
const find = (query: string) => findReferences(query, today);

describe("findReferences", () => {
  it.each([
    ["¿Qué dispone la Ley 27818?", { type: "Ley", number: "27818" }],
    ["ley 27.818", { type: "Ley", number: "27818" }],
    ["Ley N° 27.742", { type: "Ley", number: "27742" }],
    ["Ley Nº 24.241 de jubilaciones", { type: "Ley", number: "24241" }],
    ["ley nro. 23.966", { type: "Ley", number: "23966" }],
    ["LEY NÚMERO 22520", { type: "Ley", number: "22520" }],
    ["Decreto 833/2026", { type: "Decreto", number: "833", year: 2026 }],
    ["decreto 833/26", { type: "Decreto", number: "833", year: 2026 }],
    ["Decreto N° 50/2019", { type: "Decreto", number: "50", year: 2019 }],
    ["Decreto 438/92", { type: "Decreto", number: "438", year: 1992 }],
    ["decreto 70 de 2023", { type: "Decreto", number: "70", year: 2023 }],
    ["el decreto 70 del año 2023", { type: "Decreto", number: "70", year: 2023 }],
    ["DNU 70/2023", { type: "Decreto", number: "70", year: 2023 }],
    ["Dto. 282/2026", { type: "Decreto", number: "282", year: 2026 }],
    [
      "decreto de necesidad y urgencia 70/2023",
      { type: "Decreto", number: "70", year: 2023 },
    ],
    ["Decreto 0282/2026", { type: "Decreto", number: "282", year: 2026 }],
    ["Decreto-Ley 1285/58", { type: "Decreto/Ley", number: "1285", year: 1958 }],
    ["decreto ley 6582/1958", { type: "Decreto/Ley", number: "6582", year: 1958 }],
    ["Decreto/Ley N° 5965/63", { type: "Decreto/Ley", number: "5965", year: 1963 }],
    ["Ley 340", { type: "Ley", number: "340" }],
    ["Resolución 15/2022", { type: "Resolución", number: "15", year: 2022 }],
    ["resolucion 794", { type: "Resolución", number: "794" }],
    [
      "Decisión Administrativa 3/2025",
      { type: "Decisión Administrativa", number: "3", year: 2025 },
    ],
    ["Disposición 12/2024", { type: "Disposición", number: "12", year: 2024 }],
  ])("reads %s", (query, expected) => {
    expect(find(query)).toEqual([expected]);
  });

  it("does not take a year for a law: laws are numbered once", () => {
    expect(find("Ley 27.742/2024")).toEqual([{ type: "Ley", number: "27742" }]);
    expect(find("ley 27742 de 2024")).toEqual([{ type: "Ley", number: "27742" }]);
  });

  it("does not mistake the day of a date for a year", () => {
    expect(find("Decreto N° 50 del 19 de diciembre de 2019")).toEqual([
      { type: "Decreto", number: "50" },
    ]);
    expect(find("Decreto 438 del 12 de marzo de 1992")).toEqual([
      { type: "Decreto", number: "438" },
    ]);
  });

  it("finds a decree cited without a year", () => {
    expect(find("¿sigue vigente el decreto 282?")).toEqual([
      { type: "Decreto", number: "282" },
    ]);
  });

  it("finds several citations in one question, in order", () => {
    expect(
      find("¿El Decreto 829/2026 modifica el Decreto 617/2025 o la Ley 23.966?"),
    ).toEqual([
      { type: "Decreto", number: "829", year: 2026 },
      { type: "Decreto", number: "617", year: 2025 },
      { type: "Ley", number: "23966" },
    ]);
  });

  it("keeps a repeated citation once", () => {
    expect(find("Ley 27818: ¿qué aprueba la ley 27.818?")).toEqual([
      { type: "Ley", number: "27818" },
    ]);
  });

  it("stops at three citations", () => {
    expect(find("Ley 1, Ley 2, Ley 3, Ley 4 y Ley 5")).toHaveLength(3);
  });

  it.each([
    "convenio de seguridad social con San Marino",
    "impuesto a los combustibles en 2026",
    "aumento del 12/2025",
    "vence el 25/8/2026",
    "artículo 5 de la ley de ministerios",
    "ley nacional de tránsito",
    "decreto reglamentario de la ley de bases",
    "Social security agreement with San Marino",
    "Bailey 2024",
    "expediente EX-2026-81049283",
  ])("finds nothing in: %s", (query) => {
    expect(find(query)).toEqual([]);
  });

  it("reads two-digit years against the current century", () => {
    expect(find("Decreto 10/27")).toEqual([
      { type: "Decreto", number: "10", year: 1927 },
    ]);
    expect(find("Decreto 10/26")).toEqual([
      { type: "Decreto", number: "10", year: 2026 },
    ]);
    expect(find("Decreto 10/01")).toEqual([
      { type: "Decreto", number: "10", year: 2001 },
    ]);
  });
});
