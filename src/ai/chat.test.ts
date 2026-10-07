import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { APICallError, RetryError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ChatModelError,
  chatModelFromEnv,
  createChatModel,
  createGeminiChatModel,
  createOllamaChatModel,
  createOpenAICompatibleChatModel,
  DEFAULT_GEMINI_MODELS,
  DEFAULT_OLLAMA_CHAT_MODEL,
  toChatModelError,
  withFallback,
  type ChatFailure,
  type ChatModel,
  type ChatPart,
} from "./chat";

const request = { instructions: "Answer with the sources only.", prompt: "Question?" };

/** Every part of a stream, as it came. */
const partsOf = async (stream: AsyncIterable<ChatPart>) => {
  const parts: ChatPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
};

/** The pieces of text of a stream. */
const collect = async (stream: AsyncIterable<ChatPart>) =>
  (await partsOf(stream)).flatMap((part) => (part.type === "text" ? [part.text] : []));

/** The text written before a stream failed, and the failure (`null` if none). */
const outcomeOf = async (stream: AsyncIterable<ChatPart>) => {
  const pieces: string[] = [];
  try {
    for await (const part of stream) if (part.type === "text") pieces.push(part.text);
    return { pieces, failure: null };
  } catch (failure) {
    return { pieces, failure };
  }
};

/** The failure a stream ends with, or `null` if it ends well. */
const failureOf = async (stream: AsyncIterable<ChatPart>) => {
  try {
    await collect(stream);
    return null;
  } catch (error) {
    return error;
  }
};

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const finish = {
  type: "finish" as const,
  finishReason: { unified: "stop" as const, raw: undefined },
  logprobs: undefined,
  usage,
};

const mockModel = (pieces: string[]) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "1" },
          ...pieces.map((delta) => ({ type: "text-delta" as const, id: "1", delta })),
          { type: "text-end", id: "1" },
          finish,
        ],
      }),
    }),
  });

const apiError = (statusCode: number, message: string) =>
  new APICallError({
    message,
    statusCode,
    url: "http://provider.test",
    requestBodyValues: {},
  });

