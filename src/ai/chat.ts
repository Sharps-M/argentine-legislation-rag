import { createGoogle } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, RetryError, streamText, type LanguageModel } from "ai";

import { getEnv, type Env } from "@/env";

export type ChatRequest = {
  /** What the model must do and must not do; kept apart from the data. */
  instructions: string;
  /** The sources and the question. */
  prompt: string;
  /** Stops the generation, for instance when the reader goes away. */
  signal?: AbortSignal;
};

export type ChatPart =
  /** A model is being asked; nothing has come back from it yet. */
  | { type: "asking"; provider: string; model: string }
  /** A piece of the answer. */
  | { type: "text"; text: string }
  /** A model that could not answer; the next one in the chain is being asked. */
  | {
      type: "skipped";
      provider: string;
      model: string;
      reason: ChatFailure;
      message: string;
    };

/**
 * Writes text from a prompt, piece by piece. The rest of the code depends on
 * this interface only, so who writes (Gemini's free tier, another service, a
 * local model, or a chain of them) can change without touching the answers.
 */
export type ChatModel = {
  /** For a chain, the provider and the model that answered last. */
  readonly provider: string;
  readonly model: string;
  /** The answer as it is generated. Fails with a `ChatModelError`. */
  stream: (request: ChatRequest) => AsyncIterable<ChatPart>;
};

/**
 * - `not_configured`: the provider needs a setting that is missing (the API key).
 * - `unauthorized`: the provider rejected the key.
 * - `rate_limited`: the free quota is used up for now.
 * - `overloaded`: the provider has no capacity for this model right now. It is
 *   their side, it passes, and another model may well be free.
 * - `unavailable`: anything else: the model is not running, or the call failed.
 */
export type ChatFailure =
  "not_configured" | "unauthorized" | "rate_limited" | "overloaded" | "unavailable";

export class ChatModelError extends Error {
  constructor(
    readonly reason: ChatFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChatModelError";
  }
}

const statusOf = (error: unknown): number | undefined => {
  if (APICallError.isInstance(error)) return error.statusCode;
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    return typeof error.statusCode === "number" ? error.statusCode : undefined;
  }
  return undefined;
};

/** Says what went wrong in terms the caller can act on. */
export function toChatModelError(model: ChatModel, error: unknown): ChatModelError {
  if (error instanceof ChatModelError) return error;

  // The SDK retries first; what it gives up with wraps the last failure.
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const status = statusOf(cause);
  const detail = cause instanceof Error ? cause.message : String(cause);
  const name = `${model.provider} (${model.model})`;

  if (status === 429) {
    return new ChatModelError(
      "rate_limited",
      `${name} is over its usage limit for now: ${detail}`,
      { cause },
    );
  }
  // Gemini answers 400 to a key it does not know, and 403 to one without access.
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(detail))) {
    return new ChatModelError(
      "unauthorized",
      `${name} rejected the API key: ${detail}`,
      {
        cause,
      },
    );
  }

  // Gemini says "experiencing high demand" with a 503; others use 529.
  if (status === 503 || status === 529 || /overloaded|high demand/i.test(detail)) {
    return new ChatModelError("overloaded", `${name} is overloaded: ${detail}`, {
      cause,
    });
  }

  return new ChatModelError("unavailable", `${name} could not answer: ${detail}`, {
    cause,
  });
}

/** Failures every model of the same provider would have: same key, same account. */
const OF_THE_PROVIDER: ChatFailure[] = ["unauthorized", "not_configured"];

/**
 * One `ChatModel` out of several, tried in order: when a model cannot start an
 * answer, the next one is asked, and a `skipped` part says why. `provider` and
 * `model` name the one that answered last.
 *
 * - Only before the first piece of text. Once a model has started writing,
 *   switching would mean two half answers glued together, so its failure stands.
 * - A rejected or missing key rules out the other models of that provider, not
 *   the other providers.
 */
export function withFallback(models: readonly ChatModel[]): ChatModel {
  const [first] = models;
  if (!first) throw new RangeError("withFallback needs at least one model");
  if (models.length === 1) return first;

  let answering = first;

  return {
    get provider() {
      return answering.provider;
    },
    get model() {
      return answering.model;
    },
    async *stream(request) {
      const failures: { candidate: ChatModel; error: ChatModelError }[] = [];
      const ruledOut = new Set<string>();

      for (const candidate of models) {
        if (ruledOut.has(candidate.provider)) continue;

        // The previous model failed and there is another to ask: say so now,
        // before waiting for it.
        const previous = failures.at(-1);
        if (previous) {
          yield {
            type: "skipped",
            provider: previous.candidate.provider,
            model: previous.candidate.model,
            reason: previous.error.reason,
            message: previous.error.message,
          };
        }

        answering = candidate;
        let started = false;

        try {
          for await (const part of candidate.stream(request)) {
            started ||= part.type === "text";
            yield part;
          }
          return;
        } catch (error) {
          if (!(error instanceof ChatModelError) || started) throw error;
          if (OF_THE_PROVIDER.includes(error.reason)) ruledOut.add(candidate.provider);
          failures.push({ candidate, error });
        }
      }

      // Every model failed: the last reason, and what each one said.
      const last = failures.at(-1)!;
      throw new ChatModelError(
        last.error.reason,
        failures.map((failure) => failure.error.message).join("\n"),
        { cause: last.error.cause },
      );
    },
  };
}

