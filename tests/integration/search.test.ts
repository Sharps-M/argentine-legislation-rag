import { asc, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb, getSql } from "@/db/client";
import { chunks, regulations, regulationTexts } from "@/db/schema";
import { embedChunks } from "@/embeddings/pipeline";
import {
  createEmbeddingStore,
  resetEmbeddings,
  vacuumChunks,
} from "@/embeddings/store";
import {
  infolegUrl,
  QueryEmbeddingError,
  searchByVector,
  searchChunks,
} from "@/search/search";

import { createHashingEmbedder, hashingVector } from "../support/hashing-embedder";

const db = getDb();
const store = createEmbeddingStore(db);

const LAW_URL =
  "http://servicios.infoleg.gob.ar/infolegInternet/anexos/425000-429999/427766/norma.htm";

beforeEach(async () => {
  await db.delete(regulations);
  // Deleted rows stay in the vector index until a vacuum removes them. Without
  // this, the chunks of earlier tests would stand between a search and the
  // rows it should find.
  await vacuumChunks(db);
  await db.insert(regulations).values([
    {
      id: 427766,
      type: "Ley",
      number: "27817",
      enactedOn: "2026-06-24",
      topic: "CONVENIOS",
      title: "APROBACION",
      originalTextUrl: LAW_URL,
    },
    {
      id: 425217,
      type: "Decreto",
      number: "282",
      enactedOn: "2026-04-27",
      topic: "BELGRANO CARGAS Y LOGISTICA SOCIEDAD ANONIMA",
      title: "DISPOSICIONES",
    },
    {
      id: 300001,
      type: "Decreto",
      number: "617",
      enactedOn: "2022-08-28",
      topic: "COMBUSTIBLES",
      title: "IMPUESTOS",
    },
  ]);
  await db.insert(regulationTexts).values([
    {
      regulationId: 427766,
      source: "original",
      sourceUrl: LAW_URL,
      content: "texto",
      contentHash: "hash",
    },
    {
      regulationId: 300001,
      source: "summary",
      content: "resumen",
      contentHash: "hash",
    },
  ]);
  await db.insert(chunks).values([
    {
      regulationId: 427766,
      ordinal: 0,
      section: "article",
      label: "Artículo 1",
      content:
        "Apruébase el convenio sobre seguridad social entre la República Argentina y la República de San Marino.",
    },
    {
      regulationId: 427766,
      ordinal: 1,
      section: "article",
      label: "Artículo 2",
      content: "Comuníquese al Poder Ejecutivo nacional.",
    },
    {
      regulationId: 425217,
      ordinal: 0,
      section: "article",
      label: "Artículo 1",
      content:
        "El producido de la venta mediante remate público del material rodante será transferido a un fideicomiso.",
    },
    {
      regulationId: 300001,
      ordinal: 0,
      section: "summary",
      label: null,
      content:
        "Se difiere el incremento del impuesto sobre los combustibles líquidos y al dióxido de carbono.",
    },
  ]);
});

afterAll(async () => {
  await getSql().end();
});

const embedAll = (model?: string) => embedChunks(store, createHashingEmbedder(model));

