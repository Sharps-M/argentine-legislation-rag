/**
 * A date as a question or a regulation writes it: "1° de junio de 2026",
 * "28 de mayo de 2026", "June 1, 2026", "01/06/2026". A month and a year with
 * no day ("junio de 2026") is a date too.
 *
 * Dates are compared as written because the embeddings do not tell them apart:
 * two issues of one decree that differ in a month score a few thousandths from
 * each other.
 */
export type WrittenDate = { year: number; month: number; day?: number };

const SPANISH_MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "sep?tiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const ENGLISH_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const NOT_AFTER_A_WORD = "(?<![\\p{L}\\d])";
const NOT_BEFORE_A_DIGIT = "(?!\\d)";

// "1° de junio de 2026", "1ro de junio del 2026", "28 de mayo de 2026",
// "junio de 2026", "junio 2026"
const SPANISH = new RegExp(
  `${NOT_AFTER_A_WORD}(?:(\\d{1,2})\\s*(?:[°º]|ro|ero|er)?\\s+de\\s+)?(${SPANISH_MONTHS.join("|")})(?:\\s+del?)?\\s+(\\d{4})${NOT_BEFORE_A_DIGIT}`,
  "giu",
);

// "June 1, 2026", "1 June 2026", "1st of June 2026", "June 2026"
const ENGLISH = new RegExp(
  `${NOT_AFTER_A_WORD}(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?)?(${ENGLISH_MONTHS.join("|")})(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?,?\\s+(?:of\\s+)?(\\d{4})${NOT_BEFORE_A_DIGIT}`,
  "giu",
);

// "01/06/2026", "1-6-2026": day first, as it is written in Argentina.
const NUMERIC = /(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?![\d/-])/g;

const monthOf = (written: string, names: readonly string[]): number =>
  names.findIndex((name) => new RegExp(`^${name}$`, "i").test(written)) + 1;

const isDate = ({ year, month, day }: WrittenDate) =>
  year >= 1800 &&
  year <= 2100 &&
  month >= 1 &&
  month <= 12 &&
  (day === undefined || (day >= 1 && day <= 31));

const sameDate = (a: WrittenDate, b: WrittenDate) =>
  a.year === b.year && a.month === b.month && a.day === b.day;

/** Every date written in a text, once each, in the order they appear. */
export function findDates(text: string): WrittenDate[] {
  const found: { at: number; date: WrittenDate }[] = [];
  const day = (written: string | undefined) =>
    written === undefined ? undefined : Number(written);

  for (const match of text.matchAll(SPANISH)) {
    found.push({
      at: match.index,
      date: {
        year: Number(match[3]),
        month: monthOf(match[2]!, SPANISH_MONTHS),
        day: day(match[1]),
      },
    });
  }
  for (const match of text.matchAll(ENGLISH)) {
    found.push({
      at: match.index,
      date: {
        year: Number(match[4]),
        month: monthOf(match[2]!, ENGLISH_MONTHS),
        day: day(match[1] ?? match[3]),
      },
    });
  }
  for (const match of text.matchAll(NUMERIC)) {
    found.push({
      at: match.index,
      date: {
        year: Number(match[3]),
        month: Number(match[2]),
        day: Number(match[1]),
      },
    });
  }

  const dates: WrittenDate[] = [];
  for (const { date } of found.sort((a, b) => a.at - b.at)) {
    if (isDate(date) && !dates.some((known) => sameDate(known, date))) {
      dates.push(date);
    }
  }
  return dates;
}

/**
 * Whether a text states one of the dates asked for. A date asked without a day
 * ("junio de 2026") is stated by any day of that month.
 */
export function statesDate(text: string, asked: readonly WrittenDate[]): boolean {
  // Most questions name no date: do not read the text for nothing.
  if (asked.length === 0) return false;

  const written = findDates(text);
  return asked.some((date) =>
    written.some(
      (other) =>
        other.year === date.year &&
        other.month === date.month &&
        (date.day === undefined || other.day === date.day),
    ),
  );
}
