/**
 * - `topic`: describes what the regulation is about, in everyday words.
 * - `reference`: names the regulation by its number.
 * - `english`: asked in English, to check cross-language retrieval.
 */
export type QuestionKind = "topic" | "reference" | "english";

export type GoldQuestion = {
  question: string;
  kind: QuestionKind;
  /** InfoLEG ids of the regulations that answer the question. */
  expected: number[];
};

/**
 * Questions with a known answer, used to measure the retrieval.
 *
 * Each one was written by reading the regulation it points to. They cover the
 * nine regulations kept as test fixtures (`tests/fixtures/html/`), so every
 * expected answer can be checked against a file in the repository.
 */
export const GOLD_QUESTIONS: GoldQuestion[] = [
  // Ley 27817: social security agreement with San Marino.
  {
    question: "¿Qué ley aprueba el convenio de seguridad social con San Marino?",
    kind: "topic",
    expected: [427766],
  },
  {
    question: "Social security agreement between Argentina and San Marino",
    kind: "english",
    expected: [427766],
  },

  // Ley 27814: amendment to the double taxation treaty with France.
  {
    question:
      "Protocolo de enmienda al convenio con Francia para evitar la doble imposición",
    kind: "topic",
    expected: [427760],
  },
  {
    question: "Which law approves the amendment to the tax treaty with France?",
    kind: "english",
    expected: [427760],
  },

  // Ley 27818: settlement agreements with creditors.
  {
    question: "Acuerdo de conciliación con Bainbridge y los acreedores de Attestor",
    kind: "topic",
    expected: [427187],
  },
  {
    question: "¿Qué dispone la Ley 27818?",
    kind: "reference",
    expected: [427187],
  },

  // Decreto 282/2026: proceeds of the Belgrano Cargas rolling stock sale.
  {
    question:
      "¿A dónde va lo producido por la venta del material rodante de Belgrano Cargas?",
    kind: "topic",
    expected: [425217],
  },
  {
    question: "Decreto 282/2026",
    kind: "reference",
    expected: [425217],
  },

  // Decreto 269/2026: structure of the Jefatura de Gabinete de Ministros.
  {
    question:
      "Objetivos de la Secretaría de Innovación, Ciencia y Tecnología en materia de ciberseguridad",
    kind: "topic",
    expected: [425100],
  },
  {
    question:
      "Estructura organizativa de primer nivel operativo de la Jefatura de Gabinete de Ministros",
    kind: "topic",
    expected: [425100],
  },

  // Decreto 829/2026: fuel taxes.
  {
    question:
      "Prórroga hasta septiembre de 2026 del incremento del impuesto sobre los combustibles líquidos y al dióxido de carbono",
    kind: "topic",
    expected: [429381],
  },
  {
    question: "Decreto 829/2026 sobre combustibles",
    kind: "reference",
    expected: [429381],
  },

  // Decreto 832/2026: collective agreement for the national public administration.
  {
    question:
      "Remuneraciones de los profesionales residentes del Hospital Garrahan desde septiembre de 2026",
    kind: "topic",
    expected: [429383],
  },
  {
    question:
      "Tope de la retribución de los agentes habilitados para realizar servicios extraordinarios",
    kind: "topic",
    expected: [429383],
  },

  // Decreto 833/2026: SINEP sectoral agreement.
  {
    question:
      "Homologación del acta acuerdo del 25 de agosto de 2026 del convenio colectivo sectorial del SINEP",
    kind: "topic",
    expected: [429384],
  },
  {
    question: "Decreto 833/2026",
    kind: "reference",
    expected: [429384],
  },

  // Decreto 834/2026: pay of several public bodies.
  {
    question:
      "Retribución de los cargos de la Escuela Nacional de Bibliotecarios y del bedel del ISER",
    kind: "topic",
    expected: [429385],
  },
  {
    question:
      "Adicional por prestación de servicios en la Antártida para el personal militar",
    kind: "topic",
    expected: [429385],
  },
];
