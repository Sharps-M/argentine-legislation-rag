import { describe, expect, it } from "vitest";

import { earlierVersion, searchHit } from "../../tests/support/search-hits";
import type { AmountCheck } from "@/answers/amounts";
import type { AnswerEvent } from "@/answers/answer";
import { toSources } from "@/answers/sources";

import {
  ANSWER_SAMPLE,
  answerSample,
  scoreAnswer,
  summarize,
  type AnswerScore,
} from "./answers";
import type { GoldQuestion } from "./questions";

const EXPECTED = 427139;
const NEWER = 429383;

const question = (overrides: Partial<GoldQuestion> = {}): GoldQuestion => ({
  question: "Tope de la retribución de los agentes habilitados",
  kind: "topic",
  expected: [EXPECTED],
  ...overrides,
});

const timings = { searchMs: 40, firstTextMs: 900, totalMs: 2500 };

/** The events of an answer that reached its end. */
const answered = (
  options: {
    regulations?: number[];
    earlier?: number[];
    text?: string;
    cited?: number[];
    unknownCitations?: number[];
    amounts?: AmountCheck[];
    outcome?: "answered" | "uncited" | "not_in_sources";
    language?: "es" | "en";
    skipped?: number;
  } = {},
): AnswerEvent[] => {
  const {
    regulations = [EXPECTED],
    earlier = [],
    text = "El tope es de $907.934 [1].",
    cited = [1],
    unknownCitations = [],
    amounts = [],
    outcome = "answered",
    language = "es",
    skipped = 0,
  } = options;

  const sources = toSources(
    regulations.map((id, index) =>
      searchHit({
        chunkId: index + 1,
        regulation: { ...searchHit().regulation, id },
        earlierVersions:
          index === 0 ? earlier.map((old) => earlierVersion("Antes", null, old)) : [],
      }),
    ),
  );

  return [
    { type: "sources", sources, searchMs: 40, language },
    ...Array.from({ length: skipped }, (): AnswerEvent => ({
      type: "skipped",
      provider: "gemini",
      model: "busy",
      reason: "overloaded",
      message: "No capacity",
      ms: 300,
    })),
    { type: "asking", provider: "ollama", model: "gemma3:4b" },
    // In two pieces, as a model writes it.
    { type: "text", text: text.slice(0, 5) },
    { type: "text", text: text.slice(5) },
    {
      type: "done",
      outcome,
      cited,
      unknownCitations,
      amounts,
      provider: "ollama",
      model: "gemma3:4b",
      timings,
    },
  ];
};

const amount = (status: AmountCheck["status"]): AmountCheck => ({
  amount: "$907.934",
  cited: [1],
  foundIn: status === "not_found" ? [] : [status === "supported" ? 1 : 2],
  status,
});

describe("the sample", () => {
  it("is made of questions of the retrieval evaluation, each one once", () => {
    const sample = answerSample();

    expect(sample.map((item) => item.question)).toEqual(ANSWER_SAMPLE);
    expect(new Set(ANSWER_SAMPLE).size).toBe(ANSWER_SAMPLE.length);
  });

  it("stays small: every question but one is a call to a model", () => {
    const sample = answerSample();

    expect(sample.length).toBeLessThanOrEqual(8);
    expect(sample.filter((item) => item.kind === "absent")).toHaveLength(1);
  });

  it("covers an earlier issue, a number, English and a broad subject", () => {
    const kinds = new Set(answerSample().map((item) => item.kind));

    expect(kinds).toEqual(
      new Set(["topic", "earlier", "reference", "english", "absent"]),
    );
  });
});

