import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { decodeHtml, htmlToText } from "./html-to-text";

const fixtureDir = path.join("tests", "fixtures", "html");
const fixtures = readdirSync(fixtureDir).filter((file) => file.endsWith(".htm"));
const readFixture = (file: string) =>
  htmlToText(decodeHtml(readFileSync(path.join(fixtureDir, file))));

describe("htmlToText", () => {
  it("treats source newlines as spaces and <br> as line breaks", () => {
    const html =
      "<div>Que por el artículo 7°\nde la Ley<br>\n<br>\nARTÍCULO 1°.- Texto.</div>";

    expect(htmlToText(html)).toBe(
      "Que por el artículo 7° de la Ley\n\nARTÍCULO 1°.- Texto.",
    );
  });

  it("drops scripts, the head and the site header", () => {
    const html = `<html><head><title>InfoLEG</title><script>ga('send')</script></head>
      <body><header><img src="left.png"><map><area alt="inicio sitio infoleg"></map></header>
      <div>Ley 27817</div><script>track()</script></body></html>`;

    expect(htmlToText(html)).toBe("Ley 27817");
  });

  it("decodes entities and normalises non-breaking spaces", () => {
    expect(
      htmlToText("<p>&#8220;sujeta a&nbsp;&nbsp;privatizaci&oacute;n&#8221;</p>"),
    ).toBe("“sujeta a privatización”");
  });

  it("renders table rows as lines with cells separated by pipes", () => {
    const html =
      "<table><tr><td>Nivel</td><td>Monto</td></tr><tr><td>A</td><td>$ 100</td></tr></table>";

    expect(htmlToText(html)).toBe("Nivel | Monto\nA | $ 100");
  });

  it("keeps link text and never leaves more than one blank line", () => {
    const html = 'Ver <a href="/x">Anexo I</a><br><br><br><br><div></div>Fin';

    expect(htmlToText(html)).toBe("Ver Anexo I\n\nFin");
  });

  it.each(fixtures)("extracts clean text from the real page %s", (file) => {
    const text = readFixture(file);

    expect(text.length).toBeGreaterThan(1000);
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).not.toMatch(/gtag|GoogleAnalytics|inicio sitio infoleg/);
    expect(text).not.toMatch(/�|Ã|\n{3,}/);
    expect(text).toMatch(/^[A-ZÁÉÍÓÚÑ]/);
    expect(text).toMatch(/(Ley|Decreto) \d+/);
  });
});

describe("decodeHtml", () => {
  const latin1 = Uint8Array.from(Buffer.from("ARTÍCULO 1°.- Año", "latin1"));

  it("defaults to ISO-8859-1, the encoding InfoLEG serves", () => {
    expect(decodeHtml(latin1)).toBe("ARTÍCULO 1°.- Año");
  });

  it("honours the charset of the Content-Type header", () => {
    const utf8 = new TextEncoder().encode("ARTÍCULO 1°.- Año");

    expect(decodeHtml(utf8, "text/html; charset=UTF-8")).toBe("ARTÍCULO 1°.- Año");
  });

  it("reads the charset from a meta tag when there is no header", () => {
    const page = `<meta content="text/html; charset=utf-8" http-equiv="content-type">Año`;

    expect(decodeHtml(new TextEncoder().encode(page))).toContain("Año");
  });

  it("falls back to ISO-8859-1 for an unknown charset", () => {
    expect(decodeHtml(latin1, "text/html; charset=klingon")).toBe("ARTÍCULO 1°.- Año");
  });
});
