import { parseArgs } from "node:util";

import postgres from "postgres";

import { getEmbedder } from "../ai/embedder";
import { createDb } from "../db/client";
import { getEnv } from "../env";
import { parseSearchParams } from "./params";
import {
  DEFAULT_MIN_SIMILARITY,
  DEFAULT_VERSION_LINKAGE,
  DEFAULT_VERSION_SIMILARITY,
  QueryEmbeddingError,
  searchChunks,
} from "./search";

const HELP = `
Usage: npm run search -- "<question>" [options]

Prints the chunks that answer the question, best first: those of a regulation
cited by number, and those close enough in meaning. When nothing is close
enough it says so instead of showing unrelated regulations.
Requires the embeddings to be generated first (npm run embed).

Options:
  --limit <n>     How many chunks to show (default: 8, max: 20)
  --type <type>   Keep only this regulation type; repeat for several (Ley, Decreto)
  --from <year>   Keep regulations enacted in this year or later
  --to <year>     Keep regulations enacted in this year or earlier
  --min-similarity <0-1>
                  How close a chunk must be to count (default: ${DEFAULT_MIN_SIMILARITY});
                  0 shows the nearest chunks however far they are
  --versions <0-1|off>
                  List together the chunks of different regulations whose texts
                  are this similar, newest first (default: ${DEFAULT_VERSION_SIMILARITY ?? "off"});
                  "off" lists every chunk on its own
  --versions-link <best|chain>
                  Compare each chunk with the best one of its group, or with any
                  of its members (default: ${DEFAULT_VERSION_LINKAGE})
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
      "min-similarity": { type: "string" },
      versions: { type: "string" },
      "versions-link": { type: "string" },
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
  if (values["min-similarity"]) params.set("min_similarity", values["min-similarity"]);
  if (values.versions) params.set("versions", values.versions);
  for (const type of values.type ?? []) params.append("type", type);

  const request = parseSearchParams(params);
  if (!request.ok) {
    for (const issue of request.issues)
      console.error(`${issue.field}: ${issue.message}`);
    process.exitCode = 1;
    return;
  }

  const versionLinkage = values["versions-link"];
  if (
    versionLinkage !== undefined &&
    versionLinkage !== "best" &&
    versionLinkage !== "chain"
  ) {
    console.error(`--versions-link must be "best" or "chain", got "${versionLinkage}"`);
    process.exitCode = 1;
    return;
  }

  const sql = postgres(getEnv().DATABASE_URL, { max: 1 });

  try {
    const db = createDb(sql);
    const embedder = getEmbedder();
    const hits = await searchChunks(db, embedder, request.query, {
      ...request.options,
      ...(versionLinkage !== undefined && { versionLinkage }),
    });

    if (values.json) {
      console.log(JSON.stringify(hits, null, 2));
      return;
    }

    if (hits.length === 0) {
      const required = request.options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
      const [nearest] = await searchChunks(db, embedder, request.query, {
        ...request.options,
        limit: 1,
        minSimilarity: 0,
      });

      console.log(
        nearest
          ? `No regulation is close enough to the question: the nearest chunk scores ${nearest.similarity.toFixed(3)} (${nearest.regulation.name}) and ${required} is required.\nUse --min-similarity 0 to see the nearest ones anyway.`
          : "No results. Have the embeddings been generated? (npm run embed)",
      );
      return;
    }

    hits.forEach((hit, index) => {
      const { regulation } = hit;
      const where = [regulation.name, hit.label].filter(Boolean).join(" · ");
      const summaryOnly =
        regulation.textSource === "summary" ? "  [abstract only]" : "";
      const cited = hit.match === "reference" ? "  [cited by number]" : "";

      console.log(
        `\n${String(index + 1).padStart(2)}. ${hit.similarity.toFixed(3)}  ${where}${cited}${summaryOnly}`,
      );
      if (regulation.title) console.log(`    ${snippet(regulation.title, 100)}`);
      console.log(`    ${snippet(hit.content)}`);
      console.log(`    ${regulation.url}`);
      if (hit.earlierVersions.length > 0) {
        const names = hit.earlierVersions.map((version) => version.name);
        console.log(
          `    + ${names.length} earlier with nearly the same text: ${names.slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""}`,
        );
      }
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