describe("scoreAnswer", () => {
  it("passes an answer that cites the expected regulation", () => {
    const score = scoreAnswer(question(), answered({ amounts: [amount("supported")] }));

    expect(score.problems).toEqual([]);
    expect(score).toMatchObject({
      outcome: "answered",
      retrieval: "source",
      citesExpected: true,
      language: { expected: "es", written: "es" },
      amounts: { total: 1, supported: 1, otherSource: 0, notFound: 0 },
      provider: "ollama",
      model: "gemma3:4b",
      firstTextMs: 900,
      totalMs: 2500,
    });
  });

  it("puts the pieces of the answer back together", () => {
    const score = scoreAnswer(question(), answered({ text: "El tope sube [1]." }));

    expect(score.answer).toBe("El tope sube [1].");
  });

  it("accepts any of several expected regulations", () => {
    const score = scoreAnswer(
      question({ expected: [1, EXPECTED] }),
      answered({ regulations: [NEWER, EXPECTED], cited: [2] }),
    );

    expect(score.citesExpected).toBe(true);
    expect(score.problems).toEqual([]);
  });

  it("fails an answer that cites another source, though it had the right one", () => {
    const score = scoreAnswer(
      question(),
      answered({ regulations: [NEWER, EXPECTED], cited: [1] }),
    );

    expect(score.retrieval).toBe("source");
    expect(score.citesExpected).toBe(false);
    expect(score.problems).toEqual([
      "does not cite the expected regulation: it was among the sources",
    ]);
  });

  it("does not take a list of what the sources are about for a citation", () => {
    const score = scoreAnswer(
      question(),
      answered({
        outcome: "not_in_sources",
        regulations: [NEWER, EXPECTED],
        cited: [1, 2],
        text: "Las fuentes no responden la pregunta. Tratan otros períodos [1, 2].",
      }),
    );

    expect(score.citesExpected).toBe(false);
    expect(score.problems).toEqual([
      "says the sources do not answer; the expected regulation: it was among the sources",
    ]);
  });

  it("tells when the passage that answers is under a newer source that comes first", () => {
    // The regulation is among the sources by another of its passages.
    const score = scoreAnswer(
      question(),
      answered({
        outcome: "not_in_sources",
        regulations: [NEWER, EXPECTED],
        earlier: [EXPECTED],
        cited: [1, 2],
      }),
    );

    expect(score.retrieval).toBe("earlier");
    expect(score.problems).toEqual([
      "says the sources do not answer; the expected regulation: it was only named under a newer one",
    ]);
  });

  it("counts it as a source when it comes before the one it is named under", () => {
    const score = scoreAnswer(
      question({ expected: [NEWER] }),
      answered({ regulations: [NEWER, 7], cited: [1] }),
    );
    const named = scoreAnswer(
      question(),
      answered({ regulations: [EXPECTED, NEWER], cited: [1] }),
    );

    expect(score.retrieval).toBe("source");
    expect(named.retrieval).toBe("source");
  });

  it("tells when the expected regulation was only named under a newer one", () => {
    const score = scoreAnswer(
      question(),
      answered({ regulations: [NEWER], earlier: [EXPECTED] }),
    );

    expect(score.retrieval).toBe("earlier");
    expect(score.problems).toEqual([
      "does not cite the expected regulation: it was only named under a newer one",
    ]);
  });

  it("tells when the search did not find the expected regulation", () => {
    const score = scoreAnswer(question(), answered({ regulations: [NEWER] }));

    expect(score.retrieval).toBe("missing");
    expect(score.problems).toEqual([
      "does not cite the expected regulation: the search did not find it",
    ]);
  });

  it("fails an answer that cites nothing", () => {
    const score = scoreAnswer(
      question(),
      answered({ outcome: "uncited", cited: [], text: "Las fuentes no lo dicen." }),
    );

    expect(score.problems).toEqual(["the answer cites no source"]);
  });

  it("fails an answer in another language", () => {
    const score = scoreAnswer(
      question(),
      answered({ text: "The cap is the one that the decree sets for the agents [1]." }),
    );

    expect(score.language).toEqual({ expected: "es", written: "en" });
    expect(score.problems).toEqual(['written in "en", expected "es"']);
  });

  it("expects the language the answer was asked in, not the one of the question", () => {
    const score = scoreAnswer(
      question(),
      answered({
        language: "en",
        text: "The cap is the one that the decree sets for the agents [1].",
      }),
    );

    expect(score.language).toEqual({ expected: "en", written: "en" });
    expect(score.problems).toEqual([]);
  });

  it("fails amounts that are not where the answer says", () => {
    const score = scoreAnswer(
      question(),
      answered({
        amounts: [amount("supported"), amount("other_source"), amount("not_found")],
      }),
    );

    expect(score.amounts).toEqual({
      total: 3,
      supported: 1,
      otherSource: 1,
      notFound: 1,
    });
    expect(score.problems).toEqual([
      "1 amount(s) not in any source",
      "1 amount(s) not in the source cited for them",
    ]);
  });

  it("fails citations of sources that do not exist", () => {
    const score = scoreAnswer(question(), answered({ unknownCitations: [9, 12] }));

    expect(score.unknownCitations).toBe(2);
    expect(score.problems).toEqual(["2 citation(s) of a source that does not exist"]);
  });

  it("counts the models given up on, without holding it against the answer", () => {
    const score = scoreAnswer(question(), answered({ skipped: 2 }));

    expect(score.skipped).toBe(2);
    expect(score.problems).toEqual([]);
  });

  describe("when nothing was found", () => {
    const nothing: AnswerEvent[] = [
      { type: "sources", sources: [], searchMs: 40, language: "es" },
      {
        type: "done",
        outcome: "no_sources",
        cited: [],
        unknownCitations: [],
        amounts: [],
        provider: null,
        model: null,
        timings: { searchMs: 40, firstTextMs: null, totalMs: 41 },
      },
    ];

    it("passes a question the corpus does not cover", () => {
      const score = scoreAnswer(
        question({ kind: "absent", expected: [], question: "Receta de empanadas" }),
        nothing,
      );

      expect(score.problems).toEqual([]);
      expect(score).toMatchObject({
        outcome: "no_sources",
        retrieval: null,
        citesExpected: false,
        language: { expected: "es", written: null },
        model: null,
        firstTextMs: null,
        totalMs: 41,
        answer: "",
      });
    });

    it("fails a question that has an answer", () => {
      const score = scoreAnswer(question(), nothing);

      expect(score.retrieval).toBe("missing");
      expect(score.problems).toEqual(["the search found nothing to answer with"]);
    });
  });

  it("passes a question the corpus does not cover when the model says so", () => {
    const score = scoreAnswer(
      question({ kind: "absent", expected: [] }),
      answered({ outcome: "not_in_sources", regulations: [NEWER], cited: [] }),
    );

    expect(score.problems).toEqual([]);
  });

  it("fails an uncited answer about a subject the corpus does not cover", () => {
    const score = scoreAnswer(
      question({ kind: "absent", expected: [] }),
      answered({ outcome: "uncited", regulations: [NEWER], cited: [] }),
    );

    expect(score.problems).toEqual([
      "an answer was written for a subject the corpus does not cover",
    ]);
  });

  it("fails an answer about a subject the corpus does not cover", () => {
    const score = scoreAnswer(
      question({ kind: "absent", expected: [] }),
      answered({ regulations: [NEWER] }),
    );

    expect(score.retrieval).toBeNull();
    expect(score.problems).toEqual([
      "an answer was written for a subject the corpus does not cover",
    ]);
  });

  describe("when no model could answer", () => {
    const failed = (absent = false): AnswerScore =>
      scoreAnswer(question(absent ? { kind: "absent", expected: [] } : {}), [
        ...answered({ skipped: 1 }).slice(0, 3),
        {
          type: "error",
          reason: "rate_limited",
          message: "Every model failed",
          timings: { searchMs: 40, firstTextMs: null, totalMs: 9000 },
        },
      ]);

    it("says so, and nothing else: there is no answer to find fault with", () => {
      const score = failed();

      expect(score.outcome).toBe("error");
      expect(score.problems).toEqual(["no model finished an answer: rate_limited"]);
      expect(score).toMatchObject({ model: null, firstTextMs: null, totalMs: 9000 });
    });

    it("does not judge the piece a model wrote before it failed", () => {
      const score = scoreAnswer(question(), [
        ...answered({ regulations: [NEWER] }).slice(0, 2),
        { type: "text", text: "The cap is the one that the decree sets for the" },
        {
          type: "error",
          reason: "unavailable",
          message: "The connection was lost",
          timings: { searchMs: 40, firstTextMs: 900, totalMs: 4000 },
        },
      ]);

      expect(score.language.written).toBe("en");
      expect(score.problems).toEqual(["no model finished an answer: unavailable"]);
    });

    it("says the same for a question the corpus does not cover", () => {
      expect(failed(true).problems).toEqual([
        "no model finished an answer: rate_limited",
      ]);
    });
  });
});

describe("summarize", () => {
  const score = (overrides: Partial<AnswerScore>): AnswerScore => ({
    ...scoreAnswer(question(), answered()),
    ...overrides,
  });

  it("counts what passed, who wrote and how long it took", () => {
    const summary = summarize([
      score({ model: "flash-lite", totalMs: 2000 }),
      score({ model: "flash-lite", totalMs: 3000, problems: ["x"] }),
      score({ model: "gemma3:4b", totalMs: 60_000 }),
      score({ model: null, totalMs: 40, outcome: "no_sources" }),
      score({ model: null, totalMs: null, outcome: "error", problems: ["y"] }),
    ]);

    expect(summary).toEqual({
      questions: 5,
      passed: 3,
      writers: { "flash-lite": 2, "gemma3:4b": 1 },
      unanswered: 1,
      totalMs: 65_040,
    });
  });

  it("is all zeros for no answers", () => {
    expect(summarize([])).toEqual({
      questions: 0,
      passed: 0,
      writers: {},
      unanswered: 0,
      totalMs: 0,
    });
  });
});
