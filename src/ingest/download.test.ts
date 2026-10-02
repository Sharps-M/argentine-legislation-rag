import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { downloadDataset, extractCsv, resolveCsv } from "./download";

const fixtures = path.join("tests", "fixtures");
const sampleZip = path.join(fixtures, "infoleg-sample.zip");
const sampleCsv = path.join(fixtures, "infoleg-sample.csv");

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "infoleg-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("extractCsv", () => {
  it("extracts the CSV next to the ZIP, byte for byte", async () => {
    const zip = path.join(workDir, "dataset.zip");
    await copyFile(sampleZip, zip);

    const csv = await extractCsv(zip);

    expect(path.dirname(csv)).toBe(workDir);
    expect(await readFile(csv, "utf8")).toBe(await readFile(sampleCsv, "utf8"));
  });

  it("fails clearly when the file is not a ZIP", async () => {
    const notZip = path.join(workDir, "dataset.zip");
    await copyFile(sampleCsv, notZip);

    await expect(extractCsv(notZip)).rejects.toThrow();
  });
});

describe("resolveCsv", () => {
  it("returns a CSV path untouched", async () => {
    await expect(resolveCsv(sampleCsv)).resolves.toBe(sampleCsv);
  });

  it("rejects a path that does not exist", async () => {
    await expect(resolveCsv(path.join(workDir, "missing.csv"))).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe("downloadDataset", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const zip = await readFile(sampleZip);

    server = createServer((request, response) => {
      if (request.url === "/dataset.zip") {
        response.writeHead(200, { "content-type": "application/zip" }).end(zip);
      } else {
        response.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => new Promise<void>((resolve) => void server.close(() => resolve())));

  it("saves the ZIP and it can be extracted", async () => {
    const zip = await downloadDataset(`${baseUrl}/dataset.zip`, workDir);
    const csv = await extractCsv(zip);

    expect(await readFile(csv, "utf8")).toBe(await readFile(sampleCsv, "utf8"));
  });

  it("reports the HTTP status when the download fails", async () => {
    await expect(downloadDataset(`${baseUrl}/missing.zip`, workDir)).rejects.toThrow(
      /Download failed: 404/,
    );
  });
});
