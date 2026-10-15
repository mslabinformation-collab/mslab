import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import fontkit from "@pdf-lib/fontkit";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { checkCertificateName } from "@/domain/certificate";
import { CERT_FONT_DIR, loadCertificateAssets, renderCertificate, type CertificateAssets, type CertificateContent } from "@/server/certificate-pdf";
import { fakeMediaStore } from "../fakes";

// The certificate's PDF (phase 3d, spec §7, §10 "PDF", Review Focus 2): rendered from a fixture and read back the way a PDF reader reads
// it. pdf-lib embeds each font as a subset and writes glyph ids, not letters, into the page (the name is never in the file as text), but
// it also writes each font's ToUnicode map: readPdf below decodes the page's content stream, follows every text-showing operator (Tf, Tc,
// Tm, Tj) and turns its glyph ids back into letters through that map. That is real text extraction (a reader's copy and search use the same
// map), so it checks at once that the right letters were drawn, in which font and size, and where. Positions are PDF points from the
// bottom left of the 842 × 595 page.

const SANS = new Uint8Array(readFileSync(join(CERT_FONT_DIR, "Jost[wght].ttf")));
const SCRIPT = new Uint8Array(readFileSync(join(CERT_FONT_DIR, "GreatVibes-Regular.ttf")));
const jost = fontkit.create(SANS);
const greatVibes = fontkit.create(SCRIPT);

/** The CRC-32 of a PNG chunk. */
function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** An RGBA PNG of white ink: `ink(x, y)` is each pixel's alpha (as Seaded's upload makes the signature: white on transparent). */
function pngOf(width: number, height: number, ink: (x: number, y: number) => number): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1)); // each row: filter 0, then RGBA
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([255, 255, 255, ink(x, y)], y * (width * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (png.set(p, at), at + p.length), 0);
  return png;
}

/** A scanned signature's size after Seaded's conversion (at most 1200 px wide): a wavy stroke of ink. */
const SIGNATURE = pngOf(1200, 400, (x, y) => (Math.abs(y - (200 + 120 * Math.sin(x / 90))) < 9 ? 255 : 0));

const FIXTURE: CertificateContent = {
  number: "MS LAB 2026-03",
  name: "Kertu Õunapuu",
  courseTitle: "Kulmude kujundamise e-koolitus",
  skills: ["Kulmude kuju analüüs", "Värvi valik ja segamine", "Kulmude värvimine", "Laminatsioon", "Hügieen ja ohutus", "Kliendi nõustamine"],
  volume: "10 akadeemilist tundi",
  practicalLine: "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine",
  place: "Pärnu linn",
  registryCode: "16346048",
  issuedAt: new Date("2026-10-15T09:00:00Z"),
  trainerName: "Maria Sosnina",
};
const ASSETS: CertificateAssets = { sans: SANS, script: SCRIPT, signature: SIGNATURE };
const NO_SIGNATURE: CertificateAssets = { ...ASSETS, signature: null };

type Run = { font: string; size: number; spacing: number; x: number; y: number; text: string };

