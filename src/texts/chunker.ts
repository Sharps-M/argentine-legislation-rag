/**
 * - `preamble`: title, VISTO and CONSIDERANDO
 * - `article`: an operative article
 * - `closing`: signatures, publication line and InfoLEG notes
 * - `annex`: annexed material (tables, treaties, agreements)
 * - `summary`: title and abstract, for regulations without a published text
 */
export type ChunkSection = "preamble" | "article" | "closing" | "annex" | "summary";

export type Chunk = {
  /** Position of the chunk within the regulation, starting at 0. */
  ordinal: number;
  section: ChunkSection;
  /** "Artículo 3", "ANEXO I"... `null` for the preamble and the closing. */
  label: string | null;
  content: string;
};

export type ChunkOptions = {
  /** Upper bound for a chunk, in characters. */
  maxChars?: number;
};

const DEFAULT_MAX_CHARS = 1800;

// "ARTÍCULO 1°.-", "Artículo 2º-", "Art. 3°", "ARTICULO ÚNICO", "ARTÍCULO 5° bis".
const ARTICLE_HEADER =
  /^(?:ART[IÍ]CULO|Art[ií]culo|ART\.|Art\.)\s*(\d+|[ÚU]NICO|[Úú]nico)\s*[°ºo]?(?:\s+(bis|ter|qu[aá]ter))?(?=$|[\s.\-–—:)])/;

// "e. 28/04/2026 N° 27237/26 v. 28/04/2026": the official gazette publication line.
const PUBLICATION_LINE = /^e\.\s*\d{1,2}\/\d{1,2}\/\d{4}\s+N\s*[°º]/;

// "ANEXO", "ANEXO I", "ANEXO LXXV", "ANEXO 2" as a heading of its own.
const ANNEX_HEADING = /^ANEXO(?:\s+(?:[IVXLCDM]+|\d+))?\b/;

const LAW_CLOSING = /^DADA EN LA SALA DE SESIONES/i;

const NOTE = /^\(?\s*Nota\b/i;

type Segment = { section: ChunkSection; label: string | null; paragraphs: string[] };

const articleLabel = (match: RegExpExecArray) => {
  const number = /^\d+$/.test(match[1] ?? "") ? match[1] : "único";
  return `Artículo ${number}${match[2] ? ` ${match[2].toLowerCase()}` : ""}`;
};

/** Groups paragraphs into the regulation's logical parts. */
function segment(paragraphs: string[]): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = { section: "preamble", label: null, paragraphs: [] };
  let afterPublication = false;

  const start = (section: ChunkSection, label: string | null) => {
    if (current.paragraphs.length > 0) segments.push(current);
    current = { section, label, paragraphs: [] };
  };

  for (const paragraph of paragraphs) {
    const article = ARTICLE_HEADER.exec(paragraph);
    const isAnnexHeading = paragraph.length <= 120 && ANNEX_HEADING.test(paragraph);

    if (isAnnexHeading) {
      afterPublication = true;
      start("annex", paragraph.split("\n")[0] ?? paragraph);
    } else if (article) {
      start(afterPublication ? "annex" : "article", articleLabel(article));
    } else if (PUBLICATION_LINE.test(paragraph)) {
      afterPublication = true;
      start("closing", null);
    } else if (!afterPublication && LAW_CLOSING.test(paragraph)) {
      start("closing", null);
    } else if (
      afterPublication &&
      current.section === "closing" &&
      !NOTE.test(paragraph)
    ) {
      // Whatever follows the publication line and its notes is annexed material.
      start("annex", null);
    }

    current.paragraphs.push(paragraph);
  }

  if (current.paragraphs.length > 0) segments.push(current);

  return segments;
}

/** Splits a text that is too long at the given separator, keeping pieces under the limit. */
function splitBy(
  text: string,
  separator: string | RegExp,
  joiner: string,
  max: number,
) {
  const pieces: string[] = [];
  let buffer = "";

  for (const part of text.split(separator)) {
    if (buffer && buffer.length + joiner.length + part.length > max) {
      pieces.push(buffer);
      buffer = part;
    } else {
      buffer = buffer ? `${buffer}${joiner}${part}` : part;
    }
  }

  if (buffer) pieces.push(buffer);

  return pieces;
}

/** Breaks one oversized paragraph: by line (table rows), then sentence, then word. */
function splitParagraph(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) return [paragraph];

  return splitBy(paragraph, "\n", "\n", max)
    .flatMap((piece) =>
      piece.length <= max ? [piece] : splitBy(piece, /(?<=[.;:])\s+/, " ", max),
    )
    .flatMap((piece) =>
      piece.length <= max ? [piece] : splitBy(piece, /\s+/, " ", max),
    )
    .flatMap((piece) => {
      if (piece.length <= max) return [piece];
      // A single unbroken token longer than the limit: cut it.
      const cuts: string[] = [];
      for (let index = 0; index < piece.length; index += max) {
        cuts.push(piece.slice(index, index + max));
      }
      return cuts;
    });
}

/**
 * Splits the plain text of a regulation into retrieval chunks.
 *
 * Chunks follow the legal structure: the preamble (title, VISTO,
 * CONSIDERANDO), one chunk per article, the closing (signatures, publication
 * line, InfoLEG notes) and annexed material. Parts longer than `maxChars` are
 * split at paragraph boundaries and keep their section and label.
 */
export function chunkRegulation(text: string, options: ChunkOptions = {}): Chunk[] {
  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: Chunk[] = [];

  for (const part of segment(paragraphs)) {
    const pieces = part.paragraphs.flatMap((paragraph) =>
      splitParagraph(paragraph, max),
    );

    for (const content of splitBy(pieces.join("\u0000"), "\u0000", "\n\n", max)) {
      chunks.push({
        ordinal: chunks.length,
        section: part.section,
        label: part.label,
        content,
      });
    }
  }

  return chunks;
}
