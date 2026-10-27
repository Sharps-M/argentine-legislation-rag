import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import postgres from "postgres";

import { getEmbedder } from "../ai/embedder";
import { createDb } from "../db/client";
import { embedChunks } from "../embeddings/pipeline";
import { createEmbeddingStore, vacuumChunks } from "../embeddings/store";
import { regulationName } from "../embeddings/input";
import { getEnv } from "../env";
import { readInfolegCsv } from "../ingest/csv";
import { resolveCsv } from "../ingest/download";
import { createRegulationStore } from "../ingest/store";
import { createPoliteFetcher } from "../texts/fetcher";
import { processTexts } from "../texts/pipeline";
import { createFileCache, createTextStore, selectRegulations } from "../texts/store";
import { corpusSubset } from "./corpus";
import {
  fetchDatasetIfChanged,
  readDatasetState,
  saveDatasetState,
  type DatasetState,
} from "./dataset";
import {
  forgetVectors,
  loadSnapshots,
  regulationsWithoutText,
  unfinishedFile,
  UPDATES_DIR,
} from "./store";
import {
  describeStatus,
  latestRuns,
  recordRun,
  UPDATE_EVERY_DAYS,
  updateStatus,
  type UpdateRun,
} from "./status";
import { runUpdate, UpdateIncomplete, type UpdateReport } from "./update";

/** The table of runs comes with a migration: say so instead of failing on a missing table. */
const noRunsTable = (error: unknown): never => {
  throw new Error(
    `Could not read the past updates. If the database was set up before this command existed, run npm run db:migrate. (${error instanceof Error ? error.message : String(error)})`,
  );
};

const HELP = `
Usage: npm run update -- [options]

Brings the corpus up to date with the InfoLEG dataset, which is published
monthly. Meant to run on a schedule, for instance once a week:

  1. Downloads the dataset only if it changed since the last update.
  2. Adds the regulations that are new (every law and decree-law, and the
     decrees of the last five years) and updates the ones that changed.
  3. Downloads again the page of each regulation whose text may have changed:
     a new consolidated text, or another regulation that amends it.
  4. Embeds the new chunks, and redoes the vectors whose heading changed.

Nothing is deleted. Work an update could not finish (Ollama down, the server
refusing) is written to data/updates/unfinished.json and done by the next run.
Each run writes its report to data/updates/<date>-<time>.json.

Needs the database and Ollama, as npm run embed does.

Every run is recorded in the database, finished or not: --status and the page
say how long ago the corpus was last brought up to date.

Options:
  --check          Only say what would change; nothing is written
  --status         Say when the last update ran and when the next is due
  --if-due         Run only if the last update that finished is at least
                   --every days old; otherwise just say when it was. Meant
                   for a scheduler that runs it every day.
  --every <days>   How often an update is due (default: ${UPDATE_EVERY_DAYS})
  --file <path>    Use a local .zip or .csv instead of downloading
  --delay <ms>     Pause between page requests (default: 1000)
  --help           Show this message
`;

const nameOf = (regulation: {
  type: string;
  number?: string | null;
  enactedOn?: string | null;
}) =>
  regulationName({
    type: regulation.type,
    number: regulation.number ?? null,
    enactedOn: regulation.enactedOn ?? null,
  });

const listed = (ids: { id: number; name: string }[], max = 15) =>
  ids
    .slice(0, max)
    .map((item) => `    ${item.name} (id ${item.id})`)
    .concat(ids.length > max ? [`    … and ${ids.length - max} more`] : [])
    .join("\n");

function printReport(report: UpdateReport, check: boolean, names: Map<number, string>) {
  const named = (id: number) => names.get(id) ?? `id ${id}`;

  if (!report.dataset) {
    console.log("The dataset has not changed since the last update.");
  } else {
    const { read, rejected, inSubset, added, changed, unchanged } = report.dataset;
    console.log(
      `Dataset: ${read} rows read, ${rejected} rejected, ${inSubset} in the corpus subset.`,
    );
    console.log(
      `  ${added.length} new, ${changed.length} changed, ${unchanged} unchanged.`,
    );
    if (added.length > 0) {
      console.log(
        `\nNew:\n${listed(added.map((regulation) => ({ id: regulation.id, name: nameOf(regulation) })))}`,
      );
    }
    if (changed.length > 0) {
      console.log(
        `\nChanged:\n${listed(
          changed.map((change) => ({
            id: change.id,
            name: `${nameOf(change.after)}: ${change.fields.join(", ")}`,
          })),
        )}`,
      );
    }
  }

  const { refetch, rechunk, revector } = report.resumed;
  if (refetch.length + rechunk.length + revector.length > 0) {
    console.log(
      `\nLeft unfinished by the last update: ${[...new Set([...refetch, ...rechunk, ...revector])].map(named).join(", ")}`,
    );
  }

  if (check) {
    console.log("\nChecked only: nothing was written.");
    return;
  }

  const done = report.done!;
  const texts = (label: string, result: typeof done.newTexts) =>
    result &&
    console.log(
      `${label}: ${result.processed} processed, ${result.saved} saved, ${result.unchanged} unchanged, ${result.failed} failed.`,
    );
  console.log("");
  texts("Texts of new regulations", done.newTexts);
  texts("Pages downloaded again", done.refetched);
  texts("Texts rebuilt from the cache", done.rechunked);
  if (done.vectorsForgotten > 0) {
    console.log(`Vectors to redo: ${done.vectorsForgotten}.`);
  }
  console.log(
    done.embedded && done.embedded.total > 0
      ? `Embedded ${done.embedded.embedded} of ${done.embedded.total} pending chunks.`
      : "No chunk was waiting for a vector.",
  );
}

