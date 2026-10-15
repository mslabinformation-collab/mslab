import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { checkCertificateName, readCertificateSettings } from "@/domain/certificate";
import { CERT_FONT_DIR, CERT_FONTS, loadCertificateAssets, renderCertificate, type CertificateAssets, type CertificateContent } from "@/server/certificate-pdf";

// The certificate's PDF (phase 3d, spec §7, §10 "PDF", Review Focus 2): rendered from a fixture and read back the way a PDF reader reads
// it. pdf-lib embeds each font as glyph ids, not letters, into the page (the name is never in the file as text), but it also writes each
// font's ToUnicode map: readPdf below decodes the page's content stream, follows every text-showing operator (Tf, Tc, Tm, Tj) and turns its
// glyph ids back into letters through that map. That is real text extraction (a reader's copy and search use the same map), so it checks at
// once that the right letters were drawn, in which font and size, and where. Positions are PDF points from the bottom left of the 842 × 595
// page. The script font, Revive 80 Signature, has tall capitals with long swashes and a tiny lowercase: its ink (the glyphs' bounding box,
// not the advance widths) is checked against the title above the name and the competency lines below it.

const SANS = new Uint8Array(readFileSync(join(CERT_FONT_DIR, CERT_FONTS.sans)));
const SCRIPT = new Uint8Array(readFileSync(join(CERT_FONT_DIR, CERT_FONTS.script)));
const jost = fontkit.create(SANS);
const revive = fontkit.create(SCRIPT);
/** The fonts' families as the PDF names them (the PostScript name without "-Regular" and pdf-lib's random "-1234" suffix). */
const family = (postscriptName: string | null) => (postscriptName ?? "").replace(/-\d+$/, "").replace(/-Regular$/, "");
const SANS_FAMILY = family(jost.postscriptName);
const SCRIPT_FAMILY = family(revive.postscriptName);

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
const ASSETS: CertificateAssets = { sans: SANS, script: SCRIPT };

/** The name's band: its ink stays under the course title (whose second line, when it wraps, stands on 428) and 6 pt over the first competency line (letters up to 297). */
const INK_BAND = { bottom: 303, top: 425 } as const;

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

/** The names of the page's images (XObjects): pdf-lib leaves an empty dictionary when nothing is drawn. */
const imagesOf = (page: { node: { Resources(): PDFDict | undefined } }): string[] => {
  const xobjects = page.node.Resources()!.lookup(PDFName.of("XObject"));
  return xobjects instanceof PDFDict ? xobjects.keys().map((k) => k.decodeText()) : [];
};

/**
 * The PDF read back: its one page, the text runs (each Tj with its font's family, size, letter spacing in em, position and letters), the filled
 * circles (the competency bullets: pdf-lib draws a circle as four Bézier curves, whose end points are its four extremes; centre, diameter and
 * the fill colour), the embedded fonts' names and the page's operators.
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

/** A run's width as pdf-lib measured it when it laid the page out: the glyphs' advances (no kerning) plus the spacing between them. */
function widthOf(run: Run): number {
  const font = run.font === SCRIPT_FAMILY ? revive : jost;
  const glyphs = font.layout(run.text).glyphs;
  return (glyphs.reduce((sum, g) => sum + g.advanceWidth, 0) / font.unitsPerEm) * run.size + run.spacing * run.size * Math.max(0, glyphs.length - 1);
}

/** Where a script run's ink lies, from the font's glyph outlines: its lowest and highest points on the page (the swashes and the carons count). */
function inkOf(run: Run): { bottom: number; top: number } {
  const box = revive.layout(run.text).bbox;
  return { bottom: run.y + (box.minY / revive.unitsPerEm) * run.size, top: run.y + (box.maxY / revive.unitsPerEm) * run.size };
}

const runsIn = (runs: Run[], fontFamily: string) => runs.filter((r) => r.font === fontFamily);
const one = (runs: Run[], text: string): Run => {
  const found = runs.filter((r) => r.text === text);
  expect(found.map((r) => r.text), text).toEqual([text]);
  return found[0];
};
const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 1);