describe("createChatModel", () => {
  it("streams the text piece by piece", async () => {
    const chat = createChatModel({
      provider: "test",
      model: "mock",
      languageModel: mockModel(["El tope ", "es de ", "$907.934 [1]."]),
    });

    expect(await collect(chat.stream(request))).toEqual([
      "El tope ",
      "es de ",
      "$907.934 [1].",
    ]);
  });

  it("names itself before anything comes back, so a wait can be explained", async () => {
    const chat = createChatModel({
      provider: "test",
      model: "mock",
      languageModel: mockModel(["ok"]),
    });

    expect(await partsOf(chat.stream(request))).toEqual([
      { type: "asking", provider: "test", model: "mock" },
      { type: "text", text: "ok" },
    ]);
  });

  it("sends the instructions apart from the prompt", async () => {
    const languageModel = mockModel(["ok"]);
    const chat = createChatModel({ provider: "test", model: "mock", languageModel });

    await collect(chat.stream(request));

    expect(languageModel.doStreamCalls[0]?.prompt).toEqual([
      { role: "system", content: "Answer with the sources only." },
      { role: "user", content: [{ type: "text", text: "Question?" }] },
    ]);
  });

  it.each([
    [429, "Resource has been exhausted", "rate_limited"],
    [401, "Unauthorized", "unauthorized"],
    [403, "Permission denied", "unauthorized"],
    [400, "API key not valid. Please pass a valid API key.", "unauthorized"],
    [400, "Invalid JSON payload", "unavailable"],
    [500, "Internal error", "unavailable"],
    [503, "This model is currently experiencing high demand.", "overloaded"],
    [503, "Service Unavailable", "overloaded"],
    [529, "Try again later", "overloaded"],
    [500, "The model is overloaded", "overloaded"],
  ])("turns a %i (%s) into a %s failure", async (status, message, reason) => {
    const chat = createChatModel({
      provider: "test",
      model: "mock",
      maxRetries: 0,
      languageModel: new MockLanguageModelV4({
        doStream: async () => {
          throw apiError(status, message);
        },
      }),
    });

    const failure = await failureOf(chat.stream(request));

    expect(failure).toBeInstanceOf(ChatModelError);
    expect(failure).toMatchObject({ reason });
    expect((failure as Error).message).toContain("test (mock)");
    expect((failure as Error).message).toContain(message);
  });

  it("fails when the provider breaks off in the middle of an answer", async () => {
    const chat = createChatModel({
      provider: "test",
      model: "mock",
      maxRetries: 0,
      languageModel: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "El tope " },
              { type: "error", error: apiError(429, "quota") },
            ],
          }),
        }),
      }),
    });

    const { pieces, failure } = await outcomeOf(chat.stream(request));

    expect(pieces).toEqual(["El tope "]);
    expect(failure).toMatchObject({ reason: "rate_limited" });
  });

  it("fails when the model does not start writing in time", async () => {
    const chat = createChatModel({
      provider: "test",
      model: "mock",
      maxRetries: 0,
      firstTextTimeoutMs: 50,
      languageModel: new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => ({
          // Says it started and then nothing more, until it is cut off.
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "1" });
              abortSignal?.addEventListener("abort", () => controller.close());
            },
          }),
        }),
      }),
    });

    const failure = await failureOf(chat.stream(request));

    expect(failure).toBeInstanceOf(ChatModelError);
    expect(failure).toMatchObject({ reason: "unavailable" });
    expect((failure as Error).message).toContain("test (mock) wrote nothing");
  });

  it("does not take thinking out loud for an answer", async () => {
    const chat = createChatModel({
      provider: "test",
      model: "mock",
      maxRetries: 0,
      firstTextTimeoutMs: 50,
      languageModel: new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => ({
          // Reasons without end and never writes a word of the answer.
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "reasoning-start", id: "r" });
              const thinking = setInterval(
                () =>
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: "r",
                    delta: "hmm ",
                  }),
                5,
              );
              abortSignal?.addEventListener("abort", () => {
                clearInterval(thinking);
                controller.close();
              });
            },
          }),
        }),
      }),
    });

    const failure = await failureOf(chat.stream(request));

    expect(failure).toMatchObject({ reason: "unavailable" });
    expect((failure as Error).message).toBe("test (mock) wrote nothing within 0.05 s.");
  });

  it("fails when the model ends without having written anything", async () => {
    const chat = createChatModel({
      provider: "test",
      model: "mock",
      languageModel: mockModel([]),
    });

    expect(await failureOf(chat.stream(request))).toMatchObject({
      reason: "unavailable",
      message: "test (mock) ended without writing anything.",
    });
  });

  it("ends quietly when the reader went away", async () => {
    const controller = new AbortController();
    controller.abort();
    const chat = createChatModel({
      provider: "test",
      model: "mock",
      languageModel: mockModel(["never read"]),
    });

    expect(
      await failureOf(chat.stream({ ...request, signal: controller.signal })),
    ).toBeNull();
  });
});

describe("toChatModelError", () => {
  const chat = { provider: "gemini", model: "flash" } as ChatModel;

  it("looks inside what the SDK gives up with after retrying", () => {
    const error = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [apiError(503, "overloaded"), apiError(429, "quota")],
    });

    expect(toChatModelError(chat, error)).toMatchObject({ reason: "rate_limited" });
  });

  it("calls anything else unavailable, keeping the cause", () => {
    const cause = new TypeError("fetch failed");
    const error = toChatModelError(chat, cause);

    expect(error).toMatchObject({ reason: "unavailable", cause });
    expect(error.message).toBe("gemini (flash) could not answer: fetch failed");
  });

  it("leaves a failure it already described as it is", () => {
    const error = new ChatModelError("not_configured", "no key");

    expect(toChatModelError(chat, error)).toBe(error);
  });
});

