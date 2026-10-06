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
  DEFAULT_MIN_SIMILARITY,
  isCloseEnough,
  MAX_EF_SEARCH,
  MAX_SEARCH_LIMIT,
  QueryEmbeddingError,
  searchByVector,
  type SearchHit,
  type SearchOptions,
} from "../search/search";
import { evaluate, isAbsent, type EvalReport, type Metrics } from "./metrics";
import { GOLD_QUESTIONS, type GoldQuestion } from "./questions";

const HELP = `
Usage: npm run eval -- [options]

Measures the retrieval with a set of questions whose answer is known
(src/eval/questions.ts). For each question it reports the position of the first
chunk that belongs to the expected regulation, and overall:

  recall@k  share of questions answered within the first k chunks
  MRR       mean reciprocal rank (1 = always first)
  rejected  questions about subjects the corpus does not cover that came back
            empty, as they should

Questions whose regulation has no embedded chunks yet are skipped.

Options:
  --verbose           Under each question not answered first, show what came first
  --exact             Skip the vector index and compare against every chunk
  --ef-search <n>     Candidates the index keeps while searching (default: ${DEFAULT_EF_SEARCH})
  --semantic-only     Ignore regulations cited by number: similarity search alone
  --min-similarity <0-1>
                      How close a chunk must be to count (default: ${DEFAULT_MIN_SIMILARITY})
  --floors            Compare several --min-similarity values: answers kept
                      against unrelated results rejected, in one table
  --sweep             Compare the exact search with several --ef-search values:
                      quality and time per question, in one table (semantic only)
  --min-recall <0-1>  Exit with an error if recall@5 is below this value
  --json              Print the report as JSON
  --help              Show this message
`;

