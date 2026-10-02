import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

import yauzl from "yauzl";

/** Full InfoLEG dataset, published as open data (CC BY 4.0) and updated monthly. */
export const INFOLEG_DATASET_URL =
  "https://datos.jus.gob.ar/dataset/d9a963ea-8b1d-4ca3-9dd9-07a4773e8c23/resource/bf0ec116-ad4e-4572-a476-e57167a84403/download/base-infoleg-normativa-nacional.zip";

export const DATA_DIR = path.join("data", "infoleg");

/** Downloads the dataset ZIP (into `data/infoleg/` by default) and returns its path. */
export async function downloadDataset(
  url: string = INFOLEG_DATASET_URL,
  directory: string = DATA_DIR,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "base-infoleg-normativa-nacional.zip");

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText} (${url})`,
    );
  }

  await pipeline(
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    createWriteStream(target),
  );

  return target;
}

/** Extracts the first CSV found in a ZIP next to it and returns the CSV path. */
export function extractCsv(zipPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error("Cannot open ZIP"));

      zip.on("error", reject);
      zip.on("end", () => reject(new Error(`No CSV file inside ${zipPath}`)));

      zip.on("entry", (entry: yauzl.Entry) => {
        if (!entry.fileName.toLowerCase().endsWith(".csv")) {
          zip.readEntry();
          return;
        }

        // Use only the base name: never trust paths stored inside an archive.
        const target = path.join(path.dirname(zipPath), path.basename(entry.fileName));

        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            return reject(streamError ?? new Error("Cannot read ZIP entry"));
          }

          pipeline(stream, createWriteStream(target))
            .then(() => {
              zip.close();
              resolve(target);
            })
            .catch(reject);
        });
      });

      zip.readEntry();
    });
  });
}

/** Resolves a `.csv` or `.zip` path to a CSV path, extracting when needed. */
export async function resolveCsv(filePath: string): Promise<string> {
  await stat(filePath);
  return filePath.toLowerCase().endsWith(".zip") ? extractCsv(filePath) : filePath;
}
