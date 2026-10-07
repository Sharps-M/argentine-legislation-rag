/**
 * - `topic`: describes what the regulation is about, in everyday words.
 * - `reference`: names the regulation by its number.
 * - `english`: asked in English, to check cross-language retrieval.
 * - `earlier`: asks for one regulation of a series (decrees reissued or
 *   amended every few months) that is not the latest one. It measures what
 *   grouping the versions of a provision costs: the answer must not end up
 *   hidden under a newer look-alike.
 * - `absent`: about a subject the corpus does not cover. The right outcome is
 *   no result at all.
 */
export type QuestionKind = "topic" | "reference" | "english" | "earlier" | "absent";

export type GoldQuestion = {
  question: string;
  kind: QuestionKind;
  /** InfoLEG ids of the regulations that answer the question; none for `absent`. */
  expected: number[];
};

/**
 * Regulations the questions point to that are not kept as test fixtures. Each
 * was read on InfoLEG before its question was written: the laws on 2026-10-06,
 * the decrees on 2026-10-07.
 */
export const READ_ONLINE: Record<number, string> = {
  153011: "Ley 14346",
  184650: "Ley 22953",
  268503: "Ley 27330",
  421033: "Decreto 866/2025",
  427139: "Decreto 552/2026",
  427190: "Decreto 565/2026",
  427568: "Decreto 581/2026",
  428716: "Decreto 718/2026",
};

/**
 * Questions with a known answer, used to measure the retrieval.
 *
 * Each one was written by reading the regulation it points to. Most cover the
 * nine regulations kept as test fixtures (`tests/fixtures/html/`), so their
 * expected answer can be checked against a file in the repository; the others
 * are listed in `READ_ONLINE`.
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
  // Decreto 718/2026 replaced its article 1: either one answers the question.
  {
    question:
      "¿A dónde va lo producido por la venta del material rodante de Belgrano Cargas?",
    kind: "topic",
    expected: [425217, 428716],
  },
  {
    question: "Decreto 282/2026",
    kind: "reference",
    expected: [425217],
  },

  // Decreto 269/2026: structure of the Jefatura de Gabinete de Ministros.
  // Decreto 581/2026 states the objectives of that Secretaría again.
  {
    question:
      "Objetivos de la Secretaría de Innovación, Ciencia y Tecnología en materia de ciberseguridad",
    kind: "topic",
    expected: [425100, 427568],
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

  // Animal laws, older than any of the fixtures. They entered the corpus when
  // it was extended to every law (docs/decisiones.md, 29).
  // Ley 14346 (1954): penalties for mistreating animals.
  {
    question: "¿Qué pena tiene el maltrato o la crueldad contra los animales?",
    kind: "topic",
    expected: [153011],
  },
  // Ley 27330 (2016): dog racing banned.
  {
    question: "Prohibición de las carreras de galgos",
    kind: "topic",
    expected: [268503],
  },
  // Ley 22953 (1983): rabies control.
  {
    question: "Vacunación antirrábica obligatoria de perros y gatos",
    kind: "topic",
    expected: [184650],
  },
  // A broad question: any of the three is a right answer.
  {
    question: "Normativas relacionadas con mascotas",
    kind: "topic",
    expected: [153011, 268503, 184650],
  },

  // One issue of a series, asked for by its date. Each has a later issue among
  // the questions above, with nearly the same text.
  // Decreto 565/2026: the SINEP agreement before the one of Decreto 833/2026.
  {
    question:
      "Homologación del acta acuerdo del 28 de mayo de 2026 del convenio colectivo sectorial del SINEP",
    kind: "earlier",
    expected: [427190],
  },
  // Decreto 552/2026: the cap that Decreto 832/2026 raised two months later.
  {
    question:
      "Tope de la retribución de los agentes habilitados para realizar servicios extraordinarios a partir del 1° de junio de 2026",
    kind: "earlier",
    expected: [427139],
  },
  // Decreto 866/2025: one of many amendments to the organisation chart of
  // Decreto 50/2019. Decreto 581/2026 is a later one, about other offices.
  // A known miss: the model does not rank it among the first twenty, with or
  // without the index (docs/evaluacion.md).
  {
    question:
      "Decreto que suprime la Secretaría de Comunicación y Medios del organigrama de la Administración Nacional",
    kind: "earlier",
    expected: [421033],
  },

  // Subjects without a regulation in the corpus. Neutering is regulated by a
  // decree from 2011, and only decrees of the last five years are loaded. The
  // rest are not legal subjects at all.
  { question: "Castrar perros", kind: "absent", expected: [] },
  {
    question: "Reglas del ajedrez para torneos escolares",
    kind: "absent",
    expected: [],
  },
  { question: "Receta de empanadas salteñas", kind: "absent", expected: [] },
  {
    question: "Tabla de posiciones del campeonato de fútbol",
    kind: "absent",
    expected: [],
  },
  { question: "Cómo configurar un router wifi", kind: "absent", expected: [] },
];