const rawStream = (o: unknown): PDFRawStream => {
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
 * The PDF read back: its one page, the text runs (each Tj with its font's family, size, letter spacing in em, position and letters), the
 * embedded fonts' names, and each image drawn (its pixel size and the rectangle it is drawn into).
 */
async function readPdf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const page = pages[0];
  const resources = page.node.Resources()!;
  const fonts = new Map<string, { name: string; unicode: Map<string, string> }>();
  for (const [key, ref] of resources.lookup(PDFName.of("Font"), PDFDict).entries()) {
    const font = doc.context.lookup(ref, PDFDict);
    fonts.set(key.decodeText(), { name: font.lookup(PDFName.of("BaseFont"), PDFName).decodeText(), unicode: toUnicode(streamText(font.lookup(PDFName.of("ToUnicode")))) });
  }
  const xobjects = resources.lookup(PDFName.of("XObject"));
  const images = new Map<string, { width: number; height: number }>();
  if (xobjects instanceof PDFDict)
    for (const [key, ref] of xobjects.entries()) {
      const dict = rawStream(doc.context.lookup(ref)).dict;
      if (dict.get(PDFName.of("Subtype"))?.toString() === "/Image")
        images.set(key.decodeText(), { width: Number(dict.get(PDFName.of("Width"))!.toString()), height: Number(dict.get(PDFName.of("Height"))!.toString()) });
    }
  const contents = page.node.Contents();
  const ops = (contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents]).map(streamText).join("\n");

  const runs: Run[] = [];
  const drawn: { width: number; height: number; x: number; y: number; pixels: { width: number; height: number } }[] = [];
  let font = "";
  let size = 0;
  let spacing = 0;
  let at = [0, 0];
  let matrices: number[][] = [];
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
      runs.push({ font: f.name.replace(/-Regular-\d+$/, ""), size, spacing: spacing / size, x: at[0], y: at[1], text: glyphs.map((g) => f.unicode.get(g.toUpperCase()) ?? "�").join("") });
    } else if (token === "q") matrices = [];
    else if (token === "cm") matrices.push(args.map(Number));
    else if (token === "Do" && images.has(args[0].slice(1))) {
      // pdf-lib draws an image as: translate to its corner, then scale the unit square to its size
      const corner = matrices.find((m) => m[0] === 1 && m[3] === 1 && (m[4] !== 0 || m[5] !== 0))!;
      const scale = matrices.find((m) => m[0] !== 1 || m[3] !== 1)!;
      drawn.push({ width: scale[0], height: scale[3], x: corner[4], y: corner[5], pixels: images.get(args[0].slice(1))! });
    }
    args = [];
  }
  const fontNames = [...new Set([...fonts.values()].map((f) => f.name))].sort();
  return { doc, pages, page, runs, fontNames, drawn, ops };
}

/** A run's width as pdf-lib measured it when it laid the page out: the glyphs' advances (no kerning) plus the spacing between them. */
function widthOf(run: Run): number {
  const font = run.font === "GreatVibes" ? greatVibes : jost;
  const glyphs = font.layout(run.text).glyphs;
  return (glyphs.reduce((sum, g) => sum + g.advanceWidth, 0) / font.unitsPerEm) * run.size + run.spacing * run.size * Math.max(0, glyphs.length - 1);
}

const runsIn = (runs: Run[], family: string) => runs.filter((r) => r.font === family);
const one = (runs: Run[], text: string): Run => {
  const found = runs.filter((r) => r.text === text);
  expect(found.map((r) => r.text), text).toEqual([text]);
  return found[0];
};
const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 1);

