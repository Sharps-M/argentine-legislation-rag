import { describe, expect, it } from "vitest";

import { cosineSimilarity, groupVersions, type VersionCandidate } from "./versions";

type Item = VersionCandidate & { name: string };

const item = (
  name: string,
  regulationId: number,
  enactedOn: string | null,
  embedding: number[],
): Item => ({ name, regulationId, enactedOn, embedding });

const names = (groups: ReturnType<typeof groupVersions<Item>>) =>
  groups.map((group) => [
    group.leader.name,
    ...group.others.map((other) => other.item.name),
  ]);

describe("cosineSimilarity", () => {
  it("is 1 for the same direction, 0 for unrelated and -1 for opposite", () => {
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });

  it("is 0 when a vector is empty or all zeros", () => {
    expect(cosineSimilarity([], [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe("groupVersions", () => {
  // Three issues of the same article, and an unrelated one.
  const april = item("294/2025", 1, "2025-04-25", [1, 0.01]);
  const august = item("578/2025", 2, "2025-08-14", [1, 0.02]);
  const latest = item("834/2026", 3, "2026-08-28", [1, 0.03]);
  const other = item("otra norma", 4, "2026-09-01", [0, 1]);

  it("puts the most recent version first and the others under it, newest first", () => {
    const groups = groupVersions([april, august, other, latest], 0.95);

    expect(names(groups)).toEqual([
      ["834/2026", "578/2025", "294/2025"],
      ["otra norma"],
    ]);
  });

  it("keeps each group where its best item was", () => {
    const groups = groupVersions([other, april, latest], 0.95);

    expect(names(groups)).toEqual([["otra norma"], ["834/2026", "294/2025"]]);
  });

  it("reports how similar each older text is to the one that leads", () => {
    const [group] = groupVersions([april, latest], 0.95);

    expect(group?.others[0]?.textSimilarity).toBeCloseTo(
      cosineSimilarity(latest.embedding, april.embedding),
    );
  });

  it("does not group texts below the threshold", () => {
    const close = item("parecida", 5, "2026-01-01", [1, 0.5]);

    expect(names(groupVersions([april, close], 0.95))).toEqual([
      ["294/2025"],
      ["parecida"],
    ]);
    expect(names(groupVersions([april, close], 0.8))).toEqual([
      ["parecida", "294/2025"],
    ]);
  });

  it("never groups two chunks of the same regulation", () => {
    const again = item("294/2025 bis", 1, "2025-04-25", [1, 0.01]);

    expect(names(groupVersions([april, again], 0.95))).toEqual([
      ["294/2025"],
      ["294/2025 bis"],
    ]);
  });

  it("treats a missing date as the oldest", () => {
    const undated = item("sin fecha", 6, null, [1, 0.01]);

    expect(names(groupVersions([undated, april], 0.95))).toEqual([
      ["294/2025", "sin fecha"],
    ]);
  });

  it("does not group regulations enacted the same day: they are siblings", () => {
    const twin = item("gemela", 7, "2025-04-25", [1, 0.01]);

    expect(names(groupVersions([april, twin], 0.95))).toEqual([
      ["294/2025"],
      ["gemela"],
    ]);
    // Nor through a third one that both resemble.
    expect(names(groupVersions([april, latest, twin], 0.95))).toEqual([
      ["834/2026", "294/2025"],
      ["gemela"],
    ]);
  });

  it("returns nothing for nothing", () => {
    expect(groupVersions([], 0.95)).toEqual([]);
    expect(groupVersions([], 0.95, "chain")).toEqual([]);
  });
});

describe("groupVersions, chain linkage", () => {
  // Each issue is very like the one before it; the first and the last are not
  // that alike any more. cos 14° = 0.970, cos 28° = 0.883.
  const turn = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return [Math.cos(radians), Math.sin(radians)];
  };
  const first = item("36/2026", 1, "2026-01-23", turn(0));
  const second = item("206/2026", 2, "2026-03-27", turn(14));
  const third = item("552/2026", 3, "2026-06-29", turn(28));

  it("keeps a series together where comparing with the best item cuts it", () => {
    // By relevance the first issue comes before the last, and the middle one after.
    const items = [first, third, second];

    expect(names(groupVersions(items, 0.95, "best"))).toEqual([
      ["206/2026", "36/2026"],
      ["552/2026"],
    ]);
    expect(names(groupVersions(items, 0.95, "chain"))).toEqual([
      ["552/2026", "206/2026", "36/2026"],
    ]);
  });

  it("still leaves apart what is below the threshold of every member", () => {
    const far = item("otra", 4, "2026-09-01", turn(60));

    expect(names(groupVersions([first, second, far], 0.95, "chain"))).toEqual([
      ["206/2026", "36/2026"],
      ["otra"],
    ]);
  });

  it("keeps each group where its best item was", () => {
    const far = item("otra", 4, "2026-09-01", turn(90));

    expect(names(groupVersions([far, first, second], 0.95, "chain"))).toEqual([
      ["otra"],
      ["206/2026", "36/2026"],
    ]);
  });

  it("does not join two regulations of the same day through a third", () => {
    const twin = item("37/2026", 5, "2026-01-23", turn(1));

    // Both resemble 206/2026; the closer one gets it, the other stays alone.
    expect(names(groupVersions([first, twin, second], 0.95, "chain"))).toEqual([
      ["36/2026"],
      ["206/2026", "37/2026"],
    ]);
  });

  it("gives a text to the passage it resembles most, not to the first one found", () => {
    // Two passages of one decree, and an older decree that repeats the second.
    const article = item("834/2026 art. 3", 6, "2026-08-28", turn(0));
    const annex = item("834/2026 anexo", 6, "2026-08-28", turn(16));
    const older = item("553/2026 anexo", 7, "2026-06-29", turn(14));

    expect(names(groupVersions([article, annex, older], 0.95, "chain"))).toEqual([
      ["834/2026 art. 3"],
      ["834/2026 anexo", "553/2026 anexo"],
    ]);
    // Comparing with the best item gives it to whichever group comes first.
    expect(names(groupVersions([article, annex, older], 0.95, "best"))).toEqual([
      ["834/2026 art. 3", "553/2026 anexo"],
      ["834/2026 anexo"],
    ]);
  });
});
