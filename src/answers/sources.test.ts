import { describe, expect, it } from "vitest";

import { earlierVersion, searchHit } from "../../tests/support/search-hits";
import { MAX_EARLIER, MAX_SOURCES, toSources } from "./sources";

describe("toSources", () => {
  it("numbers the results from 1, in the order they came", () => {
    const sources = toSources([
      searchHit({ chunkId: 10 }),
      searchHit({ chunkId: 20, label: null }),
    ]);

    expect(sources.map((source) => [source.n, source.chunkId, source.title])).toEqual([
      [1, 10, "Decreto 832/2026 · Artículo 3"],
      [2, 20, "Decreto 832/2026"],
    ]);
  });

  it("keeps what a reader needs to check the source", () => {
    const [source] = toSources([searchHit()]);

    expect(source).toMatchObject({
      enactedOn: "2026-08-28",
      subject: "ACUERDOS / ACTAS ACUERDO - HOMOLOGANSE",
      url: "http://example.test/429383.htm",
      abstractOnly: false,
      match: "semantic",
    });
  });

  it("marks a regulation known only by its abstract", () => {
    const hit = searchHit();
    hit.regulation.textSource = "summary";
    hit.regulation.topic = null;
    hit.regulation.title = null;

    expect(toSources([hit])[0]).toMatchObject({ abstractOnly: true, subject: null });
  });

  it("hands over at most eight sources", () => {
    const hits = Array.from({ length: 12 }, (_, index) =>
      searchHit({ chunkId: index }),
    );

    expect(toSources(hits)).toHaveLength(MAX_SOURCES);
    expect(toSources(hits, 3).map((source) => source.n)).toEqual([1, 2, 3]);
  });

  it("names the earlier regulations, and counts the ones it leaves out", () => {
    const earlierVersions = Array.from({ length: MAX_EARLIER + 3 }, (_, index) =>
      earlierVersion(`Decreto ${index}/2025`, "2025-01-01", index),
    );
    const [source] = toSources([searchHit({ earlierVersions })]);

    expect(source?.earlier).toHaveLength(MAX_EARLIER);
    expect(source?.earlier[0]).toEqual({
      name: "Decreto 0/2025",
      enactedOn: "2025-01-01",
      url: "http://example.test/0.htm",
    });
    expect(source?.earlierOmitted).toBe(3);
  });
});
