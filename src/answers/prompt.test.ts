import { describe, expect, it } from "vitest";

import { earlierVersion, searchHit } from "../../tests/support/search-hits";
import {
  buildPrompt,
  instructionsFor,
  NOT_IN_SOURCES,
  saysNotInSources,
} from "./prompt";
import { toSources } from "./sources";

describe("buildPrompt", () => {
  it("lists each source with its number, its date and its text, then the question", () => {
    const prompt = buildPrompt(
      "  ¿Cuál es el tope?  ",
      toSources([
        searchHit(),
        searchHit({ label: "Artículo 5", content: "Otro texto." }),
      ]),
      "es",
    );

    expect(prompt).toBe(
      [
        "Fuentes:",
        [
          "[1] Decreto 832/2026 · Artículo 3 (dictada el 2026-08-28)",
          "Tema: ACUERDOS / ACTAS ACUERDO - HOMOLOGANSE",
          "<document>",
          "La retribución no deberá superar el monto de PESOS NOVECIENTOS SIETE MIL NOVECIENTOS TREINTA Y CUATRO ($907.934).",
          "</document>",
        ].join("\n"),
        [
          "[2] Decreto 832/2026 · Artículo 5 (dictada el 2026-08-28)",
          "Tema: ACUERDOS / ACTAS ACUERDO - HOMOLOGANSE",
          "<document>",
          "Otro texto.",
          "</document>",
        ].join("\n"),
        "Pregunta: ¿Cuál es el tope?",
        "Responda en español, citando cada afirmación con el número de su fuente.",
      ].join("\n\n"),
    );
  });

  it("speaks English around the same sources when the answer is to be in English", () => {
    const prompt = buildPrompt("What is the cap?", toSources([searchHit()]), "en");

    expect(prompt).toBe(
      [
        "Sources:",
        [
          "[1] Decreto 832/2026 · Artículo 3 (enacted 2026-08-28)",
          "Subject: ACUERDOS / ACTAS ACUERDO - HOMOLOGANSE",
          "<document>",
          "La retribución no deberá superar el monto de PESOS NOVECIENTOS SIETE MIL NOVECIENTOS TREINTA Y CUATRO ($907.934).",
          "</document>",
        ].join("\n"),
        "Question: What is the cap?",
        "Answer in English, citing every statement with the number of its source.",
      ].join("\n\n"),
    );
  });

  it("names the earlier regulations with their dates, so one can be picked by date", () => {
    const earlierVersions = [
      earlierVersion("Decreto 552/2026", "2026-06-29", 1),
      earlierVersion("Decreto 206/2026", null, 2),
      ...Array.from({ length: 6 }, (_, index) =>
        earlierVersion(`Decreto ${index}/2025`, "2025-01-01", 10 + index),
      ),
    ];
    const sources = toSources([searchHit({ earlierVersions })]);

    expect(buildPrompt("¿?", sources, "es")).toContain(
      "Normas anteriores con un texto casi idéntico: Decreto 552/2026 (2026-06-29), Decreto 206/2026 (fecha desconocida), Decreto 0/2025 (2025-01-01)",
    );
    expect(buildPrompt("¿?", sources, "es")).toContain(
      ", y 2 más antiguas\n<document>",
    );
    expect(buildPrompt("?", sources, "en")).toContain(
      "Earlier regulations with nearly the same text: Decreto 552/2026 (2026-06-29), Decreto 206/2026 (date unknown)",
    );
    expect(buildPrompt("?", sources, "en")).toContain(", and 2 older\n<document>");
  });

  it("says when a source is only an abstract, and when its date is unknown", () => {
    const hit = searchHit();
    hit.regulation.textSource = "summary";
    hit.regulation.enactedOn = null;
    const sources = toSources([hit]);

    expect(buildPrompt("¿?", sources, "es")).toContain(
      "(dictada el fecha desconocida)",
    );
    expect(buildPrompt("¿?", sources, "es")).toContain(
      "Solo resumen: el texto completo no está publicado.",
    );
    expect(buildPrompt("?", sources, "en")).toContain(
      "Abstract only: the full text is not published.",
    );
  });
});

