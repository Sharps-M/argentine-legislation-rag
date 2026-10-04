import { parseArgs } from "node:util";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import postgres from "postgres";

import { getEmbedder } from "../ai/embedder";
import { createDb, type Database } from "../db/client";
import { chunks } from "../db/schema";
import { getEnv } from "../env";
import { findReferences } from "../search/references";
import {
  DEFAULT_EF_SEARCH,
  MAX_EF_SEARCH,
  MAX_SEARCH_LIMIT,
  QueryEmbeddingError,
  searchByVector,
  type SearchHit,
  type SearchOptions,
} from "../search/search";
import { evaluate, type EvalReport, type Metrics } from "./metrics";
import { GOLD_QUESTIONS, type GoldQuestion } from "./questions";

const HELP = `
Usage: npm run eval -- [options]

Measures the retrieval with a set of questions whose answer is known
(src/eval/questions.ts). For each question it reports the position of the first
chunk that belongs to the expected regulation, and overall:

  recall@k  share of questions answered within the first k chunks
  MRR       mean reciprocal rank (1 = always first)

Questions whose regulation has no embedded chunks yet are skipped.

Options:
  --verbose           Under each question not answered first, show what came first
  --exact             Skip the vector index and compare against every chunk
  --ef-search <n>     Candidates the index keeps while searching (default: ${DEFAULT_EF_SEARCH})
  --semantic-only     Ignore regulations cited by number: similarity search alone
  --sweep             Compare the exact search with several --ef-search values:
                      quality and time per question, in one table (semantic only)
  --min-recall <0-1>  Exit with an error if recall@5 is below this value
  --json              Print the report as JSON
  --help              Show this message
`;

const KS = [1, 3, 5, 10] as const;
const SWEEP_EF_SEARCH = [40, 100, 200, 400, 1000];

const percent = (value: number) => `${(value * 100).toFixed(0)}%`.padStart(4);

const metricsColumns = (metrics: Metrics) =>
  KS.map((k) => `R@${k} ${percent(metrics.recall[k] ?? 0)}`).join("  ") +
  `  MRR ${metrics.mrr.toFixed(3)}`;

const metricsLine = (name: string, metrics: Metrics) =>
  `${name.padEnd(10)} ${String(metrics.questions).padStart(3)}  ${metricsColumns(metrics)}`;

/** Ids of the regulations that have at least one chunk embedded with `model`. */
async function embeddedRegulations(db: Database, model: string, ids: number[]) {
  const rows = await db
    .selectDistinct({ id: chunks.regulationId })
    .from(chunks)
    .where(
      and(
        inArray(chunks.regulationId, ids),
        isNotNull(chunks.embedding),
        eq(chunks.embeddingModel, model),
      ),
    );

  return new Set(rows.map((row) => row.id));
}

type Run = {
  report: EvalReport;
  retrieved: Map<string, SearchHit[]>;
  /** Average time of the database search, without the embedding of the question. */
  msPerQuestion: number;
};

