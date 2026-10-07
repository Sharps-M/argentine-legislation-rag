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

  it("leaves the choice of who writes the answers open by default", () => {
    const env = parseEnv({ DATABASE_URL: "postgres://localhost/db" });

    expect(env).toMatchObject({
      CHAT_PROVIDER: [],
      GEMINI_MODEL: [],
      CHAT_MODEL: [],
      OLLAMA_CHAT_MODEL: [],
    });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.CHAT_BASE_URL).toBeUndefined();
  });

  it("reads the providers and the models as lists, in the order written", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://localhost/db",
      CHAT_PROVIDER: " ollama , gemini ",
      GEMINI_API_KEY: " a-key ",
      GEMINI_MODEL: "flash-a,flash-b,,",
      OLLAMA_CHAT_MODEL: "gemma3:4b",
    });

    expect(env).toMatchObject({
      CHAT_PROVIDER: ["ollama", "gemini"],
      GEMINI_API_KEY: "a-key",
      GEMINI_MODEL: ["flash-a", "flash-b"],
      OLLAMA_CHAT_MODEL: ["gemma3:4b"],
    });
  });

  it("reads the settings of an OpenAI-compatible service", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://localhost/db",
      CHAT_BASE_URL: "https://api.groq.com/openai/v1",
      CHAT_API_KEY: " another-key ",
      CHAT_MODEL: "openai/gpt-oss-120b",
    });

    expect(env).toMatchObject({
      CHAT_BASE_URL: "https://api.groq.com/openai/v1",
      CHAT_API_KEY: "another-key",
      CHAT_MODEL: ["openai/gpt-oss-120b"],
    });
  });

  it("takes a setting left empty in .env as absent", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://localhost/db",
      CHAT_PROVIDER: "",
      GEMINI_API_KEY: "  ",
      CHAT_BASE_URL: "",
      CHAT_MODEL: " ",
    });

    expect(env.CHAT_PROVIDER).toEqual([]);
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.CHAT_BASE_URL).toBeUndefined();
    expect(env.CHAT_MODEL).toEqual([]);
  });

  it("rejects a chat provider it does not know", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://localhost/db",
        CHAT_PROVIDER: "gemini,openai",
      }),
    ).toThrowError(/CHAT_PROVIDER/);
  });

  it("rejects a chat service address that is not an HTTP URL", () => {
    expect(() =>
      parseEnv({ DATABASE_URL: "postgres://localhost/db", CHAT_BASE_URL: "groq" }),
    ).toThrowError(/CHAT_BASE_URL/);
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
