import { describe, expect, it } from "vitest";

import { checkAmounts } from "@/answers/amounts";
import { toSources } from "@/answers/sources";

import { searchHit } from "../../tests/support/search-hits";
import { toBlocks, type Block } from "./answer-text";

const text = (value: string) => ({ kind: "text", text: value }) as const;

describe("toBlocks", () => {
  it("keeps paragraphs apart, and the lines of one paragraph together", () => {
    expect(toBlocks("Uno.\nDos.\n\n\nTres.", { sourceCount: 0 })).toEqual([
      { kind: "paragraph", lines: [[text("Uno.")], [text("Dos.")]] },
      { kind: "paragraph", lines: [[text("Tres.")]] },
    ]);
  });

  it("turns lines that start with a hyphen into a list", () => {
    expect(toBlocks("Valores:\n- $1 [1]\n- $2 [1]\nFin.", { sourceCount: 1 })).toEqual([
      { kind: "paragraph", lines: [[text("Valores:")]] },
      {
        kind: "list",
        items: [
          [
            { kind: "amount", text: "$1", check: null },
            text(" "),
            { kind: "cite", refs: [{ n: 1, known: true }] },
          ],
          [
            { kind: "amount", text: "$2", check: null },
            text(" "),
            { kind: "cite", refs: [{ n: 1, known: true }] },
          ],
        ],
      },
      { kind: "paragraph", lines: [[text("Fin.")]] },
    ] satisfies Block[]);
  });

  it("starts a new list after a blank line", () => {
    const blocks = toBlocks("- a\n\n- b", { sourceCount: 0 });

    expect(blocks.map((block) => block.kind)).toEqual(["list", "list"]);
  });

  it("marks each number of a citation as known or not", () => {
    expect(toBlocks("[0]", { sourceCount: 2 })).toEqual([
      {
        kind: "paragraph",
        lines: [[{ kind: "cite", refs: [{ n: 0, known: false }] }]],
      },
    ]);
    expect(toBlocks("Así [1, 3][2].", { sourceCount: 2 })).toEqual([
      {
        kind: "paragraph",
        lines: [
          [
            text("Así "),
            {
              kind: "cite",
              refs: [
                { n: 1, known: true },
                { n: 3, known: false },
              ],
            },
            { kind: "cite", refs: [{ n: 2, known: true }] },
            text("."),
          ],
        ],
      },
    ]);
  });

  it("pairs each amount with its check, in the order the checks were made", () => {
    const sources = toSources([
      searchHit({ content: "El tope es de PESOS ($907.934) desde junio." }),
    ]);
    const answer = "Era de $871.825 [1].\n- Ahora es de $907.934 [1].";
    const amounts = checkAmounts(answer, sources);

    const blocks = toBlocks(answer, { sourceCount: 1, amounts });
    const found = blocks.flatMap((block) =>
      (block.kind === "paragraph" ? block.lines : block.items)
        .flat()
        .flatMap((segment) => (segment.kind === "amount" ? [segment] : [])),
    );

    expect(found.map((segment) => [segment.text, segment.check?.status])).toEqual([
      ["$871.825", "not_found"],
      ["$907.934", "supported"],
    ]);
  });

  it("has nothing to mark while there are no checks yet", () => {
    const [block] = toBlocks("Es de $907.934.", { sourceCount: 1 });

    expect(block).toEqual({
      kind: "paragraph",
      lines: [
        [text("Es de "), { kind: "amount", text: "$907.934", check: null }, text(".")],
      ],
    });
  });

  it("is empty for an empty answer", () => {
    expect(toBlocks("", { sourceCount: 0 })).toEqual([]);
    expect(toBlocks("\n\n", { sourceCount: 0 })).toEqual([]);
  });
});
