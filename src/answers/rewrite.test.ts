import { describe, expect, it } from "vitest";

import { MAX_QUERY_LENGTH } from "@/search/params";

import { isNewQuery, REWRITE_INSTRUCTIONS, toSearchQuery } from "./rewrite";

describe("REWRITE_INSTRUCTIONS", () => {
  it("asks for the words of the law, keeping numbers and dates, in one line", () => {
    expect(REWRITE_INSTRUCTIONS).toMatch(/palabras que usaría el texto de una ley/);
    expect(REWRITE_INSTRUCTIONS).toMatch(/números de normas, las fechas y los montos/);
    expect(REWRITE_INSTRUCTIONS).toMatch(/No responda la pregunta/);
    expect(REWRITE_INSTRUCTIONS).toMatch(/una sola línea/);
  });

  it("does not give away the questions of the evaluation as its example", () => {
    expect(REWRITE_INSTRUCTIONS).not.toMatch(/mascota|perro|animal/i);
  });
});

describe("toSearchQuery", () => {
  it("keeps the first line that says something", () => {
    expect(
      toSearchQuery("\n  maltrato animal, perros  \nEsta búsqueda sirve porque..."),
    ).toBe("maltrato animal, perros");
  });

  it("drops a label and the quotes or asterisks around it", () => {
    expect(toSearchQuery('Búsqueda: "maltrato animal"')).toBe("maltrato animal");
    expect(toSearchQuery("**query: animal cruelty**")).toBe("animal cruelty");
    expect(toSearchQuery("«protección de animales domésticos»")).toBe(
      "protección de animales domésticos",
    );
  });

  it("keeps quotes and numbers inside it", () => {
    expect(
      toSearchQuery('tope del "Decreto 552/2026" desde el 1° de junio de 2026'),
    ).toBe('tope del "Decreto 552/2026" desde el 1° de junio de 2026');
  });

  it("joins its spaces and cuts it to what the search takes", () => {
    expect(toSearchQuery("animales   domésticos\tperros")).toBe(
      "animales domésticos perros",
    );
    expect(toSearchQuery("a".repeat(MAX_QUERY_LENGTH + 50))).toHaveLength(
      MAX_QUERY_LENGTH,
    );
  });

  it("is empty when there is nothing", () => {
    expect(toSearchQuery("")).toBe("");
    expect(toSearchQuery(' \n "" \n')).toBe("");
  });
});

describe("isNewQuery", () => {
  it("is true when the rewrite says something else", () => {
    expect(isNewQuery("maltrato animal", "mascotas")).toBe(true);
  });

  it("is false for the same words, whatever the case or the signs", () => {
    expect(isNewQuery("Mascotas.", "¿mascotas?")).toBe(false);
    expect(
      isNewQuery(
        "normativas  relacionadas con MASCOTAS",
        "Normativas relacionadas con mascotas",
      ),
    ).toBe(false);
  });

  it("is false for an empty rewrite", () => {
    expect(isNewQuery("", "mascotas")).toBe(false);
    expect(isNewQuery("¿?", "mascotas")).toBe(false);
  });
});