describe("renderCertificate: the page (spec §7)", () => {
  test("one A4 landscape page, black, Jost a subset and the script font whole, no image, under 300 KB", async () => {
    const bytes = await renderCertificate(FIXTURE, ASSETS);
    expect(bytes.length).toBeLessThan(300 * 1024);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    const { doc, pages, page, fontNames, ops } = await readPdf(bytes);
    expect(pages).toHaveLength(1);
    expect(page.getSize()).toEqual({ width: 842, height: 595 });
    expect(fontNames.map(family)).toEqual([SANS_FAMILY, SCRIPT_FAMILY].sort());
    // the whole page is filled black first; the texts and the lines are white
    expect(ops.trimStart().startsWith("q\n0 0 0 rg")).toBe(true);
    expect(ops).toContain("0 0 m\n0 595 l\n842 595 l\n842 0 l\nh\nf");
    expect(ops).toContain("1 1 1 rg");
    expect(ops).toContain("1 1 1 RG");
    // no signature image (the trainer's name is typed in the script font), nothing but the two fonts as resources
    expect(imagesOf(page)).toEqual([]);
    // each font's file is in the PDF (Type0 font → its CID font → the descriptor → FontFile2 for TrueType, FontFile3 for CFF): Jost a subset, much
    // smaller than the font; Revive 80 Signature whole (pdf-lib's subset of this CFF font is a file MuPDF rejects, so the viewer would draw a
    // substitute sans), its stream about the font file's size
    const fontDicts = doc.context.enumerateIndirectObjects().flatMap(([, o]) => (o instanceof PDFDict && o.get(PDFName.of("Subtype"))?.toString() === "/Type0" ? [o] : []));
    expect(fontDicts).toHaveLength(2);
    const fileSizes = new Map<string, number>();
    for (const font of fontDicts) {
      const cid = doc.context.lookup(font.lookup(PDFName.of("DescendantFonts"), PDFArray).get(0), PDFDict);
      const descriptor = cid.lookup(PDFName.of("FontDescriptor"), PDFDict);
      const file = descriptor.lookup(PDFName.of("FontFile2")) ?? descriptor.lookup(PDFName.of("FontFile3"));
      fileSizes.set(family(font.lookup(PDFName.of("BaseFont"), PDFName).decodeText()), decodePDFRawStream(rawStream(file)).decode().length);
    }
    expect(fileSizes.get(SANS_FAMILY)!).toBeLessThan(SANS.length / 2);
    expect(fileSizes.get(SCRIPT_FAMILY)!).toBeGreaterThan(SCRIPT.length * 0.95);
    expect(fileSizes.get(SCRIPT_FAMILY)!).toBeLessThan(SCRIPT.length * 1.05);
    // neutral metadata, dated by the issue
    expect([doc.getTitle(), doc.getAuthor(), doc.getProducer(), doc.getCreator()]).toEqual(["Tunnistus MS LAB 2026-03", "MS LAB", "MS LAB", "MS LAB"]);
    expect(doc.getCreationDate()).toEqual(FIXTURE.issuedAt);
    expect(doc.getModificationDate()).toEqual(FIXTURE.issuedAt);
  });

  test("the same certificate gives the same file on every download", async () => {
    expect(Buffer.from(await renderCertificate(FIXTURE, ASSETS)).equals(Buffer.from(await renderCertificate(FIXTURE, ASSETS)))).toBe(true);
  });

  test("the texts, their fonts, sizes and places: the heading, the title in spaced capitals, the name over the line, the foot", async () => {
    const { runs, ops } = await readPdf(await renderCertificate(FIXTURE, ASSETS));
    const heading = one(runs, "TUNNISTUS");
    expect([heading.font, heading.size, heading.y]).toEqual([SANS_FAMILY, 54, 478]);
    near(heading.x + widthOf(heading) / 2, 421);
    const title = one(runs, "KULMUDE KUJUNDAMISE E-KOOLITUS");
    expect([title.font, title.size, title.y]).toEqual([SANS_FAMILY, 18, 440]);
    near(title.spacing, 0.35);
    near(title.x + widthOf(title) / 2, 421);
    const name = one(runs, "Kertu Õunapuu");
    expect([name.font, name.size, name.y]).toEqual([SCRIPT_FAMILY, 88, 331]);
    near(name.x + widthOf(name) / 2, 421);
    // the thin line under the name: 70 % of the width, centred
    expect(ops).toMatch(/126\.3\d* 316 m\n715\.7 316 l\nS/);
    // the practical line at the left and the volume at the right, on one baseline, in capitals
    const practical = one(runs, "PRAKTILINE TÖÖ FOTODEL, KOOLITAJA POOLT HINNATUD ISESEISEV PROTSEDUURI TEOSTAMINE");
    expect([practical.font, practical.size, practical.x, practical.y]).toEqual([SANS_FAMILY, 8, 56, 148]);
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
    // bottom right: "KOOLITAJA" and the place with the Tallinn date of the issue, centred under the trainer's name
    for (const [text, y] of [["KOOLITAJA", 58], ["Pärnu linn 15.10.2026", 46]] as const) {
      const run = one(runs, text);
      expect([run.font, run.size, run.y]).toEqual([SANS_FAMILY, 8, y]);
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

  test("Maria's signature is the trainer's name typed in the script font at the bottom right, above KOOLITAJA, and there is never an image", async () => {
    const { runs, page } = await readPdf(await renderCertificate(FIXTURE, ASSETS));
    expect(imagesOf(page)).toEqual([]);
    const trainer = one(runs, "Maria Sosnina");
    expect([trainer.font, trainer.size, trainer.y]).toEqual([SCRIPT_FAMILY, 40, 96]);
    near(trainer.x + widthOf(trainer) / 2, 706);
    // its ink (the M's swash reaches below the baseline) stays clear of "KOOLITAJA" (capitals 5.6 pt high on baseline 58) and of the practical line (148)
    const ink = inkOf(trainer);
    expect(ink.bottom).toBeGreaterThan(58 + 8 * 0.7 + 4);
    expect(ink.top).toBeLessThan(148 - 6);
    // the name and the trainer's name are the only script texts
    expect(runsIn(runs, SCRIPT_FAMILY).map((r) => r.text).sort()).toEqual(["Kertu Õunapuu", "Maria Sosnina"]);
  });

  test("the typographic apostrophe is drawn straight in the trainer's name too: the setting and the content keep it as written, the PDF reads back '", async () => {
    const trainerName = "Maria D’Arcy";
    expect(checkCertificateName(trainerName)).toEqual({ ok: true, name: trainerName });
    expect(readCertificateSettings({ trainerName }, FIXTURE.issuedAt).trainerName).toBe(trainerName); // the stored setting is not rewritten
    const content = { ...FIXTURE, trainerName };
    const { runs } = await readPdf(await renderCertificate(content, ASSETS));
    expect(content.trainerName).toBe(trainerName); // nor the content the PDF was drawn from
    const signed = one(runs, "Maria D'Arcy");
    expect([signed.font, signed.size, signed.y]).toEqual([SCRIPT_FAMILY, 40, 96]);
    near(signed.x + widthOf(signed) / 2, 706);
    expect(runs.filter((r) => r.text.includes("’"))).toEqual([]); // the font has no ’: it would be an empty box
  });

  test("a long trainer's name shrinks to fit the 170 pt column; the worst letters stay clear of KOOLITAJA", async () => {
    const trainerName = "Anna-Maria Kristiina Elisabeth Õunapuu";
    const long = one((await readPdf(await renderCertificate({ ...FIXTURE, trainerName }, ASSETS))).runs, trainerName);
    expect(long.size).toBeLessThan(40);
    near(widthOf(long), 170);
    near(long.x + widthOf(long) / 2, 706);
    const worst = one((await readPdf(await renderCertificate({ ...FIXTURE, trainerName: "Yrjö Ÿvonne" }, ASSETS))).runs, "Yrjö Ÿvonne");
    expect(inkOf(worst).bottom).toBeGreaterThan(58 + 8 * 0.7 + 1);
  });

  test("the place and the date are fitted to the signature column; a place of 60 characters stays inside the page", async () => {
    const place = "Pärnu linn, Pärnumaa, Eesti Vabariik, Euroopa Liit, Maailm.".padEnd(60, "x");
    expect(Array.from(place)).toHaveLength(60);
    for (const text of [place, "M".repeat(60)]) {
      const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, place: text }, ASSETS));
      const line = one(runs, `${text} 15.10.2026`);
      expect(line.y).toBe(46);
      expect(line.size).toBeLessThan(8);
      expect(line.size).toBeGreaterThan(3);
      near(line.x + widthOf(line) / 2, 706);
      expect(line.x).toBeGreaterThan(560);
      expect(line.x + widthOf(line)).toBeLessThanOrEqual(806 + 0.01);
    }
    // down to a floor (5 pt) a place is fitted to the 170 pt column, a short one is not touched
    const medium = one((await readPdf(await renderCertificate({ ...FIXTURE, place: "Tallinn, Harju maakond, Eesti Vabariik, Euroopa" }, ASSETS))).runs, "Tallinn, Harju maakond, Eesti Vabariik, Euroopa 15.10.2026");
    expect(medium.size).toBeLessThan(8);
    expect(medium.size).toBeGreaterThanOrEqual(5);
    expect(widthOf(medium)).toBeLessThanOrEqual(170 + 0.01);
  });

  test("a long course title wraps to two lines at 14 pt", async () => {
    const courseTitle = "Kulmude ja ripsmete kujundamise, värvimise ning laminatsiooni põhjalik e-koolitus algajatele";
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, courseTitle }, ASSETS));
    const lines = runs.filter((r) => r.font === SANS_FAMILY && r.y > 400 && r.text !== "TUNNISTUS");
    expect(lines.map((r) => [r.size, r.y])).toEqual([[14, 448], [14, 428]]);
    expect(lines.map((r) => r.text).join(" ")).toBe(courseTitle.toLocaleUpperCase("et"));
    for (const line of lines) {
      expect(widthOf(line)).toBeLessThanOrEqual(662 + 0.01);
      near(line.x + widthOf(line) / 2, 421);
    }
  });

  test("the competency lines: two columns of round bullets, the left one filled first, 9.5 pt; 8.5 pt above 12 lines; a long line wraps under its bullet", async () => {
    const six = await readPdf(await renderCertificate(FIXTURE, ASSETS));
    const rows = (runs: Run[]) => runs.filter((r) => r.font === SANS_FAMILY && r.y <= 290 && r.y > 160);
    // a bullet is a filled white circle (Jost's "•" is a 1 pt dot set high): 0.275 em across (2.6 pt at 9.5 pt), its left edge at the column's x,
    // its centre 0.25 em over the baseline (the middle of the lowercase letters, whose height is 0.46 em)
    const bulletAt = (left: number, baseline: number, fontSize: number) => ({ x: left + (0.275 * fontSize) / 2, y: baseline + 0.25 * fontSize, diameter: 0.275 * fontSize, color: "1 1 1" });
    const bullets = (circles: { x: number; y: number; diameter: number; color: string }[]) => circles.map((c) => ({ x: expect.closeTo(c.x, 3), y: expect.closeTo(c.y, 3), diameter: expect.closeTo(c.diameter, 3), color: c.color }));
    expect(six.runs.filter((r) => r.text.includes("•"))).toEqual([]); // no bullet glyph is written
    expect(rows(six.runs).map((r) => [r.text, r.x, r.y, r.size])).toEqual([
      ["Kulmude kuju analüüs", 107.4, 290, 9.5],
      ["Värvi valik ja segamine", 107.4, 274.8, 9.5],
      ["Kulmude värvimine", 107.4, 259.6, 9.5],
      ["Laminatsioon", 445.4, 290, 9.5],
      ["Hügieen ja ohutus", 445.4, 274.8, 9.5],
      ["Kliendi nõustamine", 445.4, 259.6, 9.5],
    ].map(([text, x, y, size]) => [text, expect.closeTo(x as number, 5), expect.closeTo(y as number, 5), size]));
    expect(six.circles).toEqual(bullets([[96, 290], [96, 274.8], [96, 259.6], [434, 290], [434, 274.8], [434, 259.6]].map(([x, y]) => bulletAt(x, y, 9.5))));
    near(six.circles[0].diameter, 2.6); // "about 2.6 pt"
    // the text gap is unchanged: the text starts 1.2 em after the bullet's origin (96 + 11.4), 8.8 pt after the circle's right edge
    near(rows(six.runs)[0].x - (six.circles[0].x + six.circles[0].diameter / 2), 1.2 * 9.5 - 0.275 * 9.5);

    const thirteen = await readPdf(await renderCertificate({ ...FIXTURE, skills: Array.from({ length: 13 }, (_, i) => `Oskus ${i + 1}`) }, ASSETS));
    expect(rows(thirteen.runs).map((r) => r.text)).toEqual(Array.from({ length: 13 }, (_, i) => `Oskus ${i + 1}`));
    expect(new Set(rows(thirteen.runs).map((r) => r.size))).toEqual(new Set([8.5]));
    expect(thirteen.circles).toHaveLength(13);
    for (const c of thirteen.circles) expect(c.diameter).toBeCloseTo(0.275 * 8.5, 2); // the bullets scale with the text
    expect(rows(thirteen.runs).filter((r) => r.x > 400).map((r) => r.text)).toEqual(["Oskus 8", "Oskus 9", "Oskus 10", "Oskus 11", "Oskus 12", "Oskus 13"]);

    const long = "Kulmude kuju analüüs, mõõtmine ja kujundamine vastavalt näo proportsioonidele ning kliendi soovidele ja eelistustele";
    const wrapped = await readPdf(await renderCertificate({ ...FIXTURE, skills: [long, "Värvimine"] }, ASSETS));
    const left = rows(wrapped.runs).filter((r) => r.x < 400);
    expect(left.length).toBeGreaterThan(1);
    expect(left.map((r) => r.text).join(" ")).toBe(long);
    expect(wrapped.circles).toHaveLength(2); // one bullet per line, none on the wrapped rows
    for (const r of left) expect(r.x + widthOf(r)).toBeLessThanOrEqual(96 + 312 + 0.01);
  });

  test("16 lines of 120 characters still stay above the practical line", async () => {
    const skills = Array.from({ length: 16 }, (_, i) => `${i + 1}. ${"Kulmude kuju analüüs ja värvimine ".repeat(4)}`.slice(0, 120));
    const { runs, circles } = await readPdf(await renderCertificate({ ...FIXTURE, skills }, ASSETS));
    const rows = runs.filter((r) => r.font === SANS_FAMILY && r.y <= 290 && r.y > 150);
    expect(Math.min(...rows.map((r) => r.y))).toBeGreaterThanOrEqual(172);
    expect(circles).toHaveLength(16);
    expect(rows.map((r) => r.text).join(" ")).toBe(skills.map((s) => s.trim()).join(" "));
  });
});

