import { parseArgs } from "node:util";

import postgres from "postgres";

import { getEmbedder } from "../ai/embedder";
import { createDb } from "../db/client";
import { getEnv } from "../env";
import { regulationName } from "./input";
import { embedChunks } from "./pipeline";
import { createEmbeddingStore, resetEmbeddings, vacuumChunks } from "./store";

const HELP = `
Usage: npm run embed -- [options]

Generates the embedding of every chunk that does not have one yet, using the
local Ollama model set in EMBEDDING_MODEL (default: bge-m3).

Requires Ollama running with the model pulled:  ollama pull bge-m3

Each batch is saved as soon as it is embedded, so the command can be stopped
and resumed at any time.

A text the model cannot handle is set aside and listed at the end; the run goes
on with the rest.

Options:
  --limit <n>    Embed at most n chunks (useful for a first trial)
  --batch <n>    Chunks per request to the model (default: 32)
  --reset        Discard the stored embeddings first and embed everything again
  --help         Show this message
`;

const positiveInteger = (name: string, value: string | undefined) => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
};

async function main() {
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      batch: { type: "string" },
      reset: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const env = getEnv();
  const sql = postgres(env.DATABASE_URL, { max: 1 });

  try {
    const db = createDb(sql);
    const embedder = getEmbedder();

    console.log(`Model:   ${embedder.model} (${embedder.dimensions} dimensions)`);
    console.log(`Ollama:  ${env.OLLAMA_BASE_URL}`);

    // Fail before touching anything if the model is unreachable or the wrong size.
    await embedder.embed(["prueba de conexión"]);

    if (values.reset) {
      await resetEmbeddings(db);
      console.log("Stored embeddings discarded.");
    }

    const startedAt = Date.now();
    let lastPrinted = 0;

    const report = await embedChunks(createEmbeddingStore(db), embedder, {
      limit: positiveInteger("limit", values.limit),
      batchSize: positiveInteger("batch", values.batch),
      onProgress: (done, total) => {
        if (done === total || done - lastPrinted >= 500) {
          lastPrinted = done;
          const seconds = (Date.now() - startedAt) / 1000;
          const rate = done / Math.max(seconds, 0.001);
          const remaining = Math.round((total - done) / Math.max(rate, 0.001));
          console.log(
            `  ${done}/${total}  (${rate.toFixed(1)} chunks/s, ~${remaining}s left)`,
          );
        }
      },
    });

    if (report.embedded > 0 || values.reset) {
      await vacuumChunks(db);
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      report.total === 0
        ? "\nNothing to embed: every chunk already has a vector from this model."
        : `\nEmbedded ${report.embedded} chunks in ${report.batches} batches (${seconds}s).`,
    );

    if (report.skipped.length > 0) {
      console.log(
        `\n${report.skipped.length} chunk(s) could not be embedded and stay pending:`,
      );
      for (const { chunk, reason } of report.skipped.slice(0, 20)) {
        const where = [regulationName(chunk), chunk.label].filter(Boolean).join(" · ");
        const preview = JSON.stringify(chunk.content.slice(0, 70));
        console.log(
          `  chunk ${chunk.id}  ${where}  (${chunk.content.length} chars)  ${preview}`,
        );
        console.log(`    ${reason.slice(0, 160)}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (/ECONNREFUSED|fetch failed|Cannot connect/i.test(message)) {
    console.error(
      "\nCould not reach Ollama. Is it running?  Start it with `ollama serve` and pull the model with `ollama pull bge-m3`.",
    );
  }
  process.exit(1);
});
