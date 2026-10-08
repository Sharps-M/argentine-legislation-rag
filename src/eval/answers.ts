import type { AnswerEvent, AnswerOutcome } from "@/answers/answer";
import { detectLanguage, type AnswerLanguage } from "@/answers/language";

import { firstNestedRank, firstRelevantRank, isUnderNewer } from "./metrics";
import { GOLD_QUESTIONS, type GoldQuestion } from "./questions";

/**
 * The questions whose answers are evaluated: a handful, because every one of
 * them is a call to a model with a quota. One of each kind of trouble seen so
 * far, taken from the questions of the retrieval evaluation, so the expected
 * regulation of each is already known.
 */
export const ANSWER_SAMPLE: readonly string[] = [
  // Several amounts, in three regulations of different years.
  "Adicional por prestación de servicios en la Antártida para el personal militar",
  // An earlier issue asked for by date; the search puts a later one first.
  "Homologación del acta acuerdo del 28 de mayo de 2026 del convenio colectivo sectorial del SINEP",
  // An earlier issue that the search lists under a newer one.
  "Tope de la retribución de los agentes habilitados para realizar servicios extraordinarios a partir del 1° de junio de 2026",
  // A regulation cited by its number.
  "¿Qué dispone la Ley 27818?",
  // A question in English about a law in Spanish.
  "Which law approves the amendment to the tax treaty with France?",
  // A broad question, in words the laws do not use.
  "Normativas relacionadas con mascotas",
  // Nothing to answer with: the model must not be asked.
  "Receta de empanadas salteñas",
];

export const answerSample = (): GoldQuestion[] =>
  ANSWER_SAMPLE.map((question) => {
    const found = GOLD_QUESTIONS.find((item) => item.question === question);
    if (!found) throw new Error(`"${question}" is not among the gold questions`);
    return found;
  });

/** Where the expected regulation was when the model was asked. */
export type Retrieval =
  /** Among the sources: the model had its text. */
  | "source"
  /**
   * Named under a newer source that comes first. The model had the name of the
   * regulation there, and at best some other passage of it further down.
   */
  | "earlier"
  /** Not there at all. */
  | "missing";

export type AnswerScore = {
  question: string;
  kind: GoldQuestion["kind"];
  /** How it ended; `error` when no model could answer. */
  outcome: AnswerOutcome | "error";
  /** `null` for a question that has no answer in the corpus. */
  retrieval: Retrieval | null;
  /** The answer cites a source of an expected regulation. */
  citesExpected: boolean;
  language: { expected: AnswerLanguage; written: AnswerLanguage | null };
  amounts: { total: number; supported: number; otherSource: number; notFound: number };
  unknownCitations: number;
  /** Models given up on before one answered. */
  skipped: number;
  provider: string | null;
  model: string | null;
  /** How long the search took: the wait before any model was asked. */
  searchMs: number | null;
  firstTextMs: number | null;
  totalMs: number | null;
  /** What is wrong with the answer; empty when it passes. */
  problems: string[];
  answer: string;
};

/**
 * Scores one answer from the events it was delivered as.
 *
 * Everything here is counted, not judged: whether the answer cites the
 * regulation it should, is in the language asked for, and quotes amounts its
 * sources state. Whether what it says is right still has to be read.
 */
