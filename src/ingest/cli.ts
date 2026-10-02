import { parseArgs } from "node:util";

import postgres from "postgres";

import { createDb } from "../db/client";
import { getEnv } from "../env";
import { readInfolegCsv } from "./csv";
import { downloadDataset, resolveCsv } from "./download";
import { ingestRegulations, type IngestReport } from "./ingest";
import { createRegulationStore } from "./store";
import { yearsAgo } from "./subset";

const HELP = `
Usage: npm run ingest -- [options]

Loads regulations from the InfoLEG open dataset into PostgreSQL.

Source (pick one):
  --download            Download the full dataset (ZIP) into data/infoleg/
  --file <path>         Use a local .csv or .zip file

Subset:
  --types <a,b>         Regulation types to keep (default: Ley,Decreto)
  --all-types           Keep every regulation type
  --since <YYYY-MM-DD>  Keep regulations enacted on or after this date
                        (default: five years ago)
  --all-dates           Do not filter by date
  --limit <n>           Stop after n selected regulations

Other:
  --dry-run             Validate and report only; do not touch the database
  --help                Show this message
`;

const sortedEntries = (counter: Record<string, number>, by: "key" | "count") =>
  Object.entries(counter).sort(([keyA, countA], [keyB, countB]) =>
    by === "key" ? keyA.localeCompare(keyB) : countB - countA,
  );

function printReport(report: IngestReport, dryRun: boolean) {
  console.log(`\nRows read:        ${report.read}`);
  console.log(`Rejected:         ${report.rejected}`);
  console.log(`Outside subset:   ${report.filteredOut}`);
  console.log(`${dryRun ? "Would load:  " : "Loaded:      "}     ${report.selected}`);

  if (report.selected > 0) {
    console.log("\nBy type:");
    for (const [type, total] of sortedEntries(report.byType, "count")) {
      console.log(`  ${String(total).padStart(8)}  ${type}`);
    }

    console.log("\nBy year:");
    for (const [year, total] of sortedEntries(report.byYear, "key")) {
      console.log(`  ${String(total).padStart(8)}  ${year}`);
    }
  }

  if (report.rejected > 0) {
    console.log("\nRejection reasons:");
    for (const [reason, total] of sortedEntries(report.rejectionReasons, "count")) {
      console.log(`  ${String(total).padStart(8)}  ${reason}`);
    }

    console.log("\nFirst rejected rows:");
    for (const example of report.rejectedExamples) {
      console.log(
        `  line ${example.line} (id ${example.id || "?"}): ${example.reasons.join("; ")}`,
      );
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      download: { type: "boolean", default: false },
      file: { type: "string" },
      types: { type: "string", default: "Ley,Decreto" },
      "all-types": { type: "boolean", default: false },
      since: { type: "string" },
      "all-dates": { type: "boolean", default: false },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help || (!values.download && !values.file)) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const since = values["all-dates"] ? null : (values.since ?? yearsAgo(5));
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error(`--since must be YYYY-MM-DD, got "${since}"`);
  }

  const limit =
    values.limit === undefined ? undefined : Number.parseInt(values.limit, 10);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive integer, got "${values.limit}"`);
  }

  const types = values["all-types"]
    ? []
    : values.types
        .split(",")
        .map((type) => type.trim())
        .filter(Boolean);

  let source = values.file;
  if (values.download) {
    console.log("Downloading the InfoLEG dataset...");
    source = await downloadDataset();
    console.log(`Saved to ${source}`);
  }

  const csvPath = await resolveCsv(source!);
  const dryRun = values["dry-run"];

  console.log(`Source:  ${csvPath}`);
  console.log(`Types:   ${types.length > 0 ? types.join(", ") : "all"}`);
  console.log(`Since:   ${since ?? "all dates"}`);
  if (dryRun) console.log("Dry run: the database will not be modified.");

  const sql = dryRun ? null : postgres(getEnv().DATABASE_URL, { max: 1 });

  try {
    const store = sql ? createRegulationStore(createDb(sql)) : null;
    const report = await ingestRegulations(readInfolegCsv(csvPath), store, {
      filter: { types, since },
      limit,
    });

    printReport(report, dryRun);
  } finally {
    await sql?.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
