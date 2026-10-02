import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { readInfolegCsv } from "./csv";
import { INFOLEG_COLUMNS } from "./infoleg-row";

const collect = async (source: string | Readable) => {
  const records: Record<string, string>[] = [];
  for await (const record of readInfolegCsv(source)) records.push(record);
  return records;
};

const fixture = path.join("tests", "fixtures", "infoleg-sample.csv");
const header = INFOLEG_COLUMNS.map((column) => `"${column}"`).join(",");

describe("readInfolegCsv", () => {
  it("reads the real sample rows keyed by column name", async () => {
    const records = await collect(fixture);

    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({
      id_norma: "374675",
      tipo_norma: "Resolución",
      clase_norma: "",
      fecha_sancion: "2022-11-03",
    });
    expect(Object.keys(records[0] ?? {})).toEqual([...INFOLEG_COLUMNS]);
  });

  it("keeps commas, quotes and line breaks inside quoted fields", async () => {
    const values = INFOLEG_COLUMNS.map((column) =>
      column === "texto_resumido" ? '"UNO, DOS\nY ""TRES"""' : '"x"',
    ).join(",");

    const [record] = await collect(Readable.from([`﻿${header}\n${values}\n`]));

    expect(record?.texto_resumido).toBe('UNO, DOS\nY "TRES"');
    expect(record?.id_norma).toBe("x");
  });

  it("refuses a CSV that is not the InfoLEG dataset", async () => {
    await expect(collect(Readable.from(['"a","b"\n"1","2"\n']))).rejects.toThrow(
      /Not an InfoLEG CSV: missing columns id_norma/,
    );
  });
});
