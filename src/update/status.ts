import { desc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { updateRuns, type UpdateRunRow } from "@/db/schema";

/** How often the corpus is brought up to date: InfoLEG publishes monthly, on no fixed day. */
export const UPDATE_EVERY_DAYS = 7;
/** Past this, the page says the regulations may be out of date: two weekly updates were missed. */
export const OVERDUE_AFTER_DAYS = 14;

export type UpdateRun = Pick<
  UpdateRunRow,
  | "startedAt"
  | "finishedAt"
  | "outcome"
  | "datasetChanged"
  | "added"
  | "changed"
  | "error"
>;

export type UpdateStatus = {
  /** The last update that finished. */
  lastSuccess: UpdateRun | null;
  /** The last one that ran, finished or not. */
  lastAttempt: UpdateRun | null;
  /** Whole days since the last update that finished; `null` if none did. */
  daysSince: number | null;
  /** Whole days since the last one that ran; `null` if none did. */
  daysSinceAttempt: number | null;
  /** Another update should run now. */
  due: boolean;
  /** Days until the next one is due, `0` when it is. */
  dueInDays: number;
  /** Worth telling whoever reads the regulations: too long, or the last attempt failed. */
  warning: "never" | "overdue" | "failed" | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether an update is due, and whether the page should say anything about it. */
export function updateStatus(
  runs: { lastSuccess: UpdateRun | null; lastAttempt: UpdateRun | null },
  now: Date,
  { everyDays = UPDATE_EVERY_DAYS, overdueDays = OVERDUE_AFTER_DAYS } = {},
): UpdateStatus {
  const { lastSuccess, lastAttempt } = runs;
  const daysAgo = (run: UpdateRun | null) =>
    run
      ? Math.max(0, Math.floor((now.getTime() - run.finishedAt.getTime()) / DAY_MS))
      : null;
  const daysSince = daysAgo(lastSuccess);
  const due = daysSince === null || daysSince >= everyDays;

  return {
    lastSuccess,
    lastAttempt,
    daysSince,
    daysSinceAttempt: daysAgo(lastAttempt),
    due,
    dueInDays: daysSince === null ? 0 : Math.max(0, everyDays - daysSince),
    warning:
      lastAttempt?.outcome === "failed"
        ? "failed"
        : daysSince === null
          ? "never"
          : daysSince > overdueDays
            ? "overdue"
            : null,
  };
}

const COLUMNS = {
  startedAt: updateRuns.startedAt,
  finishedAt: updateRuns.finishedAt,
  outcome: updateRuns.outcome,
  datasetChanged: updateRuns.datasetChanged,
  added: updateRuns.added,
  changed: updateRuns.changed,
  error: updateRuns.error,
};

/** The last update that finished and the last one that ran. */
export async function latestRuns(db: Database) {
  const [lastAttempt] = await db
    .select(COLUMNS)
    .from(updateRuns)
    .orderBy(desc(updateRuns.finishedAt))
    .limit(1);
  const [lastSuccess] = await db
    .select(COLUMNS)
    .from(updateRuns)
    .where(eq(updateRuns.outcome, "ok"))
    .orderBy(desc(updateRuns.finishedAt))
    .limit(1);

  return { lastSuccess: lastSuccess ?? null, lastAttempt: lastAttempt ?? null };
}

export async function recordRun(db: Database, run: UpdateRun): Promise<void> {
  await db.insert(updateRuns).values(run);
}

const at = (date: Date) => date.toISOString().slice(0, 16).replace("T", " ");
const days = (count: number) => (count === 1 ? "1 day" : `${count} days`);

/** The status in a few lines, for the command and for the log of the scheduled runs. */
export function describeStatus(status: UpdateStatus): string {
  const lines: string[] = [];
  const { lastSuccess, lastAttempt, daysSince } = status;

  if (!lastSuccess || daysSince === null) {
    lines.push("No update has finished yet.");
  } else {
    const what = lastSuccess.datasetChanged
      ? `${lastSuccess.added} new, ${lastSuccess.changed} changed`
      : "the dataset had not changed";
    const ago = daysSince === 0 ? "today" : `${days(daysSince)} ago`;
    lines.push(`Last update: ${at(lastSuccess.finishedAt)} UTC (${ago}): ${what}.`);
  }

  if (lastAttempt?.outcome === "failed") {
    lines.push(
      `The last attempt, ${at(lastAttempt.finishedAt)} UTC, failed: ${lastAttempt.error ?? "no reason recorded"}`,
    );
  }

  lines.push(
    status.due
      ? "An update is due now."
      : `The next one is due in ${days(status.dueInDays)}.`,
  );
  if (status.warning === "overdue") {
    lines.push(`Warning: more than ${OVERDUE_AFTER_DAYS} days without an update.`);
  }
  return lines.join("\n");
}