describe("withFallback", () => {
  /** A model that fails before writing, or writes the given pieces. */
  const model = (
    name: string,
    behaviour: { fails?: ChatFailure; writes?: string[]; thenFails?: ChatFailure },
    asked: string[] = [],
    provider = "fake",
  ): ChatModel => ({
    provider,
    model: name,
    async *stream() {
      asked.push(name);
      if (behaviour.fails) throw new ChatModelError(behaviour.fails, `${name} failed`);
      for (const text of behaviour.writes ?? []) yield { type: "text", text };
      if (behaviour.thenFails) {
        throw new ChatModelError(behaviour.thenFails, `${name} broke off`);
      }
    },
  });

  it("asks the next model when one cannot answer, saying which was passed over and why", async () => {
    const asked: string[] = [];
    const chat = withFallback([
      model("newest", { fails: "overloaded" }, asked, "gemini"),
      model("local", { writes: ["El tope ", "es [1]."] }, asked, "ollama"),
      model("never", { writes: ["never asked"] }, asked),
    ]);

    expect(chat).toMatchObject({ provider: "gemini", model: "newest" });
    expect(await partsOf(chat.stream(request))).toEqual([
      {
        type: "skipped",
        provider: "gemini",
        model: "newest",
        reason: "overloaded",
        message: "newest failed",
      },
      { type: "text", text: "El tope " },
      { type: "text", text: "es [1]." },
    ]);
    expect(asked).toEqual(["newest", "local"]);
    expect(chat).toMatchObject({ provider: "ollama", model: "local" });
  });

  it.each(["rate_limited", "unavailable", "unauthorized", "not_configured"] as const)(
    "moves on to another provider when a model is %s",
    async (reason) => {
      const chat = withFallback([
        model("first", { fails: reason }, [], "one"),
        model("second", { writes: ["ok"] }, [], "another"),
      ]);

      expect(await collect(chat.stream(request))).toEqual(["ok"]);
    },
  );

  it("does not try the other models of a provider whose key was rejected", async () => {
    const asked: string[] = [];
    const chat = withFallback([
      model("flash", { fails: "unauthorized" }, asked, "gemini"),
      model("flash-lite", { writes: ["same key, same answer"] }, asked, "gemini"),
      model("local", { writes: ["ok"] }, asked, "ollama"),
    ]);

    expect(await collect(chat.stream(request))).toEqual(["ok"]);
    expect(asked).toEqual(["flash", "local"]);
  });

  it("does try the other models of a provider that only lacked capacity", async () => {
    const asked: string[] = [];
    const chat = withFallback([
      model("flash", { fails: "overloaded" }, asked, "gemini"),
      model("flash-lite", { writes: ["ok"] }, asked, "gemini"),
    ]);

    expect(await collect(chat.stream(request))).toEqual(["ok"]);
    expect(asked).toEqual(["flash", "flash-lite"]);
  });

  it("does not switch models in the middle of an answer", async () => {
    const asked: string[] = [];
    const chat = withFallback([
      model("first", { writes: ["El tope "], thenFails: "overloaded" }, asked),
      model("second", { writes: ["otra respuesta"] }, asked),
    ]);

    const { pieces, failure } = await outcomeOf(chat.stream(request));

    expect(pieces).toEqual(["El tope "]);
    expect(failure).toMatchObject({ reason: "overloaded", message: "first broke off" });
    expect(asked).toEqual(["first"]);
  });

  it("when every model fails, says what each one said", async () => {
    const chat = withFallback([
      model("first", { fails: "overloaded" }),
      model("second", { fails: "rate_limited" }),
    ]);

    expect(await failureOf(chat.stream(request))).toMatchObject({
      reason: "rate_limited",
      message: "first failed\nsecond failed",
    });
  });

  it("when the only provider left was ruled out, fails with what it said", async () => {
    const chat = withFallback([
      model("flash", { fails: "unauthorized" }, [], "gemini"),
      model("flash-lite", { writes: ["never"] }, [], "gemini"),
    ]);

    expect(await failureOf(chat.stream(request))).toMatchObject({
      reason: "unauthorized",
      message: "flash failed",
    });
  });

  it("lets a failure that is not the model's through", async () => {
    const broken: ChatModel = {
      provider: "fake",
      model: "broken",

      async *stream() {
        throw new TypeError("a bug");
      },
    };
    const chat = withFallback([broken, model("second", { writes: ["ok"] })]);

    expect(await failureOf(chat.stream(request))).toBeInstanceOf(TypeError);
  });

  it("is the model itself when there is only one, and needs at least one", () => {
    const only = model("only", { writes: ["ok"] });

    expect(withFallback([only])).toBe(only);
    expect(() => withFallback([])).toThrow(RangeError);
  });
});

