import { parseArgs } from "node:util";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import postgres from "postgres";

import { getEmbedder } from "../ai/embedder";
import { createDb, type Database } from "../db/client";
import { chunks } from "../db/schema";
import { getEnv } from "../env";
import { findDates } from "../search/dates";
import { findReferences } from "../search/references";
import {
  DEFAULT_EF_SEARCH,
  DEFAULT_MIN_SIMILARITY,
  DEFAULT_VERSION_LINKAGE,
  DEFAULT_VERSION_SIMILARITY,
  isCloseEnough,
  MAX_EF_SEARCH,
  MAX_SEARCH_LIMIT,
  QueryEmbeddingError,
  searchByVector,
  type SearchHit,
  type SearchOptions,
} from "../search/search";
import type { VersionLinkage } from "../search/versions";
import {
  evaluate,
  firstNestedRank,
  firstRelevantRank,
  isAbsent,
  isUnderNewer,
  type EvalReport,
  type Metrics,
} from "./metrics";
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
  --no-dates          Ignore the dates a question names: the most recent issue
                      of a provision always leads
  --min-similarity <0-1>
                      How close a chunk must be to count (default: ${DEFAULT_MIN_SIMILARITY})
  --floors            Compare several --min-similarity values: answers kept
                      against unrelated results rejected, in one table
                      (without grouping)
  --versions <0-1|off>
                      List together the chunks of different regulations whose
                      texts are this similar, newest first (default: ${DEFAULT_VERSION_SIMILARITY ?? "off"})
  --versions-link <best|chain>
                      Compare each chunk with the best one of its group, or with
                      any of its members (default: ${DEFAULT_VERSION_LINKAGE})
  --versions-sweep    Compare several --versions values with both ways of
                      linking: what the latest issue of a series gains against
                      what an earlier one loses
  --sweep             Compare the exact search with several --ef-search values:
                      quality and time per question, in one table (semantic
                      only, without grouping)
  --min-recall <0-1>  Exit with an error if recall@5 is below this value
  --json              Print the report as JSON
  --help              Show this message
