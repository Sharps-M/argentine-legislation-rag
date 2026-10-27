import type { NewRegulation } from "@/db/schema";
import type { EmbedReport } from "@/embeddings/pipeline";
import { parseInfolegRow } from "@/ingest/infoleg-row";
import { matchesSubset, type SubsetFilter } from "@/ingest/subset";
import type { TextReport } from "@/texts/pipeline";

import { findChanges, type RegulationChange, type Snapshot } from "./changes";

/**
 * Work an update found and had not finished: regulations whose page has to be
 * downloaded again, or whose vectors have to be redone. It is written down
 * before the database changes, so that an update cut short (Ollama down, the
 * server refusing) is finished by the next one instead of forgotten: by then
 * the stored regulation already looks like the dataset, and nothing would tell
 * that its text is out of date.
 */
export type Unfinished = { refetch: number[]; rechunk: number[]; revector: number[] };

export const NOTHING_UNFINISHED: Unfinished = {
  refetch: [],
  rechunk: [],
  revector: [],
};

export type UpdateDeps = {
  /** The rows of the dataset, or `null` when it did not change since the last update. */
  records: () => Promise<AsyncIterable<Record<string, unknown>> | null>;
  /** How the stored regulations look now. */
  snapshots: () => Promise<Map<number, Snapshot>>;
  upsert: (regulations: NewRegulation[]) => Promise<void>;
  /** Stored regulations that have no text yet. */
  withoutText: () => Promise<number[]>;
  /** Downloads (or, with `refetch: false`, reads from the cache), chunks and saves texts. */
  texts: (ids: number[], options: { refetch: boolean }) => Promise<TextReport>;
  /** Forgets the vectors of these regulations' chunks; returns how many. */
  forgetVectors: (ids: number[]) => Promise<number>;
  /** Embeds every chunk without a vector. */
  embed: () => Promise<EmbedReport>;
  unfinished: {
    load: () => Promise<Unfinished>;
    save: (work: Unfinished) => Promise<void>;
  };
  /** Called once everything else worked: remembers the dataset that was loaded. */
  commit: () => Promise<void>;
};

export type UpdateOptions = {
  /** Which regulations the corpus keeps; a row matching any of them is kept. */
  subset: readonly SubsetFilter[];
  /** Only say what would change: nothing is written or downloaded but the dataset. */
  check?: boolean;
  batchSize?: number;
};

export type DatasetChanges = {
  read: number;
  rejected: number;
  inSubset: number;
  added: NewRegulation[];
  changed: RegulationChange[];
  unchanged: number;
};

export type UpdateReport = {
  /** `null` when the dataset did not change. */
  dataset: DatasetChanges | null;
  /** Work left by an update that did not finish, done now. */
  resumed: Unfinished;
  /** Absent when only checking. */
  done?: {
    newTexts: TextReport | null;
    refetched: TextReport | null;
    rechunked: TextReport | null;
    vectorsForgotten: number;
    embedded: EmbedReport | null;
  };
};

/** The update stopped before the end; what it did not finish is kept for the next one. */
export class UpdateIncomplete extends Error {
  constructor(reason: string) {
    super(
      `The update did not finish: ${reason}. The next run picks up where it stopped.`,
    );
    this.name = "UpdateIncomplete";
  }
}

const union = (...lists: number[][]) =>
  [...new Set(lists.flat())].sort((a, b) => a - b);

async function readDataset(
  records: AsyncIterable<Record<string, unknown>>,
  subset: readonly SubsetFilter[],
  stored: Map<number, Snapshot>,
): Promise<DatasetChanges> {
  let read = 0;
  let rejected = 0;
  const current: NewRegulation[] = [];

  for await (const record of records) {
    read += 1;
    const parsed = parseInfolegRow(record);
    if (!parsed.ok) rejected += 1;
    else if (subset.some((filter) => matchesSubset(parsed.regulation, filter))) {
      current.push(parsed.regulation);
    }
  }

  return { read, rejected, inSubset: current.length, ...findChanges(stored, current) };
}

/**
 * Brings the corpus up to date with the dataset InfoLEG publishes every month.
 *
 * Regulations are added and updated, never deleted: one that leaves the
 * dataset, or the subset, stays where it is. For each one that changed it does
 * only what the change asks for: its page is downloaded again when the text may
 * be different, and its vectors are redone when the heading they were made with
 * is different.
 */
export async function runUpdate(
  deps: UpdateDeps,
  { subset, check = false, batchSize = 500 }: UpdateOptions,
): Promise<UpdateReport> {
  const resumed = await deps.unfinished.load();
  const records = await deps.records();
  const dataset = records
    ? await readDataset(records, subset, await deps.snapshots())
    : null;

  if (check) return { dataset, resumed };

  const changed = dataset?.changed ?? [];
  const work: Unfinished = {
    refetch: union(
      resumed.refetch,
      changed.filter((c) => c.text).map((c) => c.id),
    ),
    // A new heading: a summary-only text is built from it, so it is made again
    // (from the cache) and saved if it came out different.
    rechunk: union(
      resumed.rechunk,
      changed.filter((c) => c.context && !c.text).map((c) => c.id),
    ),
    revector: union(
      resumed.revector,
      changed.filter((c) => c.context).map((c) => c.id),
    ),
  };
  await deps.unfinished.save(work);

  if (dataset) {
    const toWrite = new Set([
      ...dataset.added.map((regulation) => regulation.id),
      ...changed.map((change) => change.id),
    ]);
    const rows = [...dataset.added, ...changed.map((change) => change.after)].filter(
      (row) => toWrite.has(row.id),
    );
    for (let start = 0; start < rows.length; start += batchSize) {
      await deps.upsert(rows.slice(start, start + batchSize));
    }
  }

  // A server that keeps refusing stops the texts: nothing after that is done,
  // and the work stays written down for the next run.
  const texts = async (ids: number[], refetch: boolean) => {
    if (ids.length === 0) return null;
    const result = await deps.texts(ids, { refetch });
    if (result.aborted) throw new UpdateIncomplete(result.aborted);
    return result;
  };

  const withoutText = await deps.withoutText();
  const done = {
    newTexts: await texts(withoutText, false),
    refetched: await texts(work.refetch, true),
    rechunked: await texts(work.rechunk, false),
    vectorsForgotten:
      work.revector.length > 0 ? await deps.forgetVectors(work.revector) : 0,
    embedded: null as EmbedReport | null,
  };
  // Every chunk without a vector, whatever left it so: new, rewritten or forgotten.
  done.embedded = await deps.embed();

  await deps.unfinished.save(NOTHING_UNFINISHED);
  if (dataset) await deps.commit();
  return { dataset, resumed, done };
}
