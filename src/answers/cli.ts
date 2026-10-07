import { parseArgs } from "node:util";

import postgres from "postgres";

import { getChatModel } from "../ai/chat";
import { getEmbedder } from "../ai/embedder";
import { createDb } from "../db/client";
import { getEnv } from "../env";
import { parseSearchParams } from "../search/params";
import { QueryEmbeddingError, searchChunks } from "../search/search";
import type { AmountCheck } from "./amounts";
import { answerQuestion, type AnswerEvent, type AnswerTimings } from "./answer";
import { isAnswerLanguage } from "./language";
import type { AnswerSource } from "./sources";

const HELP = `
Usage: npm run ask -- "<question>" [options]

Answers a question from the regulations the search finds. Prints the sources,
numbered, and then the answer as it is written, with each statement pointing at
its source: [1], [2]... When no regulation is close enough it says so and does
not ask the model.

Requires the embeddings (npm run embed) and at least one chat model. Every
provider that is configured is tried in order, until one answers: Gemini
(GEMINI_API_KEY in .env), an OpenAI-compatible service, and a local model on
Ollama (ollama pull gemma3:4b). See .env.example.

Options:
  --type <type>   Keep only this regulation type; repeat for several (Ley, Decreto)
  --from <year>   Keep regulations enacted in this year or later
  --to <year>     Keep regulations enacted in this year or earlier
  --lang <es|en>  Language of the answer (default: the language of the question)
  --json          Print every event as a line of JSON instead
  --help          Show this message

Examples:
  npm run ask -- "¿Cuál es el tope de la retribución por servicios extraordinarios?"
  npm run ask -- "What does Decreto 829/2026 change about fuel taxes?"
`;

const sourceLine = (source: AnswerSource) => {
  const enacted = source.enactedOn ? ` (${source.enactedOn})` : "";
  const abstract = source.abstractOnly ? "  [abstract only]" : "";
  return `[${source.n}] ${source.title}${enacted}${abstract}\n    ${source.url}`;
};

const LANGUAGES = { es: "Spanish", en: "English" } as const;

const REASONS = {
  not_configured: "is not configured",
  unauthorized: "rejected the API key",
  rate_limited: "over its usage limit",
  overloaded: "no capacity right now",
  unavailable: "did not answer",
} as const;