export type ChatModelOptions = {
  provider: string;
  model: string;
  languageModel: LanguageModel;
  maxRetries?: number;
  /** How long to wait for the first word before giving up on the model. */
  firstTextTimeoutMs?: number;
  /**
   * How much the model reasons before it writes, for the models that do. Left
   * out, the provider decides, and nothing is sent to models that do not.
   */
  reasoning?: "minimal" | "low" | "medium" | "high";
};

/**
 * Enough for a hosted model to start writing. One that has not by then is
 * stuck or queued, and with other models behind it there is no reason to wait.
 */
export const DEFAULT_FIRST_TEXT_TIMEOUT_MS = 30_000;

/** A `ChatModel` on top of any model the AI SDK can talk to. */
export function createChatModel(options: ChatModelOptions): ChatModel {
  const {
    provider,
    model,
    languageModel,
    maxRetries = 2,
    firstTextTimeoutMs = DEFAULT_FIRST_TEXT_TIMEOUT_MS,
    reasoning,
  } = options;

  const chat: ChatModel = {
    provider,
    model,
    async *stream({ instructions, prompt, signal }) {
      let wrote = false;
      yield { type: "asking", provider, model };

      // The wait for the first word is timed here, not left to the SDK: its
      // own timeout stops at the first output of any kind, and a model that
      // only "thinks" out loud would never trip it.
      const patience = new AbortController();
      const timer = setTimeout(() => patience.abort(), firstTextTimeoutMs);

      try {
        const result = streamText({
          model: languageModel,
          instructions,
          prompt,
          maxRetries,
          ...(reasoning && { reasoning }),
          abortSignal: signal
            ? AbortSignal.any([signal, patience.signal])
            : patience.signal,
          // Errors arrive as a part of the stream, below: nothing to log here.
          onError: () => {},
        });

        for await (const part of result.stream) {
          if (part.type === "text-delta" && part.text) {
            wrote = true;
            clearTimeout(timer);
            yield { type: "text", text: part.text };
          } else if (part.type === "error") {
            throw part.error;
          }
        }
      } catch (error) {
        // Running out of patience may surface as an error of the request.
        if (!patience.signal.aborted) throw toChatModelError(chat, error);
      } finally {
        clearTimeout(timer);
      }

      // A stream that was stopped just ends: the SDK reports it as an "abort"
      // part, not as an error. If the reader stopped it, there is nothing to
      // add. Otherwise an empty answer is a failure, and the next model may do
      // better.
      if (wrote || signal?.aborted) return;

      const name = `${provider} (${model})`;
      throw new ChatModelError(
        "unavailable",
        patience.signal.aborted
          ? `${name} wrote nothing within ${firstTextTimeoutMs / 1000} s.`
          : `${name} ended without writing anything.`,
      );
    },
  };

  return chat;
}

/**
 * Tried in this order: the lightest first. It was the other way round, newest
 * first, on the idea that it writes best. On the free tier the two bigger
 * models did not answer once in fourteen tries: no capacity, or thirty seconds
 * of silence, costing up to thirty-two seconds a question. The lightest
 * answered four times out of five, and what it wrote held against the sources
 * (docs/evaluacion.md). A model that answers beats a better one that does not.
 */
export const DEFAULT_GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.8-flash",
] as const;
export const DEFAULT_OLLAMA_CHAT_MODEL = "gemma3:4b";

type ProviderOptions = {
  model: string;
  maxRetries?: number;
  firstTextTimeoutMs?: number;
};

/** Gemini through Google's API. Its free tier needs a key and no billing. */
export function createGeminiChatModel(
  options: ProviderOptions & { apiKey: string; baseUrl?: string },
): ChatModel {
  const google = createGoogle({
    apiKey: options.apiKey,
    ...(options.baseUrl && { baseURL: options.baseUrl }),
  });

  return createChatModel({
    provider: "gemini",
    model: options.model,
    languageModel: google(options.model),
    maxRetries: options.maxRetries,
    firstTextTimeoutMs: options.firstTextTimeoutMs,
    // The answer is read out of the sources, not worked out: little reasoning
    // is enough, and the first word comes sooner.
    reasoning: "low",
  });
}

/**
 * Any service that speaks OpenAI's chat API: Groq, OpenRouter, Cerebras,
 * Mistral, or a local server. `baseUrl` includes the version: ".../v1".
 */
