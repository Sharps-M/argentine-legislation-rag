import { parseArgs } from "node:util";

import postgres from "postgres";

import { createDb } from "../db/client";
import { getEnv } from "../env";
import { createPoliteFetcher } from "./fetcher";
import { processTexts, type TextReport } from "./pipeline";
import { createFileCache, createTextStore, selectRegulations } from "./store";

const HELP = `
Usage: npm run texts -- [options]

Downloads the full text of each loaded regulation from InfoLEG, cleans it and
splits it into chunks (one per article). Regulations without a published text
get a single chunk built from their title and abstract.

Pages are cached under data/infoleg/html/, and regulations that already have a
text are skipped, so the command can be stopped and resumed at any time.

Options:
  --limit <n>       Process at most n regulations
  --ids <a,b>       Process only these regulation ids
  --delay <ms>      Pause between requests (default: 1000)
  --only-cached     Do not use the network; process cached pages only
  --refetch         Download again, ignoring the cache
  --all             Include regulations that already have a text
  --force           Re-chunk and save even when the text did not change
  --help            Show this message
`;

const positiveInteger = (name: string, value: string | undefined) => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
};

function printReport(report: TextReport) {
  console.log(`\nRegulations processed:  ${report.processed}`);
  console.log(`  downloaded:           ${report.downloaded}`);
  console.log(`  read from cache:      ${report.fromCache}`);
  console.log(`  summary only:         ${report.summaries}`);
  console.log(`Saved:                  ${report.saved} (${report.chunks} chunks)`);
  console.log(`Unchanged:              ${report.unchanged}`);
  console.log(`Failed:                 ${report.failed}`);

  if (report.failed > 0) {
    console.log("\nFailure reasons:");
    for (const [reason, total] of Object.entries(report.failureReasons)) {
      console.log(`  ${String(total).padStart(6)}  ${reason}`);
    }
    console.log("\nFirst failures:");
    for (const example of report.failedExamples) {
      console.log(`  regulation ${example.id}: ${example.reason}`);
    }
  }

  if (report.aborted) console.log(`\n${report.aborted}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      ids: { type: "string" },
      delay: { type: "string", default: "1000" },
      "only-cached": { type: "boolean", default: false },
      refetch: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const ids = values.ids
    ?.split(",")
    .map((id) => positiveInteger("ids", id.trim()))
    .filter((id): id is number => id !== undefined);

  const sql = postgres(getEnv().DATABASE_URL, { max: 1 });

  try {
    const db = createDb(sql);
    const regulations = await selectRegulations(db, {
      ids,
      includeDone: values.all || values.force || values.refetch || Boolean(ids?.length),
      limit: positiveInteger("limit", values.limit),
    });

    console.log(`Regulations to process: ${regulations.length}`);
    if (regulations.length === 0) return;

    let lastPrinted = 0;
    const report = await processTexts(
      regulations,
      {
        fetchPage: createPoliteFetcher({
          delayMs: positiveInteger("delay", values.delay),
        }),
        cache: createFileCache(),
        store: createTextStore(db),
      },
      {
        onlyCached: values["only-cached"],
        refetch: values.refetch,
        force: values.force,
        onProgress: (done, total) => {
          if (done === total || done - lastPrinted >= 50) {
            lastPrinted = done;
            console.log(`  ${done}/${total}`);
          }
        },
      },
    );

    printReport(report);
    if (report.aborted) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
