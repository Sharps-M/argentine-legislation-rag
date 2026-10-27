import { describe, expect, it } from "vitest";

import { describeStatus, updateStatus, type UpdateRun } from "./status";

const run = (finishedAt: string, overrides: Partial<UpdateRun> = {}): UpdateRun => ({
  startedAt: new Date(new Date(finishedAt).getTime() - 60_000),
  finishedAt: new Date(finishedAt),
  outcome: "ok",
  datasetChanged: false,
  added: 0,
  changed: 0,
  error: null,
  ...overrides,
});

const now = new Date("2026-11-10T12:00:00Z");

describe("updateStatus", () => {
  it("is due, and warns, when no update ever finished", () => {
    expect(updateStatus({ lastSuccess: null, lastAttempt: null }, now)).toMatchObject({
      daysSince: null,
      daysSinceAttempt: null,
      due: true,
      dueInDays: 0,
      warning: "never",
    });
  });

  it("counts whole days since the last update that finished", () => {
    const last = run("2026-11-07T13:00:00Z");

    expect(updateStatus({ lastSuccess: last, lastAttempt: last }, now)).toMatchObject({
      daysSince: 2,
      due: false,
      dueInDays: 5,
      warning: null,
    });
  });

  it("is due a week after the last one, and not a moment before", () => {
    const sixDays = run("2026-11-03T12:00:01Z");
    const sevenDays = run("2026-11-03T12:00:00Z");

    expect(updateStatus({ lastSuccess: sixDays, lastAttempt: sixDays }, now).due).toBe(
      false,
    );
    expect(
      updateStatus({ lastSuccess: sevenDays, lastAttempt: sevenDays }, now),
    ).toMatchObject({
      due: true,
      dueInDays: 0,
    });
  });

  it("warns once two weekly updates were missed", () => {
    const fourteen = run("2026-10-27T12:00:00Z");
    const fifteen = run("2026-10-26T12:00:00Z");

    expect(
      updateStatus({ lastSuccess: fourteen, lastAttempt: fourteen }, now).warning,
    ).toBeNull();
    expect(
      updateStatus({ lastSuccess: fifteen, lastAttempt: fifteen }, now).warning,
    ).toBe("overdue");
  });

  it("warns when the last attempt failed, even if a recent one finished", () => {
    const status = updateStatus(
      {
        lastSuccess: run("2026-11-09T09:00:00Z"),
        lastAttempt: run("2026-11-10T09:00:00Z", {
          outcome: "failed",
          error: "Ollama",
        }),
      },
      now,
    );

    expect(status).toMatchObject({
      daysSince: 1,
      daysSinceAttempt: 0,
      due: false,
      warning: "failed",
    });
  });

  it("takes the period and the warning threshold it is given", () => {
    const last = run("2026-11-08T12:00:00Z");

    expect(
      updateStatus({ lastSuccess: last, lastAttempt: last }, now, {
        everyDays: 1,
        overdueDays: 1,
      }),
    ).toMatchObject({ due: true, warning: "overdue" });
  });

  it("does not count a run from the future as negative days", () => {
    const later = run("2026-11-11T12:00:00Z");

    expect(
      updateStatus({ lastSuccess: later, lastAttempt: later }, now).daysSince,
    ).toBe(0);
  });
});

describe("describeStatus", () => {
  it("says when the last update was, what it found and when the next is due", () => {
    const last = run("2026-11-07T13:00:00Z", {
      datasetChanged: true,
      added: 12,
      changed: 3,
    });

    expect(
      describeStatus(updateStatus({ lastSuccess: last, lastAttempt: last }, now)),
    ).toBe(
      "Last update: 2026-11-07 13:00 UTC (2 days ago): 12 new, 3 changed.\nThe next one is due in 5 days.",
    );
  });

  it("says when the dataset had not changed, and counts one day and today", () => {
    const yesterday = run("2026-11-09T11:00:00Z");
    const today = run("2026-11-10T11:00:00Z");

    expect(
      describeStatus(
        updateStatus({ lastSuccess: yesterday, lastAttempt: yesterday }, now),
      ),
    ).toContain("(1 day ago): the dataset had not changed.");
    expect(
      describeStatus(updateStatus({ lastSuccess: today, lastAttempt: today }, now)),
    ).toContain("(today)");
  });

  it("tells a failed last attempt, an update never run and one long overdue", () => {
    expect(
      describeStatus(
        updateStatus(
          {
            lastSuccess: null,
            lastAttempt: run("2026-11-10T09:00:00Z", {
              outcome: "failed",
              error: "Ollama is not running",
            }),
          },
          now,
        ),
      ),
    ).toBe(
      "No update has finished yet.\nThe last attempt, 2026-11-10 09:00 UTC, failed: Ollama is not running\nAn update is due now.",
    );

    const old = run("2026-10-01T12:00:00Z");
    expect(
      describeStatus(updateStatus({ lastSuccess: old, lastAttempt: old }, now)),
    ).toContain("Warning: more than 14 days without an update.");
  });
});