describe("renderCertificate: the page (spec §7)", () => {
  test("one A4 landscape page, black, both fonts embedded as subsets, under 300 KB with a full-size signature", async () => {
    const bytes = await renderCertificate(FIXTURE, ASSETS);
    expect(bytes.length).toBeLessThan(300 * 1024);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    const { doc, pages, page, fontNames, ops } = await readPdf(bytes);
    expect(pages).toHaveLength(1);
    expect(page.getSize()).toEqual({ width: 842, height: 595 });
    expect(fontNames).toHaveLength(2);
    expect(fontNames[0]).toMatch(/^GreatVibes-Regular-\d+$/);
    expect(fontNames[1]).toMatch(/^Jost-Regular-\d+$/);
    // the whole page is filled black first
    expect(ops.trimStart().startsWith("q\n0 0 0 rg")).toBe(true);
    expect(ops).toContain("0 0 m\n0 595 l\n842 595 l\n842 0 l\nh\nf");
    // each font's file is in the PDF (Type0 font → its CID font → the descriptor → FontFile2), a subset: much smaller than the font
    const fontDicts = doc.context.enumerateIndirectObjects().flatMap(([, o]) => (o instanceof PDFDict && o.get(PDFName.of("Subtype"))?.toString() === "/Type0" ? [o] : []));
    expect(fontDicts).toHaveLength(2);
    for (const font of fontDicts) {
      const cid = doc.context.lookup(font.lookup(PDFName.of("DescendantFonts"), PDFArray).get(0), PDFDict);
      const file = cid.lookup(PDFName.of("FontDescriptor"), PDFDict).lookup(PDFName.of("FontFile2"));
      expect(decodePDFRawStream(rawStream(file)).decode().length).toBeLessThan(SANS.length / 2);
    }
    // neutral metadata, dated by the issue
    expect([doc.getTitle(), doc.getAuthor(), doc.getProducer(), doc.getCreator()]).toEqual(["Tunnistus MS LAB 2026-03", "MS LAB", "MS LAB", "MS LAB"]);
    expect(doc.getCreationDate()).toEqual(FIXTURE.issuedAt);
  });

  test("the same certificate gives the same file on every download", async () => {
    expect(Buffer.from(await renderCertificate(FIXTURE, ASSETS)).equals(Buffer.from(await renderCertificate(FIXTURE, ASSETS)))).toBe(true);
  });

  test("the texts, their fonts, sizes and places: the heading, the title in spaced capitals, the name over the line, the foot", async () => {
    const { runs, ops } = await readPdf(await renderCertificate(FIXTURE, ASSETS));
    const heading = one(runs, "TUNNISTUS");
    expect([heading.font, heading.size, heading.y]).toEqual(["Jost", 54, 478]);
    near(heading.x + widthOf(heading) / 2, 421);
    const title = one(runs, "KULMUDE KUJUNDAMISE E-KOOLITUS");
    expect([title.font, title.size, title.y]).toEqual(["Jost", 18, 440]);
    near(title.spacing, 0.35);
    near(title.x + widthOf(title) / 2, 421);
    const name = one(runs, "Kertu Õunapuu");
    expect([name.font, name.size, name.y]).toEqual(["GreatVibes", 54, 334]);
    near(name.x + widthOf(name) / 2, 421);
    // the thin line under the name: 70 % of the width, centred
    expect(ops).toMatch(/126\.3\d* 316 m\n715\.7 316 l\nS/);
    // the practical line at the left and the volume at the right, on one baseline, in capitals
    const practical = one(runs, "PRAKTILINE TÖÖ FOTODEL, KOOLITAJA POOLT HINNATUD ISESEISEV PROTSEDUURI TEOSTAMINE");
    expect([practical.font, practical.size, practical.x, practical.y]).toEqual(["Jost", 8, 56, 148]);
    const volume = one(runs, "10 AKADEEMILIST TUNDI");
    expect([volume.size, volume.y]).toEqual([8, 148]);
    near(volume.x + widthOf(volume), 786);
    // bottom left: the logo, then the registry code and the number
    const logo = one(runs, "MS LAB");
    near(logo.x + widthOf(logo) / 2, 131);
    const small = one(runs, "KOOLITUSKESKUS");
    near(small.x + widthOf(small) / 2, 131);
    expect(one(runs, "REGISTRIKOOD: 16346048")).toMatchObject({ x: 56, y: 58, size: 7.5 });
    expect(one(runs, "Tunnistuse nr. MS LAB 2026-03")).toMatchObject({ x: 56, y: 46, size: 7.5 });
    // bottom right: "KOOLITAJA" and the place with the Tallinn date of the issue, centred under the signature
    for (const [text, y] of [["KOOLITAJA", 58], ["Pärnu linn 15.10.2026", 46]] as const) {
      const run = one(runs, text);
      expect([run.font, run.size, run.y]).toEqual(["Jost", 8, y]);
      near(run.x + widthOf(run) / 2, 706);
    }
  });

  test("the date is the issue's Tallinn date: 22:30 UTC on 31.12 prints 1 January", async () => {
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, issuedAt: new Date("2026-12-31T22:30:00Z") }, ASSETS));
    one(runs, "Pärnu linn 01.01.2027");
  });

  test("no volume: nothing at the right of the practical line", async () => {
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, volume: "" }, ASSETS));
    expect(runs.filter((r) => r.y === 148).map((r) => r.text)).toEqual(["PRAKTILINE TÖÖ FOTODEL, KOOLITAJA POOLT HINNATUD ISESEISEV PROTSEDUURI TEOSTAMINE"]);
  });

  test("a long practical line shrinks, then takes two lines, and never runs into the volume", async () => {
    const practicalLine = "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine ning kliendi nõustamine ".repeat(2).slice(0, 200).trim();
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, practicalLine }, ASSETS));
    const volume = one(runs, "10 AKADEEMILIST TUNDI");
    const lines = runs.filter((r) => r.x === 56 && r.y <= 148 && r.y > 130);
    expect(lines.map((r) => r.text).join(" ")).toBe(practicalLine.toLocaleUpperCase("et"));
    expect(lines.map((r) => r.y)).toEqual([148, expect.closeTo(148 - lines[0].size * 1.35, 5)]);
    for (const r of lines) {
      expect(r.size).toBeLessThanOrEqual(6.5);
      expect(r.x + widthOf(r)).toBeLessThanOrEqual(volume.x - 24 + 0.01);
    }
  });

  test("the signature image in its box at the bottom right; without one, the trainer's name in the script font there", async () => {
    const signed = await readPdf(await renderCertificate(FIXTURE, ASSETS));
    expect(signed.drawn).toHaveLength(1);
    const [image] = signed.drawn;
    expect(image.pixels).toEqual({ width: 1200, height: 400 });
    // scaled to fit 170 × 56, keeping its proportions, standing on y 72, centred on 706
    near(image.height, 56);
    near(image.width, 168);
    near(image.y, 72);
    near(image.x + image.width / 2, 706);
    expect(runsIn(signed.runs, "GreatVibes").map((r) => r.text)).toEqual(["Kertu Õunapuu"]);

    const unsigned = await readPdf(await renderCertificate(FIXTURE, NO_SIGNATURE));
    expect(unsigned.drawn).toEqual([]);
    const trainer = one(unsigned.runs, "Maria Sosnina");
    expect([trainer.font, trainer.size, trainer.y]).toEqual(["GreatVibes", 26, 78]);
    near(trainer.x + widthOf(trainer) / 2, 706);
  });

  test("a long course title wraps to two lines at 14 pt", async () => {
    const courseTitle = "Kulmude ja ripsmete kujundamise, värvimise ning laminatsiooni põhjalik e-koolitus algajatele";
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, courseTitle }, ASSETS));
    const lines = runs.filter((r) => r.font === "Jost" && r.y > 400 && r.text !== "TUNNISTUS");
    expect(lines.map((r) => [r.size, r.y])).toEqual([[14, 448], [14, 428]]);
    expect(lines.map((r) => r.text).join(" ")).toBe(courseTitle.toLocaleUpperCase("et"));
    for (const line of lines) {
      expect(widthOf(line)).toBeLessThanOrEqual(662 + 0.01);
      near(line.x + widthOf(line) / 2, 421);
    }
  });

  test("the competency lines: two columns of bullets, the left one filled first, 9.5 pt; 8.5 pt above 12 lines; a long line wraps under its bullet", async () => {
    const six = await readPdf(await renderCertificate(FIXTURE, ASSETS));
    const rows = (runs: Run[]) => runs.filter((r) => r.font === "Jost" && r.y <= 290 && r.y > 160 && r.text !== "•");
    const bullets = (runs: Run[]) => runs.filter((r) => r.text === "•");
    expect(rows(six.runs).map((r) => [r.text, r.x, r.y, r.size])).toEqual([
      ["Kulmude kuju analüüs", 107.4, 290, 9.5],
      ["Värvi valik ja segamine", 107.4, 274.8, 9.5],
      ["Kulmude värvimine", 107.4, 259.6, 9.5],
      ["Laminatsioon", 445.4, 290, 9.5],
      ["Hügieen ja ohutus", 445.4, 274.8, 9.5],
      ["Kliendi nõustamine", 445.4, 259.6, 9.5],
    ].map(([text, x, y, size]) => [text, expect.closeTo(x as number, 5), expect.closeTo(y as number, 5), size]));
    expect(bullets(six.runs).map((r) => [r.x, r.y])).toEqual([[96, 290], [96, 274.8], [96, 259.6], [434, 290], [434, 274.8], [434, 259.6]].map(([x, y]) => [expect.closeTo(x, 5), expect.closeTo(y, 5)]));

    const thirteen = await readPdf(await renderCertificate({ ...FIXTURE, skills: Array.from({ length: 13 }, (_, i) => `Oskus ${i + 1}`) }, ASSETS));
    expect(rows(thirteen.runs).map((r) => r.text)).toEqual(Array.from({ length: 13 }, (_, i) => `Oskus ${i + 1}`));
    expect(new Set(rows(thirteen.runs).map((r) => r.size))).toEqual(new Set([8.5]));
    expect(rows(thirteen.runs).filter((r) => r.x > 400).map((r) => r.text)).toEqual(["Oskus 8", "Oskus 9", "Oskus 10", "Oskus 11", "Oskus 12", "Oskus 13"]);

    const long = "Kulmude kuju analüüs, mõõtmine ja kujundamine vastavalt näo proportsioonidele ning kliendi soovidele ja eelistustele";
    const wrapped = await readPdf(await renderCertificate({ ...FIXTURE, skills: [long, "Värvimine"] }, ASSETS));
    const left = rows(wrapped.runs).filter((r) => r.x < 400);
    expect(left.length).toBeGreaterThan(1);
    expect(left.map((r) => r.text).join(" ")).toBe(long);
    expect(bullets(wrapped.runs)).toHaveLength(2);
    for (const r of left) expect(r.x + widthOf(r)).toBeLessThanOrEqual(96 + 312 + 0.01);
  });

  test("16 lines of 120 characters still stay above the practical line", async () => {
    const skills = Array.from({ length: 16 }, (_, i) => `${i + 1}. ${"Kulmude kuju analüüs ja värvimine ".repeat(4)}`.slice(0, 120));
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, skills }, ASSETS));
    const rows = runs.filter((r) => r.font === "Jost" && r.y <= 290 && r.y > 150 && r.text !== "•");
    expect(Math.min(...rows.map((r) => r.y))).toBeGreaterThanOrEqual(172);
    expect(rows.map((r) => r.text).join(" ")).toBe(skills.map((s) => s.trim()).join(" "));
  });
});