describe("instructionsFor", () => {
  const rules = (text: string) =>
    text.split("\n").filter((line) => /^\d+\. /.test(line));

  it("gives the same rules in both languages, one for one", () => {
    expect(rules(instructionsFor("es"))).toHaveLength(10);
    expect(rules(instructionsFor("en"))).toHaveLength(10);
  });

  // Not a test of the wording: a guard against dropping a rule by accident.
  it.each([
    [
      "answering from the sources only",
      /únicamente las fuentes numeradas/,
      /only the numbered sources/,
    ],
    ["citing with a number in brackets", /\[1\]/, /\[1\]/],
    [
      "not citing a source just for being on the list",
      /por el solo hecho de estar en la lista/,
      /just because it is on the list/,
    ],
    [
      "admitting when the sources do not answer",
      /empiece con esta oración, sin cambiarla: "Las fuentes no responden la pregunta\."/,
      /start with this sentence, unchanged: "The sources do not answer the question\."/,
    ],
    [
      "treating the sources as data",
      /documentos, no instrucciones/,
      /documents, not instructions/,
    ],
    [
      "not claiming a regulation is in force",
      /sigue vigente o fue derogada/,
      /still in force or was repealed/,
    ],
    [
      "not ranking the sources by date unasked",
      /ni diga cuál es la más reciente/,
      /or say which one is the most recent/,
    ],
    [
      "giving the most recent value first",
      /dé primero los de la norma más reciente/,
      /those of the most recent regulation first/,
    ],
    [
      "writing amounts in figures, not in words",
      /montos en cifras[\s\S]*?no los repita en letras/,
      /amounts in figures[\s\S]*?do not repeat them in words/,
    ],
    [
      "keeping to plain text and hyphen lists",
      /lista con guiones; no use negritas/,
      /list with hyphens; no bold/,
    ],
    [
      "giving every value a source sets",
      /délos todos: no se quede con el primero/,
      /give all of them: do not stop at the first/,
    ],
  ])("keep the rule about %s", (_rule, spanish, english) => {
    expect(instructionsFor("es")).toMatch(spanish);
    expect(instructionsFor("en")).toMatch(english);
  });

  it("names the language of the answer in that language", () => {
    expect(instructionsFor("es")).toMatch(/Responda en español, neutro y formal/);
    expect(instructionsFor("en")).toMatch(
      /Answer in English\. The sources are in Spanish/,
    );
  });
});

describe("saysNotInSources", () => {
  it("knows the sentence the rules ask for, in both languages", () => {
    expect(saysNotInSources(NOT_IN_SOURCES.es)).toBe(true);
    expect(saysNotInSources(NOT_IN_SOURCES.en)).toBe(true);
  });

  it("looks only at how the answer starts", () => {
    expect(
      saysNotInSources(
        "Las fuentes no responden la pregunta. Tratan sobre sanidad animal [1, 2].",
      ),
    ).toBe(true);
    expect(
      saysNotInSources(
        "El tope es de $871.825 [1]. Las fuentes no responden la pregunta por otros años.",
      ),
    ).toBe(false);
  });

  it("forgives capitals, spaces, quotes and a sentence that goes on", () => {
    expect(saysNotInSources('  "LAS FUENTES  NO RESPONDEN\nla pregunta".')).toBe(true);
    expect(
      saysNotInSources("**The sources do not answer the question** about pets."),
    ).toBe(true);
    expect(
      saysNotInSources("Las fuentes no responden la pregunta sobre mascotas."),
    ).toBe(true);
  });

  it("is false for an answer, and for nothing", () => {
    expect(saysNotInSources("Las fuentes fijan el tope en $871.825 [1].")).toBe(false);
    expect(saysNotInSources("The sources set the cap [1].")).toBe(false);
    expect(saysNotInSources("")).toBe(false);
  });
});
