import type { AnswerSource } from "./sources";

// "$1.598.124", "$ 444.829", "$ 10,572", "U$S 1.500". Argentine figures use a
// dot for thousands and a comma for decimals; a model answering in English may
// swap them, so both are accepted here and told apart nowhere (see `digitsOf`).
const AMOUNT =
  /(?:U\$S|US\$|USD|\$)\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?)/g;

// The citations that come right after a statement: "[1]", "[1][3]", "[1, 3]".
const NEXT_CITATIONS = /(?:\[\d{1,3}(?:\s*,\s*\d{1,3})*\]\s*)+/;

/**
 * The figure without its separators: "$1.598.124", "$ 1.598.124" and
 * "$1,598,124" are the same amount written three ways.
 *
 * The price of ignoring separators is that "$10,572" and "$10.572" look alike
 * too. A wrong separator is a slip of format; this check is after figures that
 * are not in the source at all.
 */
const digitsOf = (written: string) => written.replace(/\D/g, "");

/** Every amount of money written in a text, as figures only. */
export function findAmounts(text: string): string[] {
  return [...text.matchAll(AMOUNT)].map((match) => digitsOf(match[1] ?? ""));
}

// Any figure, with or without a currency sign in front.
const FIGURE = /\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?/g;

/**
 * Every figure a source states. Wider than `findAmounts` on purpose: a table
 * may give its amounts in a column, with the sign only in the heading, and an
 * amount the source does state must not be reported as missing.
 */
const figuresIn = (text: string) =>
  new Set((text.match(FIGURE) ?? []).map((figure) => digitsOf(figure)));

/**
 * From this many digits on, a figure is its own evidence: "1598124" does not
 * turn up in a text by chance. A shorter one does ("artículo 30", "30 días"),
 * so it only counts where the source writes it as money.
 */
const DISTINCTIVE_DIGITS = 4;

/**
 * - `supported`: the source cited right after the amount states it.
 * - `other_source`: one of the sources states it, but not the one cited, or the
 *   answer cites none for it. The figure is real; the reference is not.
 * - `not_found`: no source states it. It was miscopied, worked out, or made up.
 */
export type AmountStatus = "supported" | "other_source" | "not_found";

export type AmountCheck = {
  /** As the answer wrote it: "$1.598.124". */
  amount: string;
  /** Sources the answer cites for it: the first citations after it, on its line. */
  cited: number[];
  /** Sources whose text states it. */
  foundIn: number[];
  status: AmountStatus;
};

/**
 * Checks every amount of money in an answer against the sources it was given.
 *
 * A citation only says where a statement claims to come from. This looks at
 * the one part of a statement that can be compared without understanding it:
 * a figure is in the source, or it is not.
 *
 * It covers amounts written with a currency sign. Percentages, dates and
 * amounts spelled out in words are not checked.
 */
export function checkAmounts(
  answer: string,
  sources: readonly AnswerSource[],
): AmountCheck[] {
  const stated = sources.map((source) => ({
    n: source.n,
    money: new Set(findAmounts(source.content)),
    figures: figuresIn(source.content),
  }));
  const known = new Set(sources.map((source) => source.n));

  const checks: AmountCheck[] = [];

  // A citation belongs to its own line: a list item, or a paragraph.
  for (const line of answer.split("\n")) {
    for (const match of line.matchAll(AMOUNT)) {
      const digits = digitsOf(match[1] ?? "");
      const after = line.slice(match.index + match[0].length);

      const cited = [
        ...new Set(
          (NEXT_CITATIONS.exec(after)?.[0].match(/\d+/g) ?? [])
            .map(Number)
            .filter((n) => known.has(n)),
        ),
      ];
      const foundIn = stated
        .filter((source) =>
          digits.length >= DISTINCTIVE_DIGITS
            ? source.figures.has(digits)
            : source.money.has(digits),
        )
        .map((source) => source.n);

      checks.push({
        amount: match[0].replace(/\s+/g, " "),
        cited,
        foundIn,
        status:
          foundIn.length === 0
            ? "not_found"
            : cited.some((n) => foundIn.includes(n))
              ? "supported"
              : "other_source",
      });
    }
  }

  return checks;
}
