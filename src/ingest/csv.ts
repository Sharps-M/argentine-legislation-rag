import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

import { parse } from "csv-parse";

import { INFOLEG_COLUMNS } from "./infoleg-row";

/**
 * Streams the records of an InfoLEG CSV as objects keyed by column name.
 *
 * The file is read as a stream: the full dataset is too large to hold in memory.
 */
export async function* readInfolegCsv(
  source: string | Readable,
): AsyncGenerator<Record<string, string>> {
  const input = typeof source === "string" ? createReadStream(source) : source;

  const parser = input.pipe(
    parse({
      bom: true,
      columns: (header: string[]) => {
        const missing = INFOLEG_COLUMNS.filter((column) => !header.includes(column));
        if (missing.length > 0) {
          throw new Error(`Not an InfoLEG CSV: missing columns ${missing.join(", ")}`);
        }
        return header;
      },
      skip_empty_lines: true,
    }),
  );

  for await (const record of parser) {
    yield record as Record<string, string>;
  }
}