describe("Review Focus 2: a name the fonts or the layout cannot take", () => {
  const nameRuns = async (name: string) => runsIn((await readPdf(await renderCertificate({ ...FIXTURE, name }, ASSETS))).runs, "GreatVibes");
  /** Two lines of a name read back as one: a break after a hyphen keeps it, a break at a space drops it. */
  const joined = (lines: Run[]) => lines.reduce((s, r) => (s === "" ? r.text : s.endsWith("-") ? s + r.text : `${s} ${r.text}`), "");

  test("an 80-character name with a double surname wraps to two lines at 30 pt or smaller, each within the line and centred", async () => {
    const name = "Anna-Maria Kristiina Elisabeth Õunapuu-Šmidt von Liivalaid-Kuusemäe Tammsaar-Ots";
    expect(checkCertificateName(name)).toEqual({ ok: true, name });
    expect(Array.from(name)).toHaveLength(80);
    const lines = await nameRuns(name);
    expect(lines).toHaveLength(2);
    expect(joined(lines)).toBe(name);
    expect(lines[0].size).toBe(lines[1].size);
    expect(lines[0].size).toBeLessThanOrEqual(30);
    expect(lines[0].size).toBeGreaterThan(20);
    expect(lines.map((r) => r.y)).toEqual([expect.closeTo(330 + lines[0].size * 1.15, 5), 330]);
    for (const r of lines) {
      expect(widthOf(r)).toBeLessThanOrEqual(570 + 0.01);
      near(r.x + widthOf(r) / 2, 421);
    }
  });

  test("a long name shrinks to fit the line on one line while it can stay at 30 pt or more", async () => {
    const [line, ...rest] = await nameRuns("Kristiina-Elisabeth Õunapuu-Liivalaid");
    expect(rest).toEqual([]);
    expect(line.text).toBe("Kristiina-Elisabeth Õunapuu-Liivalaid");
    expect(line.size).toBeLessThan(54);
    expect(line.size).toBeGreaterThanOrEqual(30);
    near(widthOf(line), 570);
    expect(line.y).toBe(334);
  });

  test("a Cyrillic name prints in the script font, and the text extraction finds it", async () => {
    for (const name of ["Мария Соснина", "Анастасия Владимировна Соколова-Кузнецова", "Олеся Ґудзь-Їжакевич"]) {
      const lines = await nameRuns(name);
      expect(joined(lines), name).toBe(name);
      for (const r of lines) expect(widthOf(r)).toBeLessThanOrEqual(570 + 0.01);
    }
  });

  test("a name with nowhere to break stays on one line, as small as it must be", async () => {
    const name = "Õ".repeat(80);
    const [line, ...rest] = await nameRuns(name);
    expect(rest).toEqual([]);
    expect(line.text).toBe(name);
    expect(line.size).toBeLessThan(30);
    near(widthOf(line), 570);
  });

  test("every letter the name rules accept has a glyph in the script font (none prints as an empty box)", () => {
    const missing: string[] = [];
    let letters = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const r = checkCertificateName(String.fromCodePoint(cp).repeat(2));
      if (!r.ok) continue;
      for (const c of new Set(Array.from(r.name))) {
        letters++;
        if (!greatVibes.hasGlyphForCodePoint(c.codePointAt(0)!)) missing.push(c);
      }
    }
    expect(letters).toBeGreaterThan(400);
    expect(missing).toEqual([]);
    // and the joiners between them
    for (const c of " -'’.") expect(greatVibes.hasGlyphForCodePoint(c.codePointAt(0)!), c).toBe(true);
  });
});

