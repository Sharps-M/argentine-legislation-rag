import { describe, expect, it } from "vitest";

import type { AnswerEvent } from "@/answers/answer";
import { toSources } from "@/answers/sources";

import { searchHit } from "../../tests/support/search-hits";
import {
  answerReducer,
  failureOf,
  initialView,
  type AnswerAction,
  type AnswerView,
} from "./answer-view";

const sources = toSources([searchHit()]);
const timings = { searchMs: 40, firstTextMs: 900, totalMs: 2000 };
const done: AnswerEvent = {
  type: "done",
  outcome: "answered",
  cited: [1],
  unknownCitations: [],
  amounts: [],
  provider: "gemini",
  model: "flash-lite",
  timings,
};

const run = (...actions: AnswerAction[]) =>
  actions.reduce<AnswerView>(answerReducer, initialView);
const event = (value: AnswerEvent): AnswerAction => ({ type: "event", event: value });

describe("answerReducer", () => {
  it("starts afresh with each question", () => {
    const view = run(
      { type: "start", question: "uno" },
      event({ type: "sources", sources, searchMs: 40, language: "es" }),
      event({ type: "text", text: "Sí [1]." }),
      { type: "start", question: "dos" },
    );

    expect(view).toEqual({ ...initialView, phase: "searching", question: "dos" });
  });

  it("follows an answer from the sources to the end", () => {
    const steps: AnswerAction[] = [
      { type: "start", question: "¿Tope?" },
      event({ type: "sources", sources, searchMs: 40, language: "es" }),
      event({ type: "asking", provider: "gemini", model: "flash-lite" }),
      event({ type: "text", text: "El tope " }),
      event({ type: "text", text: "es $907.934 [1]." }),
      event(done),
    ];

    const phases = steps.map((_, index) => run(...steps.slice(0, index + 1)));

    expect(phases.map((view) => view.phase)).toEqual([
      "searching",
      "answering",
      "answering",
      "answering",
      "answering",
      "done",
    ]);
    expect(phases[2]?.asking).toEqual({ provider: "gemini", model: "flash-lite" });
    expect(phases[3]?.asking).toBeNull();
    expect(phases[5]).toMatchObject({
      question: "¿Tope?",
      sources,
      language: "es",
      text: "El tope es $907.934 [1].",
      done,
      failure: null,
    });
  });

  it("keeps the models that were passed over, in order", () => {
    const view = run(
      { type: "start", question: "q" },
      event({ type: "asking", provider: "gemini", model: "a" }),
      event({
        type: "skipped",
        provider: "gemini",
        model: "a",
        reason: "overloaded",
        message: "busy",
        ms: 300,
      }),
      event({
        type: "skipped",
        provider: "gemini",
        model: "b",
        reason: "rate_limited",
        message: "rested",
        ms: 0,
        resting: true,
      }),
    );

    expect(view.asking).toBeNull();
    expect(view.skipped.map((skip) => [skip.model, skip.reason, skip.resting])).toEqual(
      [
        ["a", "overloaded", undefined],
        ["b", "rate_limited", true],
      ],
    );
  });

  it("takes the sources of a second search in place of the first", () => {
    const better = toSources([searchHit({ chunkId: 9, label: "Artículo 9" })]);

    const view = run(
      { type: "start", question: "mascotas" },
      event({ type: "sources", sources, searchMs: 40, language: "es" }),
      event({ type: "rewritten", query: "animales", found: true, ms: 800 }),
      event({ type: "sources", sources: better, searchMs: 30, language: "es" }),
    );

    expect(view.sources).toBe(better);
    expect(view.rewritten).toEqual({ query: "animales", found: true });
    expect(view.phase).toBe("answering");
  });

  it("ends in failure, keeping the sources, when no model could answer", () => {
    const view = run(
      { type: "start", question: "q" },
      event({ type: "sources", sources, searchMs: 40, language: "es" }),
      event({ type: "asking", provider: "ollama", model: "gemma3:4b" }),
      event({ type: "error", reason: "unavailable", message: "down", timings }),
    );

    expect(view).toMatchObject({
      phase: "failed",
      sources,
      asking: null,
      failure: { kind: "model", reason: "unavailable" },
    });
  });

  it("records a refusal before the stream", () => {
    const view = run(
      { type: "start", question: "q" },
      { type: "failed", failure: { kind: "invalid" } },
    );

    expect(view).toMatchObject({ phase: "failed", failure: { kind: "invalid" } });
  });

  it("stops an answer under way, and leaves one that ended alone", () => {
    const underWay = run(
      { type: "start", question: "q" },
      event({ type: "asking", provider: "gemini", model: "a" }),
      { type: "stopped" },
    );
    const ended = run({ type: "start", question: "q" }, event(done), {
      type: "stopped",
    });

    expect(underWay).toMatchObject({ phase: "stopped", asking: null });
    expect(ended.phase).toBe("done");
    expect(run({ type: "stopped" }).phase).toBe("idle");
  });
});

describe("failureOf", () => {
  it("reads the limit and the wait of a 429", () => {
    expect(failureOf(429, { limit: "total", retryAfterSeconds: 12.2 })).toEqual({
      kind: "rate_limited",
      limit: "total",
      retryAfterSeconds: 13,
    });
    expect(failureOf(429, { limit: "client", retryAfterSeconds: 5 })).toMatchObject({
      limit: "client",
    });
  });

  it("assumes a minute, and the client's own limit, when the body says nothing useful", () => {
    for (const body of [
      null,
      "x",
      {},
      { retryAfterSeconds: -1 },
      { retryAfterSeconds: "?" },
    ]) {
      expect(failureOf(429, body)).toEqual({
        kind: "rate_limited",
        limit: "client",
        retryAfterSeconds: 60,
      });
    }
  });

  it("tells an invalid question from a search that could not run", () => {
    expect(failureOf(400, {})).toEqual({ kind: "invalid" });
    expect(failureOf(503, {})).toEqual({ kind: "search_unavailable" });
    expect(failureOf(500, {})).toEqual({ kind: "network" });
  });
});
