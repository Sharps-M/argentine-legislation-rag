import { describe, expect, it } from "vitest";

import { readEvents, toAnswerEvent, type RawEvent } from "./event-stream";

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

const all = async (body: ReadableStream<Uint8Array>) => {
  const events: RawEvent[] = [];
  for await (const event of readEvents(body)) events.push(event);
  return events;
};

describe("readEvents", () => {
  it("reads each event with its name and its data", async () => {
    expect(
      await all(
        streamOf('event: text\ndata: {"text":"Hola"}\n\nevent: done\ndata: {}\n\n'),
      ),
    ).toEqual([
      { event: "text", data: '{"text":"Hola"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("puts back together an event split across chunks, even inside a character", async () => {
    const bytes = new TextEncoder().encode(
      'event: text\ndata: {"text":"Atención"}\n\n',
    );
    // Cut in the middle of the two bytes of "ó".
    const cut = bytes.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });

    expect(await all(body)).toEqual([{ event: "text", data: '{"text":"Atención"}' }]);
  });

  it("joins several data lines, and takes \\r\\n as a line break", async () => {
    expect(await all(streamOf("event: text\r\ndata: a\r\ndata: b\r\n\r\n"))).toEqual([
      { event: "text", data: "a\nb" },
    ]);
  });

  it("skips comments and events with no data, and names unnamed ones 'message'", async () => {
    expect(await all(streamOf(": keep-alive\n\nevent: ping\n\ndata: x\n\n"))).toEqual([
      { event: "message", data: "x" },
    ]);
  });

  it("reads a last event that was not closed with a blank line", async () => {
    expect(await all(streamOf("event: done\ndata: {}"))).toEqual([
      { event: "done", data: "{}" },
    ]);
  });

  it("keeps a colon inside the value, and only one space after the field", async () => {
    expect(await all(streamOf("data:  a: b\n\n"))).toEqual([
      { event: "message", data: " a: b" },
    ]);
  });
});

describe("toAnswerEvent", () => {
  it("turns an event of the answer into its typed form", () => {
    expect(toAnswerEvent({ event: "text", data: '{"text":"Hola"}' })).toEqual({
      type: "text",
      text: "Hola",
    });
  });

  it("keeps the name of the event over a 'type' in its data", () => {
    expect(
      toAnswerEvent({ event: "text", data: '{"type":"done","text":"x"}' }),
    ).toEqual({
      type: "text",
      text: "x",
    });
  });

  it("ignores events it does not know, and data that is not an object", () => {
    expect(toAnswerEvent({ event: "progress", data: "{}" })).toBeNull();
    expect(toAnswerEvent({ event: "text", data: "3" })).toBeNull();
    expect(toAnswerEvent({ event: "text", data: "null" })).toBeNull();
  });
});
