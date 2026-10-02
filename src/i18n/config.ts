export const locales = ["es", "en"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "es";

export const hasLocale = (value: string): value is Locale =>
  (locales as readonly string[]).includes(value);

/**
 * Picks the best supported locale from an `Accept-Language` header.
 *
 * Entries are ranked by their quality value (`q`), and only the primary
 * language subtag is compared, so `es-AR` and `es-419` both resolve to `es`.
 */
export function pickLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return defaultLocale;

  const ranked = acceptLanguage
    .split(",")
    .map((entry) => {
      const [tag = "", ...params] = entry.trim().split(";");
      const q = params
        .map((param) => param.trim())
        .find((param) => param.startsWith("q="));
      const quality = q ? Number.parseFloat(q.slice(2)) : 1;

      return {
        language: tag.trim().toLowerCase().split("-")[0] ?? "",
        quality: Number.isFinite(quality) ? quality : 0,
      };
    })
    .filter((entry) => entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  return ranked.map((entry) => entry.language).find(hasLocale) ?? defaultLocale;
}
