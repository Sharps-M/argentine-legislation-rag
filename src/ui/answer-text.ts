import { amountPattern, type AmountCheck } from "@/answers/amounts";
import { citationPattern } from "@/answers/citations";

/** A piece of a line of the answer. */
export type Segment =
  | { kind: "text"; text: string }
  /** "[1, 3]": each number, and whether it is one of the sources. */
  | { kind: "cite"; refs: { n: number; known: boolean }[] }
  /** "$1.598.124", with how it checked against the sources, once that is known. */
  | { kind: "amount"; text: string; check: AmountCheck | null };

/** The answer as the page lays it out: paragraphs and lists with hyphens. */
export type Block =
  { kind: "paragraph"; lines: Segment[][] } | { kind: "list"; items: Segment[][] };

const LIST_ITEM = /^\s*[-*•]\s+/;

/**
 * Splits an answer into what the page shows: paragraphs, lists, and in each
 * line its citations and its amounts.
 *
 * The amounts are paired with their checks in the order they appear, line by
 * line, which is the order in which `checkAmounts` found them. While the
 * answer is still being written there are no checks yet, and none is marked.
 */
export function toBlocks(
  text: string,
  {
    sourceCount,
    amounts = [],
  }: { sourceCount: number; amounts?: readonly AmountCheck[] },
): Block[] {
  const blocks: Block[] = [];
  let amountIndex = 0;

  const segment = (line: string): Segment[] => {
    const marks = [
      ...[...line.matchAll(citationPattern())].map((match) => ({
        at: match.index,
        end: match.index + match[0].length,
        segment: {
          kind: "cite",
          refs: (match[1] ?? "").split(",").map((written) => {
            const n = Number.parseInt(written, 10);
            return { n, known: n >= 1 && n <= sourceCount };
          }),
        } as Segment,
      })),
      ...[...line.matchAll(amountPattern())].map((match) => ({
        at: match.index,
        end: match.index + match[0].length,
        segment: { kind: "amount", text: match[0], check: null } as Segment,
      })),
    ].sort((a, b) => a.at - b.at);

    const segments: Segment[] = [];
    let from = 0;
    for (const mark of marks) {
      if (mark.at > from)
        segments.push({ kind: "text", text: line.slice(from, mark.at) });
      if (mark.segment.kind === "amount") {
        mark.segment = { ...mark.segment, check: amounts[amountIndex] ?? null };
        amountIndex += 1;
      }
      segments.push(mark.segment);
      from = mark.end;
    }
    if (from < line.length) segments.push({ kind: "text", text: line.slice(from) });
    return segments;
  };

  for (const line of text.split("\n")) {
    const last = blocks.at(-1);

    if (line.trim() === "") {
      // A blank line ends a paragraph or a list: the next line starts a new one.
      if (last) blocks.push({ kind: "paragraph", lines: [] });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const item = segment(line.replace(LIST_ITEM, ""));
      if (last?.kind === "list") last.items.push(item);
      else blocks.push({ kind: "list", items: [item] });
      continue;
    }

    const segments = segment(line.trim());
    if (last?.kind === "paragraph") last.lines.push(segments);
    else blocks.push({ kind: "paragraph", lines: [segments] });
  }

  return blocks.filter((block) =>
    block.kind === "paragraph" ? block.lines.length > 0 : block.items.length > 0,
  );
}
