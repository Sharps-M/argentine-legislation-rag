import { afterAll, describe, expect, it } from "vitest";

import { getSql } from "@/db/client";
import { checkHealth } from "@/server/health";
import { databaseProbe } from "@/server/health-probe";

afterAll(() => getSql().end());

describe("database", () => {
  it("has the pgvector extension enabled by the migrations", async () => {
    const report = await checkHealth(databaseProbe);

    expect(report.status).toBe("ok");
    expect(report.pgvector).toMatch(/^\d+\.\d+/);
  });

  it("computes vector distances", async () => {
    const [row] = await getSql()<{ distance: number }[]>`
      select '[1,2,3]'::vector <-> '[1,2,4]'::vector as distance
    `;

    expect(row?.distance).toBe(1);
  });
});
