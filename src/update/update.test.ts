import { describe, expect, it } from "vitest";

import type { NewRegulation } from "@/db/schema";
import type { EmbedReport } from "@/embeddings/pipeline";
import type { TextReport } from "@/texts/pipeline";

import type { Snapshot } from "./changes";
import {
  NOTHING_UNFINISHED,
  runUpdate,
  UpdateIncomplete,
  type Unfinished,
  type UpdateDeps,
} from "./update";

/** A row of the dataset, as the CSV gives it. */
const record = (id: number, overrides: Record<string, string> = {}) => ({
  id_norma: String(id),
  tipo_norma: "Ley",
  numero_norma: String(20000 + id),
  clase_norma: "",
  organismo_origen: "HONORABLE CONGRESO DE LA NACION ARGENTINA",
  fecha_sancion: "2020-05-01",
  numero_boletin: "",
  fecha_boletin: "",
  pagina_boletin: "",
  titulo_resumido: "TITULO",
  titulo_sumario: "TEMA",
  texto_resumido: "",
  observaciones: "",
  texto_original: `http://example.test/${id}.htm`,
  texto_actualizado: "",
  modificada_por: "0",
  modifica_a: "0",
  ...overrides,
});

const snapshot = (id: number, overrides: Partial<Snapshot> = {}): Snapshot => ({
  id,
  type: "Ley",
  number: String(20000 + id),
  enactedOn: "2020-05-01",
  topic: "TEMA",
  title: "TITULO",
  summary: null,
  originalTextUrl: `http://example.test/${id}.htm`,
  updatedTextUrl: null,
  amendedByCount: 0,
  ...overrides,
});

const textReport = (overrides: Partial<TextReport> = {}): TextReport => ({
  processed: 0,
  downloaded: 0,
  fromCache: 0,
  summaries: 0,
  unchanged: 0,
  saved: 0,
  chunks: 0,
  failed: 0,
  failureReasons: {},
  failedExamples: [],
  aborted: null,
  ...overrides,
});

const embedReport: EmbedReport = {
  model: "bge-m3",
  total: 0,
  embedded: 0,
  batches: 0,
  skipped: [],
};

async function* rows(...records: Record<string, unknown>[]) {
  for (const value of records) yield value;
}

/** Fakes for every dependency, recording what they were asked to do. */
const fakes = (
  options: {
    records?: Record<string, unknown>[] | null;
    stored?: Snapshot[];
    withoutText?: number[];
    unfinished?: Unfinished;
    texts?: (ids: number[], refetch: boolean) => TextReport;
  } = {},
) => {
  const calls = {
    upserted: [] as NewRegulation[][],
    texts: [] as { ids: number[]; refetch: boolean }[],
    forgotten: [] as number[][],
    embedded: 0,
    saved: [] as Unfinished[],
    committed: 0,
  };

  const deps: UpdateDeps = {
    records: async () =>
      options.records === null ? null : rows(...(options.records ?? [])),
    snapshots: async () =>
      new Map((options.stored ?? []).map((item) => [item.id, item])),
    upsert: async (regulations) => {
      calls.upserted.push(regulations);
    },
    withoutText: async () => options.withoutText ?? [],
    texts: async (ids, { refetch }) => {
      calls.texts.push({ ids, refetch });
      return options.texts?.(ids, refetch) ?? textReport({ processed: ids.length });
    },
    forgetVectors: async (ids) => {
      calls.forgotten.push(ids);
      return ids.length * 3;
    },
    embed: async () => {
      calls.embedded += 1;
      return embedReport;
    },
    unfinished: {
      load: async () => options.unfinished ?? NOTHING_UNFINISHED,
      save: async (work) => {
        calls.saved.push(work);
      },
    },
    commit: async () => {
      calls.committed += 1;
    },
  };

  return { deps, calls };
};

const LAWS = [{ types: ["Ley"], since: null }];

