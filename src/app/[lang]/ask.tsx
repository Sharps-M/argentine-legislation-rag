"use client";

import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";

import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { fill, plural, seconds } from "@/i18n/format";
import { MAX_QUERY_LENGTH, MAX_YEAR, MIN_YEAR } from "@/search/query-limits";
import { toBlocks } from "@/ui/answer-text";
import {
  answerReducer,
  failureOf,
  initialView,
  type AnswerView,
  type Failure,
} from "@/ui/answer-view";
import {
  CORPUS_TYPES,
  filterCount,
  queryFromParams,
  queryProblem,
  toSearch,
  type AskQuery,
} from "@/ui/ask-query";
import { readEvents, toAnswerEvent } from "@/ui/event-stream";
import {
  ANSWERS_KEY,
  DRAFT_KEY,
  isEmptyDraft,
  keepAnswer,
  parseAnswers,
  parseDraft,
  readKept,
  writeKept,
  type Fields,
} from "@/ui/kept";

import { AnswerText, SourceList } from "./answer-parts";

type Texts = Dictionary["ask"];

const fieldsOf = (query: AskQuery): Fields => ({
  q: query.q,
  type: query.type ?? "",
  from: query.from === null ? "" : String(query.from),
  to: query.to === null ? "" : String(query.to),
});

const queryOf = (fields: Fields): AskQuery =>
  queryFromParams({ q: fields.q, type: fields.type, from: fields.from, to: fields.to });

/**
 * The question and its answer, as it arrives from `/api/answer`. The answer is
 * written in the language of the page.
 *
 * The question and its filters live in the address of the page: a link to
 * `/es?q=...` opens with its answer, and going back shows the answer before,
 * kept from when it was given instead of asked again.
 *
 * Changing the language opens the page again: what was being written and the
 * answers already given are kept in the tab, so the reader finds them there. An
 * answer stays in the language it was written in until the reader asks for it
 * again in the new one.
 */
