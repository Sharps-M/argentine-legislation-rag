import { parseArgs } from "node:util";

import postgres from "postgres";

import { getChatModel } from "../ai/chat";
import { getEmbedder } from "../ai/embedder";
import { answerQuestion, type AnswerEvent } from "../answers/answer";
import { createDb } from "../db/client";
import { getEnv } from "../env";
import { QueryEmbeddingError, searchChunks } from "../search/search";
import { answerSample, scoreAnswer, summarize, type AnswerScore } from "./answers";

const HELP = `
Usage: npm run eval:answers -- [options]

Asks a handful of questions (src/eval/answers.ts) and checks what can be checked
without reading the answer:

  cites     the answer cites a source of the regulation it should
  lang      it is written in the language of the question
  amounts   the amounts it quotes are in the sources it cites for them
  time      when the first word came, and the total
  model     who wrote it, after how many models were given up on

Each question is a call to a chat model and counts against its quota: that is
why they are few. Whether an answer is right still has to be read; --verbose
prints every answer for that.

Options:
  --limit <n>     Ask only the first n questions
  --verbose       Print each answer in full
  --json          Print the scores as JSON
  --help          Show this message
`;

const seconds = (ms: number | null) =>
  ms === null ? "—".padStart(6) : `${(ms / 1000).toFixed(1)} s`.padStart(6);

const row = (score: AnswerScore) => {
  const expectsAnswer = score.retrieval !== null;
  const amounts =
    score.amounts.total === 0
      ? "—"
      : `${score.amounts.supported}/${score.amounts.total}`;

  return [
    (score.problems.length === 0 ? "ok" : "FAIL").padEnd(4),
    (expectsAnswer ? (score.citesExpected ? "yes" : "no") : "—").padEnd(5),
    (score.language.written ?? "—").padEnd(4),
    amounts.padEnd(7),
    seconds(score.firstTextMs),
    seconds(score.totalMs),
    ` ${(score.model ?? "—").padEnd(22)}`,
    score.question.length > 60 ? `${score.question.slice(0, 59)}…` : score.question,
  ].join("  ");
};

async function main() {
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      verbose: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) {
    throw new Error(`--limit must be a whole number from 1, got "${values.limit}"`);
  }

  const questions = answerSample().slice(0, limit);
  const sql = postgres(getEnv().DATABASE_URL, { max: 1 });

  try {
    const db = createDb(sql);
    const embedder = getEmbedder();
    const scores: AnswerScore[] = [];

    if (!values.json) {
      console.log(
        `${questions.length} questions, one at a time. Each one is a call to a chat model.\n`,
      );
      console.log(
        "pass  cites  lang  amounts   first   total   model                   question",
      );
    }

    // One at a time: a free tier counts requests per minute.
    for (const question of questions) {
      const events: AnswerEvent[] = [];
      for await (const event of answerQuestion(
        {
          search: (query, options) => searchChunks(db, embedder, query, options),
          chat: getChatModel,
        },
        question.question,
      )) {
        events.push(event);
      }

      const score = scoreAnswer(question, events);
      scores.push(score);
      if (values.json) continue;

      console.log(row(score));
      for (const problem of score.problems) console.log(`      ↳ ${problem}`);
      if (values.verbose && score.answer.trim()) {
        console.log(
          `\n${score.answer
            .trim()
            .split("\n")
            .map((line) => `      │ ${line}`)
            .join("\n")}\n`,
        );
      }
    }

    const summary = summarize(scores);
    if (values.json) {
      console.log(JSON.stringify({ summary, scores }, null, 2));
    } else {
      const writers = Object.entries(summary.writers)
        .map(([model, answers]) => `${model} ${answers}`)
        .join(", ");
      console.log(
        `\nPassed ${summary.passed} of ${summary.questions} · written by: ${writers || "nobody"} · ${seconds(summary.totalMs).trim()} in all`,
      );
      if (summary.unanswered > 0) {
        console.log(
          `${summary.unanswered} question(s) got no answer from any model: that says nothing about the answers. Run it again later.`,
        );
      }
      console.log(
        '\ncites: the answer cites the expected regulation. amounts: found in the source cited / quoted.\n"ok" means nothing countable is wrong. It does not mean the answer is right: read it with --verbose.',
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof QueryEmbeddingError) {
    console.error(error.message);
    console.error(
      "Could not reach Ollama. Start it with `ollama serve` and pull the model with `ollama pull bge-m3`.",
    );
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
