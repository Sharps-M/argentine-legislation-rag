import { describe, expect, it } from "vitest";

import { EmbeddingDimensionError, type Embedder } from "@/ai/embedder";

import { embedChunks, type EmbeddingStore, type PendingChunk } from "./pipeline";

const chunk = (id: number): PendingChunk => ({
  id,
  type: "Decreto",
  number: String(id),
  enactedOn: "2026-01-01",
  topic: "TEMA",
  title: "TITULO",
  label: `Artículo ${id}`,
  content: `Contenido del fragmento ${id}.`,
});

/** In-memory store: a chunk is pending until a vector of the model is saved. */
const memoryStore = (ids: number[], embeddedWith: Record<number, string> = {}) => {
  const models = new Map<number, string>(
    Object.entries(embeddedWith).map(([id, model]) => [Number(id), model]),
  );
  const vectors = new Map<number, number[]>();
  const cursors: number[] = [];
  const pendingIds = (model: string) => ids.filter((id) => models.get(id) !== model);

  const store: EmbeddingStore = {
    pending: async (model, limit, afterId) => {
      cursors.push(afterId);
      return pendingIds(model)
        .filter((id) => id > afterId)
        .slice(0, limit)
        .map(chunk);
    },
    countPending: async (model) => pendingIds(model).length,
    save: async (model, saved) => {
      for (const { id, embedding } of saved) {
        models.set(id, model);
        vectors.set(id, embedding);
      }
    },
  };

  return { store, models, vectors, cursors };
};

const fakeEmbedder = (model = "fake") => {
  const calls: string[][] = [];
  const embedder: Embedder = {
    model,
    dimensions: 2,
    embed: async (values) => {
      calls.push(values);
      return values.map((value) => [value.length, 1]);
    },
  };

  return { embedder, calls };
};

const range = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