const KS = [1, 3, 5, 10] as const;
const SWEEP_EF_SEARCH = [40, 100, 200, 400, 1000];
const SWEEP_FLOORS = [
  0, 0.5, 0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58, 0.6, 0.62, 0.65,
];

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
  /** What the search found for each question, before any similarity floor. */
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
      "min-similarity": { type: "string" },
      floors: { type: "boolean", default: false },
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

  const minSimilarity =
    values["min-similarity"] === undefined
      ? DEFAULT_MIN_SIMILARITY
      : Number(values["min-similarity"]);
  if (!(minSimilarity >= 0 && minSimilarity <= 1)) {
    throw new Error(
      `--min-similarity must be between 0 and 1, got "${values["min-similarity"]}"`,
    );
  }

  const sql = postgres(getEnv().DATABASE_URL, { max: 1 });

  try {
    const db = createDb(sql);
    const embedder = getEmbedder();

    const available = await embeddedRegulations(db, embedder.model, [
      ...new Set(GOLD_QUESTIONS.flatMap((question) => question.expected)),
    ]);
    const questions = GOLD_QUESTIONS.filter(
      (question) =>
        isAbsent(question) || question.expected.some((id) => available.has(id)),
    );
    const skipped = GOLD_QUESTIONS.length - questions.length;

    if (questions.every(isAbsent)) {
      throw new Error(
        "None of the expected regulations has embedded chunks. Run `npm run ingest`, `npm run texts` and `npm run embed` first.",
      );
    }

    // Every question is embedded once, so runs with different search settings
    // compare the search alone.
    const vectors = await embedQuestions(embedder, questions);

    // The sweep measures the index, so it leaves the lookup by number out.
    const semanticOnly = values["semantic-only"] || values.sweep;

    // The search runs once per question, without a similarity floor. Floors are
    // then applied to what came back, so several can be compared on one run.
    const run = async (options: SearchOptions): Promise<Run> => {
      const retrieved = new Map<string, SearchHit[]>();
      let elapsed = 0;

      for (const { question } of questions) {
        const startedAt = performance.now();
        const hits = await searchByVector(db, embedder.model, vectors.get(question)!, {
          limit: MAX_SEARCH_LIMIT,
          references: semanticOnly ? [] : findReferences(question),
          minSimilarity: 0,
          ...options,
        });
        elapsed += performance.now() - startedAt;

        retrieved.set(question, hits);
      }

      return { retrieved, msPerQuestion: elapsed / questions.length };
    };

    const score = (retrieved: Map<string, SearchHit[]>, floor: number) =>
      evaluate(
        questions,
        async (question) =>
          (retrieved.get(question) ?? [])
            .filter((hit) => isCloseEnough(hit, floor))
            .map((hit) => hit.regulation.id),
        KS,
      );

    const rejectedColumn = (report: EvalReport) =>
      `rejected ${report.rejection.rejected}/${report.rejection.questions}`;

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
        const { retrieved, msPerQuestion } = await run(setting.options);
        // The index is measured on its own: no floor.
        const report = await score(retrieved, 0);
        rows.push({ name: setting.name, metrics: report.overall, msPerQuestion });
      }

      if (values.json) {
        console.log(
          JSON.stringify({ model: embedder.model, skipped, sweep: rows }, null, 2),
        );
      } else {
        console.log(
          `Model: ${embedder.model} · ${rows[0]?.metrics.questions ?? 0} questions\n`,
        );
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

    // The first pass loads the data into memory; the second one is timed.
    await run({ exact: values.exact, efSearch });
    const { retrieved, msPerQuestion } = await run({ exact: values.exact, efSearch });

    if (values.floors) {
      const rows = [];
      for (const floor of SWEEP_FLOORS) {
        const report = await score(retrieved, floor);
        rows.push({ floor, metrics: report.overall, rejection: report.rejection });
      }

      if (values.json) {
        console.log(
          JSON.stringify({ model: embedder.model, skipped, floors: rows }, null, 2),
        );
      } else {
        const [first] = rows;
        console.log(
          `Model: ${embedder.model} · ${first?.metrics.questions ?? 0} questions with an answer, ${first?.rejection.questions ?? 0} without\n`,
        );
        for (const row of rows) {
          const mark = row.floor === DEFAULT_MIN_SIMILARITY ? "  <- default" : "";
          console.log(
            `min ${row.floor.toFixed(2)}   ${metricsColumns(row.metrics)}   rejected ${row.rejection.rejected}/${row.rejection.questions}${mark}`,
          );
        }
        console.log(
          "\nA good floor keeps recall where it is and rejects every question without an answer.",
        );
      }
      return;
    }

    const report = await score(retrieved, minSimilarity);

    if (values.json) {
      console.log(
        JSON.stringify(
          { model: embedder.model, skipped, minSimilarity, msPerQuestion, ...report },
          null,
          2,
        ),
      );
    } else {
      const mode = values.exact
        ? "exact search"
        : `ef_search ${efSearch ?? DEFAULT_EF_SEARCH}`;
      const scope = semanticOnly ? "semantic only" : "with lookup by number";
      console.log(
        `Model: ${embedder.model} (${mode}, ${scope}, min similarity ${minSimilarity})\n`,
      );
      console.log("rank   top    hit   kind       question");
      for (const result of report.results) {
        const hits = retrieved.get(result.question) ?? [];
        const expectedHit = hits.find((hit) =>
          result.expected.includes(hit.regulation.id),
        );
        const similarity = (hit: SearchHit | undefined) =>
          hit ? hit.similarity.toFixed(3) : "  —  ";

        const outcome = isAbsent(result)
          ? result.returned === 0
            ? " ok"
            : `+${result.returned}`.padStart(3)
          : result.rank === null
            ? "  —"
            : String(result.rank).padStart(3);

        console.log(
          `${outcome}   ${similarity(hits[0])}  ${similarity(expectedHit)}  ${result.kind.padEnd(10)} ${result.question}`,
        );

        const wrong = isAbsent(result) ? result.returned > 0 : result.rank !== 1;
        if (values.verbose && wrong) {
          for (const [index, hit] of hits.slice(0, 5).entries()) {
            const expected = result.expected.includes(hit.regulation.id) ? "*" : " ";
            const cited = hit.match === "reference" ? " [cited]" : "";
            const dropped = isCloseEnough(hit, minSimilarity) ? "" : " [too far]";
            const where = [hit.regulation.name, hit.label].filter(Boolean).join(" · ");
            const title = [hit.regulation.topic, hit.regulation.title]
              .filter(Boolean)
              .join(" / ");
            console.log(
              `       ${expected}${index + 1}. ${hit.similarity.toFixed(3)}  ${where}${cited}${dropped} — ${title.slice(0, 90)}`,
            );
          }
        }
      }

      console.log(`\n${"".padEnd(10)}   n`);
      console.log(metricsLine("all", report.overall));
      for (const [kind, metrics] of Object.entries(report.byKind)) {
        console.log(metricsLine(kind, metrics));
      }
      if (report.rejection.questions > 0) {
        console.log(
          `${"absent".padEnd(10)} ${String(report.rejection.questions).padStart(3)}  ${rejectedColumn(report)}`,
        );
      }
      console.log(`\nSearch time: ${msPerQuestion.toFixed(0)} ms per question.`);

      console.log(
        "\ntop: similarity of the nearest chunk. hit: similarity of the first chunk of the expected regulation.",
      );
      console.log(
        'Questions of kind "absent" have no answer in the corpus: "ok" means nothing came back, "+N" that N chunks did.',
      );
      if (values.verbose) {
        console.log("* marks a chunk of the expected regulation.");
      }
      if (skipped > 0) {
        console.log(
          `\n${skipped} question(s) skipped: their regulation has no embedded chunks yet.`,
        );
      }
      if (report.results.some((result) => !isAbsent(result) && result.rank === null)) {
        console.log(
          `\n"—" means the regulation was not among the first ${MAX_SEARCH_LIMIT} chunks, or was too far.`,
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
