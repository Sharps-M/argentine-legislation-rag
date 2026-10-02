import { describe, expect, it } from "vitest";

import { parseInfolegRow } from "./infoleg-row";

const row = (overrides: Record<string, string> = {}) => ({
  id_norma: "1001",
  tipo_norma: "Ley",
  numero_norma: "27000",
  clase_norma: "",
  organismo_origen: "HONORABLE CONGRESO DE LA NACION ARGENTINA",
  fecha_sancion: "2023-05-10",
  numero_boletin: "35100",
  fecha_boletin: "2023-05-20",
  pagina_boletin: "3",
  titulo_resumido: "TITULO DE PRUEBA",
  titulo_sumario: "TEMA DE PRUEBA",
  texto_resumido: "RESUMEN DE PRUEBA.",
  observaciones: "",
  texto_original:
    "http://servicios.infoleg.gob.ar/infolegInternet/anexos/1000-1999/1001/norma.htm",
  texto_actualizado: "",
  modificada_por: "2",
  modifica_a: "",
  ...overrides,
});

describe("parseInfolegRow", () => {
  it("maps a complete row to a regulation", () => {
    const result = parseInfolegRow(row());

    expect(result).toEqual({
      ok: true,
      regulation: {
        id: 1001,
        type: "Ley",
        number: "27000",
        class: null,
        issuingBody: "HONORABLE CONGRESO DE LA NACION ARGENTINA",
        enactedOn: "2023-05-10",
        gazetteNumber: 35100,
        gazetteDate: "2023-05-20",
        gazettePage: 3,
        title: "TITULO DE PRUEBA",
        topic: "TEMA DE PRUEBA",
        summary: "RESUMEN DE PRUEBA.",
        notes: null,
        originalTextUrl:
          "http://servicios.infoleg.gob.ar/infolegInternet/anexos/1000-1999/1001/norma.htm",
        updatedTextUrl: null,
        amendedByCount: 2,
        amendsCount: 0,
      },
    });
  });

  it("turns blank optional fields into null and blank counters into zero", () => {
    const result = parseInfolegRow(
      row({
        numero_norma: "  ",
        fecha_sancion: "",
        numero_boletin: "",
        texto_original: "",
        modificada_por: "",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.regulation).toMatchObject({
      number: null,
      enactedOn: null,
      gazetteNumber: null,
      originalTextUrl: null,
      amendedByCount: 0,
    });
  });

  it("keeps unnumbered regulations", () => {
    const result = parseInfolegRow(row({ numero_norma: "S/N" }));

    expect(result.ok && result.regulation.number).toBe("S/N");
  });

  it.each([
    ["id_norma", "abc"],
    ["id_norma", "0"],
    ["tipo_norma", ""],
    ["fecha_sancion", "03/11/2022"],
    ["fecha_sancion", "2022-02-30"],
    ["numero_boletin", "treinta"],
    ["texto_original", "norma.htm"],
    ["texto_original", "javascript:alert(1)"],
  ])("rejects %s = %j and names the column", (column, value) => {
    const result = parseInfolegRow(row({ [column]: value }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.join(" ")).toContain(column);
  });

  it("rejects a row with a missing column", () => {
    const incomplete: Record<string, string> = row();
    delete incomplete.tipo_norma;

    expect(parseInfolegRow(incomplete).ok).toBe(false);
  });
});
