import type { Embedder } from "@/ai/embedder";

import { embeddingInput, type EmbeddingContext } from "./input";

export type PendingChunk = EmbeddingContext & { id: number };

export type EmbeddingStore = {
  /** Chunks without a vector from this model, lowest id first. */
  pending: (model: string, limit: number) => Promise<PendingChunk[]>;
  countPending: (model: string) => Promise<number>;
  save: (
    model: string,
    vectors: { id: number; embedding: number[] }[],
  ) => Promise<void>;
};

export type EmbedOptions = {
  /** Chunks sent to the model per request. */
  batchSize?: number;
  /** Stop after this many chunks. */
  limit?: number;
  onProgress?: (done: number, total: number) => void;
};

export type EmbedReport = {
  model: string;
  total: number;
  embedded: number;
  batches: number;
};

/**
 * Embeds every chunk that has no vector from the current model.
 *
 * Each batch is saved before the next one starts, so the command can be
 * interrupted at any point and resumed without losing work.
 */
export async function embedChunks(
  store: EmbeddingStore,
  embedder: Embedder,
  options: EmbedOptions = {},
): Promise<EmbedReport> {
  const batchSize = options.batchSize ?? 32;
  const pendingTotal = await store.countPending(embedder.model);
  const total = Math.min(pendingTotal, options.limit ?? pendingTotal);

  const report: EmbedReport = { model: embedder.model, total, embedded: 0, batches: 0 };

  while (report.embedded < total) {
    const chunks = await store.pending(
      embedder.model,
      Math.min(batchSize, total - report.embedded),
    );
    if (chunks.length === 0) break;

    const embeddings = await embedder.embed(chunks.map(embeddingInput));
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `The model returned ${embeddings.length} vectors for ${chunks.length} chunks.`,
      );
    }

    await store.save(
      embedder.model,
      chunks.map((chunk, index) => ({ id: chunk.id, embedding: embeddings[index]! })),
    );

    report.embedded += chunks.length;
    report.batches += 1;
    options.onProgress?.(report.embedded, total);
  }

  return report;
}
