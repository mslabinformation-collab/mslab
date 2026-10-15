import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit, { type Font } from "@pdf-lib/fontkit";
import { PDFDocument, rgb, setCharacterSpacing, type PDFFont, type PDFPage } from "pdf-lib";
import type { Certificate } from "@/db/schema";
import { tallinnDateText } from "@/domain/certificate";

// The e-course certificate as a PDF (phase 3d, spec §7): drawn on every download from the certificate's frozen row, the trainer's name and
// the two committed fonts, with pdf-lib and its fontkit. A4 landscape, white on black, laid out as Maria's paper certificate: "TUNNISTUS",
// the course title in spaced capitals, the student's name in the script font over a thin line, the competency lines in two columns, the
// practical line and the volume on one baseline, then the logo, the registry code and the number at the bottom left and Maria's signature
// (her name typed in the script font, as on her Canva certificates: there is no signature image), "KOOLITAJA" and the place and date at the
// bottom right. Every position below is in PDF points from the bottom left corner.
// Jost is embedded as a subset (only the letters drawn); the script font, Revive 80 Signature, whole, 308 KB (see renderCertificate). The page
// is about 160 KB; tests/unit/certificate-pdf.test.ts holds it under 300 KB.

/**
 * app/assets/fonts, next to package.json (`next dev`, `next start` and the tests run in app/; on Vercel the function's working directory is
 * the project's). `next build`'s file tracing follows this join (LOCAL_MEDIA_DIR opts out of it, this does not), and next.config.ts names
 * the folder for the two functions that render besides.
 */
export const CERT_FONT_DIR = path.join(process.cwd(), "assets", "fonts");

/**
 * The fonts' files in CERT_FONT_DIR, named once: Jost (the sans: the variable font, drawn at its default weight 400) and Revive 80 Signature
 * (the script: the student's name and Maria's signature; © Tom Chalky / Inspiration Hut, licensed to MS LAB for its certificates).
 */
export const CERT_FONTS = { sans: "Jost[wght].ttf", script: "Revive80Signature.otf" } as const;

/** The two fonts' bytes. */
export type CertificateAssets = { sans: Uint8Array; script: Uint8Array };

/** What the PDF prints: the certificate's frozen copy, and the trainer's name from Seaded (Maria's signature, typed in the script font). */
export type CertificateContent = Pick<Certificate, "number" | "name" | "courseTitle" | "skills" | "volume" | "practicalLine" | "place" | "registryCode" | "issuedAt"> & {
  trainerName: string;
};

/** The fonts' bytes, read once per process; a failed read is tried again on the next download. */
let fontFiles: Promise<{ sans: Uint8Array; script: Uint8Array }> | null = null;

function readFonts(): Promise<{ sans: Uint8Array; script: Uint8Array }> {
  fontFiles ??= Promise.all([readFile(path.join(CERT_FONT_DIR, CERT_FONTS.sans)), readFile(path.join(CERT_FONT_DIR, CERT_FONTS.script))]).then(
    ([sans, script]) => ({ sans: new Uint8Array(sans), script: new Uint8Array(script) }),
    (e: unknown) => {
      fontFiles = null;
      throw e;
    },
  );
  return fontFiles;
}

/** The two fonts from disk (once per process). A read that fails throws: the download then fails and is tried again. */
export async function loadCertificateAssets(): Promise<CertificateAssets> {
  return readFonts();
}

// ---------- the layout (842 × 595 pt) ----------

const PAGE = { width: 842, height: 595 } as const;
const CENTRE = PAGE.width / 2;
const WHITE = rgb(1, 1, 1);
const BLACK = rgb(0, 0, 0);

