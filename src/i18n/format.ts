import type { Locale } from "./config";

/** "Pruebe en {seconds} s" with `{ seconds: 12 }` → "Pruebe en 12 s". Unknown names are left as written. */
export const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );

/** The form of a word for a count: `{ one: "un monto", other: "{count} montos" }`. */
export const plural = (
  forms: { one: string; other: string },
  count: number,
  locale: Locale,
) =>
  fill(new Intl.PluralRules(locale).select(count) === "one" ? forms.one : forms.other, {
    count,
  });

/** 1234 ms → "1,2 s" in Spanish, "1.2 s" in English. */
export const seconds = (ms: number, locale: Locale) =>
  `${(ms / 1000).toLocaleString(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} s`;

/** 0 → "hoy", 1 → "ayer", 3 → "hace 3 días"; "today", "yesterday", "3 days ago". */
export const daysAgo = (days: number, locale: Locale) =>
  new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-days, "day");

/**
 * "2026-08-28" → "28 de agosto de 2026" / "August 28, 2026". Dates without a
 * time are read in UTC, so that no time zone moves them to the day before.
 */
export const longDate = (iso: string, locale: Locale) => {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
        date,
      );
};
