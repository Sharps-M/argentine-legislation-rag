"use client";

import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";

import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { fill, plural, seconds } from "@/i18n/format";
import { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH } from "@/search/query-limits";
import { toBlocks } from "@/ui/answer-text";
import {
  answerReducer,
  failureOf,
  initialView,
  type AnswerView,
  type Failure,
} from "@/ui/answer-view";
import { readEvents, toAnswerEvent } from "@/ui/event-stream";

import { AnswerText, SourceList } from "./answer-parts";

type Texts = Dictionary["ask"];

/**
 * The question and its answer, as it arrives from `/api/answer`. The answer is
 * written in the language of the page.
 */
export function Ask({ lang, texts }: { lang: Locale; texts: Texts }) {
  const [view, dispatch] = useReducer(answerReducer, initialView);
  const [question, setQuestion] = useState("");
  const [tooShort, setTooShort] = useState(false);
  const running = useRef<AbortController | null>(null);

  // Leaving the page stops the answer: no quota is spent on what nobody reads.
  useEffect(() => () => running.current?.abort(), []);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setTooShort(true);
      return;
    }
    setTooShort(false);

    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    // A question asked after this one takes over: this one stops updating the page.
    const isCurrent = () => running.current === controller;

    dispatch({ type: "start", question: trimmed });
    try {
      const params = new URLSearchParams({ q: trimmed, lang });
      const response = await fetch(`/api/answer?${params}`, {
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      });
      if (!response.ok || !response.body) {
        const body: unknown = await response.json().catch(() => null);
        if (isCurrent())
          dispatch({ type: "failed", failure: failureOf(response.status, body) });
        return;
      }

      let ended = false;
      for await (const raw of readEvents(response.body)) {
        const event = toAnswerEvent(raw);
        if (!event || !isCurrent()) continue;
        ended ||= event.type === "done" || event.type === "error";
        dispatch({ type: "event", event });
      }
      // The stream closed without saying how the answer ended: it broke off.
      if (!ended && isCurrent())
        dispatch({ type: "failed", failure: { kind: "network" } });
    } catch {
      if (!isCurrent()) return;
      dispatch(
        controller.signal.aborted
          ? { type: "stopped" }
          : { type: "failed", failure: { kind: "network" } },
      );
    } finally {
      if (isCurrent()) running.current = null;
    }
  }

  const busy = view.phase === "searching" || view.phase === "answering";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  return (
    <div className="space-y-8">
      <form onSubmit={onSubmit} className="space-y-3">
        <label htmlFor="question" className="block text-sm font-medium">
          {texts.label}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="question"
            name="q"
            type="search"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={texts.placeholder}
            maxLength={MAX_QUERY_LENGTH}
            autoComplete="off"
            aria-invalid={tooShort || undefined}
            aria-describedby={tooShort ? "question-error" : undefined}
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 outline-none focus:border-accent"
          />
          {busy ? (
            // Separate keys: stopping turns this button back into "Ask" while the
            // click is still under way, and the same element, now a submit button,
            // would send the question again.
            <button
              key="stop"
              type="button"
              onClick={(event) => {
                event.preventDefault();
                running.current?.abort();
              }}
              className="rounded-lg border border-border px-4 py-2 font-medium hover:bg-surface"
            >
              {texts.stop}
            </button>
          ) : (
            <button
              key="submit"
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 font-medium text-background hover:opacity-90"
            >
              {texts.submit}
            </button>
          )}
        </div>
        {tooShort && (
          <p id="question-error" className="text-sm text-danger">
            {texts.tooShort}
          </p>
        )}
        {view.phase === "idle" && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">{texts.examples}</span>
            {texts.exampleQuestions.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  setQuestion(example);
                  void ask(example);
                }}
                className="rounded-full border border-border px-3 py-1 text-left hover:bg-surface"
              >
                {example}
              </button>
            ))}
          </div>
        )}
      </form>

      {view.phase !== "idle" && <Result view={view} lang={lang} texts={texts} />}
    </div>
  );
}