/** The report, without the full rows: what was added and what changed, by name. */
const forTheRecord = (report: UpdateReport, startedAt: Date) => ({
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  dataset: report.dataset && {
    ...report.dataset,
    added: report.dataset.added.map((regulation) => ({
      id: regulation.id,
      name: nameOf(regulation),
    })),
    changed: report.dataset.changed.map(({ id, after, fields }) => ({
      id,
      name: nameOf(after),
      fields,
    })),
  },
  resumed: report.resumed,
  done: report.done && {
    ...report.done,
    embedded: report.done.embedded && {
      total: report.done.embedded.total,
      embedded: report.done.embedded.embedded,
      skipped: report.done.embedded.skipped.length,
    },
  },
});

async function main() {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      status: { type: "boolean", default: false },
      "if-due": { type: "boolean", default: false },
      every: { type: "string" },
      file: { type: "string" },
      delay: { type: "string", default: "1000" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const delayMs = Number(values.delay);
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error(
      `--delay must be a whole number of milliseconds, got "${values.delay}"`,
    );
  }

  const everyDays =
    values.every === undefined ? UPDATE_EVERY_DAYS : Number(values.every);
  if (!Number.isInteger(everyDays) || everyDays < 1) {
    throw new Error(
      `--every must be a whole number of days from 1, got "${values.every}"`,
    );
  }

  const startedAt = new Date();
  const check = values.check;
  const env = getEnv();
  const sql = postgres(env.DATABASE_URL, { max: 1 });

  try {
    const db = createDb(sql);
    const status = updateStatus(await latestRuns(db).catch(noRunsTable), startedAt, {
      everyDays,
    });

    if (values.status) {
      console.log(describeStatus(status));
      return;
    }
    if (values["if-due"]) {
      console.log(describeStatus(status));
      if (!status.due) return;
      console.log("");
    }

    // Whatever happens from here on is recorded, so that the next run, the
    // status and the page know when the corpus was last brought up to date.
    const record = (run: Omit<UpdateRun, "startedAt" | "finishedAt">) =>
      check
        ? Promise.resolve()
        : recordRun(db, { startedAt, finishedAt: new Date(), ...run });

    const embedder = getEmbedder();
    let loaded: DatasetState | null = null;
    const records = async () => {
      if (values.file) {
        console.log(`Reading ${values.file}`);
        return readInfolegCsv(await resolveCsv(values.file));
      }
      console.log("Checking the InfoLEG dataset…");
      const result = await fetchDatasetIfChanged(await readDatasetState());
      if (!result.changed) return null;
      loaded = result.state;
      return readInfolegCsv(await resolveCsv(result.zipPath));
    };

    let report: UpdateReport;
    try {
      // Fail before touching anything if the model is unreachable or the wrong size.
      if (!check) {
        await embedder.embed(["prueba de conexión"]).catch((error: unknown) => {
          throw new Error(
            `The embedding model "${embedder.model}" is not reachable at ${env.OLLAMA_BASE_URL}: is Ollama running? Nothing was changed. (${error instanceof Error ? error.message : String(error)})`,
          );
        });
      }

      report = await runUpdate(
        {
          records,
          snapshots: () => loadSnapshots(db),
          upsert: (rows) => createRegulationStore(db).upsertMany(rows),
          withoutText: () => regulationsWithoutText(db),
          texts: async (ids, { refetch }) =>
            processTexts(
              await selectRegulations(db, { ids, includeDone: true }),
              {
                fetchPage: createPoliteFetcher({ delayMs }),
                cache: createFileCache(),
                store: createTextStore(db),
              },
              { refetch },
            ),
          forgetVectors: (ids) => forgetVectors(db, ids),
          embed: async () => {
            const result = await embedChunks(createEmbeddingStore(db), embedder);
            if (result.embedded > 0) await vacuumChunks(db);
            return result;
          },
          unfinished: unfinishedFile(),
          commit: async () => {
            if (loaded) await saveDatasetState(loaded);
          },
        },
        { subset: corpusSubset(startedAt), check },
      );
    } catch (error) {
      await record({
        outcome: "failed",
        datasetChanged: null,
        added: 0,
        changed: 0,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      }).catch(() => undefined);
      throw error;
    }

    await record({
      outcome: "ok",
      datasetChanged: report.dataset !== null,
      added: report.dataset?.added.length ?? 0,
      changed: report.dataset?.changed.length ?? 0,
      error: null,
    });

    const ids = [
      ...report.resumed.refetch,
      ...report.resumed.rechunk,
      ...report.resumed.revector,
    ];
    const names = new Map(
      ids.length === 0
        ? []
        : (await selectRegulations(db, { ids, includeDone: true })).map(
            (regulation) => [regulation.id, nameOf(regulation)],
          ),
    );
    printReport(report, check, names);

    if (!check) {
      await mkdir(UPDATES_DIR, { recursive: true });
      // "2026-10-27-0915.json": one file per run, in the order they ran.
      const stamp = startedAt
        .toISOString()
        .slice(0, 16)
        .replace("T", "-")
        .replace(":", "");
      const file = path.join(UPDATES_DIR, `${stamp}.json`);
      await writeFile(
        file,
        `${JSON.stringify(forTheRecord(report, startedAt), null, 2)}\n`,
      );
      console.log(`\nReport saved to ${file}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (!(error instanceof UpdateIncomplete)) {
    console.error(
      "Nothing that was left undone is lost: the next npm run update picks it up.",
    );
  }
  process.exit(1);
});
