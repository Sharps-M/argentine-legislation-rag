import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { chunkRegulation } from "./chunker";
import { decodeHtml, htmlToText } from "./html-to-text";

const fixtureDir = path.join("tests", "fixtures", "html");
const fixtures = readdirSync(fixtureDir).filter((file) => file.endsWith(".htm"));
const fixtureText = (id: number | string) =>
  htmlToText(
    decodeHtml(
      readFileSync(path.join(fixtureDir, `${id}`.replace(/\.htm$/, "") + ".htm")),
    ),
  );

const outline = (text: string, maxChars?: number) =>
  chunkRegulation(text, { maxChars }).map((chunk) => [chunk.section, chunk.label]);

const squash = (text: string) => text.replace(/\s+/g, "");

describe("chunkRegulation", () => {
  it("splits a decree into preamble, articles and closing", () => {
    const text = [
      "Decreto 1/2026",
      "VISTO el Expediente, y",
      "CONSIDERANDO:",
      "Que corresponde actuar.",
      "DECRETA:",
      "ARTÍCULO 1°.- Apruébase el régimen.",
      "Segundo párrafo del artículo primero.",
      "ARTÍCULO 2º.- Comuníquese y archívese.",
      "PEREZ - Gómez",
      "e. 28/04/2026 N° 27237/26 v. 28/04/2026",
      "(Nota Infoleg: ver anexos.)",
    ].join("\n\n");

    const chunks = chunkRegulation(text);

    expect(chunks.map((chunk) => [chunk.ordinal, chunk.section, chunk.label])).toEqual([
      [0, "preamble", null],
      [1, "article", "Artículo 1"],
      [2, "article", "Artículo 2"],
      [3, "closing", null],
    ]);
    expect(chunks[1]?.content).toBe(
      "ARTÍCULO 1°.- Apruébase el régimen.\n\nSegundo párrafo del artículo primero.",
    );
    expect(chunks[3]?.content).toContain("Nota Infoleg");
  });

  it.each([
    ["ARTÍCULO 1°.- Texto", "Artículo 1"],
    ["Artículo 2º- Texto", "Artículo 2"],
    ["Art. 3° Texto", "Artículo 3"],
    ["ARTICULO 14.- Texto", "Artículo 14"],
    ["ARTÍCULO 5° bis.- Texto", "Artículo 5 bis"],
    ["ARTÍCULO ÚNICO.- Texto", "Artículo único"],
    ["ARTÍCULO 10", "Artículo 10"],
  ])("recognises the article header %j", (header, label) => {
    expect(outline(`Encabezado\n\n${header}`)).toEqual([
      ["preamble", null],
      ["article", label],
    ]);
  });

  it("does not split on articles quoted inside another article", () => {
    const text = [
      "ARTÍCULO 1°.- Sustitúyese el artículo 5° por el siguiente:",
      "“ARTÍCULO 5°.- Texto nuevo del artículo quinto.”",
      "Que por el Artículo 3 se dispuso otra cosa.",
      "ARTÍCULO 2°.- Comuníquese.",
    ].join("\n\n");

    expect(outline(text)).toEqual([
      ["article", "Artículo 1"],
      ["article", "Artículo 2"],
    ]);
  });

  it("labels what follows the publication line as annexed material", () => {
    const text = [
      "Artículo 1º- Apruébase el Protocolo.",
      "DADA EN LA SALA DE SESIONES DEL CONGRESO ARGENTINO.",
      "e. 17/07/2026 N° 50266/26 v. 17/07/2026",
      "(Nota Infoleg: anexos extraídos del Boletín Oficial)",
      "PROTOCOLO DE ENMIENDA",
      "ARTÍCULO 1",
      "El apartado 3 será reemplazado.",
      "ANEXO II",
      "Tabla de valores.",
    ].join("\n\n");

    expect(outline(text)).toEqual([
      ["article", "Artículo 1"],
      ["closing", null],
      ["closing", null],
      ["annex", null],
      ["annex", "Artículo 1"],
      ["annex", "ANEXO II"],
    ]);
  });

  it("splits long parts at paragraph boundaries and keeps their label", () => {
    const paragraph = (index: number) =>
      `Párrafo ${index}. ${"palabra ".repeat(30).trim()}.`;
    const text = `ARTÍCULO 1°.- Inicio.\n\n${[1, 2, 3, 4, 5].map(paragraph).join("\n\n")}`;

    const chunks = chunkRegulation(text, { maxChars: 600 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.label === "Artículo 1")).toBe(true);
    expect(chunks.every((chunk) => chunk.content.length <= 600)).toBe(true);
    expect(
      chunks.every((chunk) => !/^Párrafo \d+\. palabra.*\bpalab$/.test(chunk.content)),
    ).toBe(true);
    expect(squash(chunks.map((chunk) => chunk.content).join(""))).toBe(squash(text));
  });

  it("breaks a single oversized paragraph by line, sentence and word", () => {
    const table = Array.from(
      { length: 40 },
      (_, row) => `Nivel ${row} | $ ${row * 1000}`,
    ).join("\n");
    const sentence = `${"Una oración larga de prueba. ".repeat(40).trim()}`;
    const token = "x".repeat(950);

    for (const text of [table, sentence, token]) {
      const chunks = chunkRegulation(text, { maxChars: 400 });

      expect(chunks.length).toBeGreaterThan(1);
      expect(
        Math.max(...chunks.map((chunk) => chunk.content.length)),
      ).toBeLessThanOrEqual(400);
      expect(squash(chunks.map((chunk) => chunk.content).join(""))).toBe(squash(text));
    }
  });

  it("returns no chunks for empty text", () => {
    expect(chunkRegulation("  \n\n ")).toEqual([]);
  });
});

