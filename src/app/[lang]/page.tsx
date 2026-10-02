import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { hasLocale, locales } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { checkHealth } from "@/server/health";
import { databaseProbe } from "@/server/health-probe";

export default async function HomePage({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  // The status below reflects the live database, so render at request time.
  await connection();
  const health = await checkHealth(databaseProbe);

  const checks = [
    { label: dict.status.database, ok: health.database === "up" },
    { label: dict.status.vectorSearch, ok: health.pgvector !== null },
  ];

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 py-16">
      <header className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{dict.meta.title}</h1>
          <p className="mt-2 text-lg text-muted">{dict.home.tagline}</p>
        </div>

        <nav aria-label={dict.language.label} className="flex gap-1 text-sm">
          {locales.map((locale) => (
            <Link
              key={locale}
              href={`/${locale}`}
              hrefLang={locale}
              aria-current={locale === lang ? "page" : undefined}
              className="rounded-md px-2 py-1 text-muted hover:text-foreground aria-[current=page]:bg-surface aria-[current=page]:font-medium aria-[current=page]:text-foreground"
            >
              {dict.language[locale]}
            </Link>
          ))}
        </nav>
      </header>

      <section className="space-y-3">
        <p>{dict.home.intro}</p>
        <p className="text-muted">{dict.home.comingSoon}</p>
      </section>

      <section
        aria-labelledby="status-heading"
        className="rounded-xl border border-border bg-surface p-5"
      >
        <h2 id="status-heading" className="text-sm font-semibold">
          {dict.status.heading}
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          {checks.map((check) => (
            <li key={check.label} className="flex items-center justify-between">
              <span>{check.label}</span>
              <span
                className={check.ok ? "text-success" : "text-danger"}
                data-status={check.ok ? "up" : "down"}
              >
                {check.ok ? dict.status.up : dict.status.down}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-auto text-sm text-muted">{dict.home.disclaimer}</footer>
    </main>
  );
}