describe("chatModelFromEnv", () => {
  const env = {
    CHAT_PROVIDER: [],
    GEMINI_API_KEY: undefined,
    GEMINI_MODEL: [],
    CHAT_BASE_URL: undefined,
    CHAT_API_KEY: undefined,
    CHAT_MODEL: [],
    // Nothing listens here: asking fails at once, which shows the order tried.
    OLLAMA_BASE_URL: "http://127.0.0.1:9",
    OLLAMA_CHAT_MODEL: [],
  };
  // The last model of a chain is retried; here that would only be waiting.
  const fromEnv = (settings: Parameters<typeof chatModelFromEnv>[0]) =>
    chatModelFromEnv(settings, { lastModelRetries: 0 });
  const groq = {
    CHAT_BASE_URL: "http://127.0.0.1:9/openai/v1",
    CHAT_MODEL: ["gpt-oss"],
  };

  /** Asks the chain, with every address unreachable, and lists who was tried. */
  const tried = async (chat: ChatModel) => {
    const failure = (await failureOf(chat.stream(request))) as Error;
    return failure.message
      .split("\n")
      .map((line) => /^([^ ]+ \([^)]+\))/.exec(line)?.[1] ?? line);
  };

  it("with nothing configured, uses the local model", async () => {
    const chat = fromEnv(env);

    expect(chat).toMatchObject({
      provider: "ollama",
      model: DEFAULT_OLLAMA_CHAT_MODEL,
    });
    expect(await tried(chat)).toEqual([`ollama (${DEFAULT_OLLAMA_CHAT_MODEL})`]);
  });

  it("chains every provider that is configured: hosted ones first, the local one last", () => {
    const chat = fromEnv({ ...env, GEMINI_API_KEY: "a-key", ...groq });

    // Starts with Gemini's newest Flash; the rest is checked below, offline.
    expect(chat).toMatchObject({ provider: "gemini", model: DEFAULT_GEMINI_MODELS[0] });
  });

  it("leaves out, without a word, a hosted provider that is not configured", async () => {
    expect(await tried(fromEnv({ ...env, ...groq }))).toEqual([
      "127.0.0.1 (gpt-oss)",
      `ollama (${DEFAULT_OLLAMA_CHAT_MODEL})`,
    ]);
  });

  it("tries several models of a provider in the order given", async () => {
    const chat = fromEnv({
      ...env,
      ...groq,
      CHAT_MODEL: ["big", "small"],
      OLLAMA_CHAT_MODEL: ["gemma3:4b", "qwen2.5:3b"],
    });

    expect(await tried(chat)).toEqual([
      "127.0.0.1 (big)",
      "127.0.0.1 (small)",
      "ollama (gemma3:4b)",
      "ollama (qwen2.5:3b)",
    ]);
  });

  it("follows the providers and the order it is told", async () => {
    const chat = fromEnv({
      ...env,
      ...groq,
      CHAT_PROVIDER: ["ollama", "openai-compatible"],
    });

    expect(await tried(chat)).toEqual([
      `ollama (${DEFAULT_OLLAMA_CHAT_MODEL})`,
      "127.0.0.1 (gpt-oss)",
    ]);
  });

  it("reports a provider that was asked for and is not configured", async () => {
    const chat = fromEnv({ ...env, CHAT_PROVIDER: ["gemini", "ollama"] });
    const parts: ChatPart[] = [];
    await (async () => {
      try {
        for await (const part of chat.stream(request)) parts.push(part);
      } catch {
        // The local model is unreachable here; the skipped part is what matters.
      }
    })();

    expect(parts).toEqual([
      expect.objectContaining({
        type: "skipped",
        provider: "gemini",
        reason: "not_configured",
        message: expect.stringContaining("GEMINI_API_KEY is not set"),
      }),
      { type: "asking", provider: "ollama", model: DEFAULT_OLLAMA_CHAT_MODEL },
    ]);
  });

  it("says what an openai-compatible service needs when it is the only one asked for", async () => {
    const chat = fromEnv({ ...env, CHAT_PROVIDER: ["openai-compatible"] });

    expect(await failureOf(chat.stream(request))).toMatchObject({
      reason: "not_configured",
      message: expect.stringMatching(/CHAT_BASE_URL.*CHAT_MODEL/),
    });
  });
});

