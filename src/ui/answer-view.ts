import type { ChatFailure } from "@/ai/chat";
import type { AnswerEvent } from "@/answers/answer";
import type { AnswerLanguage } from "@/answers/language";
import type { AnswerSource } from "@/answers/sources";

type Done = Extract<AnswerEvent, { type: "done" }>;
type Skipped = Extract<AnswerEvent, { type: "skipped" }>;

/** Why there is no answer, in terms the page can explain in its own language. */
export type Failure =
  /** The server refused the question: too short, too long, a filter out of range. */
  | { kind: "invalid" }
  /** Too many answers in the last minute: from this reader, or from everyone. */
  | { kind: "rate_limited"; limit: "client" | "total"; retryAfterSeconds: number }
  /** The embedding model is down: nothing could be searched. */
  | { kind: "search_unavailable" }
  /** Every chat model failed; the sources, if any, are still shown. */
  | { kind: "model"; reason: ChatFailure }
  /** The server could not be reached, or the answer broke off. */
  | { kind: "network" };

export type AnswerView = {
  /**
   * - `idle`: nothing asked yet.
   * - `searching`: waiting for the sources.
   * - `answering`: the sources are here; a model is being asked or is writing.
   * - `done`: the answer ended. `failed`: it could not be given.
   * - `stopped`: the reader stopped it.
   */
  phase: "idle" | "searching" | "answering" | "done" | "failed" | "stopped";
  question: string;
  sources: AnswerSource[];
  language: AnswerLanguage | null;
  /** The model being asked, while nothing has been written. */
  asking: { provider: string; model: string } | null;
  skipped: Skipped[];
  rewritten: { query: string; found: boolean } | null;
  text: string;
  done: Done | null;
  failure: Failure | null;
};

export const initialView: AnswerView = {
  phase: "idle",
  question: "",
  sources: [],
  language: null,
  asking: null,
  skipped: [],
  rewritten: null,
  text: "",
  done: null,
  failure: null,
};

export type AnswerAction =
  | { type: "start"; question: string }
  | { type: "event"; event: AnswerEvent }
  | { type: "failed"; failure: Failure }
  | { type: "stopped" };

/** What the page shows, after each thing that happens. */
export function answerReducer(view: AnswerView, action: AnswerAction): AnswerView {
  switch (action.type) {
    case "start":
      return { ...initialView, phase: "searching", question: action.question };

    case "failed":
      return { ...view, phase: "failed", asking: null, failure: action.failure };

    case "stopped":
      // An answer that already ended stays as it was.
      return view.phase === "searching" || view.phase === "answering"
        ? { ...view, phase: "stopped", asking: null }
        : view;

    case "event":
      return onEvent(view, action.event);
  }
}

function onEvent(view: AnswerView, event: AnswerEvent): AnswerView {
  switch (event.type) {
    case "sources":
      // A second search replaces the sources; nothing was shown from the first
      // answer, which said the sources did not answer.
      return {
        ...view,
        phase: "answering",
        sources: event.sources,
        language: event.language,
      };
    case "asking":
      return { ...view, asking: { provider: event.provider, model: event.model } };
    case "skipped":
      return { ...view, asking: null, skipped: [...view.skipped, event] };
    case "rewritten":
      return {
        ...view,
        asking: null,
        rewritten: { query: event.query, found: event.found },
      };
    case "text":
      return { ...view, asking: null, text: view.text + event.text };
    case "done":
      return { ...view, phase: "done", asking: null, done: event };
    case "error":
      return {
        ...view,
        phase: "failed",
        asking: null,
        failure: { kind: "model", reason: event.reason },
      };
  }
}

/**
 * Why a request to `/api/answer` was refused, from its status and its body:
 * the failures that come before the stream starts.
 */
export function failureOf(status: number, body: unknown): Failure {
  const data = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;

  if (status === 429) {
    const seconds = Number(data.retryAfterSeconds);
    return {
      kind: "rate_limited",
      limit: data.limit === "total" ? "total" : "client",
      retryAfterSeconds:
        Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60,
    };
  }
  if (status === 400) return { kind: "invalid" };
  if (status === 503) return { kind: "search_unavailable" };
  return { kind: "network" };
}
