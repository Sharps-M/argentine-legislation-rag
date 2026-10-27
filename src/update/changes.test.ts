import { describe, expect, it } from "vitest";

import type { NewRegulation } from "@/db/schema";

import { compareRegulation, findChanges, type Snapshot } from "./changes";

const stored: Snapshot = {
  id: 1,
  type: "Ley",
  number: "14346",
  enactedOn: "1954-09-27",
  topic: "ANIMALES",
  title: "MALOS TRATOS",
  summary: null,
  originalTextUrl: "http://example.test/original.htm",
  updatedTextUrl: null,
  amendedByCount: 0,
};

const row = (overrides: Partial<NewRegulation> = {}): NewRegulation => ({
  ...stored,
  // Fields the update does not look at.
  gazetteNumber: 17777,
  notes: "una nota",
  ...overrides,
});

describe("compareRegulation", () => {
  it("is null when nothing it looks at changed", () => {
    expect(
      compareRegulation(stored, row({ notes: "otra nota", gazetteNumber: 1 })),
    ).toBeNull();
  });

  it("takes a missing value and null for the same thing", () => {
    const withoutNulls = row();
    delete withoutNulls.summary;
    delete withoutNulls.updatedTextUrl;

    expect(compareRegulation(stored, withoutNulls)).toBeNull();
  });

  it("asks for the page again when the text may have changed", () => {
    expect(
      compareRegulation(
        stored,
        row({
          updatedTextUrl: "http://example.test/actualizado.htm",
          amendedByCount: 2,
        }),
      ),
    ).toMatchObject({
      id: 1,
      fields: ["updatedTextUrl", "amendedByCount"],
      text: true,
      context: false,
    });
  });

  it("asks for the page again when the original text or the abstract changed", () => {
    expect(
      compareRegulation(stored, row({ originalTextUrl: "http://x.test/n.htm" })),
    ).toMatchObject({
      text: true,
    });
    expect(compareRegulation(stored, row({ summary: "Nuevo resumen" }))).toMatchObject({
      text: true,
    });
  });

  it("asks for new vectors when the heading of the chunks changed", () => {
    expect(
      compareRegulation(stored, row({ title: "MALTRATO ANIMAL", topic: "FAUNA" })),
    ).toMatchObject({
      id: 1,
      fields: ["topic", "title"],
      text: false,
      context: true,
    });
    for (const field of [
      { type: "Decreto/Ley" },
      { number: "14.346" },
      { enactedOn: "1954-09-28" },
    ]) {
      expect(compareRegulation(stored, row(field))).toMatchObject({
        context: true,
        text: false,
      });
    }
  });

  it("asks for both when both kinds changed", () => {
    expect(
      compareRegulation(stored, row({ title: "X", amendedByCount: 1 })),
    ).toMatchObject({
      fields: ["amendedByCount", "title"],
      text: true,
      context: true,
    });
  });
});

describe("findChanges", () => {
  it("sorts the regulations into new, changed and unchanged", () => {
    const changes = findChanges(
      new Map([
        [1, stored],
        [2, { ...stored, id: 2 }],
      ]),
      [row(), row({ id: 2, amendedByCount: 1 }), row({ id: 3, number: "27330" })],
    );

    expect(changes.unchanged).toBe(1);
    expect(changes.changed).toMatchObject([
      { id: 2, fields: ["amendedByCount"], text: true, context: false },
    ]);
    expect(changes.changed[0]?.after).toMatchObject({ id: 2, amendedByCount: 1 });
    expect(changes.added.map((regulation) => regulation.id)).toEqual([3]);
  });

  it("finds nothing in an empty dataset", () => {
    expect(findChanges(new Map([[1, stored]]), [])).toEqual({
      added: [],
      changed: [],
      unchanged: 0,
    });
  });
});
