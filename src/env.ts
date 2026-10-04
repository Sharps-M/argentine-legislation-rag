import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .describe("PostgreSQL connection string, e.g. postgres://user:pass@host:5432/db"),
  OLLAMA_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .default("http://localhost:11434")
    .describe("Where Ollama listens"),
  EMBEDDING_MODEL: z
    .string()
    .trim()
    .min(1)
    .default("bge-m3")
    .describe("Ollama model used for embeddings; must output 1,024 dimensions"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates raw environment variables and fails fast with a readable message
 * listing every invalid or missing variable.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  return result.data;
}

let cached: Env | undefined;

/** Lazily validated environment, so importing this module never throws at build time. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
