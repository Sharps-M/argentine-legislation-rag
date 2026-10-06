import { describe, expect, it } from "vitest";

import type { Chunk } from "./chunker";
import type { FetchedPage, PageFetcher } from "./fetcher";
import {
  hashText,
  pickSource,
  processTexts,
  summaryText,
  type ExtractedText,
  type PageCache,
  type RegulationRef,
  type TextStore,
} from "./pipeline";

const regulation = (overrides: Partial<RegulationRef> = {}): RegulationRef => ({
  id: 1,
  type: "Decreto",
  number: "10",
  title: "TITULO",
  topic: "TEMA",
  summary: "RESUMEN DE LA NORMA.",
  originalTextUrl: "http://example.test/1/norma.htm",
  updatedTextUrl: null,
  ...overrides,
});

const page = (body: string): FetchedPage => ({
  ok: true,
  bytes: new TextEncoder().encode(
    `<meta charset="utf-8"><div>${body}<br><br>${"Texto de relleno de la norma. ".repeat(5)}</div>`,
  ),
  contentType: "text/html; charset=utf-8",
});

const harness = (respond: (url: string) => FetchedPage) => {
  const requested: string[] = [];
  const cached = new Map<string, Uint8Array>();
  const saved = new Map<number, { text: ExtractedText; chunks: Chunk[] }>();

  const fetchPage: PageFetcher = async (url) => {
    requested.push(url);
    return respond(url);
  };
  const cache: PageCache = {
    read: async (id, source) => cached.get(`${id}.${source}`) ?? null,
    write: async (id, source, bytes) => void cached.set(`${id}.${source}`, bytes),
  };
  const store: TextStore = {
    currentHash: async (id) => saved.get(id)?.text.contentHash ?? null,
    save: async (id, text, chunks) => void saved.set(id, { text, chunks }),
  };

  return { deps: { fetchPage, cache, store }, requested, cached, saved };
};

describe("pickSource", () => {
  it("prefers the consolidated text over the original", () => {
    expect(
      pickSource(regulation({ updatedTextUrl: "http://example.test/1/texact.htm" })),
    ).toEqual({ source: "updated", url: "http://example.test/1/texact.htm" });
    expect(pickSource(regulation())).toEqual({
      source: "original",
      url: "http://example.test/1/norma.htm",
    });
    expect(pickSource(regulation({ originalTextUrl: null }))).toBeNull();
  });
});

describe("summaryText", () => {
  it("joins what the dataset provides, skipping blanks", () => {
    expect(summaryText(regulation({ topic: null, number: null }))).toBe(
      "Decreto\n\nTITULO\n\nRESUMEN DE LA NORMA.",
    );
  });
});