describe("embedChunks", () => {
  it("embeds every pending chunk, in batches", async () => {
    const { store, vectors } = memoryStore(range(5));
    const { embedder, calls } = fakeEmbedder();

    const report = await embedChunks(store, embedder, { batchSize: 2 });

    expect(report).toEqual({
      model: "fake",
      total: 5,
      embedded: 5,
      batches: 3,
      skipped: [],
    });
    expect(calls.map((call) => call.length)).toEqual([2, 2, 1]);
    expect(vectors.size).toBe(5);
  });

  it("sends the text with its regulation context, not the bare content", async () => {
    const { store } = memoryStore([7]);
    const { embedder, calls } = fakeEmbedder();

    await embedChunks(store, embedder);

    expect(calls[0]?.[0]).toBe(
      "Decreto 7/2026 · TEMA · TITULO · Artículo 7\n\nContenido del fragmento 7.",
    );
  });

  it("asks for each batch after the last chunk of the previous one", async () => {
    const { store, cursors } = memoryStore(range(5));
    const { embedder } = fakeEmbedder();

    await embedChunks(store, embedder, { batchSize: 2 });

    expect(cursors).toEqual([0, 2, 4]);
  });

  it("stops at the limit", async () => {
    const { store, vectors } = memoryStore(range(10));
    const { embedder } = fakeEmbedder();

    const report = await embedChunks(store, embedder, { batchSize: 4, limit: 6 });

    expect(report).toMatchObject({ total: 6, embedded: 6, batches: 2 });
    expect([...vectors.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("resumes: a second run only embeds what is still pending", async () => {
    const { store } = memoryStore(range(4), { 1: "fake", 2: "fake" });
    const { embedder, calls } = fakeEmbedder();

    const report = await embedChunks(store, embedder);

    expect(report).toMatchObject({ total: 2, embedded: 2 });
    expect(calls.flat()).toHaveLength(2);

    const again = await embedChunks(store, embedder);
    expect(again).toMatchObject({ total: 0, embedded: 0, batches: 0 });
  });

  it("embeds again the chunks whose vector came from another model", async () => {
    const { store, models } = memoryStore(range(3), { 1: "old", 2: "old", 3: "new" });
    const { embedder } = fakeEmbedder("new");

    const report = await embedChunks(store, embedder);

    expect(report).toMatchObject({ total: 2, embedded: 2 });
    expect([...models.values()]).toEqual(["new", "new", "new"]);
  });

  it("recovers a batch that failed once, without skipping anything", async () => {
    const { store, vectors } = memoryStore(range(4));
    let requests = 0;
    const embedder: Embedder = {
      model: "fake",
      dimensions: 2,
      embed: async (values) => {
        requests += 1;
        // The model crashes once, on the first batch, and then comes back.
        if (requests === 1) throw new Error("do embedding request: EOF");
        return values.map(() => [1, 1]);
      },
    };

    const report = await embedChunks(store, embedder, {
      batchSize: 4,
      retryDelayMs: 0,
    });

    expect(report).toMatchObject({ embedded: 4, skipped: [] });
    expect(vectors.size).toBe(4);
  });

  it("sets aside a text the model cannot handle and goes on with the rest", async () => {
    const { store, vectors } = memoryStore(range(6));
    const embedder: Embedder = {
      model: "fake",
      dimensions: 2,
      embed: async (values) => {
        // Any request that includes the fourth chunk fails, alone or in a batch.
        if (values.some((value) => value.includes("fragmento 4."))) {
          throw new Error("do embedding request: EOF");
        }
        return values.map(() => [1, 1]);
      },
    };

    const report = await embedChunks(store, embedder, {
      batchSize: 3,
      retryDelayMs: 0,
    });

    expect(report).toMatchObject({ total: 6, embedded: 5, batches: 2 });
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({
      chunk: { id: 4 },
      reason: "do embedding request: EOF",
    });
    expect([...vectors.keys()]).toEqual([1, 2, 3, 5, 6]);
  });

  it("stops when the model fails on one chunk after another", async () => {
    const { store, vectors } = memoryStore(range(20));
    let requests = 0;
    const embedder: Embedder = {
      model: "fake",
      dimensions: 2,
      embed: async (values) => {
        requests += 1;
        // The first batch works; then the model stops answering.
        if (requests > 1) throw new Error("the model stopped answering");
        return values.map(() => [1, 1]);
      },
    };

    await expect(
      embedChunks(store, embedder, {
        batchSize: 4,
        maxConsecutiveFailures: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/failed on 3 chunks in a row.*the model stopped answering/);
    // What was saved before stays saved.
    expect(vectors.size).toBe(4);
  });

  it("does not retry text by text when the vectors have the wrong size", async () => {
    const { store } = memoryStore(range(4));
    let requests = 0;
    const embedder: Embedder = {
      model: "fake",
      dimensions: 2,
      embed: async () => {
        requests += 1;
        throw new EmbeddingDimensionError("fake", 2, 3);
      },
    };

    await expect(embedChunks(store, embedder)).rejects.toThrow(EmbeddingDimensionError);
    expect(requests).toBe(1);
  });

  it("does not save a response with a different number of vectors", async () => {
    const { store, vectors } = memoryStore(range(2));
    const embedder: Embedder = {
      model: "fake",
      dimensions: 2,
      // One vector for two texts, and none for one: never the right count.
      embed: async (values) => (values.length === 2 ? [[1, 1]] : []),
    };

    const report = await embedChunks(store, embedder, { retryDelayMs: 0 });

    expect(report.embedded).toBe(0);
    expect(report.skipped.map((item) => item.reason)).toEqual([
      "The model returned 0 vectors for 1 chunks.",
      "The model returned 0 vectors for 1 chunks.",
    ]);
    expect(vectors.size).toBe(0);
  });

  it("reports progress after every batch", async () => {
    const { store } = memoryStore(range(5));
    const { embedder } = fakeEmbedder();
    const progress: [number, number][] = [];

    await embedChunks(store, embedder, {
      batchSize: 2,
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(progress).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
  });
});
