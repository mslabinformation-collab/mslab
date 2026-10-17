import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

// The PDF tests' reader (the certificate's, phase 3d, moved here when the invoice's PDF, phase 4, needed it too): a PDF read back the way a
// reader reads it. pdf-lib embeds each font as glyph ids, not letters, into the page (a text is never in the file as text), but it also writes
// each font's ToUnicode map: readPdf decodes the page's content stream, follows every text-showing operator (Tf, Tc, Tm, Tj) and turns its
// glyph ids back into letters through that map. That is real text extraction (a reader's copy and search use the same map), so it checks at
// once that the right letters were drawn, in which font and size, and where. Positions are PDF points from the bottom left of the page.

/** The fonts' families as the PDF names them (the PostScript name without "-Regular" and pdf-lib's random "-1234" suffix). */
export const family = (postscriptName: string | null) => (postscriptName ?? "").replace(/-\d+$/, "").replace(/-Regular$/, "");
export type Run = { font: string; size: number; spacing: number; x: number; y: number; text: string };

export const rawStream = (o: unknown): PDFRawStream => {
  if (!(o instanceof PDFRawStream)) throw new Error("not a stream");
  return o;
};
const streamText = (o: unknown): string => new TextDecoder().decode(decodePDFRawStream(rawStream(o)).decode());

/** A ToUnicode map (pdf-lib writes `<glyph> <UTF-16BE>` pairs between beginbfchar and endbfchar): glyph id → its letters. */
function toUnicode(cmap: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of cmap.split("beginbfchar").slice(1)) {
    for (const [, glyph, utf16] of section.split("endbfchar")[0].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(glyph.toUpperCase(), String.fromCharCode(...(utf16.match(/.{4}/g) ?? []).map((u) => parseInt(u, 16))));
    }
  }
  return map;
}

/**
 * The PDF read back: its page number `index` (the first by default; the contract's PDF has several), the text runs (each Tj with its font's
 * family, size, letter spacing in em, position and letters), the filled circles (the competency bullets: pdf-lib draws a circle as four Bézier
 * curves, whose end points are its four extremes; centre, diameter and the fill colour), the embedded fonts' names and the page's operators.
 */
export async function readPdf(bytes: Uint8Array, index = 0) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const page = pages[index];
  const resources = page.node.Resources()!;
  const fonts = new Map<string, { name: string; unicode: Map<string, string> }>();
  for (const [key, ref] of resources.lookup(PDFName.of("Font"), PDFDict).entries()) {
    const font = doc.context.lookup(ref, PDFDict);
    fonts.set(key.decodeText(), { name: font.lookup(PDFName.of("BaseFont"), PDFName).decodeText(), unicode: toUnicode(streamText(font.lookup(PDFName.of("ToUnicode")))) });
  }
  const contents = page.node.Contents();
  const ops = (contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents]).map(streamText).join("\n");

  const runs: Run[] = [];
  const circles: { x: number; y: number; diameter: number; color: string }[] = [];
  let font = "";
  let size = 0;
  let spacing = 0;
  let at = [0, 0];
  let fill = "";
  let path: number[][] = [];
  let curves = 0;
  let args: string[] = [];
  for (const token of ops.match(/\/[^\s/<>[\]()]+|<[0-9A-Fa-f]*>|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z*'"]+|\[|\]/g) ?? []) {
    if (!/^[A-Za-z*'"]+$/.test(token)) {
      args.push(token);
      continue;
    }
    if (token === "Tf") [font, size] = [args[0].slice(1), Number(args[1])];
    else if (token === "Tc") spacing = Number(args[0]);
    else if (token === "Tm") at = [Number(args[4]), Number(args[5])];
    else if (token === "Tj") {
      const f = fonts.get(font)!;
      const glyphs = args[0].slice(1, -1).match(/.{4}/g) ?? [];
      runs.push({ font: family(f.name), size, spacing: spacing / size, x: at[0], y: at[1], text: glyphs.map((g) => f.unicode.get(g.toUpperCase()) ?? "�").join("") });
    } else if (token === "rg") fill = args.map(Number).join(" ");
    else if (token === "m") [path, curves] = [[[Number(args[0]), Number(args[1])]], 0];
    else if (token === "c") {
      path.push([Number(args[4]), Number(args[5])]);
      curves++;
    } else if (token === "f" && curves === 4) {
      const [xs, ys] = [path.map((p) => p[0]), path.map((p) => p[1])];
      circles.push({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, diameter: Math.max(...xs) - Math.min(...xs), color: fill });
    }
    args = [];
  }
  const fontNames = [...new Set([...fonts.values()].map((f) => f.name))].sort();
  return { doc, pages, page, runs, circles, fontNames, ops };
}

