import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { GOLD_QUESTIONS } from "./questions";

describe("gold questions", () => {
  it("are not repeated", () => {
    const questions = GOLD_QUESTIONS.map((item) => item.question);

    expect(new Set(questions).size).toBe(questions.length);
  });

  it("each point to at least one regulation, unless the subject is absent", () => {
    for (const item of GOLD_QUESTIONS) {
      if (item.kind === "absent") {
        expect(item.expected, item.question).toEqual([]);
      } else {
        expect(item.expected.length, item.question).toBeGreaterThan(0);
      }
    }
  });

  it("only point to regulations whose text is kept as a fixture", () => {
    for (const id of new Set(GOLD_QUESTIONS.flatMap((item) => item.expected))) {
      const fixture = path.join("tests", "fixtures", "html", `${id}.htm`);

      expect(existsSync(fixture), fixture).toBe(true);
    }
  });

  it("cover every kind of question", () => {
    expect(new Set(GOLD_QUESTIONS.map((item) => item.kind))).toEqual(
      new Set(["topic", "reference", "english", "absent"]),
    );
  });
});