// Stand-ins for the two providers, speaking each one's streaming format.
describe("providers, against a local server", () => {
  let server: Server;
  let baseUrl: string;
  let seen: {
    url: string;
    key: string | undefined;
    authorization: string | undefined;
    body: Record<string, unknown>;
  }[];
  /** Model ids the stand-in has no capacity for. */
  let busy: string[];
  let status: number;
  let stall: boolean;

  const sse = (events: unknown[]) =>
    events
      .map(
        (event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`,
      )
      .join("\n\n") + "\n\n";

  beforeAll(async () => {
    server = createServer((incoming, response) => {
      let raw = "";
      incoming.on("data", (part) => (raw += part));
      incoming.on("end", () => {
        const url = incoming.url ?? "";
        seen.push({
          url,
          key: incoming.headers["x-goog-api-key"] as string | undefined,
          authorization: incoming.headers.authorization,
          body: JSON.parse(raw) as Record<string, unknown>,
        });

        if (busy.some((model) => url.includes(model))) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code: 503,
                message: "This model is currently experiencing high demand.",
                status: "UNAVAILABLE",
              },
            }),
          );
          return;
        }

        if (status !== 200) {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { code: status, message: "Quota exceeded", status: "EXHAUSTED" },
            }),
          );
          return;
        }

        response.writeHead(200, { "content-type": "text/event-stream" });
        if (stall) {
          // Sends the beginning of an answer and then never finishes it.
          response.write(
            sse([
              {
                id: "1",
                object: "chat.completion.chunk",
                created: 0,
                model: "local",
                choices: [
                  { index: 0, delta: { content: "Hola " }, finish_reason: null },
                ],
              },
            ]),
          );
          return;
        }
        if (url.includes("/chat/completions")) {
          const chunk = (delta: object, finishReason: string | null = null) => ({
            id: "1",
            object: "chat.completion.chunk",
            created: 0,
            model: "local",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          });
          response.end(
            sse([
              chunk({ role: "assistant", content: "Hola " }),
              chunk({ content: "desde Ollama [1]." }),
              chunk({}, "stop"),
              "[DONE]",
            ]),
          );
        } else {
          const candidate = (text: string, finishReason?: string) => ({
            candidates: [
              {
                index: 0,
                content: { role: "model", parts: [{ text }] },
                ...(finishReason && { finishReason }),
              },
            ],
            usageMetadata: {
              promptTokenCount: 3,
              candidatesTokenCount: 5,
              totalTokenCount: 8,
            },
          });
          response.end(
            sse([candidate("Hola "), candidate("desde Gemini [1].", "STOP")]),
          );
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    seen = [];
    status = 200;
    stall = false;
    busy = [];
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("asks Ollama through its OpenAI-compatible endpoint", async () => {
    const chat = createOllamaChatModel({ baseUrl: `${baseUrl}/`, model: "local" });

    expect((await collect(chat.stream(request))).join("")).toBe(
      "Hola desde Ollama [1].",
    );
    expect(seen[0]?.url).toBe("/v1/chat/completions");
    expect(seen[0]?.body).toMatchObject({
      model: "local",
      stream: true,
      messages: [
        { role: "system", content: "Answer with the sources only." },
        { role: "user", content: "Question?" },
      ],
    });
  });

  it("asks Gemini for the model chosen, with the key in a header", async () => {
    const chat = createGeminiChatModel({
      apiKey: "a-key",
      model: "flash-test",
      baseUrl,
    });

    expect((await collect(chat.stream(request))).join("")).toBe(
      "Hola desde Gemini [1].",
    );
    expect(seen[0]?.url).toContain("/models/flash-test:streamGenerateContent");
    expect(seen[0]?.url).not.toContain("a-key");
    expect(seen[0]?.key).toBe("a-key");
    expect(JSON.stringify(seen[0]?.body)).toContain("Answer with the sources only.");
    expect(JSON.stringify(seen[0]?.body)).toContain("Question?");
  });

  it("asks Gemini to reason little, and says nothing about reasoning to the others", async () => {
    // A real model id: the SDK words the request by the generation of the model.
    const gemini = createGeminiChatModel({
      apiKey: "a-key",
      model: "gemini-3.8-flash",
      baseUrl,
    });
    const local = createOllamaChatModel({ baseUrl, model: "local" });

    await collect(gemini.stream(request));
    await collect(local.stream(request));

    expect(seen[0]?.body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
    });
    expect(JSON.stringify(seen[1]?.body)).not.toMatch(/reasoning|thinking/i);
  });

  it("ends quietly when the reader goes away in the middle of an answer", async () => {
    stall = true;
    const controller = new AbortController();
    const chat = createOllamaChatModel({ baseUrl, model: "local", maxRetries: 0 });

    const pieces: string[] = [];
    const failure = await (async () => {
      try {
        for await (const part of chat.stream({
          ...request,
          signal: controller.signal,
        })) {
          if (part.type !== "text") continue;
          pieces.push(part.text);
          controller.abort();
        }
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(pieces).toEqual(["Hola "]);
    expect(failure).toBeNull();
  });

  it("sends the key of an OpenAI-compatible service as a bearer token", async () => {
    const chat = createOpenAICompatibleChatModel({
      provider: "api.groq.com",
      baseUrl: `${baseUrl}/openai/v1/`,
      apiKey: "another-key",
      model: "openai/gpt-oss-120b",
    });

    expect((await collect(chat.stream(request))).join("")).toBe(
      "Hola desde Ollama [1].",
    );
    expect(seen[0]?.url).toBe("/openai/v1/chat/completions");
    expect(seen[0]?.authorization).toBe("Bearer another-key");
    expect(seen[0]?.body).toMatchObject({ model: "openai/gpt-oss-120b" });
  });

  it("falls back to another Gemini model when the first has no capacity", async () => {
    busy = ["flash-newest"];
    const gemini = (model: string) =>
      createGeminiChatModel({ apiKey: "a-key", model, baseUrl, maxRetries: 0 });
    const chat = withFallback([gemini("flash-newest"), gemini("flash-older")]);

    expect((await collect(chat.stream(request))).join("")).toBe(
      "Hola desde Gemini [1].",
    );
    expect(seen.map((call) => /models\/([^:]+):/.exec(call.url)?.[1])).toEqual([
      "flash-newest",
      "flash-older",
    ]);
    expect(chat.model).toBe("flash-older");
  });

  it("calls a model without capacity overloaded, not unreachable", async () => {
    busy = ["flash-newest"];
    const chat = createGeminiChatModel({
      apiKey: "a-key",
      model: "flash-newest",
      baseUrl,
      maxRetries: 0,
    });

    expect(await failureOf(chat.stream(request))).toMatchObject({
      reason: "overloaded",
    });
  });

  it("reports the usage limit of a real HTTP response", async () => {
    status = 429;
    const chat = createGeminiChatModel({
      apiKey: "a-key",
      model: "flash-test",
      baseUrl,
      maxRetries: 0,
    });

    expect(await failureOf(chat.stream(request))).toMatchObject({
      reason: "rate_limited",
    });
  });
});
