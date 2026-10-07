import { describe, expect, it } from "vitest";

import { ChatModelError, type ChatModel, type ChatRequest } from "@/ai/chat";
import type { SearchHit, SearchOptions } from "@/search/search";

import { searchHit } from "../../tests/support/search-hits";
import { answerQuestion, type AnswerEvent } from "./answer";
import { instructionsFor } from "./prompt";

const collect = async (events: AsyncIterable<AnswerEvent>) => {
  const all: AnswerEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
};

/** A chat model that writes the given pieces, and remembers what it was asked. */
const fakeChat = (pieces: string[], failure?: ChatModelError) => {
  const requests: ChatRequest[] = [];
  const chat: ChatModel = {
    provider: "fake",
    model: "fake-model",
    async *stream(request) {
      requests.push(request);
      for (const text of pieces) yield { type: "text", text };
      if (failure) throw failure;
    },
  };

  return { chat: () => chat, requests };
};

const fakeSearch = (hits: SearchHit[]) => {
  const calls: { query: string; options: SearchOptions }[] = [];
  return {
    search: async (query: string, options: SearchOptions) => {
      calls.push({ query, options });
      return hits;
    },
    calls,
  };
};

describe("answerQuestion", () => {
  const hits = [
    searchHit({ chunkId: 1 }),
    searchHit({ chunkId: 2, label: "Artículo 5" }),
  ];

  it("sends the sources first, then the text as it is written, then how it ended", async () => {
    const { search } = fakeSearch(hits);
    const { chat } = fakeChat(["El tope es de ", "$907.934 [1]."]);

    const events = await collect(answerQuestion({ search, chat }, "¿Cuál es el tope?"));

    expect(events.map((event) => event.type)).toEqual([
      "sources",
      "text",
      "text",
      "done",
    ]);
    expect(events[0]).toMatchObject({
      sources: [
        { n: 1, title: "Decreto 832/2026 · Artículo 3" },
        { n: 2, title: "Decreto 832/2026 · Artículo 5" },
      ],
    });
    expect(events.slice(1, 3)).toEqual([
      { type: "text", text: "El tope es de " },
      { type: "text", text: "$907.934 [1]." },
    ]);
    expect(events[3]).toEqual({
      type: "done",
      outcome: "answered",
      cited: [1],
      unknownCitations: [],
      // Both sources of this test hold the same article.
      amounts: [
        { amount: "$907.934", cited: [1], foundIn: [1, 2], status: "supported" },
      ],
      provider: "fake",
      model: "fake-model",
      timings: expect.any(Object),
    });
  });

  it("gives the model the instructions, the numbered sources and the question", async () => {
    const { search } = fakeSearch(hits);
    const { chat, requests } = fakeChat(["ok [1]"]);

    await collect(answerQuestion({ search, chat }, "¿Cuál es el tope?"));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.instructions).toBe(instructionsFor("es"));
    expect(requests[0]?.prompt).toContain("[2] Decreto 832/2026 · Artículo 5");
    expect(requests[0]?.prompt).toContain("Pregunta: ¿Cuál es el tope?");
  });

  it("says which models were passed over, and names the one that wrote the answer", async () => {
    const { search } = fakeSearch(hits);
    let answering = { provider: "gemini", model: "flash" };
    const chat = (): ChatModel => ({
      get provider() {
        return answering.provider;
      },
      get model() {
        return answering.model;
      },
      // What a chain of models does when the first one has no capacity.
      async *stream() {
        yield {
          type: "skipped",
          provider: "gemini",
          model: "flash",
          reason: "overloaded",
          message: "gemini (flash) is overloaded",
        };
        answering = { provider: "ollama", model: "gemma3:4b" };
        yield { type: "text", text: "ok [1]" };
      },
    });

    const events = await collect(answerQuestion({ search, chat }, "¿?"));

    expect(events.map((event) => event.type)).toEqual([
      "sources",
      "skipped",
      "text",
      "done",
    ]);
    expect(events[1]).toEqual({
      type: "skipped",
      provider: "gemini",
      model: "flash",
      reason: "overloaded",
      message: "gemini (flash) is overloaded",
      ms: expect.any(Number),
    });
    expect(events.at(-1)).toMatchObject({
      outcome: "answered",
      provider: "ollama",
      model: "gemma3:4b",
    });
  });

  it("says where the time went: the search, each model given up on, the first word", async () => {
    // A clock the test moves by hand.
    let clock = 5_000;
    const now = () => clock;
    const search = async () => {
      clock += 400;
      return hits;
    };
    const chat = (): ChatModel => ({
      provider: "ollama",
      model: "local",
      async *stream() {
        yield { type: "asking", provider: "gemini", model: "flash" };
        clock += 600;
        yield {
          type: "skipped",
          provider: "gemini",
          model: "flash",
          reason: "overloaded",
          message: "busy",
        };
        yield { type: "asking", provider: "ollama", model: "local" };
        clock += 2_000;
        yield { type: "text", text: "ok " };
        clock += 3_000;
        yield { type: "text", text: "[1]" };
      },
    });

    const events = await collect(answerQuestion({ search, chat, now }, "¿?"));

    expect(events.map((event) => event.type)).toEqual([
      "sources",
      "asking",
      "skipped",
      "asking",
      "text",
      "text",
      "done",
    ]);
    expect(events[0]).toMatchObject({ searchMs: 400 });
    expect(events[1]).toEqual({ type: "asking", provider: "gemini", model: "flash" });
    expect(events[2]).toMatchObject({ model: "flash", ms: 600 });
    expect(events.at(-1)).toMatchObject({
      timings: { searchMs: 400, firstTextMs: 3_000, totalMs: 6_000 },
    });
  });

  it("times an answer nobody could write, with no first word", async () => {
    let clock = 0;
    const search = async () => hits;
    const chat = (): ChatModel => ({
      provider: "gemini",
      model: "flash",

      async *stream() {
        clock += 30_000;
        throw new ChatModelError("unavailable", "wrote nothing within 30 s.");
      },
    });

    const events = await collect(
      answerQuestion({ search, chat, now: () => clock }, "¿?"),
    );

    expect(events.at(-1)).toMatchObject({
      type: "error",
      timings: { searchMs: 0, firstTextMs: null, totalMs: 30_000 },
    });
  });

  it("answers in the language of the question, and tells the model in that language", async () => {
    const { search } = fakeSearch(hits);
    const { chat, requests } = fakeChat(["ok [1]"]);

    const spanish = await collect(
      answerQuestion({ search, chat }, "¿Cuál es el tope?"),
    );
    const english = await collect(
      answerQuestion({ search, chat }, "What is the cap on overtime pay?"),
    );

    expect(spanish[0]).toMatchObject({ type: "sources", language: "es" });
    expect(english[0]).toMatchObject({ type: "sources", language: "en" });
    expect(requests.map((request) => request.instructions)).toEqual([
      instructionsFor("es"),
      instructionsFor("en"),
    ]);
    expect(requests[0]?.prompt).toMatch(/Responda en español[^\n]*$/);
    expect(requests[1]?.prompt).toMatch(/Answer in English[^\n]*$/);
  });

  it("answers in the language it is told, whatever the question looks like", async () => {
    const { search, calls } = fakeSearch(hits);
    const { chat, requests } = fakeChat(["ok [1]"]);

    const events = await collect(
      answerQuestion({ search, chat }, "¿Cuál es el tope?", { language: "en" }),
    );

    expect(events[0]).toMatchObject({ language: "en" });
    expect(requests[0]?.instructions).toBe(instructionsFor("en"));
    // The language is about the answer: the search is not told.
    expect(calls[0]?.options).toEqual({ limit: 8 });
  });

  it("checks the amounts of the answer against the sources it was given", async () => {
    const { search } = fakeSearch([
      searchHit({ chunkId: 1, content: "El tope es de PESOS ($871.825)." }),
      searchHit({ chunkId: 2, content: "El tope es de PESOS ($907.934)." }),
    ]);
    // The second amount is split between two pieces, as a stream may leave it.
    const { chat } = fakeChat(["Era de $871.825 [1] y pasó a $907", ".934 [1]."]);

    const events = await collect(answerQuestion({ search, chat }, "¿Cuál es el tope?"));

    expect(events.at(-1)).toMatchObject({
      outcome: "answered",
      amounts: [
        { amount: "$871.825", cited: [1], foundIn: [1], status: "supported" },
        { amount: "$907.934", cited: [1], foundIn: [2], status: "other_source" },
      ],
    });
  });

  it("does not ask the model when the search finds nothing", async () => {
    const { search } = fakeSearch([]);
    let asked = false;
    const chat = () => {
      asked = true;
      return fakeChat([]).chat();
    };

    const events = await collect(
      answerQuestion({ search, chat }, "receta de empanadas"),
    );

    expect(asked).toBe(false);
    expect(events).toEqual([
      {
        type: "sources",
        sources: [],
        searchMs: expect.any(Number),
        language: "es",
      },
      {
        type: "done",
        outcome: "no_sources",
        cited: [],
        unknownCitations: [],
        amounts: [],
        provider: null,
        model: null,
        timings: expect.any(Object),
      },
    ]);
  });

  it("flags an answer that cites nothing", async () => {
    const { search } = fakeSearch(hits);
    const { chat } = fakeChat(["Las fuentes no tratan ese tema."]);

    const events = await collect(answerQuestion({ search, chat }, "¿?"));

    expect(events.at(-1)).toMatchObject({ outcome: "uncited", cited: [] });
  });

  it("tells an answer that says the sources do not answer, even if it lists them", async () => {
    const { search } = fakeSearch(hits);
    const { chat } = fakeChat([
      "Las fuentes no responden ",
      "la pregunta. Tratan sobre otros períodos [1, 2].",
    ]);

    const events = await collect(answerQuestion({ search, chat }, "¿?"));

    expect(events.at(-1)).toMatchObject({ outcome: "not_in_sources", cited: [1, 2] });
  });

  it("tells it when it lists no source, too", async () => {
    const { search } = fakeSearch(hits);
    const { chat } = fakeChat(["The sources do not answer the question."]);

    const events = await collect(answerQuestion({ search, chat }, "¿?"));

    expect(events.at(-1)).toMatchObject({ outcome: "not_in_sources", cited: [] });
  });

  it("reports a citation of a source that does not exist", async () => {
    const { search } = fakeSearch(hits);
    const { chat } = fakeChat(["Lo dice [2] y también ", "[7]."]);

    const events = await collect(answerQuestion({ search, chat }, "¿?"));

    expect(events.at(-1)).toMatchObject({
      outcome: "answered",
      cited: [2],
      unknownCitations: [7],
    });
  });

  it("reads a citation split between two pieces of the stream", async () => {
    const { search } = fakeSearch(hits);
    const { chat } = fakeChat(["Lo dice [", "1", "]."]);

    const events = await collect(answerQuestion({ search, chat }, "¿?"));

    expect(events.at(-1)).toMatchObject({ outcome: "answered", cited: [1] });
  });

  it("ends with an error, after the sources, when the model fails halfway", async () => {
    const { search } = fakeSearch(hits);
    const { chat } = fakeChat(
      ["El tope "],
      new ChatModelError("rate_limited", "over the limit"),
    );

    const events = await collect(answerQuestion({ search, chat }, "¿?"));

    expect(events.map((event) => event.type)).toEqual(["sources", "text", "error"]);
    expect(events.at(-1)).toEqual({
      type: "error",
      reason: "rate_limited",
      message: "over the limit",
      timings: expect.any(Object),
    });
  });

  it("ends with an error when the chat model is not configured", async () => {
    const { search } = fakeSearch(hits);
    const chat = () => {
      throw new ChatModelError("not_configured", "GEMINI_API_KEY is not set.");
    };

    const events = await collect(answerQuestion({ search, chat }, "¿?"));

    expect(events.map((event) => event.type)).toEqual(["sources", "error"]);
    expect(events.at(-1)).toMatchObject({ reason: "not_configured" });
  });

  it("lets a failure of the search through, before any event", async () => {
    const search = async () => {
      throw new Error("the embedding model is down");
    };
    const { chat } = fakeChat([]);

    await expect(collect(answerQuestion({ search, chat }, "¿?"))).rejects.toThrow(
      "the embedding model is down",
    );
  });

  it("does not hide a failure that is not the model's", async () => {
    const { search } = fakeSearch(hits);
    const chat = () => {
      throw new TypeError("a bug");
    };

    await expect(collect(answerQuestion({ search, chat }, "¿?"))).rejects.toThrow(
      "a bug",
    );
  });

  it("searches with the filters it was given, and never for more than eight chunks", async () => {
    const { search, calls } = fakeSearch(hits);
    const { chat } = fakeChat(["ok [1]"]);

    await collect(
      answerQuestion({ search, chat }, "¿?", {
        types: ["Ley"],
        yearFrom: 2024,
        limit: 20,
      }),
    );
    await collect(answerQuestion({ search, chat }, "¿?", { limit: 3 }));

    expect(calls.map((call) => call.options)).toEqual([
      { types: ["Ley"], yearFrom: 2024, limit: 8 },
      { limit: 3 },
    ]);
  });

  it("passes on the signal that stops the generation, and says nothing more once it fired", async () => {
    const { search } = fakeSearch(hits);
    const controller = new AbortController();
    const requests: ChatRequest[] = [];
    const chat = (): ChatModel => ({
      provider: "fake",
      model: "fake-model",
      async *stream(request) {
        requests.push(request);
        yield { type: "text", text: "El tope " };
        controller.abort();
      },
    });

    const events = await collect(
      answerQuestion({ search, chat }, "¿?", { signal: controller.signal }),
    );

    expect(requests[0]?.signal).toBe(controller.signal);
    expect(events.map((event) => event.type)).toEqual(["sources", "text"]);
  });
});
