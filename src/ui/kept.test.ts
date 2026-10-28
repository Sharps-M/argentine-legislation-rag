import { describe, expect, it } from "vitest";

import { initialView, type AnswerView } from "@/ui/answer-view";
import { keepAnswer, parseAnswers, parseDraft, isEmptyDraft } from "@/ui/kept";

const done = (text: string): AnswerView => ({
  ...initialView,
  phase: "done",
  question: "pregunta",
  text,
});

describe("parseDraft", () => {
  it("reads a draft as it was written", () => {
    const draft = { q: "vacaciones", type: "Ley", from: "2020", to: "" };
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft);
  });

  it("keeps years as typed, even half written", () => {
    const draft = { q: "", type: "", from: "20", to: "" };
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft);
  });

  it("is no draft when nothing was kept, or what was kept is not one", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("{not json")).toBeNull();
    expect(parseDraft("[]")).toBeNull();
    expect(
      parseDraft(JSON.stringify({ q: "x", type: "", from: 2020, to: "" })),
    ).toBeNull();
  });

  it("refuses a regulation type the corpus does not have", () => {
    const draft = { q: "x", type: "Resolución", from: "", to: "" };
    expect(parseDraft(JSON.stringify(draft))).toBeNull();
  });
});

describe("isEmptyDraft", () => {
  it("is empty only when every field is", () => {
    expect(isEmptyDraft({ q: "", type: "", from: "", to: "" })).toBe(true);
    expect(isEmptyDraft({ q: "", type: "Decreto", from: "", to: "" })).toBe(false);
  });
});

describe("parseAnswers", () => {
  it("reads the answers kept", () => {
    const kept = [{ search: "?q=a", view: done("uno") }];
    expect(parseAnswers(JSON.stringify(kept))).toEqual(kept);
  });

  it("drops what is not an answer that ended", () => {
    const kept = [
      { search: "?q=a", view: done("uno") },
      { search: "?q=b", view: { ...done("dos"), phase: "answering" } },
      { search: "q=c", view: done("tres") },
      { search: "?q=d" },
      "?q=e",
    ];
    expect(parseAnswers(JSON.stringify(kept)).map((answer) => answer.search)).toEqual([
      "?q=a",
    ]);
  });

  it("is empty when nothing was kept, or it is not a list", () => {
    expect(parseAnswers(null)).toEqual([]);
    expect(parseAnswers("{}")).toEqual([]);
    expect(parseAnswers("not json")).toEqual([]);
  });
});

describe("keepAnswer", () => {
  it("replaces the answer its address had, and puts it last", () => {
    const kept = [
      { search: "?q=a", view: done("uno") },
      { search: "?q=b", view: done("dos") },
    ];
    const again = { search: "?q=a", view: done("uno, en inglés") };
    expect(keepAnswer(kept, again)).toEqual([kept[1], again]);
  });

  it("forgets the oldest past the limit", () => {
    const kept = ["?q=a", "?q=b", "?q=c"].map((search) => ({
      search,
      view: done(search),
    }));
    const added = { search: "?q=d", view: done("d") };
    expect(keepAnswer(kept, added, 3).map((answer) => answer.search)).toEqual([
      "?q=b",
      "?q=c",
      "?q=d",
    ]);
  });
});