describe("loadCertificateAssets", () => {
  test("the two fonts from app/assets/fonts, read once per process", async () => {
    const a = await loadCertificateAssets(null, null);
    expect(Buffer.from(a.sans).equals(Buffer.from(SANS))).toBe(true);
    expect(Buffer.from(a.script).equals(Buffer.from(SCRIPT))).toBe(true);
    const b = await loadCertificateAssets(null, null);
    expect([b.sans, b.script]).toEqual([a.sans, a.script]);
    expect(b.sans).toBe(a.sans); // the same bytes, not read again
  });

  test("the signature from the store; null without a key, a store or the object", async () => {
    const key = "certificate/signature-0b5e8f2a.png";
    const store = fakeMediaStore({ [key]: { bytes: Array.from(SIGNATURE), contentType: "image/png" } });
    expect(Buffer.from((await loadCertificateAssets(store, key)).signature!).equals(Buffer.from(SIGNATURE))).toBe(true);
    expect((await loadCertificateAssets(store, "certificate/signature-gone.png")).signature).toBeNull();
    expect((await loadCertificateAssets(null, key)).signature).toBeNull();
    store.requested.length = 0;
    expect((await loadCertificateAssets(store, null)).signature).toBeNull();
    expect(store.requested).toEqual([]); // no key: the store is not asked
  });

  test("a store that cannot be reached fails the download (never a certificate without the signature it has)", async () => {
    const store = { ...fakeMediaStore(), get: async () => Promise.reject(new Error("R2 down")) };
    await expect(loadCertificateAssets(store, "certificate/signature-x.png")).rejects.toThrow("R2 down");
  });

  test("an ArrayBuffer body works as well as a stream", async () => {
    const store = { ...fakeMediaStore(), get: async () => ({ body: SIGNATURE.slice().buffer as ArrayBuffer }) };
    expect(Buffer.from((await loadCertificateAssets(store, "certificate/signature-x.png")).signature!).equals(Buffer.from(SIGNATURE))).toBe(true);
  });
});