async function main() {
  const { values } = parseArgs({
    options: {
      "min-recall": { type: "string" },
      "ef-search": { type: "string" },
      verbose: { type: "boolean", default: false },
      exact: { type: "boolean", default: false },
      sweep: { type: "boolean", default: false },
      "semantic-only": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const minRecall =
    values["min-recall"] === undefined ? undefined : Number(values["min-recall"]);
  if (minRecall !== undefined && !(minRecall >= 0 && minRecall <= 1)) {
    throw new Error(
      `--min-recall must be between 0 and 1, got "${values["min-recall"]}"`,
    );
  }

  const efSearch =
    values["ef-search"] === undefined ? undefined : Number(values["ef-search"]);
  if (
    efSearch !== undefined &&
    !(Number.isInteger(efSearch) && efSearch >= 1 && efSearch <= MAX_EF_SEARCH)
  ) {
    throw new Error(
      `--ef-search must be a whole number between 1 and ${MAX_EF_SEARCH}, got "${values["ef-search"]}"`,
    );
  }

  const sql = postgres(getEnv().DATABASE_URL, { max: 1 });

  try {
    const db = createDb(sql);
    const embedder = getEmbedder();

    const available = await embeddedRegulations(db, embedder.model, [
      ...new Set(GOLD_QUESTIONS.flatMap((question) => question.expected)),
    ]);
    const questions = GOLD_QUESTIONS.filter((question) =>
      question.expected.some((id) => available.has(id)),
    );
    const skipped = GOLD_QUESTIONS.length - questions.length;

    if (questions.length === 0) {
      throw new Error(
        "None of the expected regulations has embedded chunks. Run `npm run ingest`, `npm run texts` and `npm run embed` first.",
      );
    }

    // Every question is embedded once, so runs with different search settings
    // compare the search alone.
    const vectors = await embedQuestions(embedder, questions);

    // The sweep measures the index, so it leaves the lookup by number out.
    const semanticOnly = values["semantic-only"] || values.sweep;

    const run = async (options: SearchOptions): Promise<Run> => {
      const retrieved = new Map<string, SearchHit[]>();
      let elapsed = 0;

      const report = await evaluate(
        questions,
        async (question) => {
          const startedAt = performance.now();
          const hits = await searchByVector(
            db,
            embedder.model,
            vectors.get(question)!,
            {
              limit: MAX_SEARCH_LIMIT,
              references: semanticOnly ? [] : findReferences(question),
              ...options,
            },
          );
          elapsed += performance.now() - startedAt;

          retrieved.set(question, hits);
          return hits.map((hit) => hit.regulation.id);
        },
        KS,
      );

      return { report, retrieved, msPerQuestion: elapsed / questions.length };
    };

    if (values.sweep) {
      const settings: { name: string; options: SearchOptions }[] = [
        { name: "exact", options: { exact: true } },
        ...SWEEP_EF_SEARCH.map((value) => ({
          name: `ef_search ${value}`,
          options: { efSearch: value },
        })),
      ];

      const rows: { name: string; metrics: Metrics; msPerQuestion: number }[] = [];
      for (const setting of settings) {
        // The first pass loads the data into memory; the second one is timed.
        await run(setting.options);
        const { report, msPerQuestion } = await run(setting.options);
        rows.push({ name: setting.name, metrics: report.overall, msPerQuestion });
      }

      if (values.json) {
        console.log(
          JSON.stringify({ model: embedder.model, skipped, sweep: rows }, null, 2),
        );
      } else {
        console.log(`Model: ${embedder.model} · ${questions.length} questions\n`);
        for (const row of rows) {
          console.log(
            `${row.name.padEnd(15)} ${metricsColumns(row.metrics)}  ${row.msPerQuestion.toFixed(0).padStart(5)} ms/question`,
          );
        }
        console.log(
          "\nThe time is the database search alone, without embedding the question.",
        );
      }
      return;
    }

    const { report, retrieved, msPerQuestion } = await run({
      exact: values.exact,
      efSearch,
    });

    if (values.json) {
      console.log(
        JSON.stringify(
          { model: embedder.model, skipped, msPerQuestion, ...report },
          null,
          2,
        ),
      );
    } else {
      const mode = values.exact
        ? "exact search"
        : `ef_search ${efSearch ?? DEFAULT_EF_SEARCH}`;
      const scope = semanticOnly ? "semantic only" : "with lookup by number";
      console.log(`Model: ${embedder.model} (${mode}, ${scope})\n`);
      console.log("rank  kind       question");
      for (const result of report.results) {
        const rank = result.rank === null ? "  —" : String(result.rank).padStart(3);
        console.log(`${rank}   ${result.kind.padEnd(10)} ${result.question}`);

        if (values.verbose && result.rank !== 1) {
          for (const [index, hit] of (retrieved.get(result.question) ?? [])
            .slice(0, 5)
            .entries()) {
            const expected = result.expected.includes(hit.regulation.id) ? "*" : " ";
            const cited = hit.match === "reference" ? " [cited]" : "";
            const where = [hit.regulation.name, hit.label].filter(Boolean).join(" · ");
            const title = [hit.regulation.topic, hit.regulation.title]
              .filter(Boolean)
              .join(" / ");
            console.log(
              `       ${expected}${index + 1}. ${hit.similarity.toFixed(3)}  ${where}${cited} — ${title.slice(0, 90)}`,
            );
          }
        }
      }

      console.log(`\n${"".padEnd(10)}   n`);
      console.log(metricsLine("all", report.overall));
      for (const [kind, metrics] of Object.entries(report.byKind)) {
        console.log(metricsLine(kind, metrics));
      }
      console.log(`\nSearch time: ${msPerQuestion.toFixed(0)} ms per question.`);

      if (values.verbose) {
        console.log("\n* marks a chunk of the expected regulation.");
      }
      if (skipped > 0) {
        console.log(
          `\n${skipped} question(s) skipped: their regulation has no embedded chunks yet.`,
        );
      }
      if (report.results.some((result) => result.rank === null)) {
        console.log(
          `\n"—" means the regulation was not among the first ${MAX_SEARCH_LIMIT} chunks.`,
        );
      }
    }

    const recallAt5 = report.overall.recall[5] ?? 0;
    if (minRecall !== undefined && recallAt5 < minRecall) {
      console.error(
        `\nrecall@5 is ${recallAt5.toFixed(2)}, below the required ${minRecall.toFixed(2)}.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

async function embedQuestions(
  embedder: ReturnType<typeof getEmbedder>,
  questions: GoldQuestion[],
): Promise<Map<string, number[]>> {
  let embeddings: number[][];
  try {
    embeddings = await embedder.embed(questions.map((item) => item.question));
  } catch (cause) {
    throw new QueryEmbeddingError(embedder.model, cause);
  }

  return new Map(
    questions.map((item, index) => [item.question, embeddings[index] ?? []] as const),
  );
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
