import type { AnswerEvent } from "@/answers/answer";

/** One server-sent event as it arrives: its name and its data, still unchecked. */
export type RawEvent = { event: string; data: string };

/**
 * Reads a stream of server-sent events, one event at a time, as the bytes
 * arrive. An event ends with a blank line; it may come split across chunks, or
 * several may come in one.
 */
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // The specification allows \r\n and \r as well as \n.
      buffer = buffer.replace(/\r\n?/g, "\n");

      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = parseBlock(block);
        if (event) yield event;
      }

      if (done) {
        // A last event the server did not close with a blank line.
        const event = parseBlock(buffer);
        if (event) yield event;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): RawEvent | null {
  let event = "message";
  const data: string[] = [];

  for (const line of block.split("\n")) {
    // A line that starts with a colon is a comment: its field is empty, and
    // nothing below reads an empty field.
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  return data.length === 0 ? null : { event, data: data.join("\n") };
}

const ANSWER_EVENTS = new Set<string>([
  "sources",
  "asking",
  "skipped",
  "rewritten",
  "text",
  "done",
  "error",
] satisfies AnswerEvent["type"][]);

/**
 * An event of `/api/answer`, or `null` for one this screen does not know: a
 * newer server may send more kinds than an older page understands.
 */
export function toAnswerEvent({ event, data }: RawEvent): AnswerEvent | null {
  if (!ANSWER_EVENTS.has(event)) return null;
  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== "object" || parsed === null) return null;
  return { ...parsed, type: event } as AnswerEvent;
}
