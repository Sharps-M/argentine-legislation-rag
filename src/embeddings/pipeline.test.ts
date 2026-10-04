import { describe, expect, it } from "vitest";

import type { Embedder } from "@/ai/embedder";

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
  const pendingIds = (model: string) => ids.filter((id) => models.get(id) !== model);

  const store: EmbeddingStore = {
    pending: async (model, limit) => pendingIds(model).slice(0, limit).map(chunk),
    countPending: async (model) => pendingIds(model).length,
    save: async (model, saved) => {
      for (const { id, embedding } of saved) {
        models.set(id, model);
        vectors.set(id, embedding);
      }
    },
  };

  return { store, models, vectors };
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

    expect(report).toEqual({ model: "fake", total: 5, embedded: 5, batches: 3 });
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

  it("keeps the batches already saved when the model fails halfway", async () => {
    const { store, vectors } = memoryStore(range(6));
    let requests = 0;
    const embedder: Embedder = {
      model: "fake",
      dimensions: 2,
      embed: async (values) => {
        requests += 1;
        if (requests === 3) throw new Error("the model stopped answering");
        return values.map(() => [1, 1]);
      },
    };

    await expect(embedChunks(store, embedder, { batchSize: 2 })).rejects.toThrow(
      "the model stopped answering",
    );
    expect(vectors.size).toBe(4);
  });

  it("refuses a response with a different number of vectors", async () => {
    const { store, vectors } = memoryStore(range(2));
    const embedder: Embedder = {
      model: "fake",
      dimensions: 2,
      embed: async () => [[1, 1]],
    };

    await expect(embedChunks(store, embedder)).rejects.toThrow(
      "returned 1 vectors for 2 chunks",
    );
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
