import { afterEach, describe, expect, it, vi } from "vitest";

import { searchResponse, type SearchFn } from "./http";
import { QueryEmbeddingError, type SearchHit, type SearchOptions } from "./search";

const hit: SearchHit = {
  chunkId: 1,
  match: "semantic",
  similarity: 0.87,
  section: "article",
  label: "Artículo 1",
  content: "Apruébase el convenio.",
  earlierVersions: [],
  regulation: {
    id: 427766,
    type: "Ley",
    number: "27817",
    name: "Ley 27817",
    title: "APROBACION",
    topic: "CONVENIOS",
    enactedOn: "2026-06-24",
    textSource: "original",
    url: "http://example.test/norma.htm",
  },
};

const params = (query: string) => new URLSearchParams(query);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("searchResponse", () => {
  it("returns the results with the question and the model", async () => {
    const calls: [string, SearchOptions][] = [];
    const search: SearchFn = async (query, options) => {
      calls.push([query, options]);
      return [hit];
    };

    const response = await searchResponse(
      params("q=seguridad social&type=Ley&limit=3"),
      search,
      "bge-m3",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      query: "seguridad social",
      model: "bge-m3",
      minSimilarity: 0.55,
      versionSimilarity: 0.95,
      results: [hit],
    });
    expect(calls).toEqual([["seguridad social", { limit: 3, types: ["Ley"] }]]);
  });

  it("passes on a request to list every chunk on its own, and says so", async () => {
    const calls: SearchOptions[] = [];
    const search: SearchFn = async (_query, options) => {
      calls.push(options);
      return [];
    };

    const response = await searchResponse(
      params("q=seguridad social&versions=off"),
      search,
      "bge-m3",
    );

    expect(await response.json()).toMatchObject({ versionSimilarity: null });
    expect(calls).toEqual([{ limit: 8, versionSimilarity: null }]);
  });

  it("answers 200 with an empty list when nothing is close enough", async () => {
    const calls: SearchOptions[] = [];
    const search: SearchFn = async (_query, options) => {
      calls.push(options);
      return [];
    };

    const response = await searchResponse(
      params("q=mascotas&min_similarity=0.6"),
      search,
      "bge-m3",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ minSimilarity: 0.6, results: [] });
    expect(calls).toEqual([{ limit: 8, minSimilarity: 0.6 }]);
  });

  it("answers 400 and does not search when the request is invalid", async () => {
    let searched = false;
    const search: SearchFn = async () => {
      searched = true;
      return [];
    };

    const response = await searchResponse(params("q=ab&limit=99"), search, "bge-m3");

    expect(response.status).toBe(400);
    expect(searched).toBe(false);

    const body = (await response.json()) as {
      error: string;
      issues: { field: string }[];
    };
    expect(body.error).toBe("invalid_request");
    expect(body.issues.map((issue) => issue.field).sort()).toEqual(["limit", "q"]);
  });

  it("answers 503 when the embedding model cannot be reached", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const search: SearchFn = async () => {
      throw new QueryEmbeddingError("bge-m3", new Error("connect ECONNREFUSED"));
    };

    const response = await searchResponse(params("q=combustibles"), search, "bge-m3");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "embeddings_unavailable" });
    expect(logged).toHaveBeenCalled();
  });

  it("does not hide other errors", async () => {
    const search: SearchFn = async () => {
      throw new Error("connection to the database lost");
    };

    await expect(
      searchResponse(params("q=combustibles"), search, "bge-m3"),
    ).rejects.toThrow("connection to the database lost");
  });
});
