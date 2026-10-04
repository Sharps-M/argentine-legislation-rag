import { describe, expect, it } from "vitest";

import { embeddingInput, regulationName } from "./input";

describe("regulationName", () => {
  it("adds the year to a decree, which is numbered again every year", () => {
    expect(
      regulationName({ type: "Decreto", number: "282", enactedOn: "2026-04-27" }),
    ).toBe("Decreto 282/2026");
  });

  it("leaves a law as is: laws are numbered once and for all", () => {
    expect(
      regulationName({ type: "Ley", number: "27817", enactedOn: "2026-06-24" }),
    ).toBe("Ley 27817");
  });

  it("does not add a year to a number that already carries one", () => {
    expect(
      regulationName({ type: "Decreto", number: "70/2023", enactedOn: "2023-12-20" }),
    ).toBe("Decreto 70/2023");
  });

  it("falls back to the type when there is no number", () => {
    expect(
      regulationName({ type: "Decreto", number: null, enactedOn: "2026-01-01" }),
    ).toBe("Decreto");
    expect(regulationName({ type: "Decreto", number: "  ", enactedOn: null })).toBe(
      "Decreto",
    );
  });

  it("omits the year when the date is unknown", () => {
    expect(regulationName({ type: "Decreto", number: "282", enactedOn: null })).toBe(
      "Decreto 282",
    );
  });
});

describe("embeddingInput", () => {
  const article = {
    type: "Decreto",
    number: "282",
    enactedOn: "2026-04-27",
    topic: "BELGRANO CARGAS Y LOGÍSTICA SOCIEDAD ANÓNIMA",
    title: "DISPOSICIONES",
    label: "Artículo 4",
    content:
      "El presente decreto entrará en vigencia el día siguiente al de su publicación.",
  };

  it("puts the regulation, its topic, title and the article before the text", () => {
    expect(embeddingInput(article)).toBe(
      "Decreto 282/2026 · BELGRANO CARGAS Y LOGÍSTICA SOCIEDAD ANÓNIMA · DISPOSICIONES · Artículo 4\n\n" +
        "El presente decreto entrará en vigencia el día siguiente al de su publicación.",
    );
  });

  it("skips the parts that are missing or blank", () => {
    expect(embeddingInput({ ...article, topic: null, title: "  ", label: null })).toBe(
      `Decreto 282/2026\n\n${article.content}`,
    );
  });
});