export function Ask({
  lang,
  texts,
  initial,
}: {
  lang: Locale;
  texts: Texts;
  /** The question in the address the page was opened with. */
  initial: AskQuery;
}) {
  const [view, dispatch] = useReducer(answerReducer, initialView);
  const [fields, setFields] = useState<Fields>(() => fieldsOf(initial));
  const [problem, setProblem] = useState<ReturnType<typeof queryProblem>>(null);
  const running = useRef<AbortController | null>(null);
  /** Answers already given, by address: going back does not spend a question. */
  const given = useRef(new Map<string, AnswerView>());
  const current = useRef("");

  async function ask(query: AskQuery) {
    const found = queryProblem(query);
    setProblem(found);
    if (found) return;

    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    // A question asked after this one takes over: this one stops updating the page.
    const isCurrent = () => running.current === controller;
    current.current = toSearch(query);

    dispatch({ type: "start", question: query.q });
    try {
      const params = new URLSearchParams(toSearch(query));
      params.set("lang", lang);
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

  /** Asks, and puts the question in the address so it can be shared and gone back to. */
  function askAndRemember(query: AskQuery) {
    if (queryProblem(query)) {
      setProblem(queryProblem(query));
      return;
    }
    const search = toSearch(query);
    if (search !== window.location.search) {
      window.history.pushState(null, "", `${window.location.pathname}${search}`);
    }
    void ask(query);
  }

  // Opened with a question in the address: show the answer the tab kept for it,
  // or ask. Opened without one: bring back what was being written. Once, even
  // when React runs effects twice in development. This effect comes before the
  // one that saves the draft, so it reads the draft before it is written over.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    for (const { search, view: kept } of parseAnswers(readKept(ANSWERS_KEY))) {
      given.current.set(search, kept);
    }

    if (initial.q) {
      const search = toSearch(initial);
      const kept = given.current.get(search);
      current.current = search;
      // The tab's storage and the server are the outside world this effect
      // keeps in step with; the state that follows comes from them.
      if (kept) dispatch({ type: "restore", view: kept });
      else void ask(initial);
      return;
    }
    const draft = parseDraft(readKept(DRAFT_KEY));
    // The tab's storage does not exist on the server: the draft can only come
    // back after the first render, or the page would not match what was sent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (draft && !isEmptyDraft(draft)) setFields(draft);
    // Only on the first render: later questions come from the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What is being written is kept in the tab, for when the page opens again.
  useEffect(() => writeKept(DRAFT_KEY, fields), [fields]);

  // An answer that ended is kept under its address, in the page and in the tab.
  useEffect(() => {
    if (view.phase !== "done" || !current.current) return;
    if (given.current.get(current.current) === view) return;
    given.current.set(current.current, view);
    const answer = { search: current.current, view };
    writeKept(ANSWERS_KEY, keepAnswer(parseAnswers(readKept(ANSWERS_KEY)), answer));
  }, [view]);

  // Back and forward: show the answer that address had, or ask it.
  useEffect(() => {
    function onPopState() {
      const query = queryFromParams(new URLSearchParams(window.location.search));
      setFields(fieldsOf(query));
      setProblem(null);
      running.current?.abort();
      running.current = null;

      const search = toSearch(query);
      const kept = given.current.get(search);
      current.current = search;
      if (!query.q) dispatch({ type: "restore", view: initialView });
      else if (kept) dispatch({ type: "restore", view: kept });
      else void ask(query);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // `ask` only reads refs and stable values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the page stops the answer: no quota is spent on what nobody reads.
  useEffect(() => () => running.current?.abort(), []);

  const busy = view.phase === "searching" || view.phase === "answering";
  const activeFilters = filterCount(queryOf(fields));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    askAndRemember(queryOf(fields));
  }

  const set = (name: keyof Fields) => (event: { target: { value: string } }) =>
    setFields((before) => ({ ...before, [name]: event.target.value }));

  const yearInput = (name: "from" | "to") => (
    <label className="flex flex-col gap-1">
      <span className="text-muted">{texts.filters[name]}</span>
      <input
        name={name}
        type="number"
        inputMode="numeric"
        min={MIN_YEAR}
        max={MAX_YEAR}
        value={fields[name]}
        onChange={set(name)}
        aria-invalid={problem === "years_order" || undefined}
        className="w-32 rounded-lg border border-border bg-background px-3 py-2 outline-none focus:border-accent"
      />
    </label>
  );

  return (
    <div className="space-y-8">
      {/* Without JavaScript the form still goes to the address of the question. */}
      <form method="get" onSubmit={onSubmit} className="space-y-3">
        <label htmlFor="question" className="block text-sm font-medium">
          {texts.label}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="question"
            name="q"
            type="search"
            value={fields.q}
            onChange={set("q")}
            placeholder={texts.placeholder}
            maxLength={MAX_QUERY_LENGTH}
            autoComplete="off"
            aria-invalid={problem === "too_short" || undefined}
            aria-describedby={problem ? "question-error" : undefined}
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

        <details open={activeFilters > 0 || undefined} className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-foreground">
            {texts.filters.heading}
            {activeFilters > 0 && ` (${activeFilters})`}
          </summary>
          <div className="mt-3 flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-muted">{texts.filters.type}</span>
              <select
                name="type"
                value={fields.type}
                onChange={set("type")}
                className="rounded-lg border border-border bg-background px-3 py-2 outline-none focus:border-accent"
              >
                <option value="">{texts.filters.anyType}</option>
                {CORPUS_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {texts.filters.types[type]}
                  </option>
                ))}
              </select>
            </label>
            {yearInput("from")}
            {yearInput("to")}
            {activeFilters > 0 && (
              <button
                type="button"
                onClick={() =>
                  setFields((before) => ({ ...before, type: "", from: "", to: "" }))
                }
                className="rounded-lg px-3 py-2 text-muted hover:bg-surface hover:text-foreground"
              >
                {texts.filters.clear}
              </button>
            )}
          </div>
        </details>

        {problem && (
          <p id="question-error" className="text-sm text-danger">
            {problem === "too_short" ? texts.tooShort : texts.filters.yearsOrder}
          </p>
        )}
        {view.phase === "idle" && !initial.q && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">{texts.examples}</span>
            {texts.exampleQuestions.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  const next = { ...fields, q: example };
                  setFields(next);
                  askAndRemember(queryOf(next));
                }}
                className="rounded-full border border-border px-3 py-1 text-left hover:bg-surface"
              >
                {example}
              </button>
            ))}
          </div>
        )}
      </form>

      {initial.q && (
        <noscript>
          <p className="rounded-lg bg-surface p-3 text-sm">{texts.noscript}</p>
        </noscript>
      )}

      {view.phase === "done" && view.language && view.language !== lang && (
        <p className="flex flex-wrap items-center gap-3 rounded-lg bg-surface p-3 text-sm">
          <span>{texts.otherLanguage}</span>
          <button
            type="button"
            onClick={() =>
              void ask(queryFromParams(new URLSearchParams(current.current)))
            }
            className="rounded-lg border border-border px-3 py-1 font-medium hover:bg-background"
          >
            {texts.answerAgain}
          </button>
        </p>
      )}

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
