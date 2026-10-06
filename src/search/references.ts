/**
 * A regulation cited by its number inside a question: "Ley 27.818",
 * "Decreto N° 833/2026", "DNU 70/23", "Decreto-Ley 1285/58".
 */
export type RegulationReference = {
  /** Regulation type as InfoLEG names it: "Ley", "Decreto"... */
  type: string;
  /** The number without separators: "27818". */
  number: string;
  /** Year of enactment, when the citation gives one. Never set for laws. */
  year?: number;
};

/** At most this many citations are honoured per question. */
export const MAX_REFERENCES = 3;

// How people write each type, and the name InfoLEG gives it.
const TYPES: [pattern: string, type: string][] = [
  // Before "decreto" and "ley": it contains both words.
  ["decreto[\\s/-]*ley", "Decreto/Ley"],
  ["ley", "Ley"],
  ["decreto\\s+de\\s+necesidad\\s+y\\s+urgencia", "Decreto"],
  ["decreto", "Decreto"],
  ["dnu", "Decreto"],
  ["dto\\.?", "Decreto"],
  ["decisi[oó]n\\s+administrativa", "Decisión Administrativa"],
  ["resoluci[oó]n", "Resolución"],
  ["disposici[oó]n", "Disposición"],
];

const TYPE = TYPES.map(([pattern]) => pattern).join("|");
// "N°", "Nº", "Nro.", "No.", "núm.", "número"
const NUMBER_SIGN = "(?:n(?:ro|o|[uú]m(?:ero)?)?\\.?\\s*[°º]?\\s*)?";
// "27818", "27.818"
const NUMBER = "(\\d{1,3}(?:\\.\\d{3})+|\\d+)";
// "/2026", "/26", "de 2026", "del año 2026". The worded form needs four digits:
// in "Decreto 50 del 19 de diciembre de 2019", 19 is a day, not a year.
const YEAR =
  "(?:\\s*/\\s*(\\d{4}|\\d{2})(?![\\d/])|\\s+del?\\s+(?:a[ñn]o\\s+)?(\\d{4})(?!\\d))?";

const CITATION = new RegExp(
  `(?<![\\p{L}\\d])(${TYPE})\\s*${NUMBER_SIGN}${NUMBER}(?![\\d.]*\\d)${YEAR}`,
  "giu",
);

const typeOf = (written: string): string => {
  const text = written.toLowerCase();
  const match = TYPES.find(([pattern]) => new RegExp(`^${pattern}$`, "iu").test(text));
  // CITATION only matches what TYPES lists, so there is always a match.
  return match?.[1] ?? written;
};

/** "26" → 2026, "98" → 1998, "2026" → 2026. */
const fullYear = (written: string, today: Date): number => {
  const value = Number.parseInt(written, 10);
  if (written.length === 4) return value;

  const century = Math.floor(today.getFullYear() / 100) * 100;
  return value <= today.getFullYear() % 100 ? century + value : century - 100 + value;
};

/**
 * Finds the regulations a question cites by number.
 *
 * A type word is required ("Decreto 833/2026"): a bare "12/2025" may just as
 * well be a month, and a wrong guess would put an unrelated regulation first.
 */
export function findReferences(
  query: string,
  today = new Date(),
): RegulationReference[] {
  const references: RegulationReference[] = [];

  for (const match of query.matchAll(CITATION)) {
    const [, writtenType, writtenNumber, slashYear, wordedYear] = match;
    if (!writtenType || !writtenNumber) continue;

    const type = typeOf(writtenType.replace(/\s+/g, " "));
    const number = writtenNumber.replace(/\./g, "").replace(/^0+(?=\d)/, "");
    const writtenYear = slashYear ?? wordedYear;

    const reference: RegulationReference = { type, number };
    // Laws are numbered once and for all: a year adds nothing and may be the
    // year of publication rather than of enactment.
    if (writtenYear && type !== "Ley") reference.year = fullYear(writtenYear, today);

    const repeated = references.some(
      (other) =>
        other.type === reference.type &&
        other.number === reference.number &&
        other.year === reference.year,
    );
    if (!repeated) references.push(reference);
    if (references.length === MAX_REFERENCES) break;
  }

  return references;
}
