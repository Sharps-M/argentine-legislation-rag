import { parseArgs } from "node:util";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import postgres from "postgres";

import { getEmbedder } from "../ai/embedder";
import { createDb, type Database } from "../db/client";
import { chunks } from "../db/schema";
import { getEnv } from "../env";
import {
  MAX_SEARCH_LIMIT,
  QueryEmbeddingError,
  searchChunks,
  type SearchHit,
} from "../search/search";
import { evaluate, type Metrics } from "./metrics";
import { GOLD_QUESTIONS } from "./questions";

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
  --min-recall <0-1>  Exit with an error if recall@5 is below this value
  --json              Print the report as JSON
  --help              Show this message
`;

const KS = [1, 3, 5, 10] as const;

const percent = (value: number) => `${(value * 100).toFixed(0)}%`.padStart(4);

const metricsLine = (name: string, metrics: Metrics) =>
  `${name.padEnd(10)} ${String(metrics.questions).padStart(3)}  ` +
  KS.map((k) => `R@${k} ${percent(metrics.recall[k] ?? 0)}`).join("  ") +
  `  MRR ${metrics.mrr.toFixed(3)}`;

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

async function main() {
  const { values } = parseArgs({
    options: {
      "min-recall": { type: "string" },
      verbose: { type: "boolean", default: false },
      exact: { type: "boolean", default: false },
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

    const retrieved = new Map<string, SearchHit[]>();

    const report = await evaluate(
      questions,
      async (question) => {
        const hits = await searchChunks(db, embedder, question, {
          limit: MAX_SEARCH_LIMIT,
          exact: values.exact,
        });
        retrieved.set(question, hits);
        return hits.map((hit) => hit.regulation.id);
      },
      KS,
    );

    if (values.json) {
      console.log(
        JSON.stringify({ model: embedder.model, skipped, ...report }, null, 2),
      );
    } else {
      console.log(`Model: ${embedder.model}${values.exact ? " (exact search)" : ""}\n`);
      console.log("rank  kind       question");
      for (const result of report.results) {
        const rank = result.rank === null ? "  —" : String(result.rank).padStart(3);
        console.log(`${rank}   ${result.kind.padEnd(10)} ${result.question}`);

        if (values.verbose && result.rank !== 1) {
          for (const [index, hit] of (retrieved.get(result.question) ?? [])
            .slice(0, 5)
            .entries()) {
            const expected = result.expected.includes(hit.regulation.id) ? "*" : " ";
            const where = [hit.regulation.name, hit.label].filter(Boolean).join(" · ");
            const title = [hit.regulation.topic, hit.regulation.title]
              .filter(Boolean)
              .join(" / ");
            console.log(
              `       ${expected}${index + 1}. ${hit.similarity.toFixed(3)}  ${where} — ${title.slice(0, 90)}`,
            );
          }
        }
      }

      console.log(`\n${"".padEnd(10)}   n`);
      console.log(metricsLine("all", report.overall));
      for (const [kind, metrics] of Object.entries(report.byKind)) {
        console.log(metricsLine(kind, metrics));
      }

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