describe("processTexts", () => {
  it("downloads, caches, chunks and saves a regulation", async () => {
    const { deps, requested, cached, saved } = harness(() =>
      page("ARTÍCULO 1°.- Apruébase.<br><br>ARTÍCULO 2°.- Comuníquese."),
    );

    const report = await processTexts([regulation()], deps);

    expect(requested).toEqual(["http://example.test/1/norma.htm"]);
    expect(cached.has("1.original")).toBe(true);
    expect(saved.get(1)?.text).toMatchObject({
      source: "original",
      sourceUrl: "http://example.test/1/norma.htm",
    });
    expect(saved.get(1)?.text.contentHash).toBe(hashText(saved.get(1)!.text.content));
    expect(saved.get(1)?.chunks.map((chunk) => chunk.label)).toEqual([
      "Artículo 1",
      "Artículo 2",
    ]);
    expect(report).toMatchObject({
      processed: 1,
      downloaded: 1,
      saved: 1,
      chunks: 2,
      failed: 0,
    });
  });

  it("uses the cache instead of the network on a second run", async () => {
    const { deps, requested } = harness(() => page("ARTÍCULO 1°.- Apruébase."));

    await processTexts([regulation()], deps);
    const second = await processTexts([regulation()], deps);

    expect(requested).toHaveLength(1);
    expect(second).toMatchObject({
      fromCache: 1,
      downloaded: 0,
      unchanged: 1,
      saved: 0,
    });
  });

  it("saves again when forced, and downloads again when asked to refetch", async () => {
    const { deps, requested } = harness(() => page("ARTÍCULO 1°.- Apruébase."));
    await processTexts([regulation()], deps);

    const forced = await processTexts([regulation()], deps, { force: true });
    const refetched = await processTexts([regulation()], deps, { refetch: true });

    expect(forced).toMatchObject({ fromCache: 1, saved: 1 });
    expect(refetched).toMatchObject({ downloaded: 1, unchanged: 1 });
    expect(requested).toHaveLength(2);
  });

  it("builds a single summary chunk when there is no text to download", async () => {
    const { deps, requested, saved } = harness(() => page("no se usa"));

    const report = await processTexts([regulation({ originalTextUrl: null })], deps);

    expect(requested).toEqual([]);
    expect(saved.get(1)?.text).toMatchObject({ source: "summary", sourceUrl: null });
    expect(saved.get(1)?.chunks).toEqual([
      {
        ordinal: 0,
        section: "summary",
        label: null,
        content: "TEMA\n\nDecreto 10\n\nTITULO\n\nRESUMEN DE LA NORMA.",
      },
    ]);
    expect(report).toMatchObject({ summaries: 1, saved: 1, chunks: 1 });
  });

  it("never touches the network with onlyCached", async () => {
    const { deps, requested } = harness(() => page("x"));

    const report = await processTexts([regulation()], deps, { onlyCached: true });

    expect(requested).toEqual([]);
    expect(report).toMatchObject({ failed: 1, failureReasons: { "not in cache": 1 } });
  });

  it("records failures and keeps going", async () => {
    const { deps, saved } = harness((url) =>
      url.includes("/2/")
        ? { ok: false, status: 404, reason: "HTTP 404" }
        : url.includes("/3/")
          ? {
              ok: true,
              bytes: new TextEncoder().encode("<p>Forbidden</p>"),
              contentType: null,
            }
          : page("ARTÍCULO 1°.- Apruébase."),
    );

    const report = await processTexts(
      [1, 2, 3, 4].map((id) =>
        regulation({ id, originalTextUrl: `http://example.test/${id}/norma.htm` }),
      ),
      deps,
    );

    expect([...saved.keys()]).toEqual([1, 4]);
    expect(report.failureReasons).toEqual({ "HTTP 404": 1, "page has no text": 1 });
    expect(report.failedExamples).toEqual([
      { id: 2, reason: "HTTP 404" },
      { id: 3, reason: "page has no text" },
    ]);
    expect(report.aborted).toBeNull();
  });

  it("counts a regulation the database rejects as a failure and goes on", async () => {
    const { deps, saved } = harness(() => page("ARTÍCULO 1°.- Texto de la norma."));
    const save = deps.store.save;
    deps.store.save = async (id, text, chunks) => {
      if (id === 2) throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
      return save(id, text, chunks);
    };

    const report = await processTexts(
      [regulation({ id: 1 }), regulation({ id: 2 }), regulation({ id: 3 })],
      deps,
    );

    expect(report).toMatchObject({ processed: 3, saved: 2, failed: 1 });
    expect(report.failedExamples).toEqual([
      {
        id: 2,
        reason: 'could not save: invalid byte sequence for encoding "UTF8": 0x00',
      },
    ]);
    expect([...saved.keys()]).toEqual([1, 3]);
  });

  it("stops when the server keeps answering 403", async () => {
    const { deps, requested } = harness(() => ({
      ok: false,
      status: 403,
      reason: "HTTP 403",
    }));
    const many = Array.from({ length: 10 }, (_, index) =>
      regulation({ id: index + 1 }),
    );

    const report = await processTexts(many, deps, { maxConsecutiveForbidden: 3 });

    expect(requested).toHaveLength(3);
    expect(report.processed).toBe(3);
    expect(report.aborted).toMatch(/3 consecutive "403 Forbidden"/);
  });

  it("reports progress", async () => {
    const { deps } = harness(() => page("ARTÍCULO 1°.- Apruébase."));
    const progress: [number, number][] = [];

    await processTexts([regulation({ id: 1 }), regulation({ id: 2 })], deps, {
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