/** "TUNNISTUS": the sans at 54 pt, slightly spaced, centred; its capitals reach about 80 pt below the top. */
const HEADING = { size: 54, spacing: 0.08, baseline: 478 } as const;
/** The course title: capitals spaced 0.35 em, 18 pt on one line, else two lines at 14 pt (or smaller, so the wider line fits). */
const TITLE = { size: 18, twoLineSize: 14, spacing: 0.35, width: 662, baseline: 440, twoLineBaselines: [448, 428] } as const;
/**
 * The name, in Revive 80 Signature: tall capitals with long swashes and a tiny lowercase (x-height 0.18 em, cap height 0.71 em, the ink of a
 * capital reaching from 0.3 em below the baseline, 0.54 em for a Y, to 0.84 em above it), so it is drawn large, as on Maria's paper certificate:
 * 88 pt on baseline 331, which puts a K's swash across the thin line (316) as there. Shrunk to fit `width` (a little under the line's 589, the
 * swashes reach past the letters' advances) down to 44 pt (lowercase 8 pt high); below that two lines (leading 1.1 em) at 44 pt or smaller.
 * The ink stays between `inkFloor` (6 pt above the first competency line, whose letters reach 297) and 425 (under the course title, whose
 * second line, when it wraps, stands on 428): a name whose capitals dip deeper than the baseline allows (Y, G, J, H) is lifted until its lowest
 * point is on `inkFloor`. At 88 pt even the tallest-and-deepest name (Å and Y: 1.38 em of ink, 121 pt) fits under 425 then.
 */
const NAME = { size: 88, shrinkTo: 44, width: 540, baseline: 331, leading: 1.1, inkFloor: 303 } as const;
const RULE = { y: 316, halfWidth: PAGE.width * 0.35, thickness: 0.75 } as const;
/** The competency lines: two columns of "• line", the left one filled first; 9.5 pt, 8.5 pt above 12 lines, smaller still if they would reach the practical line. */
const SKILLS = { size: 9.5, manySize: 8.5, many: 12, minSize: 5, spacing: 0.05, leading: 1.6, top: 290, bottom: 172, left: 96, width: 650, gap: 26 } as const;
/** The practical line at the left and the volume at the right, capitals, 8 pt on one baseline; a long practical line shrinks to 6.5 pt, then takes two lines. */
const FOOT = { size: 8, shrinkTo: 6.5, spacing: 0.12, baseline: 148, left: 56, right: 786, gap: 24, leading: 1.35 } as const;
/** The MS LAB logo as vector shapes (public/brand/logo.png is dark on transparent): a thin frame, "MS LAB" in it, "KOOLITUSKESKUS" on its lower edge. */
const LOGO = { x: 56, y: 80, width: 150, height: 50, thickness: 0.8, nameSize: 30, nameSpacing: 0.12, smallSize: 5.2, smallSpacing: 0.4, smallPad: 4 } as const;
/** Under the logo: "REGISTRIKOOD: …" and "Tunnistuse nr. …". */
const LEFT_LINES = { x: 56, size: 7.5, spacing: 0.1, baselines: [58, 46] } as const;
/**
 * The bottom right block, centred on one axis: Maria's signature (the trainer's name in the script font, 40 pt as on her certificate, or smaller
 * to fit `width`; its M's swash dips 12 pt below the baseline, a Y's 22 pt, so the ink stays above "KOOLITAJA"), "KOOLITAJA", the place and
 * the date. The place line is fitted to `width` too, down to a 5 pt floor, and never wider than `placeMaxWidth` (a place of 60 characters stays
 * inside the page: 706 + 100 is 806).
 */
const SIGN = { centre: 706, width: 170, nameSize: 40, nameBaseline: 96, size: 8, labelSpacing: 0.3, spacing: 0.06, baselines: [58, 46], placeFloor: 5, placeMaxWidth: 200 } as const;

/** A piece of text in one font, size and letter spacing (em). */
type Style = { font: PDFFont; size: number; spacing: number };

/** Every run of white space one space, trimmed: pdf-lib would break a line at a line break, and the layout measures single lines. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
/** A name or the trainer's name as the script font draws it: on one line, the typographic apostrophe ’ (which the font lacks) as the straight one. */
const scriptText = (s: string): string => oneLine(s).replace(/’/g, "'");
/** Estonian capitals ("ü" → "Ü"). */
const upper = (s: string): string => oneLine(s).toLocaleUpperCase("et");

