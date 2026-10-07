import { describe, expect, it } from "vitest";

import { searchHit } from "../../tests/support/search-hits";
import { checkAmounts, findAmounts } from "./amounts";
import { toSources } from "./sources";

// Three articles as InfoLEG publishes them, on the same allowance in three years.
const ARTICLE_2026 =
  "ARTÍCULO 5°.- Fíjase el valor del adicional remuneratorio por prestaciones de servicios en la Antártida en los términos previstos en la Ley N° 23.547 para el personal militar establecido por el artículo 1° del Decreto N° 690 del 6 de junio de 2011 y sus modificatorios en la suma de PESOS UN MILLÓN QUINIENTOS NOVENTA Y OCHO MIL CIENTO VEINTICUATRO ($1.598.124) a partir del 1° de septiembre de 2026, PESOS UN MILLÓN SEISCIENTOS VEINTISÉIS MIL OCHOCIENTOS NOVENTA ($1.626.890) a partir del 1° de octubre de 2026, PESOS UN MILLÓN SEISCIENTOS CINCUENTA Y DOS MIL NOVECIENTOS VEINTE ($1.652.920) a partir del 1° de noviembre de 2026 y PESOS UN MILLÓN SEISCIENTOS SETENTA Y SIETE MIL SETECIENTOS CATORCE ($1.677.714) a partir del 1° de diciembre de 2026.";
const ARTICLE_2024 =
  "ARTÍCULO 7°.- Fíjase el valor del adicional remuneratorio por prestaciones de servicios en la Antártida en los términos previstos en la Ley N° 23.547 para el personal militar establecido por el artículo 1° del Decreto N° 690 del 6 de junio de 2011 y sus modificatorios en la suma de PESOS OCHOCIENTOS CINCUENTA Y TRES MIL SETECIENTOS CINCUENTA Y OCHO ($853.758), a partir del 1º de marzo de 2024.";
const ARTICLE_2023 =
  "ARTÍCULO 7°.- Fíjase el valor del Adicional Remuneratorio por prestaciones de servicios en la Antártida, en la suma de PESOS TRESCIENTOS NOVENTA Y SIETE MIL CIENTO SESENTA Y NUEVE ($ 397.169), a partir del 1º de julio de 2023 y PESOS CUATROCIENTOS CUARENTA Y CUATRO MIL OCHOCIENTOS VIENTINUEVE ($ 444.829), a partir del 1º de agosto de 2023.";

const sources = toSources([
  searchHit({ chunkId: 1, content: ARTICLE_2026 }),
  searchHit({ chunkId: 2, content: ARTICLE_2024 }),
  searchHit({ chunkId: 3, content: ARTICLE_2023 }),
]);

const statuses = (answer: string) =>
  checkAmounts(answer, sources).map((check) => [check.amount, check.status]);

describe("findAmounts", () => {
  it("reads amounts however they are spaced and separated", () => {
    expect(findAmounts("($1.598.124), $ 444.829 y $907934.")).toEqual([
      "1598124",
      "444829",
      "907934",
    ]);
  });

  it("reads decimals, and a row of a table with no space between cells", () => {
    expect(findAmounts("Nafta$ 10,572-$ 0,648Gasoil$ 9,511")).toEqual([
      "10572",
      "0648",
      "9511",
    ]);
  });

  it("takes the same amount written the English way for the same amount", () => {
    expect(findAmounts("$1,598,124")).toEqual(findAmounts("$1.598.124"));
  });

  it("reads amounts in dollars", () => {
    expect(findAmounts("U$S 1.500, US$ 2.000 y USD 3.000")).toEqual([
      "1500",
      "2000",
      "3000",
    ]);
  });

  it("leaves alone what is not an amount of money", () => {
    expect(
      findAmounts("El artículo 5° de la Ley 23.547, del 1° de septiembre de 2026 [1]."),
    ).toEqual([]);
  });

  it("does not take the full stop of a sentence into the amount", () => {
    expect(findAmounts("Es de $853.758. Rige desde 2024.")).toEqual(["853758"]);
  });
});

