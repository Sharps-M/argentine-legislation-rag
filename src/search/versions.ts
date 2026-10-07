/**
 * Some provisions are reissued again and again: every few months a new decree
 * repeats the same article with other amounts or dates. A similarity search
 * finds them all, a few thousandths apart, and may list last year's first.
 *
 * Chunks of different regulations whose texts are nearly identical are treated
 * here as versions of one provision: the most recent leads and the others are
 * kept under it.
 */

export type VersionCandidate = {
  regulationId: number;
  /** ISO date; `null` sorts as the oldest. */
  enactedOn: string | null;
  embedding: number[];
};

export type VersionGroup<T> = {
  /** The most recent version. */
  leader: T;
  /** The others, most recent first, with how similar their text is to the leader's. */
  others: { item: T; textSimilarity: number }[];
};

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/**
 * Whether two chunks can be issues of one provision: they must come from
 * different regulations enacted on different days. Two chunks of one
 * regulation are different passages; and decrees signed the same day that
 * share a paragraph are siblings, not an older and a newer version.
 */
const isAnotherIssue = (a: VersionCandidate, b: VersionCandidate) =>
  a.regulationId !== b.regulationId &&
  (a.enactedOn === null || b.enactedOn === null || a.enactedOn !== b.enactedOn);

const isMoreRecent = (candidate: VersionCandidate, current: VersionCandidate) =>
  (candidate.enactedOn ?? "") > (current.enactedOn ?? "");

/**
 * How chunks are joined into a group.
 *
 * - `best`: a chunk joins a group when it is similar enough to the group's
 *   best-ranked chunk. Every member stays close to one text, so a group cannot
 *   drift; but a series whose issues sit right at the threshold is cut into
 *   several groups, and an older issue may lead one of them.
 * - `chain`: a chunk joins a group when it is similar enough to any of its
 *   members, the strongest links first. A whole series ends up together even
 *   when its first and last issues are not that alike; the risk is the
 *   opposite one, joining look-alikes of different series through a middle one.
 */
export type VersionLinkage = "best" | "chain";

const bestGroups = <T extends VersionCandidate>(
  items: readonly T[],
  minTextSimilarity: number,
): T[][] => {
  const groups: T[][] = [];

  for (const item of items) {
    const group = groups.find(
      (members) =>
        members.every((member) => isAnotherIssue(member, item)) &&
        cosineSimilarity(members[0]!.embedding, item.embedding) >= minTextSimilarity,
    );

    if (group) group.push(item);
    else groups.push([item]);
  }

  return groups;
};

const chainGroups = <T extends VersionCandidate>(
  items: readonly T[],
  minTextSimilarity: number,
): T[][] => {
  const links: { a: number; b: number; similarity: number }[] = [];
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      if (!isAnotherIssue(items[a]!, items[b]!)) continue;

      const similarity = cosineSimilarity(items[a]!.embedding, items[b]!.embedding);
      if (similarity >= minTextSimilarity) links.push({ a, b, similarity });
    }
  }
  // The strongest links first: when two passages of one regulation both
  // resemble a third text, it goes with the one it resembles most.
  links.sort((x, y) => y.similarity - x.similarity || x.a - y.a || x.b - y.b);

  // A group is named after its best-ranked member, which is its lowest index.
  const groupOf = items.map((_, index) => index);
  const members = new Map(items.map((_, index) => [index, [index]]));

  for (const { a, b } of links) {
    const keep = Math.min(groupOf[a]!, groupOf[b]!);
    const drop = Math.max(groupOf[a]!, groupOf[b]!);
    if (keep === drop) continue;

    const kept = members.get(keep)!;
    const dropped = members.get(drop)!;
    // Two groups merge only if no regulation, and no day, ends up in it twice.
    const compatible = kept.every((x) =>
      dropped.every((y) => isAnotherIssue(items[x]!, items[y]!)),
    );
    if (!compatible) continue;

    for (const index of dropped) groupOf[index] = keep;
    members.set(
      keep,
      [...kept, ...dropped].sort((x, y) => x - y),
    );
    members.delete(drop);
  }

  return [...members.entries()]
    .sort(([x], [y]) => x - y)
    .map(([, indexes]) => indexes.map((index) => items[index]!));
};

/**
 * Groups items (given best first) into versions of the same provision.
 *
 * Two items can share a group when their texts are at least
 * `minTextSimilarity` alike and each is another issue of the other: from a
 * different regulation, enacted on a different day. `linkage` says to which
 * member of the group an item is compared. Groups keep the order of their best
 * item.
 *
 * The most recent issue leads because that is what a question usually wants.
 * `askedFor` says otherwise: it marks the items that state something the
 * question singles out, such as a date. When the most recent issue of a group
 * is not one of them, the most recent that is comes out of the group and goes
 * right before it, on its own.
 */
export function groupVersions<T extends VersionCandidate>(
  items: readonly T[],
  minTextSimilarity: number,
  linkage: VersionLinkage = "best",
  askedFor: (item: T) => boolean = () => false,
): VersionGroup<T>[] {
  const groups =
    linkage === "chain"
      ? chainGroups(items, minTextSimilarity)
      : bestGroups(items, minTextSimilarity);

  return groups.flatMap((members) => {
    const mostRecent = (candidates: readonly T[]) =>
      candidates.reduce((best, member) => (isMoreRecent(member, best) ? member : best));

    const leader = mostRecent(members);
    const wanted = askedFor(leader) ? [] : members.filter(askedFor);
    const apart = wanted.length > 0 ? mostRecent(wanted) : undefined;

    const group: VersionGroup<T> = {
      leader,
      others: members
        .filter((member) => member !== leader && member !== apart)
        .sort((a, b) => (b.enactedOn ?? "").localeCompare(a.enactedOn ?? ""))
        .map((item) => ({
          item,
          textSimilarity: cosineSimilarity(leader.embedding, item.embedding),
        })),
    };

    return apart ? [{ leader: apart, others: [] }, group] : [group];
  });
}
