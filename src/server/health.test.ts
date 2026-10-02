import { describe, expect, it } from "vitest";

import { checkHealth, type HealthProbe } from "./health";

const probe = (overrides: Partial<HealthProbe> = {}): HealthProbe => ({
  ping: async () => {},
  vectorVersion: async () => "0.8.0",
  ...overrides,
});

describe("checkHealth", () => {
  it("reports ok when the database and pgvector are available", async () => {
    await expect(checkHealth(probe())).resolves.toEqual({
      status: "ok",
      database: "up",
      pgvector: "0.8.0",
    });
  });

  it("reports the database as down when the ping fails", async () => {
    const report = await checkHealth(
      probe({
        ping: async () => {
          throw new Error("connection refused");
        },
      }),
    );

    expect(report).toEqual({ status: "degraded", database: "down", pgvector: null });
  });

  it("is degraded when the pgvector extension is not installed", async () => {
    const report = await checkHealth(probe({ vectorVersion: async () => null }));

    expect(report).toEqual({ status: "degraded", database: "up", pgvector: null });
  });

  it("treats a failing extension lookup as missing pgvector", async () => {
    const report = await checkHealth(
      probe({
        vectorVersion: async () => {
          throw new Error("permission denied");
        },
      }),
    );

    expect(report.status).toBe("degraded");
    expect(report.database).toBe("up");
  });
});
