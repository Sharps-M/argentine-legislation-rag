import {
  ChatModelError,
  type ChatFailure,
  type ChatModel,
  type ChatRequest,
} from "@/ai/chat";
import { findDates } from "@/search/dates";
import { findReferences } from "@/search/references";
import {
  QueryEmbeddingError,
  type SearchHit,
  type SearchOptions,
} from "@/search/search";

import { checkAmounts, type AmountCheck } from "./amounts";
import { findCitations } from "./citations";
import { detectLanguage, type AnswerLanguage } from "./language";
import { buildPrompt, instructionsFor, readOpening, saysNotInSources } from "./prompt";
import { isNewQuery, REWRITE_INSTRUCTIONS, toSearchQuery } from "./rewrite";
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
  /**
   * What the search found, numbered. Always the first event, and sent once
   * more if the question is searched again with other words.
   */
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
  /**
   * The sources did not answer, so the question was searched again in the
   * words of the law. `found` says whether that brought new sources: if it
   * did, a `sources` event with them follows and the answer starts over; if
   * not, the first answer stands.
   */
  | { type: "rewritten"; query: string; found: boolean; ms: number }
  /** A model that could not answer; the next one is being asked. */
  | {
      type: "skipped";
      provider: string;
      model: string;
      reason: ChatFailure;
      message: string;
      /** How long it was waited for. */
      ms: number;
      /** It was not asked: it failed a moment ago and is being left alone. */
      resting?: true;
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

/** What one request to the model wrote. */
type Attempt = {
  text: string;
  /** It opens by saying that the sources do not answer the question. */
  notInSources: boolean;
  writer: { provider: string; model: string };
};

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

  const limit = Math.min(searchOptions.limit ?? MAX_SOURCES, MAX_SOURCES);

  /**
   * One request to the model, as events. With `hold`, the beginning of the
   * text is kept back until it is clear whether it says the sources do not
   * answer; if it does, nothing of it is sent, so that a better answer can
   * take its place.
   */
  async function* ask(
    chat: ChatModel,
    request: ChatRequest,
    hold: boolean,
  ): AsyncGenerator<AnswerEvent, Attempt, undefined> {
    // When the model now being asked was asked: the start, or the moment the
    // one before it was given up on. A skipped model is timed from there.
    let askedAt = now();
    let text = "";
    let opening = hold ? readOpening("") : "answer";

    const show = (piece: string): AnswerEvent => {
      firstTextMs ??= since(startedAt);
      return { type: "text", text: piece };
    };

    for await (const part of chat.stream(request)) {
      if (part.type === "skipped") {
        yield { ...part, ms: since(askedAt) };
        askedAt = now();
        continue;
      }
      if (part.type === "asking") {
        yield part;
        continue;
      }

      text += part.text;
      if (opening === "undecided") {
        opening = readOpening(text);
        // What was held back goes out at once.
        if (opening === "answer") yield show(text);
      } else if (opening === "answer") {
        yield show(part.text);
      }
    }
    // Too short to tell: it is an answer, if a very short one.
    if (opening === "undecided" && text) yield show(text);

    return {
      text,
      notInSources: opening === "not_in_sources",
      // Read at the end: with a chain of models, it is the one that actually
      // wrote the answer.
      writer: { provider: chat.provider, model: chat.model },
    };
  }

  /**
   * The question in the words of the law, searched again. Returns the new
   * sources and how long the search took, or `null` when there is nothing
   * better to answer with.
   */
  async function* searchAgain(
    chat: ChatModel,
  ): AsyncGenerator<AnswerEvent, { sources: AnswerSource[]; searchMs: number } | null> {
    const startedAgain = now();

    let rewrite = "";
    try {
      for await (const part of chat.stream({
        instructions: REWRITE_INSTRUCTIONS,
        prompt: question,
        signal,
      })) {
        if (part.type === "text") rewrite += part.text;
      }
    } catch (error) {
      // No model to rewrite it: the first answer stands.
      if (error instanceof ChatModelError) return null;
      throw error;
    }

    const query = toSearchQuery(rewrite);
    if (!isNewQuery(query, question) || signal?.aborted) return null;

    const searchedAt = now();
    let hits: SearchHit[];
    try {
      hits = await deps.search(query, {
        ...searchOptions,
        limit,
        // The numbers and dates of the question, not of the rewrite.
        references: searchOptions.references ?? findReferences(question),
        dates: searchOptions.dates ?? findDates(question),
      });
    } catch (error) {
      if (error instanceof QueryEmbeddingError) return null;
      throw error;
    }
    const searchMs = since(searchedAt);

    const known = new Set(sources.map((source) => source.chunkId));
    const found = hits.some((hit) => !known.has(hit.chunkId));
    yield { type: "rewritten", query, found, ms: since(startedAgain) };

    return found ? { sources: toSources(hits), searchMs } : null;
  }

  const prompt = (given: readonly AnswerSource[]): ChatRequest => ({
    instructions: instructionsFor(language),
    prompt: buildPrompt(question, given, language),
    signal,
  });

  let final: { sources: AnswerSource[]; attempt: Attempt };
  try {
    // Inside: a provider without its settings fails right here.
    const chat = deps.chat();
    const first = yield* ask(chat, prompt(sources), true);
    final = { sources, attempt: first };

    if (first.notInSources && !signal?.aborted) {
      const better = yield* searchAgain(chat);
      if (better) {
        yield { type: "sources", ...better, language };
        final = {
          sources: better.sources,
          attempt: yield* ask(chat, prompt(better.sources), false),
        };
      } else {
        // Held back in case something better came: it is the answer after all.
        firstTextMs ??= since(startedAt);
        yield { type: "text", text: first.text };
      }
    }
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

  const answer = final.attempt.text;
  const { cited, unknown } = findCitations(answer, final.sources.length);
  yield {
    type: "done",
    outcome: saysNotInSources(answer)
      ? "not_in_sources"
      : cited.length > 0
        ? "answered"
        : "uncited",
    cited,
    unknownCitations: unknown,
    amounts: checkAmounts(answer, final.sources),
    ...final.attempt.writer,
    timings: timings(),
  };
}
