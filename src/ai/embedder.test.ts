import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createOllamaEmbedder, EmbeddingDimensionError } from "./embedder";

type EmbeddingRequest = { model: string; input: string[] };

// A stand-in for Ollama's OpenAI-compatible endpoint.
let server: Server;
let baseUrl: string;
let requests: { url: string; body: EmbeddingRequest }[];
let dimensions: number;
let failures: number;

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (part) => (raw += part));
    request.on("end", () => {
      const body = JSON.parse(raw) as EmbeddingRequest;
      requests.push({ url: request.url ?? "", body });

      if (failures > 0) {
        failures -= 1;
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "model is loading" } }));
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          model: body.model,
          data: body.input.map((text, index) => ({
            object: "embedding",
            index,
            // First position tells the texts apart; the rest is padding.
            embedding: [text.length, ...new Array<number>(dimensions - 1).fill(0)],
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  requests = [];
  dimensions = 4;
  failures = 0;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("createOllamaEmbedder", () => {
  it("calls the OpenAI-compatible endpoint and returns one vector per text", async () => {
    const embedder = createOllamaEmbedder({ baseUrl, model: "bge-m3", dimensions: 4 });

    const vectors = await embedder.embed(["uno", "cuatro"]);

    expect(vectors).toEqual([
      [3, 0, 0, 0],
      [6, 0, 0, 0],
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/v1/embeddings");
    expect(requests[0]?.body).toMatchObject({
      model: "bge-m3",
      input: ["uno", "cuatro"],
    });
  });

  it("accepts a base URL with a trailing slash", async () => {
    const embedder = createOllamaEmbedder({
      baseUrl: `${baseUrl}/`,
      model: "bge-m3",
      dimensions: 4,
    });

    await embedder.embed(["uno"]);

    expect(requests[0]?.url).toBe("/v1/embeddings");
  });

  it("does not call the model for an empty list", async () => {
    const embedder = createOllamaEmbedder({ baseUrl, model: "bge-m3", dimensions: 4 });

    expect(await embedder.embed([])).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("exposes the model and the size of its vectors", () => {
    const embedder = createOllamaEmbedder({ baseUrl, model: "bge-m3" });

    expect(embedder.model).toBe("bge-m3");
    expect(embedder.dimensions).toBe(1024);
  });

  it("rejects vectors that do not fit the database column", async () => {
    dimensions = 3;
    const embedder = createOllamaEmbedder({ baseUrl, model: "other", dimensions: 4 });

    await expect(embedder.embed(["uno"])).rejects.toThrow(EmbeddingDimensionError);
    await expect(embedder.embed(["uno"])).rejects.toThrow(
      /"other" returned 3 dimensions, but the database column holds 4/,
    );
  });

  it("retries when the server answers with a temporary error", async () => {
    failures = 1;
    const embedder = createOllamaEmbedder({ baseUrl, model: "bge-m3", dimensions: 4 });

    expect(await embedder.embed(["uno"])).toEqual([[3, 0, 0, 0]]);
    expect(requests).toHaveLength(2);
  });

  it("fails when nothing listens at the address", async () => {
    const embedder = createOllamaEmbedder({
      baseUrl: "http://127.0.0.1:9",
      model: "bge-m3",
      maxRetries: 0,
    });

    await expect(embedder.embed(["uno"])).rejects.toThrow();
  });
});
