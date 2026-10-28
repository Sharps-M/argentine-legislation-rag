import { notFound } from "next/navigation";
import { connection } from "next/server";

import { hasLocale, locales, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { checkHealth } from "@/server/health";
import { getDb } from "@/db/client";
import { daysAgo, fill } from "@/i18n/format";
import { databaseProbe } from "@/server/health-probe";
import { latestRuns, updateStatus, type UpdateStatus } from "@/update/status";

import { queryFromParams } from "@/ui/ask-query";

import { Ask } from "./ask";
import { LanguageLinks } from "./language-links";

export default async function HomePage({ params, searchParams }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  // The status below reflects the live database, so render at request time.
  await connection();
  const health = await checkHealth(databaseProbe);
  // Without the database, or before its migration, there is nothing to say.
  const updates = await latestRuns(getDb())
    .then((runs) => updateStatus(runs, new Date()))
    .catch(() => null);

  const checks = [
    { label: dict.status.database, ok: health.database === "up" },
    { label: dict.status.vectorSearch, ok: health.pgvector !== null },
  ];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-16">
      <header className="flex flex-col-reverse items-start gap-4 sm:flex-row sm:justify-between sm:gap-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{dict.meta.title}</h1>
          <p className="mt-2 text-lg text-muted">{dict.home.tagline}</p>
        </div>

        <LanguageLinks
          lang={lang}
          locales={locales}
          label={dict.language.label}
          names={{ es: dict.language.es, en: dict.language.en }}
        />
      </header>

      <p>{dict.home.intro}</p>

      <Ask lang={lang} texts={dict.ask} initial={queryFromParams(await searchParams)} />

      <footer className="mt-auto space-y-3 border-t border-border pt-6 text-sm text-muted">
        <p>{dict.home.disclaimer}</p>
        {updates && <UpdateNote status={updates} lang={lang} texts={dict.status} />}
        <section aria-labelledby="status-heading">
          <h2 id="status-heading" className="sr-only">
            {dict.status.heading}
          </h2>
          <ul className="flex flex-wrap gap-x-6 gap-y-1">
            {checks.map((check) => (
              <li key={check.label}>
                {check.label}:{" "}
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
      </footer>
    </main>
  );
}

/** How long ago the regulations were brought up to date, and a warning if it is too long. */
function UpdateNote({
  status,
  lang,
  texts,
}: {
  status: UpdateStatus;
  lang: Locale;
  texts: Dictionary["status"];
}) {
  const warning = status.warning !== null;
  const text =
    status.warning === "failed" && status.daysSinceAttempt !== null
      ? fill(texts.updateFailed, { ago: daysAgo(status.daysSinceAttempt, lang) })
      : status.daysSince === null
        ? texts.neverUpdated
        : fill(status.warning === "overdue" ? texts.updateOverdue : texts.updated, {
            ago: daysAgo(status.daysSince, lang),
          });

  return (
    <p
      className={warning ? "text-warning" : undefined}
      data-update={status.warning ?? "ok"}
    >
      {text}
    </p>
  );
}
