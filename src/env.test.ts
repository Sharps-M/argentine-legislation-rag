import { describe, expect, it } from "vitest";

import { parseEnv } from "./env";

describe("parseEnv", () => {
  it("accepts a PostgreSQL connection string", () => {
    const env = parseEnv({ DATABASE_URL: "postgres://user:pass@localhost:5432/db" });

    expect(env.DATABASE_URL).toBe("postgres://user:pass@localhost:5432/db");
  });

  it("accepts the postgresql:// scheme too", () => {
    expect(() => parseEnv({ DATABASE_URL: "postgresql://localhost/db" })).not.toThrow();
  });

  it("names the missing variable", () => {
    expect(() => parseEnv({})).toThrowError(/DATABASE_URL/);
  });

  it("rejects a non-PostgreSQL URL", () => {
    expect(() => parseEnv({ DATABASE_URL: "mysql://localhost/db" })).toThrowError(
      /Invalid environment variables/,
    );
  });
});
