import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

import { DATA_DIR, INFOLEG_DATASET_URL } from "@/ingest/download";
import { USER_AGENT } from "@/texts/fetcher";

/** What was learned about the dataset the last time it was downloaded. */
export type DatasetState = {
  /** Validators the server sent, to ask next time "only if it changed". */
  etag: string | null;
  lastModified: string | null;
  /** SHA-256 of the ZIP: tells a new file from the same one sent again. */
  sha256: string;
  downloadedAt: string;
};

export type DatasetCheck =
  | {
      changed: false;
      /** `not_modified`: the server said so (304). `same_content`: it sent the same file. */
      reason: "not_modified" | "same_content";
    }
  | { changed: true; zipPath: string; state: DatasetState };

export type FetchDatasetOptions = {
  url?: string;
  directory?: string;
  fetch?: typeof fetch;
  now?: () => Date;
};

const STATE_FILE = "dataset.json";
const ZIP_FILE = "base-infoleg-normativa-nacional.zip";

export async function readDatasetState(
  directory: string = DATA_DIR,
): Promise<DatasetState | null> {
  try {
    return JSON.parse(
      await readFile(path.join(directory, STATE_FILE), "utf8"),
    ) as DatasetState;
  } catch {
    return null;
  }
}

/** Remembers the dataset that was loaded. Called once it is in the database, not before. */
export async function saveDatasetState(
  state: DatasetState,
  directory: string = DATA_DIR,
): Promise<void> {
  await writeFile(
    path.join(directory, STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

/**
 * Downloads the dataset only if it changed since `previous`.
 *
 * The server is asked first with the validators it gave last time, and a 304
 * costs no download. If it ignores them and sends the file anyway, the file is
 * compared by its hash: the same bytes are not a new dataset. The ZIP that was
 * there is only replaced by a new one, never by a half-downloaded file.
 */
export async function fetchDatasetIfChanged(
  previous: DatasetState | null,
  {
    url = INFOLEG_DATASET_URL,
    directory = DATA_DIR,
    fetch: get = fetch,
    now = () => new Date(),
  }: FetchDatasetOptions = {},
): Promise<DatasetCheck> {
  await mkdir(directory, { recursive: true });

  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (previous?.etag) headers["If-None-Match"] = previous.etag;
  if (previous?.lastModified) headers["If-Modified-Since"] = previous.lastModified;

  const response = await get(url, { headers });
  if (response.status === 304) return { changed: false, reason: "not_modified" };
  if (!response.ok || !response.body) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText} (${url})`,
    );
  }

  const target = path.join(directory, ZIP_FILE);
  const partial = `${target}.part`;
  const hash = createHash("sha256");
  try {
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(partial),
    );
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }

  const sha256 = hash.digest("hex");
  if (previous && previous.sha256 === sha256) {
    await rm(partial, { force: true });
    return { changed: false, reason: "same_content" };
  }

  await rename(partial, target);
  return {
    changed: true,
    zipPath: target,
    state: {
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      sha256,
      downloadedAt: now().toISOString(),
    },
  };
}