`;

const KS = [1, 3, 5, 10] as const;
const SWEEP_EF_SEARCH = [40, 100, 200, 400, 1000];
const SWEEP_FLOORS = [
  0, 0.5, 0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58, 0.6, 0.62, 0.65,
];

const SWEEP_VERSIONS = [0.98, 0.97, 0.96, 0.95, 0.94, 0.93, 0.92, 0.9];
const LINKAGES: VersionLinkage[] = ["best", "chain"];

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
      "no-dates": { type: "boolean", default: false },
      "min-similarity": { type: "string" },
      floors: { type: "boolean", default: false },
      versions: { type: "string" },
      "versions-link": { type: "string" },
      "versions-sweep": { type: "boolean", default: false },
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

  const versionSimilarity =
    values.versions === undefined
      ? DEFAULT_VERSION_SIMILARITY
      : values.versions === "off"
        ? null
        : Number(values.versions);
  if (
    versionSimilarity !== null &&
    !(versionSimilarity > 0 && versionSimilarity <= 1)
  ) {
    throw new Error(
      `--versions must be "off" or above 0 and at most 1, got "${values.versions}"`,
    );
  }

  const linkOption = values["versions-link"];
  if (linkOption !== undefined && linkOption !== "best" && linkOption !== "chain") {
    throw new Error(`--versions-link must be "best" or "chain", got "${linkOption}"`);
  }
  const versionLinkage: VersionLinkage = linkOption ?? DEFAULT_VERSION_LINKAGE;

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

    // Unless told otherwise, the search runs without a similarity floor and
    // without grouping: floors are applied to what came back, so several can be
    // compared on one run.
    const run = async (options: SearchOptions): Promise<Run> => {
      const retrieved = new Map<string, SearchHit[]>();
      let elapsed = 0;

      for (const { question } of questions) {
        const startedAt = performance.now();
        const hits = await searchByVector(db, embedder.model, vectors.get(question)!, {
          limit: MAX_SEARCH_LIMIT,
          references: semanticOnly ? [] : findReferences(question),
          dates: values["no-dates"] ? [] : findDates(question),
          minSimilarity: 0,
          versionSimilarity: null,
          ...options,
        });
        elapsed += performance.now() - startedAt;

        retrieved.set(question, hits);
      }

      return { retrieved, msPerQuestion: elapsed / questions.length };
    };

    const score = (
      retrieved: Map<string, SearchHit[]>,
      floor: number,
      subset: GoldQuestion[] = questions,
    ) =>
      evaluate(
        subset,
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

    /** Position of the first result that lists an expected regulation under it. */
    const nestedRank = (hits: SearchHit[], expected: number[]) =>
      firstNestedRank(
        hits.map((hit) => hit.earlierVersions.map((version) => version.regulationId)),
        expected,
      );

    if (values["versions-sweep"]) {
      // The questions that ask for an earlier issue are scored apart: grouping
      // is meant to help the others, and these show what it costs.
      const earlier = questions.filter((question) => question.kind === "earlier");
      const latest = questions.filter((question) => question.kind !== "earlier");

      const settings: { linkage: VersionLinkage | null; threshold: number | null }[] = [
        { linkage: null, threshold: null },
        ...LINKAGES.flatMap((linkage) =>
          SWEEP_VERSIONS.map((threshold) => ({ linkage, threshold })),
        ),
      ];

      const rows = [];
      for (const { linkage, threshold } of settings) {
        // Grouping happens after the floor, so here the search applies it.
        const { retrieved } = await run({
          exact: values.exact,
          efSearch,
          minSimilarity,
          versionSimilarity: threshold,
          ...(linkage && { versionLinkage: linkage }),
        });
        const report = await score(retrieved, 0, latest);
        const earlierReport = await score(retrieved, 0, earlier);

        const underNewer = questions.filter((question) => {
          const hits = retrieved.get(question.question) ?? [];
          const rank = firstRelevantRank(
            hits.map((hit) => hit.regulation.id),
            question.expected,
          );
          return isUnderNewer(rank, nestedRank(hits, question.expected));
        }).length;
        const grouped = [...retrieved.values()]
          .flat()
          .reduce((sum, hit) => sum + hit.earlierVersions.length, 0);

        rows.push({
          linkage,
          threshold,
          metrics: report.overall,
          earlier: earlierReport.overall,
          underNewer,
          rejection: report.rejection,
          grouped,
        });
      }

      if (values.json) {
        console.log(
          JSON.stringify({ model: embedder.model, skipped, versions: rows }, null, 2),
        );
      } else {
        console.log(
          `Model: ${embedder.model} · min similarity ${minSimilarity} · ${latest.filter((question) => !isAbsent(question)).length} questions, and ${earlier.length} that ask for an earlier issue\n`,
        );
        let previous: VersionLinkage | null = null;
        for (const row of rows) {
          if (row.linkage !== previous) console.log("");
          previous = row.linkage;

          const name =
            row.threshold === null
              ? "off".padEnd(10)
              : `${row.linkage?.padEnd(5)} ${row.threshold.toFixed(2)}`;
          console.log(
            `${name}  ${metricsColumns(row.metrics)}   earlier R@1 ${percent(row.earlier.recall[1] ?? 0)} R@5 ${percent(row.earlier.recall[5] ?? 0)}   under a newer ${String(row.underNewer).padStart(2)}   rejected ${row.rejection.rejected}/${row.rejection.questions}   ${String(row.grouped).padStart(4)} grouped`,
          );
        }
        console.log(
          '\nearlier: questions that ask for an issue that is not the latest of its series.\nunder a newer: questions whose answer lost its place to a newer look-alike and is only listed under it.\nA good setting raises the first columns without lowering "earlier".\nCheck what is grouped with --verbose --versions <value> --versions-link <best|chain> before choosing.',
        );
      }
      return;
    }

    // With versions grouped, the floor has to be applied before the grouping:
    // the search does both. Otherwise it is applied here, on the raw results.
    const grouping = versionSimilarity !== null && !values.floors;
    const searchOptions: SearchOptions = {
      exact: values.exact,
      efSearch,
      ...(grouping && { versionSimilarity, versionLinkage, minSimilarity }),
    };

    // The first pass loads the data into memory; the second one is timed.
    await run(searchOptions);
    const { retrieved, msPerQuestion } = await run(searchOptions);

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

    const report = await score(retrieved, grouping ? 0 : minSimilarity);

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
      const versions = grouping
        ? `, versions ${versionSimilarity} linked by ${versionLinkage}${values["no-dates"] ? ", dates ignored" : ""}`
        : "";
      console.log(
        `Model: ${embedder.model} (${mode}, ${scope}, min similarity ${minSimilarity}${versions})\n`,
      );
      console.log("rank   top    hit   kind       question");
      for (const result of report.results) {
        const hits = retrieved.get(result.question) ?? [];
        const expectedHit = hits.find((hit) =>
          result.expected.includes(hit.regulation.id),
        );
        const similarity = (hit: SearchHit | undefined) =>
          hit ? hit.similarity.toFixed(3) : "  —  ";

        const nested = nestedRank(hits, result.expected);
        const outcome = isAbsent(result)
          ? result.returned === 0
            ? " ok"
            : `+${result.returned}`.padStart(3)
          : result.rank !== null
            ? String(result.rank).padStart(3)
            : nested !== null
              ? `^${nested}`.padStart(3)
              : "  —";

        console.log(
          `${outcome}   ${similarity(hits[0])}  ${similarity(expectedHit)}  ${result.kind.padEnd(10)} ${result.question}`,
        );

        const wrong = isAbsent(result) ? result.returned > 0 : result.rank !== 1;
        const grouped = hits.some((hit) => hit.earlierVersions.length > 0);
        if (values.verbose && (wrong || grouped)) {
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
            if (hit.earlierVersions.length > 0) {
              const earlier = hit.earlierVersions.slice(0, 6).map((version) => {
                const mark = result.expected.includes(version.regulationId) ? "*" : "";
                return `${mark}${version.name} (${version.textSimilarity.toFixed(3)})`;
              });
              console.log(
                `            + ${hit.earlierVersions.length} earlier: ${earlier.join(", ")}`,
              );
            }
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
      if (grouping) {
        console.log(
          '"+ N earlier" lists older regulations grouped under a result, with how similar their text is to it; * marks an expected one.\n"^N" means the expected regulation is not a result of its own: it is listed under result N.',
        );
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
