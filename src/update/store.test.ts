import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unfinishedFile } from "./store";
import { NOTHING_UNFINISHED } from "./update";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "updates-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("unfinishedFile", () => {
  it("has nothing unfinished before the first update", async () => {
    expect(await unfinishedFile(directory).load()).toEqual(NOTHING_UNFINISHED);
  });

  it("reads back what was saved, creating the folder", async () => {
    const nested = path.join(directory, "data", "updates");
    const work = { refetch: [1, 2], rechunk: [3], revector: [3] };

    await unfinishedFile(nested).save(work);

    expect(await unfinishedFile(nested).load()).toEqual(work);
    expect(
      JSON.parse(await readFile(path.join(nested, "unfinished.json"), "utf8")),
    ).toEqual(work);
  });

  it("fills in what a file leaves out, and starts clean from a damaged one", async () => {
    await writeFile(path.join(directory, "unfinished.json"), '{"refetch":[4]}');
    expect(await unfinishedFile(directory).load()).toEqual({
      refetch: [4],
      rechunk: [],
      revector: [],
    });

    await writeFile(path.join(directory, "unfinished.json"), '{"revector":[5]}');
    expect(await unfinishedFile(directory).load()).toEqual({
      refetch: [],
      rechunk: [],
      revector: [5],
    });

    await writeFile(path.join(directory, "unfinished.json"), "not json");
    expect(await unfinishedFile(directory).load()).toEqual(NOTHING_UNFINISHED);
  });
});
