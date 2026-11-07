import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { decodePDFRawStream, PDFArray, PDFDict, PDFName } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { checkCertificateName, readCertificateSettings } from "@/domain/certificate";
import { CERT_FONT_DIR, CERT_FONTS, loadCertificateAssets, renderCertificate, type CertificateAssets, type CertificateContent } from "@/server/certificate-pdf";
import { family, rawStream, readPdf, type Run } from "../pdf-read";

// The certificate's PDF (phase 3d, spec §7, §10 "PDF", Review Focus 2): rendered from a fixture and read back the way a PDF reader reads
// it. pdf-lib embeds each font as glyph ids, not letters, into the page (the name is never in the file as text), but it also writes each
// font's ToUnicode map: readPdf (tests/pdf-read.ts, shared with the invoice's test) decodes the page's content stream, follows every
// text-showing operator (Tf, Tc, Tm, Tj) and turns its glyph ids back into letters through that map. That is real text extraction (a reader's
// copy and search use the same map), so it checks at once that the right letters were drawn, in which font and size, and where. Positions
// are PDF points from the bottom left of the 842 × 595 page. The script font, Revive 80 Signature, has tall capitals with long swashes and a
// tiny lowercase: its ink (the glyphs' bounding box, not the advance widths) is checked against the title above the name and the competency
// lines below it. The fonts are Maria's Canva certificate's (Dim 07.11): Glacial Indifference (BODY) for the heading and the lines of text,
// Montserrat (TITLE) for the course title; Jost (SANS) draws the logo and the letters Glacial Indifference lacks.

const SANS = new Uint8Array(readFileSync(join(CERT_FONT_DIR, CERT_FONTS.sans)));
const BODY = new Uint8Array(readFileSync(join(CERT_FONT_DIR, CERT_FONTS.body)));
const TITLE = new Uint8Array(readFileSync(join(CERT_FONT_DIR, CERT_FONTS.title)));
const SCRIPT = new Uint8Array(readFileSync(join(CERT_FONT_DIR, CERT_FONTS.script)));
const jost = fontkit.create(SANS);
const glacial = fontkit.create(BODY);
const montserrat = fontkit.create(TITLE);
const revive = fontkit.create(SCRIPT);
const SANS_FAMILY = family(jost.postscriptName);
const BODY_FAMILY = family(glacial.postscriptName);
const TITLE_FAMILY = family(montserrat.postscriptName);
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
const ASSETS: CertificateAssets = { sans: SANS, body: BODY, title: TITLE, script: SCRIPT };

/** The name's band: its ink stays under the course title (which stands on 428) and well over the first competency line (letters up to 284). */
const INK_BAND = { bottom: 303, top: 425 } as const;

/** The names of the page's images (XObjects): pdf-lib leaves an empty dictionary when nothing is drawn. */
const imagesOf = (page: { node: { Resources(): PDFDict | undefined } }): string[] => {
  const xobjects = page.node.Resources()!.lookup(PDFName.of("XObject"));
  return xobjects instanceof PDFDict ? xobjects.keys().map((k) => k.decodeText()) : [];
};