describe("chunk embeddings in PostgreSQL", () => {
  it("stores one vector per chunk, with the model that produced it", async () => {
    const report = await embedAll();

    expect(report).toMatchObject({ total: 4, embedded: 4 });

    const rows = await db.select().from(chunks).orderBy(asc(chunks.id));
    for (const row of rows) {
      expect(row.embedding).toHaveLength(1024);
      expect(row.embeddingModel).toBe("test-hashing");
    }
  });

  it("embeds the chunk together with the context of its regulation", async () => {
    const embedder = createHashingEmbedder();
    await embedChunks(store, embedder);

    expect(embedder.calls.flat()).toContain(
      "Ley 27817 · CONVENIOS · APROBACION · Artículo 2\n\nComuníquese al Poder Ejecutivo nacional.",
    );
  });

  it("is resumable: a second run finds nothing to do", async () => {
    await embedAll();

    expect(await store.countPending("test-hashing")).toBe(0);
    expect(await embedAll()).toMatchObject({ total: 0, embedded: 0 });
  });

  it("only embeds up to the limit and leaves the rest pending", async () => {
    const report = await embedChunks(store, createHashingEmbedder(), {
      limit: 3,
      batchSize: 2,
    });

    expect(report).toMatchObject({ total: 3, embedded: 3, batches: 2 });
    expect(await store.countPending("test-hashing")).toBe(1);
  });

  it("treats vectors from another model as pending", async () => {
    await embedAll("old-model");

    expect(await store.countPending("new-model")).toBe(4);

    await embedAll("new-model");
    const models = await db
      .selectDistinct({ model: chunks.embeddingModel })
      .from(chunks);
    expect(models).toEqual([{ model: "new-model" }]);
  });

  it("discards every vector on reset", async () => {
    await embedAll();
    await resetEmbeddings(db);

    const embedded = await db.select().from(chunks).where(isNotNull(chunks.embedding));
    expect(embedded).toHaveLength(0);
    expect(await store.countPending("test-hashing")).toBe(4);
  });

  it("rejects a vector of the wrong size", async () => {
    const [first] = await db.select({ id: chunks.id }).from(chunks).limit(1);

    await expect(
      store.save("small-model", [{ id: first!.id, embedding: [1, 2, 3] }]),
    ).rejects.toThrow();
  });
});

