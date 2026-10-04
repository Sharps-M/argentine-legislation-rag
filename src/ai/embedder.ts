import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embedMany } from "ai";

import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import { getEnv } from "@/env";

/**
 * Turns texts into vectors. The rest of the code depends on this interface
 * only, so the provider (local Ollama today) can be swapped without touching
 * the ingestion or the search.
 */
export type Embedder = {
  /** Model name, stored next to each vector: vectors of different models never mix. */
  readonly model: string;
  readonly dimensions: number;
  /** Returns one vector per value, in the same order. */
  embed: (values: string[]) => Promise<number[][]>;
};

export class EmbeddingDimensionError extends Error {
  constructor(model: string, expected: number, received: number) {
    super(
      `Embedding model "${model}" returned ${received} dimensions, but the database column holds ${expected}. ` +
        "Use a model with that size, or change EMBEDDING_DIMENSIONS and re-embed everything.",
    );
    this.name = "EmbeddingDimensionError";
  }
}

export type OllamaEmbedderOptions = {
  baseUrl: string;
  model: string;
  dimensions?: number;
  maxRetries?: number;
};

/**
 * Embedder backed by a local Ollama server, through its OpenAI-compatible
 * endpoint (`/v1/embeddings`) and the AI SDK.
 */
export function createOllamaEmbedder(options: OllamaEmbedderOptions): Embedder {
  const { model, dimensions = EMBEDDING_DIMENSIONS, maxRetries = 2 } = options;

  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: `${options.baseUrl.replace(/\/+$/, "")}/v1`,
  });
  const embeddingModel = ollama.embeddingModel(model);

  return {
    model,
    dimensions,
    async embed(values) {
      if (values.length === 0) return [];

      const { embeddings } = await embedMany({
        model: embeddingModel,
        values,
        maxRetries,
      });

      for (const embedding of embeddings) {
        if (embedding.length !== dimensions) {
          throw new EmbeddingDimensionError(model, dimensions, embedding.length);
        }
      }

      return embeddings;
    },
  };
}

/** The embedder configured through the environment. */
export const getEmbedder = (): Embedder =>
  createOllamaEmbedder({
    baseUrl: getEnv().OLLAMA_BASE_URL,
    model: getEnv().EMBEDDING_MODEL,
  });
