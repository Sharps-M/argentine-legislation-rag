import { MAX_QUERY_LENGTH } from "@/search/params";

/**
 * Words people use are not always the words of the law. Asked for
 * "normativas relacionadas con mascotas", the search finds animal health: the
 * laws on cruelty to animals and on rabies never say "mascota". When the
 * sources found do not answer, the model is asked once for the question in the
 * words a regulation would use, and the search runs again with them.
 *
 * Always in Spanish: that is the language of the corpus, whatever the language
 * of the question and of the answer.
 */
export const REWRITE_INSTRUCTIONS = `
Usted ayuda a buscar en la legislación nacional argentina. Una búsqueda con las palabras de la pregunta no encontró normas que la respondan.

Reescriba la pregunta como una búsqueda:
1. Use las palabras que usaría el texto de una ley o un decreto, no las de la conversación cotidiana. Sume los términos jurídicos o técnicos equivalentes; por ejemplo, para "jubilados": beneficiarios del régimen previsional, haber mínimo, movilidad.
2. Conserve tal como están los números de normas, las fechas y los montos.
3. No responda la pregunta ni agregue datos que no estén en ella.
4. Escriba en español, en una sola línea, sin comillas ni explicaciones.
`.trim();

/** A model's rewrite as a search: its first line, without decoration. */
export function toSearchQuery(text: string): string {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0) ?? "";

  // Quotes, asterisks and backticks around it.
  const unwrap = (text: string) => text.replace(/^[\s"'`*«»“”]+|[\s"'`*«»“”]+$/gu, "");

  return unwrap(
    // "Búsqueda: ...", the label a model may put before it.
    unwrap(line).replace(/^(?:b[uú]squeda|consulta|search|query)\s*:\s*/iu, ""),
  )
    .replace(/\s+/g, " ")
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
}

const comparable = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, " ")
    .trim();

/** Whether a rewrite says anything the question did not: otherwise there is nothing to search again. */
export const isNewQuery = (query: string, question: string): boolean =>
  comparable(query).length > 0 && comparable(query) !== comparable(question);
