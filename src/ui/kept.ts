import type { AnswerView } from "@/ui/answer-view";
import { CORPUS_TYPES, type CorpusType } from "@/ui/ask-query";

/**
 * What the page keeps in the browser tab (`sessionStorage`) so that changing
 * the language, which opens the page again, loses nothing: the question being
 * written, and the answers already given. It stays in the tab and goes when the
 * tab is closed; nothing of it reaches the server.
 */

/** What the inputs hold, as typed. */
export type Fields = { q: string; type: CorpusType | ""; from: string; to: string };

/** An answer that ended, under the address of its question. */
export type KeptAnswer = { search: string; view: AnswerView };

export const DRAFT_KEY = "normativa:draft";
export const ANSWERS_KEY = "normativa:answers";
/** Enough to go back a few questions; an answer with its sources is a few kB. */
export const MAX_KEPT_ANSWERS = 10;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parse = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** The question being written, as it was left. Anything else is no draft. */
export function parseDraft(raw: string | null): Fields | null {
  const value = parse(raw);
  if (!isObject(value)) return null;
  const { q, type, from, to } = value;
  if (
    typeof q !== "string" ||
    typeof from !== "string" ||
    typeof to !== "string" ||
    typeof type !== "string" ||
    (type !== "" && !(CORPUS_TYPES as readonly string[]).includes(type))
  ) {
    return null;
  }
  return { q, type: type as CorpusType | "", from, to };
}

/** Whether a draft says anything: an empty form is not worth restoring. */
export const isEmptyDraft = (fields: Fields) =>
  !fields.q && !fields.type && !fields.from && !fields.to;

const isKeptAnswer = (value: unknown): value is KeptAnswer =>
  isObject(value) &&
  typeof value.search === "string" &&
  value.search.startsWith("?") &&
  isObject(value.view) &&
  value.view.phase === "done" &&
  typeof value.view.text === "string" &&
  Array.isArray(value.view.sources);

/**
 * The answers kept in the tab. What does not look like one is dropped: the
 * page would rather ask again than show something broken.
 */
export function parseAnswers(raw: string | null): KeptAnswer[] {
  const value = parse(raw);
  return Array.isArray(value) ? value.filter(isKeptAnswer) : [];
}

/** Adds an answer, replacing the one its address had; the newest last. */
export function keepAnswer(
  kept: readonly KeptAnswer[],
  answer: KeptAnswer,
  max = MAX_KEPT_ANSWERS,
): KeptAnswer[] {
  return [...kept.filter((other) => other.search !== answer.search), answer].slice(
    -max,
  );
}

/**
 * Reading and writing the tab's storage. It can be missing or refuse (a
 * private window, storage turned off, full): then nothing is kept, and the
 * page works as if it had never been.
 */
export function readKept(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeKept(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing kept: the page still works.
  }
}