/** How far the ink of `text` in the script font reaches below the baseline and above it, in em: from the glyph outlines, not from the advances. */
function scriptInk(font: Font, text: string): { below: number; above: number } {
  const box = font.layout(text).bbox;
  return { below: Math.max(0, -box.minY) / font.unitsPerEm, above: Math.max(0, box.maxY) / font.unitsPerEm };
}

/** The width of `text` at 1 pt: the glyphs' advances plus the spacing between them (none after the last). Widths scale with the size. */
function unitWidth(text: string, font: PDFFont, spacing: number): number {
  return font.widthOfTextAtSize(text, 1) + spacing * Math.max(0, Array.from(text).length - 1);
}

const widthOf = (text: string, s: Style): number => unitWidth(text, s.font, s.spacing) * s.size;

/** Draws `text` with its left end at x; the letter spacing is the PDF's character spacing (Tc), set around this text only. */
function drawAt(page: PDFPage, text: string, s: Style, x: number, y: number): void {
  if (!text) return;
  const tc = s.spacing * s.size;
  if (tc) page.pushOperators(setCharacterSpacing(tc));
  page.drawText(text, { x, y, size: s.size, font: s.font, color: WHITE });
  if (tc) page.pushOperators(setCharacterSpacing(0));
}

const drawCentred = (page: PDFPage, text: string, s: Style, centre: number, y: number) => drawAt(page, text, s, centre - widthOf(text, s) / 2, y);
const drawRight = (page: PDFPage, text: string, s: Style, right: number, y: number) => drawAt(page, text, s, right - widthOf(text, s), y);

/** `text` broken at its spaces into lines that `fits` (a word too wide for any line stands on a line of its own). */
function wrap(text: string, fits: (line: string) => boolean): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && !fits(next)) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The break of `text` into two lines whose wider one is the narrowest: at a space (which goes) or after a hyphen (which stays, so a double
 * surname breaks as "Õunapuu-" / "Šmidt"). null: there is nowhere to break.
 */
function splitInTwo(text: string, unit: (line: string) => number): [string, string] | null {
  let best: [string, string] | null = null;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (let i = 1; i < text.length; i++) {
    const pair: [string, string] | null = text[i] === " " ? [text.slice(0, i), text.slice(i + 1)] : text[i - 1] === "-" ? [text.slice(0, i), text.slice(i)] : null;
    if (!pair || !pair[0].trim() || !pair[1].trim()) continue;
    const wider = Math.max(unit(pair[0]), unit(pair[1]));
    if (wider < bestWidth) [best, bestWidth] = [pair, wider];
  }
  return best;
}

/**
 * A text that must fit `width`: one line at `size`, or smaller down to `shrinkTo`; else two lines (splitInTwo) at `twoLineSize`, or
 * smaller so that the wider line fits. A text with nowhere to break stays on one line, as small as it must be.
 */
function fitBlock(text: string, unit: (line: string) => number, o: { width: number; size: number; shrinkTo: number; twoLineSize: number }): { size: number; lines: string[] } {
  const oneLineSize = o.width / unit(text);
  if (oneLineSize >= o.shrinkTo) return { size: Math.min(o.size, oneLineSize), lines: [text] };
  const pair = splitInTwo(text, unit);
  if (!pair) return { size: oneLineSize, lines: [text] };
  return { size: Math.min(o.twoLineSize, o.width / Math.max(unit(pair[0]), unit(pair[1]))), lines: pair };
}