/** A run's width as pdf-lib measured it when it laid the page out: the glyphs' advances (no kerning) plus the spacing between them. */
function widthOf(run: Run): number {
  const font = { [SCRIPT_FAMILY]: revive, [BODY_FAMILY]: glacial, [TITLE_FAMILY]: montserrat }[run.font] ?? jost;
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
  test("one A4 landscape page, black, Jost and Montserrat subsets, Glacial Indifference and the script font whole, no image, under 300 KB", async () => {
    const bytes = await renderCertificate(FIXTURE, ASSETS);
    expect(bytes.length).toBeLessThan(300 * 1024);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    const { doc, pages, page, fontNames, ops } = await readPdf(bytes);
    expect(pages).toHaveLength(1);
    expect(page.getSize()).toEqual({ width: 842, height: 595 });
    expect(fontNames.map(family)).toEqual([SANS_FAMILY, BODY_FAMILY, TITLE_FAMILY, SCRIPT_FAMILY].sort());
    // the whole page is filled black first; the texts and the lines are white
    expect(ops.trimStart().startsWith("q\n0 0 0 rg")).toBe(true);
    expect(ops).toContain("0 0 m\n0 595 l\n842 595 l\n842 0 l\nh\nf");
    expect(ops).toContain("1 1 1 rg");
    expect(ops).toContain("1 1 1 RG");
    // no signature image (the trainer's name is typed in the script font), nothing but the four fonts as resources
    expect(imagesOf(page)).toEqual([]);
    // each font's file is in the PDF (Type0 font → its CID font → the descriptor → FontFile2 for TrueType, FontFile3 for CFF): Jost and
    // Montserrat subsets, much smaller than the fonts; the two CFF fonts whole (pdf-lib's subset of Revive 80 Signature is a file MuPDF
    // rejects, so the viewer would draw a substitute sans), each stream about its font file's size
    const fontDicts = doc.context.enumerateIndirectObjects().flatMap(([, o]) => (o instanceof PDFDict && o.get(PDFName.of("Subtype"))?.toString() === "/Type0" ? [o] : []));
    expect(fontDicts).toHaveLength(4);
    const fileSizes = new Map<string, number>();
    for (const font of fontDicts) {
      const cid = doc.context.lookup(font.lookup(PDFName.of("DescendantFonts"), PDFArray).get(0), PDFDict);
      const descriptor = cid.lookup(PDFName.of("FontDescriptor"), PDFDict);
      const file = descriptor.lookup(PDFName.of("FontFile2")) ?? descriptor.lookup(PDFName.of("FontFile3"));
      fileSizes.set(family(font.lookup(PDFName.of("BaseFont"), PDFName).decodeText()), decodePDFRawStream(rawStream(file)).decode().length);
    }
    expect(fileSizes.get(SANS_FAMILY)!).toBeLessThan(SANS.length / 2);
    expect(fileSizes.get(TITLE_FAMILY)!).toBeLessThan(TITLE.length / 2);
    for (const [name, bytes] of [[SCRIPT_FAMILY, SCRIPT], [BODY_FAMILY, BODY]] as const) {
      expect(fileSizes.get(name)!, name).toBeGreaterThan(bytes.length * 0.95);
      expect(fileSizes.get(name)!, name).toBeLessThan(bytes.length * 1.05);
    }
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
    expect([heading.font, heading.size, heading.y, heading.spacing]).toEqual([BODY_FAMILY, 71, 468.5, 0]);
    near(heading.x + widthOf(heading) / 2, 421);
    // the title in Montserrat, capitals spaced 0.48 em on 428; this one is wider than 680 pt at 23.8 pt, so it is shrunk to fill 680 pt (still over 18 pt)
    const title = one(runs, "KULMUDE KUJUNDAMISE E-KOOLITUS");
    expect([title.font, title.y]).toEqual([TITLE_FAMILY, 428]);
    near(title.spacing, 0.48);
    expect(title.size).toBeLessThan(23.8);
    expect(title.size).toBeGreaterThan(18);
    near(widthOf(title), 680);
    near(title.x + widthOf(title) / 2, 421);
    const name = one(runs, "Kertu Õunapuu");
    expect([name.font, name.size, name.y]).toEqual([SCRIPT_FAMILY, 88, 331]);
    near(name.x + widthOf(name) / 2, 421);
    // the line under the name: 650 pt (96 to 746), centred, 1.2 pt thick
    expect(ops).toMatch(/1\.2 w\n[^]*?96 316 m\n746 316 l\nS/);
    // the practical line at the text block's left edge (97) and the volume ending at its right edge (747), on one baseline, capitals, 10.7 pt, not spaced
    const practical = one(runs, "PRAKTILINE TÖÖ FOTODEL, KOOLITAJA POOLT HINNATUD ISESEISEV PROTSEDUURI TEOSTAMINE");
    expect([practical.font, practical.size, practical.x, practical.y, practical.spacing]).toEqual([BODY_FAMILY, 10.7, 97, 172, 0]);
    const volume = one(runs, "10 AKADEEMILIST TUNDI");
    expect([volume.font, volume.size, volume.y, volume.spacing]).toEqual([BODY_FAMILY, 10.7, 172, 0]);
    near(volume.x + widthOf(volume), 747);
    // bottom left, at 97: our logo in Jost (146 pt wide), then the registry code (10.7 pt, not spaced) and the number (11.2 pt, spaced 0.1 em)
    const logo = one(runs, "MS LAB");
    expect(logo.font).toBe(SANS_FAMILY);
    near(logo.x + widthOf(logo) / 2, 170);
    const small = one(runs, "KOOLITUSKESKUS");
    expect(small.font).toBe(SANS_FAMILY);
    near(small.x + widthOf(small) / 2, 170);
    expect(one(runs, "REGISTRIKOOD: 16346048")).toMatchObject({ font: BODY_FAMILY, x: 97, y: 67, size: 10.7, spacing: 0 });
    const number = one(runs, "Tunnistuse nr. MS LAB 2026-03");
    expect(number).toMatchObject({ font: BODY_FAMILY, x: 97, y: 52, size: 11.2 });
    near(number.spacing, 0.1);
    // bottom right: "KOOLITAJA" and the place with the Tallinn date of the issue, ending at 747 under the trainer's name
    for (const [text, size, y, spacing] of [["KOOLITAJA", 10.7, 67, 0], ["Pärnu linn 15.10.2026", 11.2, 52, 0.1]] as const) {
      const run = one(runs, text);
      expect([run.font, run.size, run.y]).toEqual([BODY_FAMILY, size, y]);
      near(run.spacing, spacing);
      near(run.x + widthOf(run), 747);
    }
  });

  test("Maria's own course title stands at 23.8 pt, about as wide as on her Canva certificate (659 pt)", async () => {
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, courseTitle: "Kulmumeistri baaskoolitus" }, ASSETS));
    const title = one(runs, "KULMUMEISTRI BAASKOOLITUS");
    expect([title.font, title.size, title.y]).toEqual([TITLE_FAMILY, 23.8, 428]);
    expect(Math.abs(widthOf(title) - 659)).toBeLessThan(5);
    near(title.x + widthOf(title) / 2, 421);
  });

  test("a letter Glacial Indifference lacks (š, ž, €) is drawn in Jost, in place, and the line still reads back whole", async () => {
    const skill = "Šampooni ja žele kasutamine, hind 5 €";
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, skills: [skill], volume: "" }, ASSETS));
    const line = runs.filter((r) => r.y === 275.3);
    expect(line.map((r) => r.text).join("")).toBe(skill);
    expect(line.map((r) => [r.text, r.font])).toEqual([
      ["Š", SANS_FAMILY],
      ["ampooni ja ", BODY_FAMILY],
      ["ž", SANS_FAMILY],
      ["ele kasutamine, hind 5 ", BODY_FAMILY],
      ["€", SANS_FAMILY],
    ]);
    // each run starts where the one before ends, with the letter spacing after its last letter (the viewer adds Tc after every glyph)
    for (let i = 1; i < line.length; i++) near(line[i].x, line[i - 1].x + widthOf(line[i - 1]) + line[i - 1].spacing * line[i - 1].size);
    for (const r of line) expect([r.size, r.spacing]).toEqual([11.2, expect.closeTo(0.1, 5)]);
    // every other Estonian letter is the body font's own
    for (const c of "õäöüÕÄÖÜ") expect(glacial.hasGlyphForCodePoint(c.codePointAt(0)!), c).toBe(true);
    for (const c of "šžŠŽ€„") expect(glacial.hasGlyphForCodePoint(c.codePointAt(0)!), c).toBe(false);
  });

  test("the date is the issue's Tallinn date: 22:30 UTC on 31.12 prints 1 January", async () => {
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, issuedAt: new Date("2026-12-31T22:30:00Z") }, ASSETS));
    one(runs, "Pärnu linn 01.01.2027");
  });

  test("no volume: nothing at the right of the practical line", async () => {
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, volume: "" }, ASSETS));
    expect(runs.filter((r) => r.y === 172).map((r) => r.text)).toEqual(["PRAKTILINE TÖÖ FOTODEL, KOOLITAJA POOLT HINNATUD ISESEISEV PROTSEDUURI TEOSTAMINE"]);
  });

  test("a long practical line shrinks, then takes two lines, and never runs into the volume", async () => {
    const practicalLine = "Praktiline töö fotodel, koolitaja poolt hinnatud iseseisev protseduuri teostamine ning kliendi nõustamine ".repeat(2).slice(0, 200).trim();
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, practicalLine }, ASSETS));
    const volume = one(runs, "10 AKADEEMILIST TUNDI");
    const lines = runs.filter((r) => r.x === 97 && r.y <= 172 && r.y > 150);
    expect(lines.map((r) => r.text).join(" ")).toBe(practicalLine.toLocaleUpperCase("et"));
    expect(lines.map((r) => r.y)).toEqual([172, expect.closeTo(172 - lines[0].size * 1.3, 5)]);
    for (const r of lines) {
      expect(r.size).toBeLessThanOrEqual(8);
      expect(r.x + widthOf(r)).toBeLessThanOrEqual(volume.x - 24 + 0.01);
    }
  });

  test("Maria's signature is the trainer's name typed in the script font at the bottom right, above KOOLITAJA, and there is never an image", async () => {
    const { runs, page } = await readPdf(await renderCertificate(FIXTURE, ASSETS));
    expect(imagesOf(page)).toEqual([]);
    const trainer = one(runs, "Maria Sosnina");
    expect([trainer.font, trainer.size, trainer.y]).toEqual([SCRIPT_FAMILY, 40, 105]);
    near(trainer.x + widthOf(trainer), 747);
    // its ink (the M's swash reaches below the baseline) stays clear of "KOOLITAJA" (capitals 7.3 pt high on baseline 67) and of the practical line (172)
    const ink = inkOf(trainer);
    expect(ink.bottom).toBeGreaterThan(67 + 10.7 * 0.68 + 4);
    expect(ink.top).toBeLessThan(172 - 6);
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
    expect([signed.font, signed.size, signed.y]).toEqual([SCRIPT_FAMILY, 40, 105]);
    near(signed.x + widthOf(signed), 747);
    expect(runs.filter((r) => r.text.includes("’"))).toEqual([]); // the font has no ’: it would be an empty box
  });

  test("a long trainer's name shrinks to fit the 170 pt column; the worst letters stay clear of KOOLITAJA", async () => {
    const trainerName = "Anna-Maria Kristiina Elisabeth Õunapuu";
    const long = one((await readPdf(await renderCertificate({ ...FIXTURE, trainerName }, ASSETS))).runs, trainerName);
    expect(long.size).toBeLessThan(40);
    near(widthOf(long), 170);
    near(long.x + widthOf(long), 747);
    const worst = one((await readPdf(await renderCertificate({ ...FIXTURE, trainerName: "Yrjö Ÿvonne" }, ASSETS))).runs, "Yrjö Ÿvonne");
    expect(inkOf(worst).bottom).toBeGreaterThan(67 + 10.7 * 0.68 + 1);
  });

  test("the place and the date are fitted to the signature column; a place of 60 characters stays inside the page", async () => {
    const place = "Pärnu linn, Pärnumaa, Eesti Vabariik, Euroopa Liit, Maailm.".padEnd(60, "x");
    expect(Array.from(place)).toHaveLength(60);
    for (const text of [place, "M".repeat(60)]) {
      const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, place: text }, ASSETS));
      const line = one(runs, `${text} 15.10.2026`);
      expect(line.y).toBe(52);
      expect(line.size).toBeLessThan(11.2);
      expect(line.size).toBeGreaterThan(3);
      near(line.x + widthOf(line), 747);
      expect(line.x).toBeGreaterThanOrEqual(547 - 0.01);
    }
    // down to a floor (5 pt) a place is fitted to the 170 pt column, a short one is not touched
    const medium = one((await readPdf(await renderCertificate({ ...FIXTURE, place: "Tallinn, Harju maakond, Eesti Vabariik, Euroopa" }, ASSETS))).runs, "Tallinn, Harju maakond, Eesti Vabariik, Euroopa 15.10.2026");
    expect(medium.size).toBeLessThan(11.2);
    expect(medium.size).toBeGreaterThanOrEqual(5);
    expect(widthOf(medium)).toBeLessThanOrEqual(170 + 0.01);
  });

  test("a long course title wraps to two lines at 18 pt or smaller, the upper one's capitals clear of the heading's ink", async () => {
    const courseTitle = "Kulmude ja ripsmete kujundamise, värvimise ning laminatsiooni põhjalik e-koolitus algajatele";
    const { runs } = await readPdf(await renderCertificate({ ...FIXTURE, courseTitle }, ASSETS));
    const lines = runs.filter((r) => r.font === TITLE_FAMILY);
    expect(lines.map((r) => r.y)).toEqual([446, 428]);
    const headingInk = 468.5 + (glacial.layout("TUNNISTUS").bbox.minY / 1000) * 71;
    expect(446 + 0.72 * lines[0].size).toBeLessThan(headingInk - 5);
    expect(lines[0].size).toBe(lines[1].size);
    expect(lines[0].size).toBeLessThanOrEqual(18);
    expect(lines.map((r) => r.text).join(" ")).toBe(courseTitle.toLocaleUpperCase("et"));
    near(Math.max(...lines.map(widthOf)), 680);
    for (const line of lines) {
      expect(widthOf(line)).toBeLessThanOrEqual(680 + 0.01);
      near(line.x + widthOf(line) / 2, 421);
    }
  });

  test("the competency lines: two columns of round bullets, the left one filled first, 11.2 pt; 9.75 pt above 12 lines; a long line wraps under its bullet", async () => {
    const six = await readPdf(await renderCertificate(FIXTURE, ASSETS));
    const rows = (runs: Run[]) => runs.filter((r) => r.font === BODY_FAMILY && r.y <= 275.3 && r.y > 190);
    // a bullet is a filled white circle, Glacial Indifference's own "•" (228 units across, its centre 342 units over the baseline): 0.228 em
    // across (2.55 pt at 11.2 pt), its left edge at the column's x
    const bulletAt = (left: number, baseline: number, fontSize: number) => ({ x: left + (0.228 * fontSize) / 2, y: baseline + 0.342 * fontSize, diameter: 0.228 * fontSize, color: "1 1 1" });
    const bullets = (circles: { x: number; y: number; diameter: number; color: string }[]) => circles.map((c) => ({ x: expect.closeTo(c.x, 3), y: expect.closeTo(c.y, 3), diameter: expect.closeTo(c.diameter, 3), color: c.color }));
    expect(six.runs.filter((r) => r.text.includes("•"))).toEqual([]); // no bullet glyph is written
    const bullet = glacial.glyphForCodePoint("•".codePointAt(0)!).bbox;
    expect([bullet.maxX - bullet.minX, (bullet.minY + bullet.maxY) / 2]).toEqual([228, 342]);
    // short lines: the right column starts at the page's centre (421); the text 0.73 em after its column's x; rows 15.008 pt apart from 275.3
    expect(rows(six.runs).map((r) => [r.text, r.x, r.y, r.size])).toEqual([
      ["Kulmude kuju analüüs", 105.176, 275.3, 11.2],
      ["Värvi valik ja segamine", 105.176, 260.292, 11.2],
      ["Kulmude värvimine", 105.176, 245.284, 11.2],
      ["Laminatsioon", 429.176, 275.3, 11.2],
      ["Hügieen ja ohutus", 429.176, 260.292, 11.2],
      ["Kliendi nõustamine", 429.176, 245.284, 11.2],
    ].map(([text, x, y, size]) => [text, expect.closeTo(x as number, 5), expect.closeTo(y as number, 5), size]));
    for (const r of rows(six.runs)) near(r.spacing, 0.1);
    expect(six.circles).toEqual(bullets([[97, 275.3], [97, 260.292], [97, 245.284], [421, 275.3], [421, 260.292], [421, 245.284]].map(([x, y]) => bulletAt(x, y, 11.2))));
    near(six.circles[0].diameter, 2.55);
    // the text starts 0.73 em after the bullet's left edge (97 + 8.18), as "• " sets it in Canva
    near(rows(six.runs)[0].x - (six.circles[0].x + six.circles[0].diameter / 2), 0.73 * 11.2 - 0.228 * 11.2);

    // Maria's own twelve lines: the right column starts 19 pt after the left column's widest line, at 468 as on her Canva certificate
    const marias = [
      "järgib hügieeni- ja ohutusnõudeid", "mõistab kulmude rolli näo harmoonias", "analüüsib näokuju ja kujundab sobiva kulmumudeli", "leiab kulmude anatoomilised punktid",
      "rakendab värviteooriat ja teostab värvimist (värv ja henna)", "kasutab ombre-tehnikat", "viib läbi allergiatesti", "korrigeerib kulme pintsettide ja vahaga",
      "teostab protseduuri algusest lõpuni iseseisvalt", "kasutab töövahendeid ja -materjale õigesti", "annab kliendile koduhoolduse juhised", "rakendab professionaalset klienditeenindust",
    ];
    const paper = await readPdf(await renderCertificate({ ...FIXTURE, skills: marias }, ASSETS));
    const paperRows = rows(paper.runs);
    expect(paperRows.map((r) => r.text)).toEqual(marias); // no line wraps
    expect(new Set(paperRows.map((r) => r.size))).toEqual(new Set([11.2]));
    expect(Math.min(...paperRows.map((r) => r.y))).toBeCloseTo(275.3 - 5 * 15.008, 5); // six rows, the last on 200.3 as in Canva
    const widestLeft = Math.max(...paperRows.slice(0, 6).map(widthOf));
    const rightX = paper.circles[6].x - paper.circles[6].diameter / 2;
    near(rightX, 97 + 0.73 * 11.2 + widestLeft + 19);
    expect(Math.abs(rightX - 468)).toBeLessThan(1);
    for (const r of paperRows) expect(r.x + widthOf(r)).toBeLessThanOrEqual(751 + 0.01); // the longest reaches 749.6, as in Canva
    expect(Math.max(...paperRows.map((r) => r.x + widthOf(r)))).toBeGreaterThan(747);

    const thirteen = await readPdf(await renderCertificate({ ...FIXTURE, skills: Array.from({ length: 13 }, (_, i) => `Oskus ${i + 1}`) }, ASSETS));
    expect(rows(thirteen.runs).map((r) => r.text)).toEqual(Array.from({ length: 13 }, (_, i) => `Oskus ${i + 1}`));
    expect(new Set(rows(thirteen.runs).map((r) => r.size))).toEqual(new Set([9.75]));
    expect(Math.min(...rows(thirteen.runs).map((r) => r.y))).toBeGreaterThanOrEqual(196); // seven rows fit at 9.75 pt
    expect(thirteen.circles).toHaveLength(13);
    for (const c of thirteen.circles) expect(c.diameter).toBeCloseTo(0.228 * 9.75, 2); // the bullets scale with the text
    expect(rows(thirteen.runs).filter((r) => r.x > 400).map((r) => r.text)).toEqual(["Oskus 8", "Oskus 9", "Oskus 10", "Oskus 11", "Oskus 12", "Oskus 13"]);

    const long = "Kulmude kuju analüüs, mõõtmine ja kujundamine vastavalt näo proportsioonidele ning kliendi soovidele ja eelistustele";
    const wrapped = await readPdf(await renderCertificate({ ...FIXTURE, skills: [long, "Värvimine"] }, ASSETS));
    const left = rows(wrapped.runs).filter((r) => r.x < 400);
    expect(left.length).toBeGreaterThan(1);
    expect(left.map((r) => r.text).join(" ")).toBe(long);
    expect(wrapped.circles).toHaveLength(2); // one bullet per line, none on the wrapped rows
    // the right column is pushed as far right as it may go (747 - 230 = 517), and the left rows end 19 pt before it
    near(wrapped.circles[1].x - wrapped.circles[1].diameter / 2, 517);
    for (const r of left) expect(r.x + widthOf(r)).toBeLessThanOrEqual(517 - 19 + 0.01);
  });

  test("16 lines of 120 characters (the limit) get more room and still stay above the practical line, which moves down to 150", async () => {
    const skills = Array.from({ length: 16 }, (_, i) => `${i + 1}. ${"Kulmude kuju analüüs ja värvimine ".repeat(4)}`.slice(0, 120));
    const { runs, circles } = await readPdf(await renderCertificate({ ...FIXTURE, skills }, ASSETS));
    const rows = runs.filter((r) => r.font === BODY_FAMILY && r.y <= 288 && r.y > 150);
    expect(Math.max(...rows.map((r) => r.y))).toBe(288);
    expect(Math.min(...rows.map((r) => r.y))).toBeGreaterThanOrEqual(174);
    expect(Math.min(...rows.map((r) => r.size))).toBeGreaterThanOrEqual(5);
    // the first row's letters (0.75 em over its baseline at most) stay under the name's ink floor
    expect(288 + 0.75 * rows[0].size).toBeLessThan(INK_BAND.bottom);
    expect(one(runs, "PRAKTILINE TÖÖ FOTODEL, KOOLITAJA POOLT HINNATUD ISESEISEV PROTSEDUURI TEOSTAMINE").y).toBe(150);
    expect(one(runs, "10 AKADEEMILIST TUNDI").y).toBe(150);
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
  test("the four fonts from app/assets/fonts, read once per process", async () => {
    const a = await loadCertificateAssets();
    expect(Object.keys(a).sort()).toEqual(["body", "sans", "script", "title"]);
    expect(Buffer.from(a.sans).equals(Buffer.from(SANS))).toBe(true);
    expect(Buffer.from(a.body).equals(Buffer.from(BODY))).toBe(true);
    expect(Buffer.from(a.title).equals(Buffer.from(TITLE))).toBe(true);
    expect(Buffer.from(a.script).equals(Buffer.from(SCRIPT))).toBe(true);
    const b = await loadCertificateAssets();
    expect([b.sans, b.body, b.title, b.script]).toEqual([a.sans, a.body, a.title, a.script]);
    expect(b.sans).toBe(a.sans); // the same bytes, not read again
  });
});
