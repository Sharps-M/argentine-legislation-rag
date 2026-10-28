import { createServer } from "node:http";

import { hashingVector } from "../../support/hashing-embedder";

/**
 * A stand-in for Ollama, for the browser tests: nothing is downloaded and no
 * answer depends on a real model.
 *
 * - Embeddings (`/v1/embeddings`): the same hashing vectors as the integration
 *   tests, so the questions find what they are meant to find.
 * - Chat (`/v1/chat/completions`): an answer that cites the first source, in
 *   the language of the prompt, written a word at a time so the page can be
 *   seen, and stopped, while it writes.
 *
 * Run as a script: `tsx tests/e2e/support/fake-models.ts <port>`.
 */

/** Long enough to press "Stop" in the middle of an answer. */
const WORD_DELAY_MS = 120;

type ChatBody = { model: string; messages: { role: string; content: string }[] };
type EmbedBody = { model: string; input: string | string[] };

/** The answer: what the first source is, cited, in the prompt's language. */
export function fakeAnswer(prompt: string): string {
  const first = /\[1\] ([^\n(]+)/.exec(prompt)?.[1]?.trim() ?? "?";
  return prompt.includes("Pregunta:")
    ? `La primera fuente es ${first} [1]. Es una respuesta de prueba.`
    : `The first source is ${first} [1]. This is a test answer.`;
}

const chunk = (model: string, delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "fake",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

export function startFakeModels(port: number) {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (part: Buffer) => (raw += part.toString()));
    request.on("end", async () => {
      if (request.method !== "POST") {
        response.writeHead(200).end("fake models");
        return;
      }

      if (request.url?.endsWith("/chat/completions")) {
        const body = JSON.parse(raw) as ChatBody;
        const prompt = body.messages.map((message) => message.content).join("\n");
        response.writeHead(200, { "content-type": "text/event-stream" });
        let stopped = false;
        response.on("close", () => (stopped = true));
        for (const word of fakeAnswer(prompt).split(" ")) {
          if (stopped) return;
          response.write(chunk(body.model, { content: `${word} ` }));
          await new Promise((resolve) => setTimeout(resolve, WORD_DELAY_MS));
        }
        response.end(chunk(body.model, {}, "stop") + "data: [DONE]\n\n");
        return;
      }

      const body = JSON.parse(raw) as EmbedBody;
      const input = Array.isArray(body.input) ? body.input : [body.input];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          model: body.model,
          data: input.map((text, index) => ({
            object: "embedding",
            index,
            embedding: hashingVector(text),
          })),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
      );
    });
  });
  return server.listen(port, "127.0.0.1");
}

if (process.argv[1]?.endsWith("fake-models.ts")) {
  const port = Number(process.argv[2] ?? 11500);
  startFakeModels(port).on("listening", () =>
    console.log(`Fake models on http://127.0.0.1:${port}`),
  );
}
