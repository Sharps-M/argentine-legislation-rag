"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import type { Locale } from "@/i18n/config";

/**
 * The other languages of the page, keeping the question in the address: the
 * same question, answered in the language chosen.
 */
export function LanguageLinks({
  lang,
  locales,
  label,
  names,
}: {
  lang: Locale;
  locales: readonly Locale[];
  label: string;
  names: Record<Locale, string>;
}) {
  const search = useSearchParams().toString();

  return (
    <nav aria-label={label} className="flex gap-1 text-sm">
      {locales.map((locale) => (
        <Link
          key={locale}
          href={`/${locale}${search ? `?${search}` : ""}`}
          hrefLang={locale}
          aria-current={locale === lang ? "page" : undefined}
          className="rounded-md px-2 py-1 text-muted hover:text-foreground aria-[current=page]:bg-surface aria-[current=page]:font-medium aria-[current=page]:text-foreground"
        >
          {names[locale]}
        </Link>
      ))}
    </nav>
  );
}