describe("chunkRegulation on real InfoLEG pages", () => {
  it.each(fixtures)("keeps every character of %s, within the size limit", (file) => {
    const text = fixtureText(file);
    const chunks = chunkRegulation(text);

    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(chunks.every((chunk) => chunk.content.trim().length > 0)).toBe(true);
    expect(
      Math.max(...chunks.map((chunk) => chunk.content.length)),
    ).toBeLessThanOrEqual(1800);
    expect(squash(chunks.map((chunk) => chunk.content).join(""))).toBe(squash(text));
  });

  it("splits a short law (Ley 27817) into its parts", () => {
    expect(outline(fixtureText(427766))).toEqual([
      ["preamble", null],
      ["article", "Artículo 1"],
      ["article", "Artículo 2"],
      ["closing", null],
      ["closing", null],
    ]);
  });

  it("gives a decree one chunk per article (Decreto 282/2026)", () => {
    const chunks = chunkRegulation(fixtureText(425217));
    const articles = chunks.filter((chunk) => chunk.section === "article");

    expect(articles.map((chunk) => chunk.label)).toEqual([
      "Artículo 1",
      "Artículo 2",
      "Artículo 3",
      "Artículo 4",
      "Artículo 5",
    ]);
    expect(chunks[0]?.content).toMatch(/^BELGRANO CARGAS Y LOGÍSTICA SOCIEDAD ANÓNIMA/);
    expect(chunks.at(-1)).toMatchObject({ section: "closing" });
    expect(
      chunks.filter((chunk) => chunk.section === "preamble").length,
    ).toBeGreaterThan(1);
  });

  it("keeps a treaty's own articles apart from the law's (Ley 27814)", () => {
    const chunks = chunkRegulation(fixtureText(427760));
    const labels = (section: string) => [
      ...new Set(
        chunks.filter((chunk) => chunk.section === section).map((chunk) => chunk.label),
      ),
    ];

    expect(labels("article")).toEqual(["Artículo 1", "Artículo 2"]);
    expect(labels("annex")).toEqual([
      null,
      ...Array.from({ length: 10 }, (_, index) => `Artículo ${index + 1}`),
    ]);
  });

  it("labels numbered annexes (Decreto 834/2026)", () => {
    const annexes = chunkRegulation(fixtureText(429385))
      .filter((chunk) => chunk.section === "annex")
      .map((chunk) => chunk.label);

    expect([...new Set(annexes)]).toEqual([
      "ANEXO I",
      "ANEXO II",
      "ANEXO III",
      "ANEXO IV",
      "ANEXO V",
    ]);
  });
});
