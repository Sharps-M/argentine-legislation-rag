import { describe, expect, it } from "vitest";

import { ChatModelError, type ChatModel, type ChatRequest } from "@/ai/chat";
import {
  QueryEmbeddingError,
  type SearchHit,
  type SearchOptions,
} from "@/search/search";

import { searchHit } from "../../tests/support/search-hits";
import { answerQuestion, type AnswerEvent } from "./answer";
import { instructionsFor } from "./prompt";
import { REWRITE_INSTRUCTIONS } from "./rewrite";

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

  it("passes on that a model was not asked because it is resting", async () => {
    const { search } = fakeSearch(hits);
    const chat: ChatModel = {
      provider: "fake",
      model: "local",
      async *stream() {
        yield {
          type: "skipped",
          provider: "gemini",
          model: "busy",
          reason: "overloaded",
          message: "gemini (busy) failed 5 s ago",
          resting: true,
        };
        yield { type: "text", text: "Sí [1]." };
      },
    };

    const events = await collect(answerQuestion({ search, chat: () => chat }, "¿?"));

    expect(events.find((event) => event.type === "skipped")).toMatchObject({
      model: "busy",
      resting: true,
    });
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

describe("answerQuestion, when the sources do not answer", () => {
  const first = [searchHit({ chunkId: 1 }), searchHit({ chunkId: 2 })];
  const better = [
    searchHit({
      chunkId: 7,
      label: "Artículo 1",
      content: "Será reprimido el que infligiere malos tratos a los animales.",
      regulation: { ...searchHit().regulation, id: 153011, name: "Ley 14346" },
    }),
  ];
  const DECLINE =
    "Las fuentes no responden la pregunta. Tratan sobre otros temas [1, 2].";
  const REWRITE = "maltrato y crueldad hacia los animales domésticos, perros y gatos";

  /** A chat model that writes one of the given texts per request, in order. */
  const scriptedChat = (...replies: (string[] | Error)[]) => {
    const requests: ChatRequest[] = [];
    const chat: ChatModel = {
      provider: "fake",
      model: "fake-model",
      async *stream(request) {
        const reply = replies[requests.length];
        requests.push(request);
        if (reply instanceof Error) throw reply;
        yield { type: "asking", provider: "fake", model: "fake-model" };
        for (const text of reply ?? []) yield { type: "text", text };
      },
    };
    return { chat: () => chat, requests };
  };

  /** A search that returns the given results, one list per call, in order. */
  const scriptedSearch = (...results: (SearchHit[] | Error)[]) => {
    const calls: { query: string; options: SearchOptions }[] = [];
    return {
      calls,
      search: async (query: string, options: SearchOptions) => {
        const result = results[calls.length] ?? [];
        calls.push({ query, options });
        if (result instanceof Error) throw result;
        return result;
      },
    };
  };

  const texts = (events: AnswerEvent[]) =>
    events.flatMap((event) => (event.type === "text" ? [event.text] : []));

  it("searches again in the words of the law and answers from what that finds", async () => {
    const { search, calls } = scriptedSearch(first, better);
    const { chat, requests } = scriptedChat(
      [DECLINE.slice(0, 20), DECLINE.slice(20)],
      // Written in pieces, like everything a model writes.
      [REWRITE.slice(0, 9), REWRITE.slice(9)],
      ["La Ley 14346 reprime los malos tratos a los animales [1]."],
    );

    const events = await collect(
      answerQuestion({ search, chat }, "Normativas relacionadas con mascotas"),
    );

    expect(events.map((event) => event.type)).toEqual([
      "sources",
      "asking",
      "rewritten",
      "sources",
      "asking",
      "text",
      "done",
    ]);
    expect(events[2]).toMatchObject({ type: "rewritten", query: REWRITE, found: true });
    expect(events[3]).toMatchObject({
      type: "sources",
      sources: [{ n: 1, chunkId: 7, title: "Ley 14346 · Artículo 1" }],
    });
    // What said "the sources do not answer" was never shown.
    expect(texts(events)).toEqual([
      "La Ley 14346 reprime los malos tratos a los animales [1].",
    ]);
    expect(events.at(-1)).toMatchObject({ outcome: "answered", cited: [1] });

    expect(requests[1]).toMatchObject({
      instructions: REWRITE_INSTRUCTIONS,
      prompt: "Normativas relacionadas con mascotas",
    });
    expect(requests[2]?.prompt).toContain("malos tratos a los animales");
    expect(requests[2]?.prompt).toContain("Normativas relacionadas con mascotas");
    expect(calls.map((call) => call.query)).toEqual([
      "Normativas relacionadas con mascotas",
      REWRITE,
    ]);
  });

  it("keeps the numbers and dates of the question, whatever the rewrite says", async () => {
    const { search, calls } = scriptedSearch(first, better);
    const { chat } = scriptedChat([DECLINE], ["tope de horas extra"], ["Sí [1]."]);

    await collect(
      answerQuestion(
        { search, chat },
        "Tope según el Decreto 552/2026 desde junio de 2026",
      ),
    );

    expect(calls[1]?.options).toMatchObject({
      references: [{ type: "Decreto", number: "552", year: 2026 }],
      dates: [{ year: 2026, month: 6 }],
      limit: 8,
    });
  });

  it("does not look up by number a regulation only the rewrite names", async () => {
    const { search, calls } = scriptedSearch(first, better);
    // A small model, asked not to add anything, named laws that do not exist.
    const { chat } = scriptedChat(
      [DECLINE],
      ["Protección animal, Ley 26.339 y Decreto 6333/2013"],
      ["Sí [1]."],
    );

    await collect(
      answerQuestion({ search, chat }, "Normativas relacionadas con mascotas"),
    );

    expect(calls[1]?.query).toContain("Ley 26.339");
    expect(calls[1]?.options).toMatchObject({ references: [], dates: [] });
  });

  it("keeps the first answer when the second search brings nothing new", async () => {
    const { search, calls } = scriptedSearch(first, [first[1]!]);
    const { chat, requests } = scriptedChat([DECLINE], [REWRITE]);

    const events = await collect(answerQuestion({ search, chat }, "mascotas"));

    expect(events.map((event) => event.type)).toEqual([
      "sources",
      "asking",
      "rewritten",
      "text",
      "done",
    ]);
    expect(events[2]).toMatchObject({ found: false });
    expect(texts(events)).toEqual([DECLINE]);
    expect(events.at(-1)).toMatchObject({
      outcome: "not_in_sources",
      cited: [1, 2],
      timings: { firstTextMs: expect.any(Number) },
    });
    expect(requests).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it("does not search again with the question it already searched", async () => {
    const { search, calls } = scriptedSearch(first, better);
    const { chat } = scriptedChat([DECLINE], ['"Mascotas."']);

    const events = await collect(answerQuestion({ search, chat }, "¿mascotas?"));

    expect(events.map((event) => event.type)).not.toContain("rewritten");
    expect(texts(events)).toEqual([DECLINE]);
    expect(calls).toHaveLength(1);
  });

  it("keeps the first answer when no model can rewrite the question", async () => {
    const { search, calls } = scriptedSearch(first, better);
    const { chat } = scriptedChat(
      [DECLINE],
      new ChatModelError("rate_limited", "Too many requests"),
    );

    const events = await collect(answerQuestion({ search, chat }, "mascotas"));

    expect(texts(events)).toEqual([DECLINE]);
    expect(events.at(-1)).toMatchObject({ outcome: "not_in_sources" });
    expect(calls).toHaveLength(1);
  });

  it("lets any other failure of the rewrite through", async () => {
    const { search } = scriptedSearch(first, better);
    const { chat } = scriptedChat([DECLINE], new Error("a bug"));

    await expect(collect(answerQuestion({ search, chat }, "mascotas"))).rejects.toThrow(
      "a bug",
    );
  });

  it("keeps the first answer when the embedding model fails on the second search", async () => {
    const { search } = scriptedSearch(first, new QueryEmbeddingError("bge-m3", "down"));
    const { chat } = scriptedChat([DECLINE], [REWRITE]);

    const events = await collect(answerQuestion({ search, chat }, "mascotas"));

    expect(texts(events)).toEqual([DECLINE]);
    expect(events.at(-1)).toMatchObject({ outcome: "not_in_sources" });
  });

  it("lets any other failure of the second search through", async () => {
    const { search } = scriptedSearch(first, new Error("the database is gone"));
    const { chat } = scriptedChat([DECLINE], [REWRITE]);

    await expect(collect(answerQuestion({ search, chat }, "mascotas"))).rejects.toThrow(
      "the database is gone",
    );
  });

  it("tries only once: a second answer that does not answer is final", async () => {
    const { search, calls } = scriptedSearch(first, better, better);
    const { chat, requests } = scriptedChat([DECLINE], [REWRITE], [DECLINE], [REWRITE]);

    const events = await collect(answerQuestion({ search, chat }, "mascotas"));

    expect(texts(events)).toEqual([DECLINE]);
    expect(events.at(-1)).toMatchObject({ outcome: "not_in_sources" });
    expect(requests).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it("ends with an error when the model fails on the second answer", async () => {
    const { search } = scriptedSearch(first, better);
    const { chat } = scriptedChat(
      [DECLINE],
      [REWRITE],
      new ChatModelError("unavailable", "Gone"),
    );

    const events = await collect(answerQuestion({ search, chat }, "mascotas"));

    expect(events.at(-1)).toMatchObject({ type: "error", reason: "unavailable" });
    expect(texts(events)).toEqual([]);
  });

  it("holds back only the beginning of an answer, until it can tell", async () => {
    const { search, calls } = scriptedSearch(first);
    const { chat, requests } = scriptedChat([
      "Las ",
      "fuentes ",
      "fijan $907.934 [1]",
      ".",
    ]);

    const events = await collect(answerQuestion({ search, chat }, "¿Cuál es el tope?"));

    expect(texts(events)).toEqual(["Las fuentes fijan $907.934 [1]", "."]);
    expect(events.at(-1)).toMatchObject({ outcome: "answered" });
    expect(requests).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("sends nothing for an answer with no text", async () => {
    const { search } = scriptedSearch(first);
    const { chat } = scriptedChat([]);

    const events = await collect(answerQuestion({ search, chat }, "¿?"));

    expect(texts(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ outcome: "uncited" });
  });

  it("sends an answer too short to tell, when it ends", async () => {
    const { search } = scriptedSearch(first);
    const { chat } = scriptedChat(["Las fuentes"]);

    const events = await collect(answerQuestion({ search, chat }, "¿?"));

    expect(texts(events)).toEqual(["Las fuentes"]);
    expect(events.at(-1)).toMatchObject({ outcome: "uncited" });
  });

  it("times the second search, and the first word from what was shown", async () => {
    let clock = 0;
    const now = () => (clock += 10);
    const { search } = scriptedSearch(first, better);
    const { chat } = scriptedChat([DECLINE], [REWRITE], ["Sí [1]."]);

    const events = await collect(answerQuestion({ search, chat, now }, "mascotas"));
    const [, second] = events.filter((event) => event.type === "sources");
    const rewritten = events.find((event) => event.type === "rewritten");
    const done = events.at(-1);
    if (second?.type !== "sources" || rewritten?.type !== "rewritten")
      throw new Error();
    if (done?.type !== "done") throw new Error();

    expect(second.searchMs).toBeGreaterThan(0);
    // Nothing was shown before both searches and the rewrite were over.
    expect(done.timings.firstTextMs).toBeGreaterThan(
      done.timings.searchMs + rewritten.ms + second.searchMs,
    );
  });
});
