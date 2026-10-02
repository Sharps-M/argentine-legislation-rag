import { z } from "zod";

import type { NewRegulation } from "@/db/schema";

/** Column names of the InfoLEG "Base de Normativa Nacional" CSV. */
export const INFOLEG_COLUMNS = [
  "id_norma",
  "tipo_norma",
  "numero_norma",
  "clase_norma",
  "organismo_origen",
  "fecha_sancion",
  "numero_boletin",
  "fecha_boletin",
  "pagina_boletin",
  "titulo_resumido",
  "titulo_sumario",
  "texto_resumido",
  "observaciones",
  "texto_original",
  "texto_actualizado",
  "modificada_por",
  "modifica_a",
] as const;

const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

const optionalText = z.preprocess(blankToNull, z.string().trim().nullable());

const optionalInteger = z.preprocess(
  blankToNull,
  z.coerce.number().int().nonnegative().nullable(),
);

const count = z.preprocess(
  (value) => blankToNull(value) ?? 0,
  z.coerce.number().int().nonnegative(),
);

const isRealDate = (value: string) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
};

const optionalDate = z.preprocess(
  blankToNull,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .refine(isRealDate, "not a calendar date")
    .nullable(),
);

const optionalUrl = z.preprocess(
  blankToNull,
  z.url({ protocol: /^https?$/ }).nullable(),
);

const infolegRowSchema = z.object({
  id_norma: z.coerce.number().int().positive(),
  tipo_norma: z.string().trim().min(1),
  numero_norma: optionalText,
  clase_norma: optionalText,
  organismo_origen: optionalText,
  fecha_sancion: optionalDate,
  numero_boletin: optionalInteger,
  fecha_boletin: optionalDate,
  pagina_boletin: optionalInteger,
  titulo_resumido: optionalText,
  titulo_sumario: optionalText,
  texto_resumido: optionalText,
  observaciones: optionalText,
  texto_original: optionalUrl,
  texto_actualizado: optionalUrl,
  modificada_por: count,
  modifica_a: count,
});

export type RowResult =
  { ok: true; regulation: NewRegulation } | { ok: false; reasons: string[] };

/**
 * Validates one raw CSV record and maps it to a `regulations` row.
 *
 * Invalid rows are reported, not thrown: one bad record must not abort an
 * ingestion of hundreds of thousands. Each reason names the offending column.
 */
export function parseInfolegRow(raw: Record<string, unknown>): RowResult {
  const result = infolegRowSchema.safeParse(raw);

  if (!result.success) {
    return {
      ok: false,
      reasons: result.error.issues.map(
        (issue) => `${issue.path.join(".") || "(row)"}: ${issue.message}`,
      ),
    };
  }

  const row = result.data;

  return {
    ok: true,
    regulation: {
      id: row.id_norma,
      type: row.tipo_norma,
      number: row.numero_norma,
      class: row.clase_norma,
      issuingBody: row.organismo_origen,
      enactedOn: row.fecha_sancion,
      gazetteNumber: row.numero_boletin,
      gazetteDate: row.fecha_boletin,
      gazettePage: row.pagina_boletin,
      title: row.titulo_resumido,
      topic: row.titulo_sumario,
      summary: row.texto_resumido,
      notes: row.observaciones,
      originalTextUrl: row.texto_original,
      updatedTextUrl: row.texto_actualizado,
      amendedByCount: row.modificada_por,
      amendsCount: row.modifica_a,
    },
  };
}
