import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatModelError, type ChatModel } from "@/ai/chat";
import {
  QueryEmbeddingError,
  type SearchHit,
  type SearchOptions,
} from "@/search/search";

import { searchHit } from "../../tests/support/search-hits";
import { answerResponse, formatEvent } from "./http";

const params = (query: string) => new URLSearchParams(query);

const chatWriting = (pieces: string[], failure?: Error) => (): ChatModel => ({
  provider: "fake",
  model: "fake-model",
  async *stream() {
    for (const text of pieces) yield { type: "text", text };
    if (failure) throw failure;
  },
});

const searchFinding =
  (hits: SearchHit[], calls: SearchOptions[] = []) =>
  async (_query: string, options: SearchOptions) => {
    calls.push(options);
    return hits;
  };

/** The events of a server-sent stream, as `[event, data]` pairs. */
const eventsOf = async (response: Response) =>
  (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      return [
        eventLine?.replace(/^event: /, ""),
        JSON.parse(dataLine?.replace(/^data: /, "") ?? "null") as Record<
          string,
          unknown
        >,
      ] as const;
    });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatEvent", () => {
  it("writes the type as the event name and the rest as JSON data", () => {
    expect(formatEvent({ type: "text", text: "Hola\n[1]" })).toBe(
      'event: text\ndata: {"text":"Hola\\n[1]"}\n\n',
    );
  });
});

describe("answerResponse", () => {
  it("streams the sources, the text and the outcome as server-sent events", async () => {
    const response = await answerResponse(params("q=tope de servicios"), {
      search: searchFinding([searchHit()]),
      chat: chatWriting(["El tope es ", "$907.934 [1]."]),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toContain("no-cache");

    const events = await eventsOf(response);
    expect(events.map(([name]) => name)).toEqual(["sources", "text", "text", "done"]);
    expect(events[0]?.[1]).toMatchObject({
      sources: [{ n: 1, title: "Decreto 832/2026 · Artículo 3" }],
    });
    expect(events[1]?.[1]).toEqual({ text: "El tope es " });
    expect(events[3]?.[1]).toEqual({
      outcome: "answered",
      cited: [1],
      unknownCitations: [],
      amounts: [{ amount: "$907.934", cited: [1], foundIn: [1], status: "supported" }],
      provider: "fake",
      model: "fake-model",
      timings: {
        searchMs: expect.any(Number),
        firstTextMs: expect.any(Number),
        totalMs: expect.any(Number),
      },
    });
  });

  it("takes the same filters as the search", async () => {
    const calls: SearchOptions[] = [];

    await (
      await answerResponse(params("q=tope de servicios&type=Decreto&from=2026"), {
        search: searchFinding([], calls),
        chat: chatWriting([]),
      })
    ).text();

    expect(calls).toEqual([{ limit: 8, types: ["Decreto"], yearFrom: 2026 }]);
  });

  it("answers in the language asked for with lang, or guesses it from the question", async () => {
    const languageOf = async (query: string) => {
      const response = await answerResponse(params(query), {
        search: searchFinding([]),
        chat: chatWriting([]),
      });
      return (await eventsOf(response))[0]?.[1].language;
    };

    expect(await languageOf("q=tope de servicios extraordinarios&lang=en")).toBe("en");
    expect(await languageOf("q=tope de servicios extraordinarios")).toBe("es");
    expect(await languageOf("q=what is the cap on overtime pay&lang=")).toBe("en");
  });

  it("answers 400 to a language the site does not speak, with every other problem", async () => {
    const response = await answerResponse(params("q=ab&lang=pt"), {
      search: searchFinding([]),
      chat: chatWriting([]),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      issues: [{ field: "q" }, { field: "lang" }],
    });
  });

  it("answers 400 to an invalid request, without searching", async () => {
    const calls: SearchOptions[] = [];
    const response = await answerResponse(params("q=ab&from=1500"), {
      search: searchFinding([], calls),
      chat: chatWriting([]),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      issues: [{ field: "q" }, { field: "from" }],
    });
    expect(calls).toEqual([]);
  });

  it("answers 503 when the question cannot be embedded: nothing was streamed yet", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await answerResponse(params("q=tope de servicios"), {
      search: async () => {
        throw new QueryEmbeddingError("bge-m3", new Error("connection refused"));
      },
      chat: chatWriting([]),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "embeddings_unavailable" });
  });

  it("answers 200 with the sources and an error event when the chat model fails", async () => {
    const response = await answerResponse(params("q=tope de servicios"), {
      search: searchFinding([searchHit()]),
      chat: chatWriting([], new ChatModelError("unauthorized", "bad key")),
    });

    expect(response.status).toBe(200);
    const events = await eventsOf(response);
    expect(events.map(([name]) => name)).toEqual(["sources", "error"]);
    expect(events[1]?.[1]).toMatchObject({
      reason: "unauthorized",
      message: "bad key",
    });
  });

  it("stops the model when the reader closes the stream", async () => {
    let stopped = false;
    const response = await answerResponse(params("q=tope de servicios"), {
      search: searchFinding([searchHit()]),
      chat: (): ChatModel => ({
        provider: "fake",
        model: "fake-model",
        async *stream() {
          try {
            for (;;) yield { type: "text", text: "más " };
          } finally {
            // Runs when the generation is abandoned, not when it is merely idle.
            stopped = true;
          }
        },
      }),
    });

    const reader = response.body!.getReader();
    await reader.read(); // sources
    await reader.read(); // first piece
    expect(stopped).toBe(false);

    await reader.cancel();

    expect(stopped).toBe(true);
  });
});
