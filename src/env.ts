import { z } from "zod";

const emptyAsAbsent = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** A setting that may be left out, or left empty in `.env`. */
const optionalText = z.preprocess(emptyAsAbsent, z.string().trim().optional());

/** "a, b ,c" → ["a", "b", "c"]; left out or empty → []. */
const list = <T extends z.ZodType<string>>(item: T) =>
  z.preprocess(
    (value) =>
      typeof value === "string"
        ? value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : [],
    z.array(item),
  );

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
  CHAT_PROVIDER: list(z.enum(["gemini", "openai-compatible", "ollama"])).describe(
    "Who writes the answers, in the order to try them; empty means every provider that is configured",
  ),
  GEMINI_API_KEY: optionalText.describe("Key for Gemini's API"),
  GEMINI_MODEL: list(z.string()).describe(
    "Gemini models to try, in order; empty means the defaults",
  ),
  CHAT_BASE_URL: z
    .preprocess(emptyAsAbsent, z.url({ protocol: /^https?$/ }).optional())
    .describe("Where an OpenAI-compatible service listens, including /v1"),
  CHAT_API_KEY: optionalText.describe("Key for the OpenAI-compatible service"),
  CHAT_MODEL: list(z.string()).describe(
    "Models of the OpenAI-compatible service to try, in order",
  ),
  OLLAMA_CHAT_MODEL: list(z.string()).describe(
    "Local models to try, in order; empty means the default",
  ),
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
