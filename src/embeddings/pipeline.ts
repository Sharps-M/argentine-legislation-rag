import { EmbeddingDimensionError, type Embedder } from "@/ai/embedder";

import { embeddingInput, type EmbeddingContext } from "./input";

export type PendingChunk = EmbeddingContext & { id: number };

export type EmbeddingStore = {
  /**
   * Chunks without a vector from this model, lowest id first. `afterId` is the
   * last chunk already taken: each batch starts where the previous one ended,
   * instead of walking past everything embedded so far.
   */
  pending: (model: string, limit: number, afterId: number) => Promise<PendingChunk[]>;
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
  /**
   * Give up after this many chunks in a row fail on their own: by then the
   * problem is the model, not the texts.
   */
  maxConsecutiveFailures?: number;
  /** Pause before retrying one by one, so a crashed model can come back. */
  retryDelayMs?: number;
  onProgress?: (done: number, total: number) => void;
};

export type SkippedChunk = { chunk: PendingChunk; reason: string };

export type EmbedReport = {
  model: string;
  total: number;
  embedded: number;
  batches: number;
  /** Chunks the model could not embed. They stay pending. */
  skipped: SkippedChunk[];
};

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Embeds every chunk that has no vector from the current model.
 *
 * Each batch is saved before the next one starts, so the command can be
 * interrupted at any point and resumed without losing work.
 *
 * When a batch fails, its chunks are tried one by one: a single text the model
 * cannot handle is set aside and reported, instead of stopping a run of
 * hours. If chunk after chunk fails, the model itself is down and the run
 * stops.
 */
export async function embedChunks(
  store: EmbeddingStore,
  embedder: Embedder,
  options: EmbedOptions = {},
): Promise<EmbedReport> {
  const batchSize = options.batchSize ?? 32;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const pendingTotal = await store.countPending(embedder.model);
  const total = Math.min(pendingTotal, options.limit ?? pendingTotal);

  const report: EmbedReport = {
    model: embedder.model,
    total,
    embedded: 0,
    batches: 0,
    skipped: [],
  };

  const embedAndSave = async (chunks: PendingChunk[]) => {
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
  };

  let lastId = 0;
  let consecutiveFailures = 0;
  const done = () => report.embedded + report.skipped.length;

  while (done() < total) {
    const chunks = await store.pending(
      embedder.model,
      Math.min(batchSize, total - done()),
      lastId,
    );
    if (chunks.length === 0) break;
    lastId = chunks[chunks.length - 1]!.id;

    try {
      await embedAndSave(chunks);
      consecutiveFailures = 0;
    } catch (batchError) {
      // A model with the wrong vector size fails on every text: no point retrying.
      if (batchError instanceof EmbeddingDimensionError) throw batchError;
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }

      for (const chunk of chunks) {
        try {
          await embedAndSave([chunk]);
          consecutiveFailures = 0;
        } catch (error) {
          if (error instanceof EmbeddingDimensionError) throw error;

          report.skipped.push({ chunk, reason: reasonOf(error) });
          consecutiveFailures += 1;

          if (consecutiveFailures >= maxConsecutiveFailures) {
            throw new Error(
              `The model failed on ${consecutiveFailures} chunks in a row; stopping. Last error: ${reasonOf(error)}`,
              { cause: error },
            );
          }
        }
      }
    }

    report.batches += 1;
    options.onProgress?.(done(), total);
  }

  return report;
}