describe("checkAmounts", () => {
  // What Gemini wrote for this question, with the rule that asks for figures.
  const realAnswer = [
    "El adicional se fija en las siguientes sumas:",
    "- $1.677.714 a partir del 1° de diciembre de 2026, $1.652.920 a partir del 1° de noviembre de 2026, $1.626.890 a partir del 1° de octubre de 2026 y $1.598.124 a partir del 1° de septiembre de 2026, según el Decreto 834/2026, artículo 5 [1].",
    "- $853.758 a partir del 1º de marzo de 2024, de acuerdo con el Decreto 207/2024, artículo 7 [2].",
    "- $ 444.829 a partir del 1º de agosto de 2023 y $ 397.169 a partir del 1º de julio de 2023, conforme al Decreto 335/2023, artículo 7 [3].",
  ].join("\n");

  it("finds every amount of a real answer in the source it cites", () => {
    const checks = checkAmounts(realAnswer, sources);

    expect(checks).toHaveLength(7);
    expect(checks.every((check) => check.status === "supported")).toBe(true);
    expect(checks[0]).toEqual({
      amount: "$1.677.714",
      cited: [1],
      foundIn: [1],
      status: "supported",
    });
    expect(checks.at(-1)).toMatchObject({ amount: "$ 397.169", cited: [3] });
  });

  it("reports an amount that no source states", () => {
    // One digit off: what a miscopied or made-up figure looks like.
    const answer = realAnswer.replace("$853.758", "$853.785");

    expect(
      checkAmounts(answer, sources).filter((c) => c.status !== "supported"),
    ).toEqual([{ amount: "$853.785", cited: [2], foundIn: [], status: "not_found" }]);
  });

  it("reports an amount attributed to the wrong source", () => {
    expect(checkAmounts("El valor es de $853.758 [1].", sources)).toEqual([
      { amount: "$853.758", cited: [1], foundIn: [2], status: "other_source" },
    ]);
  });

  it("reports an amount the answer gives no source for", () => {
    expect(checkAmounts("El valor es de $853.758.", sources)).toEqual([
      { amount: "$853.758", cited: [], foundIn: [2], status: "other_source" },
    ]);
  });

  it("gives each amount the citations that follow it, not the ones before", () => {
    expect(
      statuses(
        "Fue de $853.758 [2] y antes de $ 397.169 [3]. Hoy es de $1.598.124 [1].",
      ),
    ).toEqual([
      ["$853.758", "supported"],
      ["$ 397.169", "supported"],
      ["$1.598.124", "supported"],
    ]);
    // The same amounts, each with the citation of another.
    expect(
      statuses(
        "Fue de $853.758 [3] y antes de $ 397.169 [1]. Hoy es de $1.598.124 [2].",
      ),
    ).toEqual([
      ["$853.758", "other_source"],
      ["$ 397.169", "other_source"],
      ["$1.598.124", "other_source"],
    ]);
  });

  it("accepts an amount backed by any of several sources cited together", () => {
    expect(checkAmounts("Es de $853.758 [1][2].", sources)[0]).toMatchObject({
      cited: [1, 2],
      status: "supported",
    });
    expect(checkAmounts("Es de $853.758 [1, 2].", sources)[0]).toMatchObject({
      cited: [1, 2],
      status: "supported",
    });
  });

  it("does not borrow the citation of another line", () => {
    const answer =
      "- $853.758 desde marzo de 2024.\n- $ 397.169 desde julio de 2023 [3].";

    expect(checkAmounts(answer, sources)[0]).toMatchObject({
      cited: [],
      status: "other_source",
    });
  });

  it("ignores a citation of a source that does not exist", () => {
    expect(checkAmounts("Es de $853.758 [9].", sources)[0]).toMatchObject({
      cited: [],
      status: "other_source",
    });
  });

  it("recognises an amount whatever separators the answer used", () => {
    expect(statuses("It is $1,598,124 [1], formerly $853758 [2].")).toEqual([
      ["$1,598,124", "supported"],
      ["$853758", "supported"],
    ]);
  });

  it("finds an amount the source gives without a currency sign", () => {
    const table = toSources([
      searchHit({
        content: "Monto fijo en pesos por litro. Nafta: 10,572. Gasoil: 9,511.",
      }),
    ]);

    expect(checkAmounts("La nafta paga $10,572 [1].", table)[0]?.status).toBe(
      "supported",
    );
  });

  it("does not take a small amount for found because the number appears for another reason", () => {
    const article = toSources([
      searchHit({
        content:
          "ARTÍCULO 30.- El plazo es de treinta (30) días. La multa es de PESOS ($50).",
      }),
    ]);

    expect(checkAmounts("La multa es de $30 [1].", article)[0]?.status).toBe(
      "not_found",
    );
    expect(checkAmounts("La multa es de $50 [1].", article)[0]?.status).toBe(
      "supported",
    );
  });

  it("has nothing to say about an answer without amounts", () => {
    expect(
      checkAmounts("Se homologa el acta mediante el Decreto 565/2026 [2].", sources),
    ).toEqual([]);
  });
});