function failureText(failure: Failure, texts: Texts): string {
  switch (failure.kind) {
    case "invalid":
      return texts.failure.invalid;
    case "rate_limited":
      return fill(
        failure.limit === "total"
          ? texts.failure.rateLimitedTotal
          : texts.failure.rateLimitedClient,
        { seconds: failure.retryAfterSeconds },
      );
    case "search_unavailable":
      return texts.failure.searchUnavailable;
    case "model":
      return fill(texts.failure.model, { reason: texts.reasons[failure.reason] });
    case "network":
      return texts.failure.network;
  }
}

function Result({
  view,
  lang,
  texts,
}: {
  view: AnswerView;
  lang: Locale;
  texts: Texts;
}) {
  const { done } = view;
  const blocks = toBlocks(view.text, {
    sourceCount: view.sources.length,
    amounts: done?.amounts,
  });
  const doubtful =
    done?.amounts.filter((check) => check.status !== "supported").length ?? 0;

  return (
    <div className="space-y-8">
      <section aria-labelledby="answer-heading" className="space-y-4">
        <h2 id="answer-heading" className="text-lg font-semibold">
          {texts.answerHeading}
        </h2>

        {/* What is being waited for, and what was given up on. */}
        <div aria-live="polite" className="space-y-1 text-sm text-muted">
          {view.phase === "searching" && <p>{texts.searching}</p>}
          {view.skipped.map((skip, index) => (
            <p key={index}>
              {skip.resting
                ? fill(texts.resting, { model: skip.model })
                : fill(texts.skipped, {
                    model: skip.model,
                    reason: texts.reasons[skip.reason],
                    seconds: seconds(skip.ms, lang),
                  })}
            </p>
          ))}
          {view.rewritten && (
            <p>
              {fill(texts.rewritten, { query: view.rewritten.query })}
              {!view.rewritten.found && ` ${texts.rewrittenNothing}`}
            </p>
          )}
          {view.asking && <p>{fill(texts.asking, { model: view.asking.model })}</p>}
          {view.phase === "stopped" && <p>{texts.stopped}</p>}
        </div>

        <div aria-busy={view.phase === "answering"}>
          <AnswerText blocks={blocks} texts={texts} />
        </div>

        {view.failure && (
          <p
            role="alert"
            className="rounded-lg border border-danger p-3 text-sm text-danger"
          >
            {failureText(view.failure, texts)}
          </p>
        )}

        {done && (
          <div className="space-y-2 text-sm">
            {done.outcome !== "answered" && (
              <p className="rounded-lg bg-surface p-3">{texts.outcome[done.outcome]}</p>
            )}
            {done.unknownCitations.map((n) => (
              <p key={n} className="text-danger">
                {fill(texts.unknownCitation, { n })}
              </p>
            ))}
            {doubtful > 0 && (
              <p className="text-warning">
                {plural(texts.amountsWarning, doubtful, lang)}
              </p>
            )}
            {done.provider && done.model && (
              <p className="text-muted">
                {fill(texts.writtenBy, { provider: done.provider, model: done.model })}
                {" · "}
                {fill(texts.timings, {
                  search: seconds(done.timings.searchMs, lang),
                  first:
                    done.timings.firstTextMs === null
                      ? "—"
                      : seconds(done.timings.firstTextMs, lang),
                  total: seconds(done.timings.totalMs, lang),
                })}
              </p>
            )}
          </div>
        )}
      </section>

      {view.sources.length > 0 && (
        <section aria-labelledby="sources-heading" className="space-y-4">
          <h2 id="sources-heading" className="text-lg font-semibold">
            {texts.sourcesHeading}
          </h2>
          <SourceList
            sources={view.sources}
            cited={done?.outcome === "answered" ? done.cited : null}
            lang={lang}
            texts={texts}
          />
        </section>
      )}
    </div>
  );
}
