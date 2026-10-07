import { describe, expect, it } from "vitest";

import { GOLD_QUESTIONS } from "@/eval/questions";

import { detectLanguage, isAnswerLanguage } from "./language";

describe("detectLanguage", () => {
  it.each([
    "Adicional por prestación de servicios en la Antártida para el personal militar",
    "¿Qué dispone la Ley 27818?",
    "tope de la retribución por servicios extraordinarios",
    "Normativas relacionadas con mascotas",
    "receta de empanadas salteñas",
  ])("takes %j for Spanish", (question) => {
    expect(detectLanguage(question)).toBe("es");
  });

  it.each([
    "What does Decreto 829/2026 change about fuel taxes?",
    "Which law approves the amendment to the tax treaty with France?",
    "Social security agreement between Argentina and San Marino",
    "Is there a cap on overtime pay for public employees?",
  ])("takes %j for English", (question) => {
    expect(detectLanguage(question)).toBe("en");
  });

  it("is not misled by the Spanish name of a regulation inside an English question", () => {
    expect(detectLanguage("What is the Ley de Ministerios about?")).toBe("en");
    expect(detectLanguage("How does the Decreto de Necesidad y Urgencia work?")).toBe(
      "en",
    );
  });

  it("goes with Spanish when the question gives nothing away", () => {
    expect(detectLanguage("Decreto 833/2026")).toBe("es");
    expect(detectLanguage("Ley 27.818")).toBe("es");
    expect(detectLanguage("")).toBe("es");
  });

  it("agrees with the language each question of the evaluation was written in", () => {
    for (const { question, kind } of GOLD_QUESTIONS) {
      expect(detectLanguage(question), question).toBe(kind === "english" ? "en" : "es");
    }
  });
});

describe("isAnswerLanguage", () => {
  it("accepts the languages the site speaks, and nothing else", () => {
    expect(isAnswerLanguage("es")).toBe(true);
    expect(isAnswerLanguage("en")).toBe(true);
    expect(isAnswerLanguage("pt")).toBe(false);
    expect(isAnswerLanguage("")).toBe(false);
  });
});
