import { parseArgs } from "node:util";

import postgres from "postgres";

import { getEmbedder } from "../ai/embedder";
import { createDb } from "../db/client";
import { getEnv } from "../env";
import { parseSearchParams } from "./params";
import { QueryEmbeddingError, searchChunks } from "./search";

const HELP = `
Usage: npm run search -- "<question>" [options]

Prints the chunks closest in meaning to the question, best first.
Requires the embeddings to be generated first (npm run embed).

Options:
  --limit <n>     How many chunks to show (default: 8, max: 20)
  --type <type>   Keep only this regulation type; repeat for several (Ley, Decreto)
  --from <year>   Keep regulations enacted in this year or later
  --to <year>     Keep regulations enacted in this year or earlier
  --json          Print the results as JSON
  --help          Show this message

Examples:
  npm run search -- "convenio de seguridad social con San Marino"
  npm run search -- "impuesto a los combustibles" --type Decreto --from 2026
`;

const snippet = (text: string, length = 220) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length)}…` : line;
};

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: "string" },
      type: { type: "string", multiple: true },
      from: { type: "string" },
      to: { type: "string" },
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
  if (values.limit) params.set("limit", values.limit);
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

  const sql = postgres(getEnv().DATABASE_URL, { max: 1 });

  try {
    const hits = await searchChunks(
      createDb(sql),
      getEmbedder(),
      request.query,
      request.options,
    );

    if (values.json) {
      console.log(JSON.stringify(hits, null, 2));
      return;
    }

    if (hits.length === 0) {
      console.log("No results. Have the embeddings been generated? (npm run embed)");
      return;
    }

    hits.forEach((hit, index) => {
      const { regulation } = hit;
      const where = [regulation.name, hit.label].filter(Boolean).join(" · ");
      const summaryOnly =
        regulation.textSource === "summary" ? "  [abstract only]" : "";

      console.log(
        `\n${String(index + 1).padStart(2)}. ${hit.similarity.toFixed(3)}  ${where}${summaryOnly}`,
      );
      if (regulation.title) console.log(`    ${snippet(regulation.title, 100)}`);
      console.log(`    ${snippet(hit.content)}`);
      console.log(`    ${regulation.url}`);
    });
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
