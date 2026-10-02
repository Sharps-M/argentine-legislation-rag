import { describe, expect, it } from "vitest";

import type { NewRegulation } from "@/db/schema";

import { ingestRegulations, type RegulationStore } from "./ingest";

const raw = (overrides: Record<string, string> = {}) => ({
  id_norma: "1",
  tipo_norma: "Ley",
  numero_norma: "27000",
  clase_norma: "",
  organismo_origen: "",
  fecha_sancion: "2023-05-10",
  numero_boletin: "",
  fecha_boletin: "",
  pagina_boletin: "",
  titulo_resumido: "",
  titulo_sumario: "",
  texto_resumido: "",
  observaciones: "",
  texto_original: "",
  texto_actualizado: "",
  modificada_por: "",
  modifica_a: "",
  ...overrides,
});

async function* stream(rows: Record<string, string>[]) {
  yield* rows;
}

const memoryStore = () => {
  const batches: NewRegulation[][] = [];
  const store: RegulationStore = {
    upsertMany: async (regulations) => {
      batches.push(regulations);
    },
  };
  return { store, batches };
};

const everything = { types: [], since: null };

describe("ingestRegulations", () => {
  it("stores the selected rows and reports what happened to the rest", async () => {
    const { store, batches } = memoryStore();

    const report = await ingestRegulations(
      stream([
        raw({ id_norma: "1", tipo_norma: "Ley", fecha_sancion: "2023-05-10" }),
        raw({ id_norma: "2", tipo_norma: "Decreto", fecha_sancion: "2024-01-02" }),
        raw({ id_norma: "3", tipo_norma: "Resolución", fecha_sancion: "2024-01-02" }),
        raw({ id_norma: "4", tipo_norma: "Ley", fecha_sancion: "2010-01-01" }),
        raw({ id_norma: "x", tipo_norma: "Ley" }),
      ]),
      store,
      { filter: { types: ["Ley", "Decreto"], since: "2021-01-01" } },
    );

    expect(batches.flat().map((regulation) => regulation.id)).toEqual([1, 2]);
    expect(report).toMatchObject({
      read: 5,
      rejected: 1,
      filteredOut: 2,
      selected: 2,
      byType: { Ley: 1, Decreto: 1 },
      byYear: { "2023": 1, "2024": 1 },
    });
    expect(report.rejectedExamples).toEqual([
      { line: 6, id: "x", reasons: [expect.stringContaining("id_norma")] },
    ]);
    expect(Object.values(report.rejectionReasons)).toEqual([1]);
  });

  it("writes in batches and flushes the last partial one", async () => {
    const { store, batches } = memoryStore();
    const rows = Array.from({ length: 5 }, (_, index) =>
      raw({ id_norma: String(index + 1) }),
    );

    await ingestRegulations(stream(rows), store, { filter: everything, batchSize: 2 });

    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it("stops at the limit", async () => {
    const { store, batches } = memoryStore();
    const rows = Array.from({ length: 10 }, (_, index) =>
      raw({ id_norma: String(index + 1) }),
    );

    const report = await ingestRegulations(stream(rows), store, {
      filter: everything,
      limit: 3,
    });

    expect(report.selected).toBe(3);
    expect(batches.flat()).toHaveLength(3);
  });

  it("produces the same report on a dry run without a store", async () => {
    const report = await ingestRegulations(
      stream([raw(), raw({ id_norma: "2" })]),
      null,
      {
        filter: everything,
      },
    );

    expect(report.selected).toBe(2);
  });

  it("caps the rejected examples but counts every rejection", async () => {
    const rows = Array.from({ length: 5 }, () => raw({ id_norma: "bad" }));

    const report = await ingestRegulations(stream(rows), null, {
      filter: everything,
      maxRejectedExamples: 2,
    });

    expect(report.rejected).toBe(5);
    expect(report.rejectedExamples).toHaveLength(2);
  });
});