/** The competency lines laid out: the size, the gap between baselines, the bullet's indent and each column's rows (a wrapped line's first row carries the bullet). */
function layoutSkills(skills: readonly string[], font: PDFFont): { size: number; leading: number; indent: number; columns: { text: string; bullet: boolean }[][] } {
  const lines = skills.map(oneLine).filter(Boolean);
  const half = Math.ceil(lines.length / 2);
  const columnWidth = (SKILLS.width - SKILLS.gap) / 2;
  for (let size: number = lines.length > SKILLS.many ? SKILLS.manySize : SKILLS.size; ; size -= 0.25) {
    const indent = size * 1.2;
    const style = { font, size, spacing: SKILLS.spacing };
    const columns = [lines.slice(0, half), lines.slice(half)].map((column) =>
      column.flatMap((line) => wrap(line, (row) => widthOf(row, style) <= columnWidth - indent).map((text, i) => ({ text, bullet: i === 0 }))),
    );
    const rows = Math.max(columns[0].length, columns[1].length);
    const leading = size * SKILLS.leading;
    if (SKILLS.top - (rows - 1) * leading >= SKILLS.bottom || size <= SKILLS.minSize) return { size, leading, indent, columns };
  }
}

/** The logo, drawn in white: the frame (its lower edge open under the small word), "MS LAB" centred in it, "KOOLITUSKESKUS" on the edge. */
function drawLogo(page: PDFPage, sans: PDFFont): void {
  const { x, y, width, height, thickness } = LOGO;
  const centre = x + width / 2;
  const line = (x1: number, y1: number, x2: number, y2: number) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: WHITE });
  const small: Style = { font: sans, size: LOGO.smallSize, spacing: LOGO.smallSpacing };
  const half = widthOf("KOOLITUSKESKUS", small) / 2 + LOGO.smallPad;
  line(x, y + height, x + width, y + height);
  line(x, y, x, y + height);
  line(x + width, y, x + width, y + height);
  line(x, y, centre - half, y);
  line(centre + half, y, x + width, y);
  const name: Style = { font: sans, size: LOGO.nameSize, spacing: LOGO.nameSpacing };
  // Jost's capitals are 0.7 em high (700 of its 1000 units): "MS LAB" sits in the middle of the frame, the small word on its edge
  drawCentred(page, "MS LAB", name, centre, y + (height - LOGO.nameSize * 0.7) / 2);
  drawCentred(page, "KOOLITUSKESKUS", small, centre, y - (LOGO.smallSize * 0.7) / 2);
}