export function scoreAnswer(
  question: GoldQuestion,
  events: AnswerEvent[],
): AnswerScore {
  const sources = events.find((event) => event.type === "sources");
  const done = events.find((event) => event.type === "done");
  const failure = events.find((event) => event.type === "error");
  const answer = events
    .flatMap((event) => (event.type === "text" ? [event.text] : []))
    .join("");

  const given = sources?.sources ?? [];
  const isExpected = (regulationId: number) => question.expected.includes(regulationId);
  const absent = question.expected.length === 0;

  // Measured as the retrieval evaluation does: a regulation that is among the
  // sources may still have the passage that answers hidden under a newer one.
  const ownRank = firstRelevantRank(
    given.map((source) => source.regulationId),
    question.expected,
  );
  const nestedRank = firstNestedRank(
    given.map((source) => source.earlier.map((earlier) => earlier.regulationId)),
    question.expected,
  );
  const retrieval: Retrieval | null = absent
    ? null
    : isUnderNewer(ownRank, nestedRank)
      ? "earlier"
      : ownRank === null
        ? "missing"
        : "source";

  const outcome = done?.outcome ?? "error";
  const cited = new Set(done?.cited ?? []);
  // Listing a source to say it is about something else is not citing it.
  const citesExpected =
    outcome === "answered" &&
    given.some((source) => cited.has(source.n) && isExpected(source.regulationId));

  const expectedLanguage = sources?.language ?? detectLanguage(question.question);
  const written = answer.trim() ? detectLanguage(answer) : null;

  const checks = done?.amounts ?? [];
  const amounts = {
    total: checks.length,
    supported: checks.filter((check) => check.status === "supported").length,
    otherSource: checks.filter((check) => check.status === "other_source").length,
    notFound: checks.filter((check) => check.status === "not_found").length,
  };
  const unknownCitations = done?.unknownCitations.length ?? 0;

  const problems: string[] = [];
  if (failure) problems.push(`no model finished an answer: ${failure.reason}`);

  // Where the expected regulation was says whose fault a wrong answer is.
  const where = {
    source: "it was among the sources",
    earlier: "it was only named under a newer one",
    missing: "the search did not find it",
  }[retrieval ?? "missing"];

  if (absent) {
    // Saying that the sources do not answer is right too: the search let
    // something through, and the model was not taken in.
    if (outcome === "answered" || outcome === "uncited") {
      problems.push("an answer was written for a subject the corpus does not cover");
    }
  } else if (!failure) {
    if (outcome === "no_sources")
      problems.push("the search found nothing to answer with");
    if (outcome === "uncited") problems.push("the answer cites no source");
    if (outcome === "not_in_sources") {
      problems.push(
        `says the sources do not answer; the expected regulation: ${where}`,
      );
    }
    if (outcome === "answered" && !citesExpected) {
      problems.push(`does not cite the expected regulation: ${where}`);
    }
    if (written && written !== expectedLanguage) {
      problems.push(`written in "${written}", expected "${expectedLanguage}"`);
    }
    if (amounts.notFound > 0) {
      problems.push(`${amounts.notFound} amount(s) not in any source`);
    }
    if (amounts.otherSource > 0) {
      problems.push(
        `${amounts.otherSource} amount(s) not in the source cited for them`,
      );
    }
    if (unknownCitations > 0) {
      problems.push(`${unknownCitations} citation(s) of a source that does not exist`);
    }
  }

  const timings = done?.timings ?? failure?.timings;

  return {
    question: question.question,
    kind: question.kind,
    outcome,
    retrieval,
    citesExpected,
    language: { expected: expectedLanguage, written },
    amounts,
    unknownCitations,
    skipped: events.filter((event) => event.type === "skipped").length,
    provider: done?.provider ?? null,
    model: done?.model ?? null,
    searchMs: sources?.searchMs ?? null,
    firstTextMs: timings?.firstTextMs ?? null,
    totalMs: timings?.totalMs ?? null,
    problems,
    answer,
  };
}

export type AnswerSummary = {
  questions: number;
  passed: number;
  /** How many answers each model wrote. */
  writers: Record<string, number>;
  /** Questions for which no model could answer. */
  unanswered: number;
  totalMs: number;
};

export function summarize(scores: readonly AnswerScore[]): AnswerSummary {
  const writers: Record<string, number> = {};
  for (const score of scores) {
    if (score.model) writers[score.model] = (writers[score.model] ?? 0) + 1;
  }

  return {
    questions: scores.length,
    passed: scores.filter((score) => score.problems.length === 0).length,
    writers,
    unanswered: scores.filter((score) => score.outcome === "error").length,
    totalMs: scores.reduce((sum, score) => sum + (score.totalMs ?? 0), 0),
  };
}