describe("semantic search", () => {
  const embedder = createHashingEmbedder();
  // The stand-in model scores far lower than the real one, so these tests turn
  // the similarity floor off unless they are about it.
  // The floor and the grouping have their own tests below; everywhere else
  // the search is checked without them.
  const search = (query: string, options = {}) =>
    searchChunks(db, embedder, query, {
      minSimilarity: 0,
      versionSimilarity: null,
      ...options,
    });

  beforeEach(async () => {
    await embedAll();
  });

  it("returns the closest chunk first, with its regulation", async () => {
    const hits = await search("convenio de seguridad social con San Marino");

    expect(hits[0]).toMatchObject({
      section: "article",
      label: "Artículo 1",
      regulation: {
        id: 427766,
        type: "Ley",
        number: "27817",
        name: "Ley 27817",
        topic: "CONVENIOS",
        enactedOn: "2026-06-24",
        textSource: "original",
        url: LAW_URL,
      },
    });
    expect(hits[0]?.content).toContain("seguridad social");
  });

  it("orders the results from most to least similar", async () => {
    const hits = await search("venta del material rodante");
    const similarities = hits.map((hit) => hit.similarity);

    expect(hits).toHaveLength(4);
    expect(hits[0]?.regulation.name).toBe("Decreto 282/2026");
    expect(similarities).toEqual([...similarities].sort((a, b) => b - a));
    for (const similarity of similarities) {
      expect(similarity).toBeGreaterThanOrEqual(-1);
      expect(similarity).toBeLessThanOrEqual(1);
    }
  });

  it("gives a similarity of 1 to a chunk identical to the question", async () => {
    const [chunk] = await db
      .select()
      .from(chunks)
      .where(eq(chunks.regulationId, 425217));
    await db
      .update(chunks)
      .set({ embedding: hashingVector("texto exacto de la pregunta") })
      .where(eq(chunks.id, chunk!.id));

    const [hit] = await search("texto exacto de la pregunta");

    expect(hit?.chunkId).toBe(chunk!.id);
    expect(hit?.similarity).toBeCloseTo(1, 5);
  });

  it("returns the same results with or without the index", async () => {
    const question = "venta del material rodante";
    const ids = (hits: Awaited<ReturnType<typeof search>>) =>
      hits.map((hit) => hit.chunkId);

    expect(ids(await search(question, { exact: true }))).toEqual(
      ids(await search(question)),
    );
  });

  it("accepts a wider index search and rejects a setting out of range", async () => {
    const hits = await search("venta del material rodante", { efSearch: 200 });
    expect(hits[0]?.regulation.name).toBe("Decreto 282/2026");

    await expect(search("venta del material rodante", { efSearch: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      search("venta del material rodante", { efSearch: 1.5 }),
    ).rejects.toThrow(RangeError);
    await expect(
      search("venta del material rodante", { efSearch: 5000 }),
    ).rejects.toThrow(RangeError);
  });

  it("searches with a vector computed beforehand", async () => {
    const question = "convenio de seguridad social con San Marino";
    const byVector = await searchByVector(db, embedder.model, hashingVector(question), {
      minSimilarity: 0,
    });

    expect(byVector).toEqual(await search(question));
  });

  it("respects the limit", async () => {
    expect(await search("impuesto a los combustibles", { limit: 2 })).toHaveLength(2);
  });

  it("filters by regulation type, ignoring case", async () => {
    const hits = await search("convenio de seguridad social", { types: ["decreto"] });

    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.regulation.type === "Decreto")).toBe(true);
  });

  it("filters by year of enactment", async () => {
    const recent = await search("impuesto a los combustibles", { yearFrom: 2026 });
    const older = await search("impuesto a los combustibles", { yearTo: 2025 });
    const none = await search("impuesto a los combustibles", {
      yearFrom: 2023,
      yearTo: 2025,
    });

    expect(recent.map((hit) => hit.regulation.id).sort()).toEqual([
      425217, 427766, 427766,
    ]);
    expect(older.map((hit) => hit.regulation.id)).toEqual([300001]);
    expect(none).toEqual([]);
  });

  it("marks abstract-only regulations and links them to their InfoLEG page", async () => {
    const [hit] = await search("impuesto sobre los combustibles líquidos");

    expect(hit?.regulation).toMatchObject({
      id: 300001,
      name: "Decreto 617/2022",
      textSource: "summary",
      url: infolegUrl(300001),
    });
  });

  it("ignores chunks without a vector or with one from another model", async () => {
    const [law] = await db
      .select({ id: chunks.id })
      .from(chunks)
      .where(eq(chunks.regulationId, 427766))
      .orderBy(asc(chunks.ordinal));
    await db
      .update(chunks)
      .set({ embeddingModel: "other-model" })
      .where(eq(chunks.id, law!.id));
    await db
      .update(chunks)
      .set({ embedding: sql`null`, embeddingModel: sql`null` })
      .where(eq(chunks.regulationId, 425217));

    const hits = await search("convenio de seguridad social con San Marino");

    expect(hits.map((hit) => hit.label)).toEqual(["Artículo 2", null]);
  });

  it("returns nothing when no chunk has been embedded", async () => {
    await resetEmbeddings(db);

    expect(await search("convenio de seguridad social")).toEqual([]);
  });

  it("reports a question that could not be embedded", async () => {
    const offline = {
      ...embedder,
      embed: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      },
    };

    await expect(searchChunks(db, offline, "combustibles")).rejects.toThrow(
      QueryEmbeddingError,
    );
  });

  describe("similarity floor", () => {
    const question = "convenio de seguridad social con San Marino";

    it("keeps only the chunks that are close enough", async () => {
      const all = await search(question);
      const floor = (all[0]!.similarity + all[1]!.similarity) / 2;

      const hits = await search(question, { minSimilarity: floor });

      expect(hits).toEqual([all[0]]);
    });

    it("returns nothing when no chunk is close enough", async () => {
      expect(await search("reglas del ajedrez", { minSimilarity: 0.5 })).toEqual([]);
    });

    it("applies a floor by default", async () => {
      // No chunk scores anywhere near the default with the stand-in model.
      expect(await searchChunks(db, embedder, question)).toEqual([]);
    });

    it("never drops a regulation cited by number", async () => {
      const hits = await search("Ley 27817", { minSimilarity: 1 });

      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.match === "reference")).toBe(true);
      expect(hits.every((hit) => hit.regulation.id === 427766)).toBe(true);
    });

    it("rejects a floor outside 0 to 1", async () => {
      await expect(search(question, { minSimilarity: 1.5 })).rejects.toThrow(
        RangeError,
      );
      await expect(search(question, { minSimilarity: -0.1 })).rejects.toThrow(
        RangeError,
      );
    });
  });

  describe("versions of the same provision", () => {
    // Long enough for the amount, the only thing that changes, to weigh little.
    const article = [
      "Fíjase el adicional por prestación de servicios en la Antártida para el personal militar",
      "de las Fuerzas Armadas destinado en las bases, refugios y buques que operan al sur del",
      "paralelo sesenta, que se liquidará mensualmente mientras dure la comisión y no se computará",
      "para el cálculo de ningún otro suplemento, compensación o bonificación, en la suma de pesos",
    ].join(" ");

    beforeEach(async () => {
      // The same article, reissued three times with another amount.
      await db.insert(regulations).values(
        [
          { id: 500001, number: "294", enactedOn: "2025-04-25" },
          { id: 500002, number: "578", enactedOn: "2025-08-14" },
          { id: 500003, number: "834", enactedOn: "2026-08-28" },
        ].map((row) => ({
          ...row,
          type: "Decreto",
          topic: "ADMINISTRACION PUBLICA NACIONAL",
          title: "RETRIBUCIONES Y ADICIONALES",
        })),
      );
      await db.insert(chunks).values(
        [
          [500001, "un millón"],
          [500002, "un millón doscientos mil"],
          [500003, "un millón quinientos mil"],
        ].map(([regulationId, amount]) => ({
          regulationId: Number(regulationId),
          ordinal: 0,
          section: "article",
          label: "Artículo 5",
          content: `${article} ${amount}.`,
        })),
      );
      await embedAll();
    });

    const question = "adicional por servicios en la Antártida para el personal militar";

    it("lists every regulation on its own when the grouping is off", async () => {
      const hits = await search(question, { limit: 3, versionSimilarity: null });

      expect(hits.map((hit) => hit.regulation.id).sort()).toEqual([
        500001, 500002, 500003,
      ]);
      expect(hits.every((hit) => hit.earlierVersions.length === 0)).toBe(true);
    });

    it("groups them by default", async () => {
      const [first] = await searchChunks(db, embedder, question, { minSimilarity: 0 });

      expect(first?.regulation.name).toBe("Decreto 834/2026");
      expect(first?.earlierVersions.map((version) => version.name)).toEqual([
        "Decreto 578/2025",
        "Decreto 294/2025",
      ]);
    });

    it("groups them when asked: the most recent leads, the others go under it", async () => {
      const [first, second] = await search(question, { versionSimilarity: 0.9 });

      expect(first?.regulation.name).toBe("Decreto 834/2026");
      expect(first?.earlierVersions.map((version) => version.name)).toEqual([
        "Decreto 578/2025",
        "Decreto 294/2025",
      ]);
      for (const version of first?.earlierVersions ?? []) {
        expect(version.textSimilarity).toBeGreaterThanOrEqual(0.9);
        expect(version.url).toBe(infolegUrl(version.regulationId));
      }
      // The next result is another subject, not an older version.
      expect(second?.regulation.id).not.toBe(500001);
      expect(second?.regulation.id).not.toBe(500002);
    });

    it("groups them the same way when linking by chain", async () => {
      const [first] = await search(question, {
        versionSimilarity: 0.9,
        versionLinkage: "chain",
      });

      expect(first?.regulation.name).toBe("Decreto 834/2026");
      expect(first?.earlierVersions.map((version) => version.name)).toEqual([
        "Decreto 578/2025",
        "Decreto 294/2025",
      ]);
    });

    it("leaves different texts apart", async () => {
      const hits = await search(question, { versionSimilarity: 0.9 });
      const law = hits.find((hit) => hit.regulation.id === 427766);

      expect(law?.earlierVersions).toEqual([]);
    });

    it("looks further than the limit to find the version in force", async () => {
      const [only] = await search(question, { versionSimilarity: 0.9, limit: 1 });

      expect(only?.regulation.name).toBe("Decreto 834/2026");
      expect(only?.earlierVersions).toHaveLength(2);
    });

    it("rejects a threshold outside 0 to 1", async () => {
      await expect(search(question, { versionSimilarity: 0 })).rejects.toThrow(
        RangeError,
      );
      await expect(search(question, { versionSimilarity: 1.2 })).rejects.toThrow(
        RangeError,
      );
    });
  });

  describe("an issue asked for by its date", () => {
    const article = [
      "La retribución bruta mensual, normal, habitual, regular y permanente de los agentes",
      "habilitados para realizar servicios extraordinarios, con excepción de los servicios",
      "requeridos por terceros, no deberá superar el monto que se fija en el presente artículo,",
      "que se actualizará conforme lo acuerden las partes signatarias, de pesos",
    ].join(" ");

    beforeEach(async () => {
      await db.insert(regulations).values(
        [
          { id: 500011, number: "207", enactedOn: "2026-03-27" },
          { id: 500012, number: "552", enactedOn: "2026-06-30" },
          { id: 500013, number: "832", enactedOn: "2026-08-28" },
        ].map((row) => ({
          ...row,
          type: "Decreto",
          topic: "ACUERDOS",
          title: "ACTAS ACUERDO - HOMOLOGANSE",
        })),
      );
      await db.insert(chunks).values(
        [
          [500011, "ochocientos mil a partir del 1° de marzo de 2026"],
          [500012, "ochocientos setenta mil a partir del 1° de junio de 2026"],
          [500013, "novecientos mil a partir del 1° de septiembre de 2026"],
        ].map(([regulationId, amount]) => ({
          regulationId: Number(regulationId),
          ordinal: 0,
          section: "article",
          label: "Artículo 3",
          content: `${article} ${amount}.`,
        })),
      );
      await embedAll();
    });

    const cap =
      "tope de la retribución de los agentes habilitados para servicios extraordinarios";
    const group = async (question: string, options = {}) =>
      (await searchChunks(db, embedder, question, { minSimilarity: 0, ...options }))
        .filter((hit) => hit.regulation.id >= 500011 && hit.regulation.id <= 500013)
        .map((hit) => [
          hit.regulation.name,
          ...hit.earlierVersions.map((version) => version.name),
        ]);

    it("lists the most recent first when no date is asked for", async () => {
      expect(await group(cap)).toEqual([
        ["Decreto 832/2026", "Decreto 552/2026", "Decreto 207/2026"],
      ]);
    });

    it("lists the issue that states the date before the most recent", async () => {
      expect(await group(`${cap} a partir del 1° de junio de 2026`)).toEqual([
        ["Decreto 552/2026"],
        ["Decreto 832/2026", "Decreto 207/2026"],
      ]);
    });

    it("reads the date however it is written", async () => {
      expect(await group(`${cap} desde junio de 2026`)).toEqual([
        ["Decreto 552/2026"],
        ["Decreto 832/2026", "Decreto 207/2026"],
      ]);
      expect(await group(`cap on extraordinary services as of March 1, 2026`)).toEqual([
        ["Decreto 207/2026"],
        ["Decreto 832/2026", "Decreto 552/2026"],
      ]);
    });

    it("changes nothing when the date is the one of the most recent", async () => {
      expect(await group(`${cap} a partir del 1° de septiembre de 2026`)).toEqual([
        ["Decreto 832/2026", "Decreto 552/2026", "Decreto 207/2026"],
      ]);
    });

    it("changes nothing when no issue states the date", async () => {
      expect(await group(`${cap} a partir del 1° de enero de 2020`)).toEqual([
        ["Decreto 832/2026", "Decreto 552/2026", "Decreto 207/2026"],
      ]);
    });

    it("puts it within reach of a short list", async () => {
      const hits = await searchChunks(
        db,
        embedder,
        `${cap} a partir del 1° de junio de 2026`,
        { minSimilarity: 0, limit: 2 },
      );
      const names = hits.map((hit) => hit.regulation.name);

      const at = names.indexOf("Decreto 552/2026");

      expect(at).toBeGreaterThanOrEqual(0);
      expect(names[at + 1]).toBe("Decreto 832/2026");
    });

    it("takes the dates it is given instead of reading the question", async () => {
      expect(
        await group(`${cap} a partir del 1° de junio de 2026`, { dates: [] }),
      ).toEqual([["Decreto 832/2026", "Decreto 552/2026", "Decreto 207/2026"]]);
    });
  });

  describe("regulations cited by number", () => {
    it("puts the cited law first, even when the wording points elsewhere", async () => {
      // The words match the fuel decree; the number names the law.
      const question = "impuesto sobre los combustibles líquidos según la Ley 27.817";

      const byMeaning = await search(question, { references: [] });
      expect(byMeaning[0]?.regulation.id).toBe(300001);

      const hits = await search(question);

      expect(hits[0]).toMatchObject({
        match: "reference",
        regulation: { id: 427766, name: "Ley 27817" },
      });
      expect(hits.some((hit) => hit.regulation.id === 300001)).toBe(true);
    });

    it("marks every chunk with the reason it was found", async () => {
      const hits = await search("Ley 27817");
      const cited = hits.filter((hit) => hit.match === "reference");

      expect(cited.map((hit) => hit.regulation.id)).toEqual([427766, 427766]);
      expect(hits.slice(0, 2)).toEqual(cited);
      expect(hits.slice(2).every((hit) => hit.match === "semantic")).toBe(true);
    });

    it("does not return a chunk twice", async () => {
      const ids = (await search("Ley 27817")).map((hit) => hit.chunkId);

      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(4);
    });

    it("tells decrees with the same number apart by their year", async () => {
      await db.insert(regulations).values({
        id: 300002,
        type: "Decreto",
        number: "282",
        enactedOn: "2023-05-10",
        topic: "OTRO TEMA",
        title: "DESIGNACION",
      });
      await db.insert(chunks).values({
        regulationId: 300002,
        ordinal: 0,
        section: "summary",
        content: "Dase por designado un funcionario.",
      });
      await embedAll();

      const dated = await search("Decreto 282/2023");
      expect(dated[0]).toMatchObject({
        match: "reference",
        regulation: { id: 300002 },
      });
      expect(dated.filter((hit) => hit.match === "reference")).toHaveLength(1);

      // Without a year both are cited, and the wording decides the order.
      const undated = await search("venta del material rodante, decreto 282");
      const cited = undated.filter((hit) => hit.match === "reference");
      expect(cited.map((hit) => hit.regulation.id)).toEqual([425217, 300002]);
    });

    it("gives the cited regulation at most half of the results", async () => {
      await db.insert(chunks).values(
        Array.from({ length: 6 }, (_, index) => ({
          regulationId: 427766,
          ordinal: 10 + index,
          section: "annex",
          content: `Anexo del convenio, parte ${index}.`,
          embedding: hashingVector(`anexo convenio parte ${index}`),
          embeddingModel: "test-hashing",
        })),
      );

      const hits = await search("Ley 27817", { limit: 4 });

      expect(hits).toHaveLength(4);
      expect(hits.filter((hit) => hit.match === "reference")).toHaveLength(2);
    });

    it("applies the filters to the cited regulation too", async () => {
      const hits = await search("Ley 27817", { types: ["Decreto"] });

      expect(hits.every((hit) => hit.match === "semantic")).toBe(true);
      expect(hits.every((hit) => hit.regulation.type === "Decreto")).toBe(true);
    });

    it("falls back to meaning when the number matches nothing", async () => {
      const hits = await search("convenio de seguridad social, Ley 99999");

      expect(hits.every((hit) => hit.match === "semantic")).toBe(true);
      expect(hits[0]?.regulation.id).toBe(427766);
    });

    it("can be left out, for measuring the similarity search alone", async () => {
      const hits = await search("Ley 27817", { references: [] });

      expect(hits.every((hit) => hit.match === "semantic")).toBe(true);
    });
  });

  it("fills the limit through the index when the filter is very selective", async () => {
    // 600 decree chunks that share words with the question, and a few law
    // chunks that share none: the index reaches the decrees first, and the
    // filter discards every one of them.
    const decrees = Array.from({ length: 600 }, (_, index) => ({
      regulationId: 425217,
      ordinal: 100 + index,
      section: "article",
      content: `relleno ${index}`,
      embedding: hashingVector(
        `impuesto combustibles liquidos partida ${index} lote ${index * 7} rubro ${index * 13}`,
      ),
      embeddingModel: "test-hashing",
    }));
    const laws = Array.from({ length: 12 }, (_, index) => ({
      regulationId: 427766,
      ordinal: 100 + index,
      section: "article",
      label: `Lejano ${index}`,
      content: `otro asunto ${index}`,
      embedding: hashingVector(`asunto distinto numero ${index} tema ${index * 3}`),
      embeddingModel: "test-hashing",
    }));
    await db.insert(chunks).values([...decrees, ...laws]);

    const hits = await db.transaction(async (tx) => {
      // Force the approximate index, as on a table with tens of thousands of rows.
      await tx.execute(sql`set local enable_seqscan = off`);
      return searchChunks(tx, embedder, "impuesto sobre los combustibles líquidos", {
        types: ["Ley"],
        limit: 5,
        minSimilarity: 0,
      });
    });

    expect(hits).toHaveLength(5);
    expect(hits.every((hit) => hit.regulation.type === "Ley")).toBe(true);
  });
});