/** A4 landscape (842 × 595), black, laid out as spec §7 (the constants above). */
export async function renderCertificate(c: CertificateContent, assets: CertificateAssets): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // neutral metadata; the dates are the issue's, so the same row gives the same file
  doc.setTitle(`Tunnistus ${c.number}`);
  doc.setAuthor("MS LAB");
  doc.setCreator("MS LAB");
  doc.setProducer("MS LAB");
  doc.setCreationDate(c.issuedAt);
  doc.setModificationDate(c.issuedAt);
  const sans = await doc.embedFont(assets.sans, { subset: true });
  // The script font whole, not as a subset: pdf-lib 1.17.1 with @pdf-lib/fontkit 1.1.1 cuts this CFF font down to a file that MuPDF rejects
  // ("unknown file format"), and the viewer then draws a substitute sans in the name's place; the whole font renders right. It costs about
  // 150 KB of the page (compressed), well inside the 300 KB the test holds.
  const script = await doc.embedFont(assets.script, { subset: false });
  const scriptOutlines = fontkit.create(assets.script);
  const page = doc.addPage([PAGE.width, PAGE.height]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: BLACK });

  drawCentred(page, "TUNNISTUS", { font: sans, size: HEADING.size, spacing: HEADING.spacing }, CENTRE, HEADING.baseline);

  const title = upper(c.courseTitle);
  const titleFit = fitBlock(title, (s) => unitWidth(s, sans, TITLE.spacing), { width: TITLE.width, size: TITLE.size, shrinkTo: TITLE.size, twoLineSize: TITLE.twoLineSize });
  const titleBaselines = titleFit.lines.length === 1 ? [TITLE.baseline] : TITLE.twoLineBaselines;
  titleFit.lines.forEach((line, i) => drawCentred(page, line, { font: sans, size: titleFit.size, spacing: TITLE.spacing }, CENTRE, titleBaselines[i]));

  const nameFit = fitBlock(scriptText(c.name), (s) => unitWidth(s, script, 0), { width: NAME.width, size: NAME.size, shrinkTo: NAME.shrinkTo, twoLineSize: NAME.shrinkTo });
  const nameStyle: Style = { font: script, size: nameFit.size, spacing: 0 };
  // the (lower) line stands on the baseline, or higher when its swashes would dip below the ink floor; a second line stands over it
  const lowest = nameFit.lines[nameFit.lines.length - 1];
  const baseline = Math.max(NAME.baseline, NAME.inkFloor + scriptInk(scriptOutlines, lowest).below * nameFit.size);
  if (nameFit.lines.length === 1) drawCentred(page, lowest, nameStyle, CENTRE, baseline);
  else {
    drawCentred(page, nameFit.lines[0], nameStyle, CENTRE, baseline + nameFit.size * NAME.leading);
    drawCentred(page, lowest, nameStyle, CENTRE, baseline);
  }
  page.drawLine({ start: { x: CENTRE - RULE.halfWidth, y: RULE.y }, end: { x: CENTRE + RULE.halfWidth, y: RULE.y }, thickness: RULE.thickness, color: WHITE });

  const skills = layoutSkills(c.skills, sans);
  const skillStyle: Style = { font: sans, size: skills.size, spacing: SKILLS.spacing };
  skills.columns.forEach((rows, column) => {
    const x = SKILLS.left + column * ((SKILLS.width + SKILLS.gap) / 2);
    rows.forEach((row, i) => {
      const y = SKILLS.top - i * skills.leading;
      if (row.bullet) drawAt(page, "•", skillStyle, x, y);
      drawAt(page, row.text, skillStyle, x + skills.indent, y);
    });
  });

  const footStyle = (size: number): Style => ({ font: sans, size, spacing: FOOT.spacing });
  const volume = upper(c.volume);
  const volumeWidth = volume ? widthOf(volume, footStyle(FOOT.size)) + FOOT.gap : 0;
  const practical = fitBlock(upper(c.practicalLine), (s) => unitWidth(s, sans, FOOT.spacing), {
    width: FOOT.right - FOOT.left - volumeWidth,
    size: FOOT.size,
    shrinkTo: FOOT.shrinkTo,
    twoLineSize: FOOT.shrinkTo,
  });
  practical.lines.forEach((line, i) => drawAt(page, line, footStyle(practical.size), FOOT.left, FOOT.baseline - i * practical.size * FOOT.leading));
  if (volume) drawRight(page, volume, footStyle(FOOT.size), FOOT.right, FOOT.baseline);

  drawLogo(page, sans);
  const left: Style = { font: sans, size: LEFT_LINES.size, spacing: LEFT_LINES.spacing };
  drawAt(page, `REGISTRIKOOD: ${oneLine(c.registryCode)}`, left, LEFT_LINES.x, LEFT_LINES.baselines[0]);
  drawAt(page, `Tunnistuse nr. ${c.number}`, left, LEFT_LINES.x, LEFT_LINES.baselines[1]);

  // Maria's signature: the trainer's name in the script font, fitted to the column
  const trainer = scriptText(c.trainerName);
  const trainerSize = Math.min(SIGN.nameSize, SIGN.width / unitWidth(trainer, script, 0));
  drawCentred(page, trainer, { font: script, size: trainerSize, spacing: 0 }, SIGN.centre, SIGN.nameBaseline);
  drawCentred(page, "KOOLITAJA", { font: sans, size: SIGN.size, spacing: SIGN.labelSpacing }, SIGN.centre, SIGN.baselines[0]);
  const placeAndDate = `${oneLine(c.place)} ${tallinnDateText(c.issuedAt)}`;
  const placeUnit = unitWidth(placeAndDate, sans, SIGN.spacing);
  const placeSize = Math.min(SIGN.size, Math.max(SIGN.placeFloor, SIGN.width / placeUnit), SIGN.placeMaxWidth / placeUnit);
  drawCentred(page, placeAndDate, { font: sans, size: placeSize, spacing: SIGN.spacing }, SIGN.centre, SIGN.baselines[1]);

  return doc.save();
}