export function createOpenAICompatibleChatModel(
  options: ProviderOptions & { provider: string; baseUrl: string; apiKey?: string },
): ChatModel {
  const service = createOpenAICompatible({
    name: options.provider,
    baseURL: options.baseUrl.replace(/\/+$/, ""),
    ...(options.apiKey && { apiKey: options.apiKey }),
  });

  return createChatModel({
    provider: options.provider,
    model: options.model,
    languageModel: service.chatModel(options.model),
    maxRetries: options.maxRetries,
    firstTextTimeoutMs: options.firstTextTimeoutMs,
  });
}

/** A local model has to be loaded into memory before its first word. */
export const OLLAMA_FIRST_TEXT_TIMEOUT_MS = 180_000;

/** A model served by a local Ollama, through its OpenAI-compatible endpoint. */
export const createOllamaChatModel = (
  options: ProviderOptions & { baseUrl: string },
): ChatModel =>
  createOpenAICompatibleChatModel({
    firstTextTimeoutMs: OLLAMA_FIRST_TEXT_TIMEOUT_MS,
    ...options,
    provider: "ollama",
    baseUrl: `${options.baseUrl.replace(/\/+$/, "")}/v1`,
  });

/** Stands for a provider that was asked for and cannot be used as configured. */
const notConfigured = (provider: string, message: string): ChatModel => ({
  provider,
  model: "not configured",

  async *stream() {
    throw new ChatModelError("not_configured", message);
  },
});

export const CHAT_PROVIDERS = ["gemini", "openai-compatible", "ollama"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

type ChatEnv = Pick<
  Env,
  | "CHAT_PROVIDER"
  | "GEMINI_API_KEY"
  | "GEMINI_MODEL"
  | "CHAT_BASE_URL"
  | "CHAT_API_KEY"
  | "CHAT_MODEL"
  | "OLLAMA_BASE_URL"
  | "OLLAMA_CHAT_MODEL"
>;

/** What each provider can offer with this configuration: its models, or why not. */
const offers = (
  env: ChatEnv,
): Record<
  ChatProvider,
  {
    models: ((options: Omit<ProviderOptions, "model">) => ChatModel)[];
    missing?: string;
  }
> => {
  const { GEMINI_API_KEY: geminiKey, CHAT_BASE_URL: serviceUrl } = env;
  const geminiModels =
    env.GEMINI_MODEL.length > 0 ? env.GEMINI_MODEL : DEFAULT_GEMINI_MODELS;
  const ollamaModels =
    env.OLLAMA_CHAT_MODEL.length > 0
      ? env.OLLAMA_CHAT_MODEL
      : [DEFAULT_OLLAMA_CHAT_MODEL];

  return {
    gemini: geminiKey
      ? {
          models: geminiModels.map(
            (model) => (options) =>
              createGeminiChatModel({ ...options, apiKey: geminiKey, model }),
          ),
        }
      : {
          models: [],
          missing:
            "GEMINI_API_KEY is not set. Create a key at https://aistudio.google.com/apikey and put it in .env.",
        },
    "openai-compatible":
      serviceUrl && env.CHAT_MODEL.length > 0
        ? {
            models: env.CHAT_MODEL.map(
              (model) => (options) =>
                createOpenAICompatibleChatModel({
                  ...options,
                  provider: new URL(serviceUrl).hostname,
                  baseUrl: serviceUrl,
                  apiKey: env.CHAT_API_KEY,
                  model,
                }),
            ),
          }
        : {
            models: [],
            missing:
              "An openai-compatible service needs CHAT_BASE_URL (for instance https://api.groq.com/openai/v1) and CHAT_MODEL, and CHAT_API_KEY if it asks for a key.",
          },
    ollama: {
      models: ollamaModels.map(
        (model) => (options) =>
          createOllamaChatModel({ ...options, baseUrl: env.OLLAMA_BASE_URL, model }),
      ),
    },
  };
};

/**
 * The chat model a configuration asks for: a chain of every model of every
 * provider, so that an answer does not depend on any one of them being up.
 *
 * With `CHAT_PROVIDER` unset, the chain is every provider that is configured,
 * hosted ones first (they write better) and the local model last (it is always
 * there). `CHAT_PROVIDER` picks the providers and their order instead; one
 * that is named and not configured is reported, not passed over in silence.
 */
export function chatModelFromEnv(
  env: ChatEnv,
  { lastModelRetries = 2 }: { lastModelRetries?: number } = {},
): ChatModel {
  const available = offers(env);
  const explicit = env.CHAT_PROVIDER.length > 0;
  const providers = explicit ? env.CHAT_PROVIDER : CHAT_PROVIDERS;

  const candidates = providers.flatMap((provider) => {
    const { models, missing } = available[provider];
    if (missing) return explicit ? [() => notConfigured(provider, missing)] : [];
    return models;
  });

  return withFallback(
    candidates.map((create, index) =>
      // A model with another one behind it is not worth waiting for: the next
      // is asked at once. Only the last one is retried.
      create({ maxRetries: index === candidates.length - 1 ? lastModelRetries : 0 }),
    ),
  );
}

/** The chat model configured through the environment. */
export const getChatModel = (): ChatModel => chatModelFromEnv(getEnv());
