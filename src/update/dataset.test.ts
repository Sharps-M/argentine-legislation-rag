import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { USER_AGENT } from "@/texts/fetcher";

import {
  fetchDatasetIfChanged,
  readDatasetState,
  saveDatasetState,
  type DatasetState,
} from "./dataset";

let directory: string;
let server: Server;
let url: string;
/** What the fake server sends, and what it was asked. */
let reply: { status: number; body: string; headers?: Record<string, string> };
let requests: IncomingHttpHeaders[];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dataset-"));
  requests = [];
  reply = { status: 200, body: "ZIP-1" };
  server = createServer((request, response) => {
    requests.push(request.headers);
    response.writeHead(reply.status, reply.headers);
    response.end(reply.status === 304 ? undefined : reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dataset.zip`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

const now = () => new Date("2026-10-27T12:00:00Z");

describe("fetchDatasetIfChanged", () => {
  it("downloads the dataset the first time, with what it needs to ask next time", async () => {
    reply = {
      status: 200,
      body: "ZIP-1",
      headers: { ETag: '"abc"', "Last-Modified": "Mon, 05 Oct 2026 10:00:00 GMT" },
    };

    const result = await fetchDatasetIfChanged(null, { url, directory, now });

    expect(result).toMatchObject({
      changed: true,
      state: {
        etag: '"abc"',
        lastModified: "Mon, 05 Oct 2026 10:00:00 GMT",
        downloadedAt: "2026-10-27T12:00:00.000Z",
      },
    });
    if (!result.changed) throw new Error();
    expect(result.state.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(result.zipPath, "utf8")).toBe("ZIP-1");
    expect(requests[0]?.["user-agent"]).toBe(USER_AGENT);
    expect(requests[0]?.["if-none-match"]).toBeUndefined();
  });

  it("asks only for a newer one, and downloads nothing when the server says so", async () => {
    const first = await fetchDatasetIfChanged(null, { url, directory, now });
    if (!first.changed) throw new Error();
    const previous: DatasetState = {
      ...first.state,
      etag: '"abc"',
      lastModified: "Mon, 05 Oct 2026 10:00:00 GMT",
    };
    reply = { status: 304, body: "" };

    expect(await fetchDatasetIfChanged(previous, { url, directory, now })).toEqual({
      changed: false,
      reason: "not_modified",
    });
    expect(requests[1]).toMatchObject({
      "if-none-match": '"abc"',
      "if-modified-since": "Mon, 05 Oct 2026 10:00:00 GMT",
    });
  });

  it("tells the same file sent again from a new one", async () => {
    const first = await fetchDatasetIfChanged(null, { url, directory, now });
    if (!first.changed) throw new Error();

    expect(await fetchDatasetIfChanged(first.state, { url, directory, now })).toEqual({
      changed: false,
      reason: "same_content",
    });

    reply = { status: 200, body: "ZIP-2" };
    const second = await fetchDatasetIfChanged(first.state, { url, directory, now });
    expect(second.changed).toBe(true);
    if (!second.changed) throw new Error();
    expect(second.state.sha256).not.toBe(first.state.sha256);
    expect(await readFile(second.zipPath, "utf8")).toBe("ZIP-2");
  });

  it("leaves no half file behind when the same file comes again", async () => {
    const first = await fetchDatasetIfChanged(null, { url, directory, now });
    if (!first.changed) throw new Error();
    await fetchDatasetIfChanged(first.state, { url, directory, now });

    expect(await readdir(directory)).toEqual(["base-infoleg-normativa-nacional.zip"]);
  });

  it("fails on an error, and keeps the file it had", async () => {
    await fetchDatasetIfChanged(null, { url, directory, now });
    reply = { status: 503, body: "busy" };

    await expect(fetchDatasetIfChanged(null, { url, directory, now })).rejects.toThrow(
      /503/,
    );
    expect(
      await readFile(
        path.join(directory, "base-infoleg-normativa-nacional.zip"),
        "utf8",
      ),
    ).toBe("ZIP-1");
  });
});

describe("the dataset state", () => {
  it("is null before the first update, and reads back what was saved", async () => {
    expect(await readDatasetState(directory)).toBeNull();

    const state: DatasetState = {
      etag: null,
      lastModified: null,
      sha256: "a".repeat(64),
      downloadedAt: "2026-10-27T12:00:00.000Z",
    };
    await saveDatasetState(state, directory);

    expect(await readDatasetState(directory)).toEqual(state);
  });

  it("is null when the file is damaged", async () => {
    await writeFile(path.join(directory, "dataset.json"), "{ not json");

    expect(await readDatasetState(directory)).toBeNull();
  });
});
