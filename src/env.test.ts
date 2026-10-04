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

  it("defaults to a local Ollama with bge-m3", () => {
    const env = parseEnv({ DATABASE_URL: "postgres://localhost/db" });

    expect(env.OLLAMA_BASE_URL).toBe("http://localhost:11434");
    expect(env.EMBEDDING_MODEL).toBe("bge-m3");
  });

  it("lets the Ollama address and the model be overridden", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://localhost/db",
      OLLAMA_BASE_URL: "http://192.168.0.10:11434",
      EMBEDDING_MODEL: " other-model ",
    });

    expect(env.OLLAMA_BASE_URL).toBe("http://192.168.0.10:11434");
    expect(env.EMBEDDING_MODEL).toBe("other-model");
  });

  it("rejects an Ollama address that is not an HTTP URL", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://localhost/db",
        OLLAMA_BASE_URL: "localhost",
      }),
    ).toThrowError(/OLLAMA_BASE_URL/);
  });
});
