import type { NewRegulation, Regulation } from "@/db/schema";

/**
 * What the update looks at in a regulation it already has. Fields that change
 * the text decide whether its page is downloaded again; fields that change the
 * heading each chunk is embedded with decide whether its vectors are redone.
 */
export const TEXT_FIELDS = [
  // A new consolidated text, or the first one.
  "updatedTextUrl",
  "originalTextUrl",
  // Another regulation amended this one: its consolidated text may have changed.
  "amendedByCount",
  // A regulation with no published text is indexed by its abstract.
  "summary",
] as const satisfies readonly (keyof Regulation)[];

export const CONTEXT_FIELDS = [
  "type",
  "number",
  "enactedOn",
  "topic",
  "title",
] as const satisfies readonly (keyof Regulation)[];

type Watched = (typeof TEXT_FIELDS)[number] | (typeof CONTEXT_FIELDS)[number];

/** A regulation as it is stored, with only what the update compares. */
export type Snapshot = Pick<Regulation, "id" | Watched>;

export type RegulationChange = {
  id: number;
  /** The regulation as the dataset now describes it: what gets stored. */
  after: NewRegulation;
  /** What changed, by field name. */
  fields: Watched[];
  /** Its page has to be downloaded again. */
  text: boolean;
  /** The heading of its chunks changed: they have to be embedded again. */
  context: boolean;
};

const valueOf = (regulation: Partial<Pick<Regulation, Watched>>, field: Watched) =>
  regulation[field] ?? null;

/**
 * Compares a regulation as the dataset now describes it with how it was
 * stored. `null` when nothing the update cares about changed.
 */
export function compareRegulation(
  before: Snapshot,
  after: NewRegulation,
): RegulationChange | null {
  const differs = (field: Watched) => valueOf(before, field) !== valueOf(after, field);
  const textFields = TEXT_FIELDS.filter(differs);
  const contextFields = CONTEXT_FIELDS.filter(differs);

  if (textFields.length === 0 && contextFields.length === 0) return null;

  return {
    id: before.id,
    after,
    fields: [...textFields, ...contextFields],
    text: textFields.length > 0,
    context: contextFields.length > 0,
  };
}

export type Changes = {
  /** In the dataset and the subset, and not stored yet. */
  added: NewRegulation[];
  changed: RegulationChange[];
  /** Stored and still the same. */
  unchanged: number;
};

/** Sorts the regulations the dataset lists into new, changed and unchanged. */
export function findChanges(
  stored: ReadonlyMap<number, Snapshot>,
  current: Iterable<NewRegulation>,
): Changes {
  const changes: Changes = { added: [], changed: [], unchanged: 0 };

  for (const regulation of current) {
    const before = stored.get(regulation.id);
    if (!before) {
      changes.added.push(regulation);
      continue;
    }
    const change = compareRegulation(before, regulation);
    if (change) changes.changed.push(change);
    else changes.unchanged += 1;
  }

  return changes;
}
