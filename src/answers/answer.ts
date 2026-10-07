import { ChatModelError, type ChatFailure, type ChatModel } from "@/ai/chat";
import type { SearchHit, SearchOptions } from "@/search/search";

import { checkAmounts, type AmountCheck } from "./amounts";
import { findCitations } from "./citations";
import { detectLanguage, type AnswerLanguage } from "./language";
import { buildPrompt, instructionsFor, saysNotInSources } from "./prompt";
import { MAX_SOURCES, toSources, type AnswerSource } from "./sources";

export type SearchFn = (query: string, options: SearchOptions) => Promise<SearchHit[]>;

/**
 * How an answer ended.
 *
 * - `answered`: the model wrote an answer and cited its sources.
 * - `not_in_sources`: the model said the sources do not answer the question.
 *   It may cite them to say what they are about; that is not an answer.
 * - `uncited`: the model wrote something that cites no source. Either it said
 *   the sources do not cover the question, or it failed to cite: in both cases
 *   nothing in it can be checked, and the reader is told.
 * - `no_sources`: the search found nothing close enough, so the model was not
 *   asked at all.
 */
export type AnswerOutcome = "answered" | "not_in_sources" | "uncited" | "no_sources";

/** Where the time of an answer went, in milliseconds since the question arrived. */
export type AnswerTimings = {
  /** Until the sources were found: embedding the question and searching. */
  searchMs: number;
  /** Until the first word of the answer; `null` if none was written. */
  firstTextMs: number | null;
  /** Until the end. */
  totalMs: number;
};

export type AnswerEvent =
  /** What the search found, numbered. Always the first event. */
  | {
      type: "sources";
      sources: AnswerSource[];
      searchMs: number;
      /** The language the answer will be written in. */
      language: AnswerLanguage;
    }
  /** A model is being asked; it has not written anything yet. */
  | { type: "asking"; provider: string; model: string }
  /** A piece of the answer, as the model writes it. */
  | { type: "text"; text: string }
  /** A model that could not answer; the next one is being asked. */
  | {
      type: "skipped";
      provider: string;
      model: string;
      reason: ChatFailure;
      message: string;
      /** How long it was waited for. */
      ms: number;
    }
  /** The last event of an answer that reached its end. */
  | {
      type: "done";
      outcome: AnswerOutcome;
      /** Sources the answer points at. */
      cited: number[];
      /** Numbers it cites that are not among the sources. */
      unknownCitations: number[];
      /** Every amount of money in the answer, checked against the sources. */
      amounts: AmountCheck[];
      /** Who wrote it; `null` when no model was asked. */
      provider: string | null;
      model: string | null;
      timings: AnswerTimings;
    }
  /** The last event of an answer the model could not finish. */
  | { type: "error"; reason: ChatFailure; message: string; timings: AnswerTimings };

export type AnswerDeps = {
  search: SearchFn;
  /** Called only if there is something to answer with. */
  chat: () => ChatModel;
  /** A clock in milliseconds; the tests bring their own. */
  now?: () => number;
};

export type AnswerOptions = SearchOptions & {
  signal?: AbortSignal;
  /**
   * The language to answer in. The page a question comes from knows it; when
   * nobody says, it is guessed from the question.
   */
  language?: AnswerLanguage;
};

/**
 * Answers a question from the regulations the search finds: first the sources,
 * then the text as it is written, then how it ended.
 *
 * A failure of the search (the embedding model is down) is thrown before any
 * event, so the caller can still answer with a plain error. A failure of the
 * chat model comes as an `error` event: by then the sources were already sent,
 * and they are useful on their own.
 */
export async function* answerQuestion(
  deps: AnswerDeps,
  question: string,
  options: AnswerOptions = {},
): AsyncGenerator<AnswerEvent, void, undefined> {
  const { signal, language = detectLanguage(question), ...searchOptions } = options;
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const since = (moment: number) => Math.round(now() - moment);

  const hits = await deps.search(question, {
    ...searchOptions,
    limit: Math.min(searchOptions.limit ?? MAX_SOURCES, MAX_SOURCES),
  });
  const sources = toSources(hits);
  const searchMs = since(startedAt);
  yield { type: "sources", sources, searchMs, language };

  let firstTextMs: number | null = null;
  const timings = (): AnswerTimings => ({
    searchMs,
    firstTextMs,
    totalMs: since(startedAt),
  });

  // Nothing to answer with: asking the model anyway would invite it to invent.
  if (sources.length === 0) {
    yield {
      type: "done",
      outcome: "no_sources",
      cited: [],
      unknownCitations: [],
      amounts: [],
      provider: null,
      model: null,
      timings: timings(),
    };
    return;
  }

  let answer = "";
  let writer: { provider: string; model: string };
  try {
    const chat = deps.chat();
    // When the model now being asked was asked: the start, or the moment the
    // one before it was given up on. A skipped model is timed from there.
    let askedAt = now();

    for await (const part of chat.stream({
      instructions: instructionsFor(language),
      prompt: buildPrompt(question, sources, language),
      signal,
    })) {
      if (part.type === "skipped") {
        yield { ...part, ms: since(askedAt) };
        askedAt = now();
        continue;
      }
      if (part.type === "text") {
        firstTextMs ??= since(startedAt);
        answer += part.text;
      }
      yield part;
    }
    // Read at the end: with a chain of models, it is the one that actually
    // wrote the answer.
    writer = { provider: chat.provider, model: chat.model };
  } catch (error) {
    if (!(error instanceof ChatModelError)) throw error;
    yield {
      type: "error",
      reason: error.reason,
      message: error.message,
      timings: timings(),
    };
    return;
  }

  if (signal?.aborted) return;

  const { cited, unknown } = findCitations(answer, sources.length);
  yield {
    type: "done",
    outcome: saysNotInSources(answer)
      ? "not_in_sources"
      : cited.length > 0
        ? "answered"
        : "uncited",
    cited,
    unknownCitations: unknown,
    amounts: checkAmounts(answer, sources),
    ...writer,
    timings: timings(),
  };
}