describe("Review Focus 2: a name the fonts or the layout cannot take", () => {
  const nameRuns = async (name: string, title?: string) =>
    runsIn((await readPdf(await renderCertificate({ ...FIXTURE, name, ...(title ? { courseTitle: title } : {}) }, ASSETS))).runs, SCRIPT_FAMILY).filter((r) => r.text !== "Maria Sosnina");
  /** Two lines of a name read back as one: a break after a hyphen keeps it, a break at a space drops it. */
  const joined = (lines: Run[]) => lines.reduce((s, r) => (s === "" ? r.text : s.endsWith("-") ? s + r.text : `${s} ${r.text}`), "");

  test("an 80-character name with a double surname wraps to two lines at 44 pt or smaller, each within the line and centred", async () => {
    const name = "Anna-Maria Kristiina Elisabeth Õunapuu-Šmidt von Liivalaid-Kuusemäe Tammsaar-Ots";
    expect(checkCertificateName(name)).toEqual({ ok: true, name });
    expect(Array.from(name)).toHaveLength(80);
    const lines = await nameRuns(name);
    expect(lines).toHaveLength(2);
    expect(joined(lines)).toBe(name);
    expect(lines[0].size).toBe(lines[1].size);
    expect(lines[0].size).toBeLessThanOrEqual(44);
    expect(lines[0].size).toBeGreaterThan(30);
    expect(lines[0].y - lines[1].y).toBeCloseTo(lines[0].size * 1.1, 5);
    expect(lines[1].y).toBeGreaterThanOrEqual(331);
    for (const r of lines) {
      expect(widthOf(r)).toBeLessThanOrEqual(540 + 0.01);
      near(r.x + widthOf(r) / 2, 421);
    }
  });

  test("a long name shrinks to fit the line on one line while it can stay at 44 pt or more", async () => {
    const [line, ...rest] = await nameRuns("Kristiina-Elisabeth Õunapuu-Liivalaid");
    expect(rest).toEqual([]);
    expect(line.text).toBe("Kristiina-Elisabeth Õunapuu-Liivalaid");
    expect(line.size).toBeLessThan(88);
    expect(line.size).toBeGreaterThanOrEqual(44);
    near(widthOf(line), 540);
    expect(line.y).toBeGreaterThanOrEqual(331);
  });

  test("names in Latin letters print in the script font, and the text extraction finds them: every Estonian letter, and the other languages' letters", async () => {
    const names = [
      "Õie-Mai Šõrmus-Žukova",
      "Ülle Äär Öövel Tõnisson",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ ÕÄÖÜŠŽ",
      "abcdefghijklmnopqrstuvwxyz õäöüšž",
      "Åsa Çelik-Þórunn Œdipe Ÿvonne Ægir Weiß",
      "François Müller-Weiß",
    ];
    for (const name of names) {
      expect(checkCertificateName(name), name).toEqual({ ok: true, name });
      const lines = await nameRuns(name);
      expect(joined(lines), name).toBe(name);
      for (const r of lines) {
        expect(r.font).toBe(SCRIPT_FAMILY);
        expect(widthOf(r)).toBeLessThanOrEqual(540 + 0.01);
      }
    }
  });

  test("an apostrophe prints as the straight one (the script font has no ’): the name is read back with it", async () => {
    expect(checkCertificateName("Siobhan O’Neill")).toEqual({ ok: true, name: "Siobhan O’Neill" });
    expect(joined(await nameRuns("Siobhan O’Neill"))).toBe("Siobhan O'Neill");
    expect(joined(await nameRuns("D'Artagnan"))).toBe("D'Artagnan");
    expect(revive.hasGlyphForCodePoint("'".codePointAt(0)!)).toBe(true);
    expect(revive.hasGlyphForCodePoint("’".codePointAt(0)!)).toBe(false);
  });

  test("a name with nowhere to break stays on one line, as small as it must be", async () => {
    const name = "Õ".repeat(80);
    const [line, ...rest] = await nameRuns(name);
    expect(rest).toEqual([]);
    expect(line.text).toBe(name);
    expect(line.size).toBeLessThan(44);
    near(widthOf(line), 540);
  });

  test("the name's ink never touches the title above or the competency lines below: carons and tildes up, swashes down, one line or two", async () => {
    const names = ["Kertu Rannak", "Õie-Mai Šõrmus-Žukova", "Yrjö Gunnar", "Ÿvonne Ýlva", "Åsa Jüri-Hjalmar", "Gerda Johanna Helene Fanny", "Anna-Maria Kristiina Elisabeth Õunapuu-Šmidt von Liivalaid-Kuusemäe Tammsaar-Ots", "Åsa Ÿ-Ÿ Åke Ýrjö-Ýrjö Ÿvonne Åsa Ÿ-Ÿ Åke Ýrjö-Ýrjö Ÿvonne Hjalmar Jürgen Gunnar"];
    for (const name of names) {
      for (const title of [undefined, "Kulmude ja ripsmete kujundamise, värvimise ning laminatsiooni põhjalik e-koolitus algajatele"]) {
        const lines = await nameRuns(name, title);
        expect(lines.length, name).toBeLessThanOrEqual(2);
        const lowest = inkOf(lines[lines.length - 1]).bottom;
        const highest = inkOf(lines[0]).top;
        expect(lowest, `${name}: lowest ink`).toBeGreaterThanOrEqual(INK_BAND.bottom - 0.01);
        expect(highest, `${name}: highest ink`).toBeLessThanOrEqual(INK_BAND.top + 0.01);
      }
    }
  });

  test("a name whose capitals reach far below the baseline (Y, G, J, H) is lifted so that the ink stays above the competency lines", async () => {
    const [plain] = await nameRuns("Kertu Rannak");
    expect(plain.y).toBe(331); // its swash (0.31 em) already clears the lines
    for (const name of ["Yrjö Ylva", "Gerda Helene"]) {
      const [line] = await nameRuns(name);
      expect(line.y, name).toBeGreaterThan(331);
      near(inkOf(line).bottom, INK_BAND.bottom);
      expect(line.size, name).toBe(88); // lifted, not shrunk
    }
  });

  test("every letter the name rules accept has a glyph in the script font (none prints as an empty box)", () => {
    const letters = new Set<string>();
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const r = checkCertificateName(String.fromCodePoint(cp).repeat(2));
      if (r.ok) for (const c of Array.from(r.name)) letters.add(c);
    }
    expect(letters.size).toBe(120);
    expect([...letters].filter((c) => !revive.hasGlyphForCodePoint(c.codePointAt(0)!))).toEqual([]);
    // and the joiners between them (the typographic apostrophe is drawn as the straight one)
    for (const c of " -'.") expect(revive.hasGlyphForCodePoint(c.codePointAt(0)!), c).toBe(true);
  });
});

describe("loadCertificateAssets", () => {
  test("the two fonts from app/assets/fonts, read once per process", async () => {
    const a = await loadCertificateAssets();
    expect(Object.keys(a).sort()).toEqual(["sans", "script"]);
    expect(Buffer.from(a.sans).equals(Buffer.from(SANS))).toBe(true);
    expect(Buffer.from(a.script).equals(Buffer.from(SCRIPT))).toBe(true);
    const b = await loadCertificateAssets();
    expect([b.sans, b.script]).toEqual([a.sans, a.script]);
    expect(b.sans).toBe(a.sans); // the same bytes, not read again
  });
});