describe("runUpdate", () => {
  it("does nothing but finish pending vectors when the dataset did not change", async () => {
    const { deps, calls } = fakes({ records: null });

    const report = await runUpdate(deps, { subset: LAWS });

    expect(report.dataset).toBeNull();
    expect(calls.upserted).toEqual([]);
    expect(calls.texts).toEqual([]);
    expect(calls.embedded).toBe(1);
    // The dataset state is only written when a new one was loaded.
    expect(calls.committed).toBe(0);
  });

  it("stores new regulations and gets their texts", async () => {
    const { deps, calls } = fakes({
      records: [record(1), record(2)],
      stored: [snapshot(1)],
      withoutText: [2],
    });

    const report = await runUpdate(deps, { subset: LAWS });

    expect(report.dataset).toMatchObject({
      read: 2,
      inSubset: 2,
      unchanged: 1,
      changed: [],
    });
    expect(report.dataset?.added.map((regulation) => regulation.id)).toEqual([2]);
    expect(calls.upserted.flat().map((regulation) => regulation.id)).toEqual([2]);
    expect(calls.texts).toEqual([{ ids: [2], refetch: false }]);
    expect(calls.embedded).toBe(1);
    expect(calls.committed).toBe(1);
  });

  it("leaves out what the subset does not keep, and what the dataset gets wrong", async () => {
    const { deps, calls } = fakes({
      records: [
        record(1),
        record(2, { tipo_norma: "Resolución" }),
        record(3, { fecha_sancion: "2020-02-30" }),
      ],
    });

    const report = await runUpdate(deps, { subset: LAWS });

    expect(report.dataset).toMatchObject({ read: 3, rejected: 1, inSubset: 1 });
    expect(calls.upserted.flat().map((regulation) => regulation.id)).toEqual([1]);
  });

  it("downloads again the page of a regulation whose text may have changed", async () => {
    const { deps, calls } = fakes({
      records: [
        record(1, {
          modificada_por: "2",
          texto_actualizado: "http://example.test/1-act.htm",
        }),
      ],
      stored: [snapshot(1)],
    });

    await runUpdate(deps, { subset: LAWS });

    expect(calls.upserted.flat()).toMatchObject([
      { id: 1, amendedByCount: 2, updatedTextUrl: "http://example.test/1-act.htm" },
    ]);
    expect(calls.texts).toEqual([{ ids: [1], refetch: true }]);
    expect(calls.forgotten).toEqual([]);
  });

  it("redoes the vectors, and a summary built from it, when only the heading changed", async () => {
    const { deps, calls } = fakes({
      records: [record(1, { titulo_resumido: "OTRO TITULO" })],
      stored: [snapshot(1)],
    });

    const report = await runUpdate(deps, { subset: LAWS });

    expect(calls.texts).toEqual([{ ids: [1], refetch: false }]);
    expect(calls.forgotten).toEqual([[1]]);
    expect(report.done?.vectorsForgotten).toBe(3);
  });

  it("writes the work down before changing the database, and clears it at the end", async () => {
    const { deps, calls } = fakes({
      records: [
        record(1, { modificada_por: "1" }),
        record(2, { titulo_sumario: "OTRO TEMA" }),
        record(3, { modificada_por: "1", titulo_resumido: "X" }),
      ],
      stored: [snapshot(1), snapshot(2), snapshot(3)],
    });

    await runUpdate(deps, { subset: LAWS });

    expect(calls.saved).toEqual([
      { refetch: [1, 3], rechunk: [2], revector: [2, 3] },
      NOTHING_UNFINISHED,
    ]);
  });

  it("finishes what an update left undone, even with no new dataset", async () => {
    const { deps, calls } = fakes({
      records: null,
      unfinished: { refetch: [7], rechunk: [8], revector: [8] },
    });

    const report = await runUpdate(deps, { subset: LAWS });

    expect(report.resumed).toEqual({ refetch: [7], rechunk: [8], revector: [8] });
    expect(calls.texts).toEqual([
      { ids: [7], refetch: true },
      { ids: [8], refetch: false },
    ]);
    expect(calls.forgotten).toEqual([[8]]);
    expect(calls.saved.at(-1)).toEqual(NOTHING_UNFINISHED);
  });

  it("joins the work left undone with the new, without repeating anything", async () => {
    const { deps, calls } = fakes({
      records: [record(1, { modificada_por: "1" }), record(2, { modificada_por: "1" })],
      stored: [snapshot(1), snapshot(2)],
      unfinished: { refetch: [2, 9], rechunk: [], revector: [] },
    });

    await runUpdate(deps, { subset: LAWS });

    expect(calls.texts).toEqual([{ ids: [1, 2, 9], refetch: true }]);
  });

  it("stops and keeps the work when the server refuses the pages", async () => {
    const { deps, calls } = fakes({
      records: [record(1, { modificada_por: "1" })],
      stored: [snapshot(1)],
      texts: () => textReport({ aborted: "5 consecutive 403 responses" }),
    });

    await expect(runUpdate(deps, { subset: LAWS })).rejects.toThrow(UpdateIncomplete);

    expect(calls.saved).toEqual([{ refetch: [1], rechunk: [], revector: [] }]);
    expect(calls.embedded).toBe(0);
    expect(calls.committed).toBe(0);
  });

  it("keeps the work when embedding fails, and does not take the dataset as loaded", async () => {
    const { deps, calls } = fakes({
      records: [record(1, { titulo_sumario: "OTRO" })],
      stored: [snapshot(1)],
    });
    deps.embed = async () => {
      throw new Error("Ollama is not running");
    };

    await expect(runUpdate(deps, { subset: LAWS })).rejects.toThrow("Ollama");

    expect(calls.saved).toEqual([{ refetch: [], rechunk: [1], revector: [1] }]);
    expect(calls.committed).toBe(0);
  });

  it("only reports when checking: nothing is written", async () => {
    const { deps, calls } = fakes({
      records: [record(1, { modificada_por: "1" }), record(2)],
      stored: [snapshot(1)],
      unfinished: { refetch: [5], rechunk: [], revector: [] },
    });

    const report = await runUpdate(deps, { subset: LAWS, check: true });

    expect(report.dataset?.changed.map((change) => change.id)).toEqual([1]);
    expect(report.dataset?.added.map((regulation) => regulation.id)).toEqual([2]);
    expect(report.resumed.refetch).toEqual([5]);
    expect(report.done).toBeUndefined();
    expect(calls).toMatchObject({
      upserted: [],
      texts: [],
      forgotten: [],
      embedded: 0,
      saved: [],
      committed: 0,
    });
  });

  it("writes in batches", async () => {
    const { deps, calls } = fakes({ records: [record(1), record(2), record(3)] });

    await runUpdate(deps, { subset: LAWS, batchSize: 2 });

    expect(calls.upserted.map((batch) => batch.length)).toEqual([2, 1]);
  });

  it("keeps a row that matches any of the filters", async () => {
    const { deps } = fakes({
      records: [
        record(1),
        record(2, { tipo_norma: "Decreto", fecha_sancion: "2026-01-10" }),
        record(3, { tipo_norma: "Decreto", fecha_sancion: "2019-01-10" }),
      ],
    });

    const report = await runUpdate(deps, {
      subset: [...LAWS, { types: ["Decreto"], since: "2021-10-01" }],
      check: true,
    });

    expect(report.dataset?.added.map((regulation) => regulation.id)).toEqual([1, 2]);
  });
});
