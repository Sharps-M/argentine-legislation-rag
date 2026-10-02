import { Parser } from "htmlparser2";

/** Elements whose content is page chrome or code, never regulation text. */
const SKIPPED = new Set(["head", "script", "style", "header", "map", "noscript"]);

/** Elements that end the current line. */
const BLOCK = new Set([
  "div",
  "p",
  "table",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "center",
]);

const CELL = new Set(["td", "th"]);

/** A table row ends its line but, unlike a block, adds no blank line between rows. */
const ROW = "tr";

/**
 * Converts an InfoLEG regulation page to plain text.
 *
 * InfoLEG hard-wraps its HTML source at ~70 columns and marks real line
 * breaks with `<br>`. So source newlines are treated as spaces, `<br>` and
 * block elements as line breaks, and table cells are joined with " | ".
 * Paragraphs come out separated by one blank line.
 */
export function htmlToText(html: string): string {
  let output = "";
  let skipDepth = 0;

  const newline = () => {
    output += "\n";
  };

  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIPPED.has(name)) skipDepth += 1;
        if (skipDepth > 0) return;

        if (name === "br") newline();
        else if (BLOCK.has(name)) newline();
        else if (CELL.has(name)) output += " | ";
      },
      ontext(text) {
        if (skipDepth > 0) return;
        output += text.replace(/\s+/g, " ");
      },
      onclosetag(name) {
        if (SKIPPED.has(name)) {
          skipDepth = Math.max(0, skipDepth - 1);
          return;
        }
        if (skipDepth > 0) return;

        if (BLOCK.has(name) || name === ROW) newline();
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );

  parser.write(html);
  parser.end();

  return normalizeText(output);
}

/** Trims lines, collapses spaces and reduces runs of blank lines to one. */
export function normalizeText(text: string): string {
  return text
    .replace(/ /g, " ")
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]+/g, " ")
        .replace(/^(\s*\|\s*)+/, "")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Decodes the bytes of an InfoLEG page. The site serves ISO-8859-1, declared
 * in the `Content-Type` header or in a `<meta>` tag; that is the default when
 * neither says otherwise.
 */
export function decodeHtml(bytes: Uint8Array, contentType?: string | null): string {
  const declared =
    /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ??
    /charset=["']?([\w-]+)/i.exec(
      new TextDecoder("latin1").decode(bytes.subarray(0, 4096)),
    )?.[1];

  try {
    return new TextDecoder(declared ?? "iso-8859-1").decode(bytes);
  } catch {
    return new TextDecoder("iso-8859-1").decode(bytes);
  }
}