const HINTS = {
  not_configured: "Set it up in .env; .env.example lists what each provider needs.",
  unauthorized: "Check the API key in .env.",
  rate_limited: "The usage limit resets by itself: try again in a minute.",
  overloaded: "It is on the provider's side and it passes: try again in a moment.",
  unavailable:
    "If the last one is the local model, check that Ollama is running and the model is pulled (ollama pull gemma3:4b).",
} as const;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      type: { type: "string", multiple: true },
      from: { type: "string" },
      to: { type: "string" },
      lang: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return;
  }

  // Same validation as the HTTP endpoint.
  const params = new URLSearchParams({ q: positionals.join(" ") });
  if (values.from) params.set("from", values.from);
  if (values.to) params.set("to", values.to);
  for (const type of values.type ?? []) params.append("type", type);

  const request = parseSearchParams(params);
  if (!request.ok) {
    for (const issue of request.issues)
      console.error(`${issue.field}: ${issue.message}`);
    process.exitCode = 1;
    return;
  }

  const language = values.lang;
  if (language !== undefined && !isAnswerLanguage(language)) {
    console.error(`--lang must be "es" or "en", got "${language}"`);
    process.exitCode = 1;
    return;
  }

  const sql = postgres(getEnv().DATABASE_URL, { max: 1 });

  try {
    const db = createDb(sql);
    const embedder = getEmbedder();
    const events = answerQuestion(
      {
        search: (query, options) => searchChunks(db, embedder, query, options),
        chat: getChatModel,
      },
      request.query,
      { ...request.options, ...(language && { language }) },
    );

    const print = printer();
    for await (const event of events) {
      if (values.json) console.log(JSON.stringify(event));
      else print(event);
    }
  } finally {
    await sql.end();
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const timingsLine = (timings: AnswerTimings) =>
  [
    `search ${seconds(timings.searchMs)}`,
    timings.firstTextMs === null
      ? null
      : `first word at ${seconds(timings.firstTextMs)}`,
    `total ${seconds(timings.totalMs)}`,
  ]
    .filter(Boolean)
    .join(" · ");

const cites = (numbers: number[]) => numbers.map((n) => `[${n}]`).join(", ");

/** What the check of the amounts found, one line per thing worth saying. */
function amountLines(amounts: AmountCheck[]): string[] {
  if (amounts.length === 0) return [];

  const problems = amounts.filter((check) => check.status !== "supported");
  if (problems.length === 0) {
    return [
      amounts.length === 1
        ? "Amounts: 1, found in the source it cites."
        : `Amounts: ${amounts.length}, each found in the source it cites.`,
    ];
  }

  return problems.map((check) => {
    if (check.status === "not_found") {
      return `Warning: ${check.amount} is not in any of the sources.`;
    }
    return check.cited.length > 0
      ? `Warning: ${check.amount} is in ${cites(check.foundIn)}, not in the source cited for it (${cites(check.cited)}).`
      : `Warning: ${check.amount} is in ${cites(check.foundIn)}, but the answer cites no source for it.`;
  });
}

/**
 * Prints the events of one answer as they come. Each model asked gets a line
 * of its own, left open until it either starts writing or is given up on, so
 * what is being waited for is always on screen.
 */
function printer() {
  let sources: AnswerSource[] = [];
  /** A model was named and its line is still open. */
  let waiting = false;

  return (event: AnswerEvent): void => {
    switch (event.type) {
      case "sources":
        sources = event.sources;
        if (sources.length > 0) {
          console.log(`Sources (found in ${seconds(event.searchMs)}):\n`);
          for (const source of sources) console.log(sourceLine(source));
          console.log(`\nAnswer (in ${LANGUAGES[event.language]}):\n`);
        }
        return;

      case "asking":
        process.stdout.write(`  ${event.provider} · ${event.model} … `);
        waiting = true;
        return;

      case "skipped": {
        // A provider without its settings was never asked: it has no open line.
        const who = waiting ? "" : `  ${event.provider} `;
        console.log(`${who}${REASONS[event.reason]} (${seconds(event.ms)})`);
        // "Did not answer" explains nothing: show what the provider said.
        if (event.reason === "unavailable") console.log(`      ${event.message}`);
        waiting = false;
        return;
      }

      case "text":
        if (waiting) {
          console.log("answering\n");
          waiting = false;
        }
        process.stdout.write(event.text);
        return;

      case "error":
        if (waiting) console.log(REASONS[event.reason]);
        console.error(
          `\nNo model could answer.\n${event.message}\n\n${HINTS[event.reason]}`,
        );
        console.error(`Time: ${timingsLine(event.timings)}`);
        process.exitCode = 1;
        return;

      case "done": {
        if (event.outcome === "no_sources") {
          console.log(
            'No regulation is close enough to the question, so no answer was written.\nTry other words, or see the nearest chunks with: npm run search -- "..." --min-similarity 0',
          );
          console.log(`Time: ${timingsLine(event.timings)}`);
          return;
        }

        console.log(`\n\n— ${event.provider} · ${event.model}`);
        if (event.outcome === "not_in_sources") {
          console.log(
            "The sources found do not answer the question. See them above, or try other words.",
          );
        } else if (event.outcome === "uncited") {
          console.log(
            "This answer cites no source: nothing in it can be checked against a regulation.",
          );
        } else {
          const cited = sources.filter((source) => event.cited.includes(source.n));
          console.log(
            `Cites: ${cited.map((source) => `[${source.n}] ${source.title}`).join("; ")}`,
          );
        }
        for (const line of amountLines(event.amounts)) console.log(line);
        if (event.unknownCitations.length > 0) {
          console.log(
            `Warning: it cites ${event.unknownCitations.map((n) => `[${n}]`).join(", ")}, which is not among the sources.`,
          );
        }
        console.log(`Time: ${timingsLine(event.timings)}`);
        return;
      }
    }
  };
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
