import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit, { type Font } from "@pdf-lib/fontkit";
import { PDFDocument, rgb, setCharacterSpacing, type PDFFont, type PDFPage } from "pdf-lib";
import type { Certificate } from "@/db/schema";
import { tallinnDateText } from "@/domain/certificate";
import { drawLogo } from "./pdf-logo";

// The e-course certificate as a PDF (phase 3d, spec §7): drawn on every download from the certificate's frozen row, the trainer's name and
// the committed fonts, with pdf-lib and its fontkit. A4 landscape, white on black, laid out as Maria's paper certificate: "TUNNISTUS",
// the course title in spaced capitals, the student's name in the script font over a thin line, the competency lines in two columns, the
// practical line and the volume on one baseline, then the logo, the registry code and the number at the bottom left and Maria's signature
// (her name typed in the script font, as on her Canva certificates: there is no signature image), "KOOLITAJA" and the place and date at the
// bottom right. Every position below is in PDF points from the bottom left corner.
// The fonts are her Canva certificate's (Dim 07.11): Glacial Indifference for the heading and every line of text, Montserrat for the course
// title, Revive 80 Signature for the names; the logo is ours, in Jost (server/pdf-logo.ts). A letter Glacial Indifference lacks (š, ž, €, „,
// the other languages' letters) is drawn in Jost, letter by letter (Face). Jost and Montserrat are embedded as subsets (only the letters
// drawn); Glacial Indifference and Revive 80 Signature, both CFF fonts, whole (see renderCertificate). The page is about 200 KB;
// tests/unit/certificate-pdf.test.ts holds it under 300 KB.

/**
 * app/assets/fonts, next to package.json (`next dev`, `next start` and the tests run in app/; on Vercel the function's working directory is
 * the project's). `next build`'s file tracing follows this join (LOCAL_MEDIA_DIR opts out of it, this does not), and next.config.ts names
 * the folder for the two functions that render besides.
 */
export const CERT_FONT_DIR = path.join(process.cwd(), "assets", "fonts");

/**
 * The fonts' files in CERT_FONT_DIR, named once: Jost (the sans: the logo, the invoice and the contract, and the letters the body font lacks;
 * the variable font, drawn at its default weight 400), Glacial Indifference (the body: the heading and the lines of text), Montserrat (the
 * course title; the static Regular, 400) and Revive 80 Signature (the script: the student's name and Maria's signature; © Tom Chalky /
 * Inspiration Hut, licensed to MS LAB for its certificates). Jost, Glacial Indifference and Montserrat are under the SIL Open Font License.
 */
export const CERT_FONTS = { sans: "Jost[wght].ttf", body: "GlacialIndifference-Regular.otf", title: "Montserrat-Regular.ttf", script: "Revive80Signature.otf" } as const;

/** The fonts' bytes. */
export type CertificateAssets = { sans: Uint8Array; body: Uint8Array; title: Uint8Array; script: Uint8Array };

/** What the PDF prints: the certificate's frozen copy, and the trainer's name from Seaded (Maria's signature, typed in the script font). */
export type CertificateContent = Pick<Certificate, "number" | "name" | "courseTitle" | "skills" | "volume" | "practicalLine" | "place" | "registryCode" | "issuedAt"> & {
  trainerName: string;
};

/** The fonts' bytes, read once per process; a failed read is tried again on the next download. */
let fontFiles: Promise<CertificateAssets> | null = null;

function readFonts(): Promise<CertificateAssets> {
  const keys = ["sans", "body", "title", "script"] as const;
  fontFiles ??= Promise.all(keys.map((k) => readFile(path.join(CERT_FONT_DIR, CERT_FONTS[k])))).then(
    ([sans, body, title, script]) => ({ sans: new Uint8Array(sans), body: new Uint8Array(body), title: new Uint8Array(title), script: new Uint8Array(script) }),
    (e: unknown) => {
      fontFiles = null;
      throw e;
    },
  );
  return fontFiles;
}

/** The fonts from disk (once per process). A read that fails throws: the download then fails and is tried again. */
export async function loadCertificateAssets(): Promise<CertificateAssets> {
  return readFonts();
}

// ---------- the layout (842 × 595 pt) ----------
// Dim 07.11: the sizes, letter spacings and places are those of Maria's Canva certificate (read off the design itself: every text box's font,
// size, spacing and edges, its baseline from the font's ascent and descent), from which her paper certificate was printed. Three places stay
// ours: the course title stands higher (428, not 416: the tallest names need the room under it), and the name, its line, the logo and the
// trainer's name are as they were.

const PAGE = { width: 842, height: 595 } as const;
const CENTRE = PAGE.width / 2;
const WHITE = rgb(1, 1, 1);
const BLACK = rgb(0, 0, 0);
/** The text block's edges, as on the Canva certificate: the competency lines, the foot and the bottom lines start at `left` and end at `right`. */
const BOX = { left: 97, right: 747 } as const;

/** "TUNNISTUS": the body font at 71 pt, not spaced, centred on baseline 468.5; its capitals reach about 78 pt below the top. */
const HEADING = { size: 71, spacing: 0, baseline: 468.5 } as const;
/**
 * The course title, in Montserrat: capitals spaced 0.48 em, 23.8 pt on one line (Maria's "KULMUMEISTRI BAASKOOLITUS" then spans 660 pt, as
 * on her certificate), shrunk to fit `width` down to 18 pt; else two lines at 18 pt (or smaller, so the wider line fits). One line stands on
 * 428, two on 446 and 428 (the upper one's capitals still 6 pt under the heading's lowest ink).
 */
const TITLE = { size: 23.8, shrinkTo: 18, twoLineSize: 18, spacing: 0.48, width: 680, baseline: 428, twoLineBaselines: [446, 428] } as const;
/**
 * The name, in Revive 80 Signature: tall capitals with long swashes and a tiny lowercase (x-height 0.18 em, cap height 0.71 em, the ink of a
 * capital reaching from 0.3 em below the baseline, 0.54 em for a Y, to 0.84 em above it), so it is drawn large, as on Maria's paper certificate:
 * 88 pt on baseline 331, which puts a K's swash across the line (316) as there. Shrunk to fit `width` (a little under the line's 650, the
 * swashes reach past the letters' advances) down to 44 pt (lowercase 8 pt high); below that two lines (leading 1.1 em) at 44 pt or smaller.
 * The ink stays between `inkFloor` (well above the first competency line, whose letters reach 284) and 425 (under the course title, which
 * stands on 428): a name whose capitals dip deeper than the baseline allows (Y, G, J, H) is lifted until its lowest point is on `inkFloor`. At
 * 88 pt even the tallest-and-deepest name (Å and Y: 1.38 em of ink, 121 pt) fits under 425 then.
 */
const NAME = { size: 88, shrinkTo: 44, width: 540, baseline: 331, leading: 1.1, inkFloor: 303 } as const;
/** The line under the name: 650 pt long, centred (96 to 746, a little past the text block, as on the paper), 1.2 pt thick. */
const RULE = { y: 316, halfWidth: 325, thickness: 1.2 } as const;
/**
 * The competency lines: two columns of lines, each after a drawn bullet (BULLET), the left one filled first; 11.2 pt spaced 0.1 em, 15 pt
 * apart (leading 1.34), the first on 275.3; 9.75 pt above 12 lines (seven rows then still fit), smaller still if they would come below
 * `bottom`. The left column starts at BOX.left; the right one `gap` after the left column's widest line (Maria's own lines then start it at
 * 468, as on her certificate: 19 pt after the end of "(värv ja henna)"), but never left of the page's centre, and never so far right that it
 * is narrower than `rightWidth` (a longer left line then wraps). The text starts `indent` em after its column's x (after "• ", as in Canva).
 * A right column's line may reach `right`, a little past BOX.right, as Maria's longest one does in Canva ("teostab protseduuri algusest
 * lõpuni iseseisvalt" ends at 749.6): her lines then stay at 11.2 pt, none wrapped.
 * Lines that do not fit between `top` and `bottom` even at `minSize` (the limit is 16 lines of 120 characters) get more room: they start on
 * `roomyTop` (their letters still under the name's ink floor) and may come down to `roomyBottom`, the practical line then standing on
 * FOOT.roomyBaseline.
 */
const SKILLS = { size: 11.2, manySize: 9.75, many: 12, minSize: 5, spacing: 0.1, leading: 1.34, top: 275.3, bottom: 196, roomyTop: 288, roomyBottom: 174, indent: 0.73, gap: 19, rightWidth: 230, right: 751 } as const;
/**
 * A competency bullet is a filled white circle, Glacial Indifference's own "•" drawn as a circle (the same in every viewer, and when the line
 * itself falls back to Jost, whose "•" is a 1 pt dot set high): `diameter` em across (2.6 pt at 11.2 pt), its left edge at the column's x and
 * its centre `centre` em over the baseline, in the upper half of the lowercase letters (0.44 em high).
 */
const BULLET = { diameter: 0.228, centre: 0.342 } as const;
/**
 * The practical line at BOX.left and the volume ending at BOX.right, capitals, 10.7 pt, not spaced, on one baseline (172, under the
 * competency lines; 150 when they need more room, see SKILLS); a long practical line shrinks to 8 pt, then takes two lines.
 */
const FOOT = { size: 10.7, shrinkTo: 8, spacing: 0, baseline: 172, roomyBaseline: 150, gap: 24, leading: 1.3 } as const;
/** Where the MS LAB logo stands (server/pdf-logo.ts draws it, here in white): the box of 146 × 52 pt, at BOX.left. */
const LOGO = { x: BOX.left, y: 84, width: 146, height: 52 } as const;
/**
 * Under the logo, at BOX.left, as on the Canva certificate: "REGISTRIKOOD: …" (10.7 pt, not spaced) on 67 and "Tunnistuse nr. …" (11.2 pt,
 * spaced 0.1 em) on 52.
 */
const LEFT_LINES = { registrySize: 10.7, registrySpacing: 0, numberSize: 11.2, numberSpacing: 0.1, baselines: [67, 52] } as const;
/**
 * The bottom right block, every line ending at BOX.right: Maria's signature (the trainer's name in the script font, 40 pt, or smaller to fit
 * `width`; its M's swash dips 12 pt below the baseline, a Y's 22 pt, so the ink stays above "KOOLITAJA"), "KOOLITAJA" (10.7 pt, not spaced,
 * on 67), the place and the date (11.2 pt, spaced 0.1 em, on 52). The place line is fitted to `width` too, down to a 5 pt floor, and never
 * wider than `placeMaxWidth` (it then starts at 547 or right of it).
 */
const SIGN = { width: 170, nameSize: 40, nameBaseline: 105, labelSize: 10.7, labelSpacing: 0, placeSize: 11.2, spacing: 0.1, baselines: [67, 52], placeFloor: 5, placeMaxWidth: 200 } as const;

/**
 * A font as the page draws it: `font`, and for a letter it lacks (`has` is false) `fallback` (Jost), letter by letter. The script font and Jost
 * themselves have no fallback (the names' letters are checked against the script font, checkCertificateName).
 */
type Face = { font: PDFFont; has: (codePoint: number) => boolean; fallback: PDFFont };
/** A piece of text in one face, size and letter spacing (em). */
type Style = { face: Face; size: number; spacing: number };

/** A face with no fallback. */
const only = (font: PDFFont): Face => ({ font, has: () => true, fallback: font });

/** `text` cut into runs of one font: the face's own where it has the letter, else its fallback. */
function runsOf(text: string, face: Face): { text: string; font: PDFFont }[] {
  const runs: { text: string; font: PDFFont }[] = [];
  for (const ch of Array.from(text)) {
    const font = face.has(ch.codePointAt(0)!) ? face.font : face.fallback;
    const last = runs[runs.length - 1];
    if (last && last.font === font) last.text += ch;
    else runs.push({ text: ch, font });
  }
  return runs;
}

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

/**
 * The width of `text` at 1 pt: the glyphs' advances (each in the font that draws it) plus the spacing between them (none after the last).
 * Widths scale with the size.
 */
function unitWidth(text: string, face: Face, spacing: number): number {
  const advances = runsOf(text, face).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, 1), 0);
  return advances + spacing * Math.max(0, Array.from(text).length - 1);
}

const widthOf = (text: string, s: Style): number => unitWidth(text, s.face, s.spacing) * s.size;

/**
 * Draws `text` with its left end at x, a run per font (runsOf); the letter spacing is the PDF's character spacing (Tc), set around this text
 * only, which a viewer adds after every letter: the next run starts after the last letter's spacing too.
 */
function drawAt(page: PDFPage, text: string, s: Style, x: number, y: number): void {
  if (!text) return;
  const tc = s.spacing * s.size;
  if (tc) page.pushOperators(setCharacterSpacing(tc));
  let at = x;
  for (const run of runsOf(text, s.face)) {
    page.drawText(run.text, { x: at, y, size: s.size, font: run.font, color: WHITE });
    at += run.font.widthOfTextAtSize(run.text, s.size) + tc * Array.from(run.text).length;
  }
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

/** The competency lines laid out (layoutSkills). */
type SkillsLayout = { size: number; leading: number; indent: number; top: number; footBaseline: number; xs: [number, number]; columns: { text: string; bullet: boolean }[][] };

/**
 * The competency lines laid out: the size, the gap between baselines, the bullet's indent, the first baseline, where the practical line then
 * stands, each column's x and each column's rows (a wrapped line's first row carries the bullet). The largest size that fits the usual room,
 * else the largest that fits the roomy one (SKILLS), else `minSize` there.
 */
function layoutSkills(skills: readonly string[], face: Face): SkillsLayout {
  const lines = skills.map(oneLine).filter(Boolean);
  const half = Math.ceil(lines.length / 2);
  const halves = [lines.slice(0, half), lines.slice(half)];
  const rooms = [
    { top: SKILLS.top, bottom: SKILLS.bottom, footBaseline: FOOT.baseline },
    { top: SKILLS.roomyTop, bottom: SKILLS.roomyBottom, footBaseline: FOOT.roomyBaseline },
  ];
  let last: SkillsLayout | null = null;
  for (const room of rooms) {
    for (let size: number = lines.length > SKILLS.many ? SKILLS.manySize : SKILLS.size; size >= SKILLS.minSize; size -= 0.25) {
      const indent = size * SKILLS.indent;
      const style = { face, size, spacing: SKILLS.spacing };
      const widestLeft = Math.max(0, ...halves[0].map((line) => widthOf(line, style)));
      const rightX = Math.min(BOX.right - SKILLS.rightWidth, Math.max(CENTRE, BOX.left + indent + widestLeft + SKILLS.gap));
      const widths = [rightX - SKILLS.gap - BOX.left, SKILLS.right - rightX];
      // the widest left line is exactly its column's width (rightX was computed from it): a millionth of a point keeps the sum's rounding from
      // wrapping it
      const columns = halves.map((column, c) =>
        column.flatMap((line) => wrap(line, (row) => widthOf(row, style) <= widths[c] - indent + 1e-6).map((text, i) => ({ text, bullet: i === 0 }))),
      );
      const rows = Math.max(columns[0].length, columns[1].length);
      const leading = size * SKILLS.leading;
      last = { size, leading, indent, top: room.top, footBaseline: room.footBaseline, xs: [BOX.left, rightX], columns };
      if (room.top - (rows - 1) * leading >= room.bottom) return last;
    }
  }
  return last!;
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
  // The two CFF fonts whole, not as subsets: pdf-lib 1.17.1 with @pdf-lib/fontkit 1.1.1 cuts Revive 80 Signature down to a file that MuPDF
  // rejects ("unknown file format"), and the viewer then draws a substitute sans in the name's place; the whole font renders right. It costs
  // about 150 KB of the page (compressed), Glacial Indifference about 35 KB, well inside the 300 KB the test holds. Montserrat (TrueType, as
  // Jost) is a subset.
  const script = await doc.embedFont(assets.script, { subset: false });
  const scriptOutlines = fontkit.create(assets.script);
  const bodyOutlines = fontkit.create(assets.body);
  const titleOutlines = fontkit.create(assets.title);
  const body: Face = { font: await doc.embedFont(assets.body, { subset: false }), has: (cp) => bodyOutlines.hasGlyphForCodePoint(cp), fallback: sans };
  const titleFace: Face = { font: await doc.embedFont(assets.title, { subset: true }), has: (cp) => titleOutlines.hasGlyphForCodePoint(cp), fallback: sans };
  const scriptFace = only(script);
  const page = doc.addPage([PAGE.width, PAGE.height]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: BLACK });

  drawCentred(page, "TUNNISTUS", { face: body, size: HEADING.size, spacing: HEADING.spacing }, CENTRE, HEADING.baseline);

  const title = upper(c.courseTitle);
  const titleFit = fitBlock(title, (s) => unitWidth(s, titleFace, TITLE.spacing), { width: TITLE.width, size: TITLE.size, shrinkTo: TITLE.shrinkTo, twoLineSize: TITLE.twoLineSize });
  const titleBaselines = titleFit.lines.length === 1 ? [TITLE.baseline] : TITLE.twoLineBaselines;
  titleFit.lines.forEach((line, i) => drawCentred(page, line, { face: titleFace, size: titleFit.size, spacing: TITLE.spacing }, CENTRE, titleBaselines[i]));

  const nameFit = fitBlock(scriptText(c.name), (s) => unitWidth(s, scriptFace, 0), { width: NAME.width, size: NAME.size, shrinkTo: NAME.shrinkTo, twoLineSize: NAME.shrinkTo });
  const nameStyle: Style = { face: scriptFace, size: nameFit.size, spacing: 0 };
  // the (lower) line stands on the baseline, or higher when its swashes would dip below the ink floor; a second line stands over it
  const lowest = nameFit.lines[nameFit.lines.length - 1];
  const baseline = Math.max(NAME.baseline, NAME.inkFloor + scriptInk(scriptOutlines, lowest).below * nameFit.size);
  if (nameFit.lines.length === 1) drawCentred(page, lowest, nameStyle, CENTRE, baseline);
  else {
    drawCentred(page, nameFit.lines[0], nameStyle, CENTRE, baseline + nameFit.size * NAME.leading);
    drawCentred(page, lowest, nameStyle, CENTRE, baseline);
  }
  page.drawLine({ start: { x: CENTRE - RULE.halfWidth, y: RULE.y }, end: { x: CENTRE + RULE.halfWidth, y: RULE.y }, thickness: RULE.thickness, color: WHITE });

  const skills = layoutSkills(c.skills, body);
  const skillStyle: Style = { face: body, size: skills.size, spacing: SKILLS.spacing };
  skills.columns.forEach((rows, column) => {
    const x = skills.xs[column];
    rows.forEach((row, i) => {
      const y = skills.top - i * skills.leading;
      if (row.bullet) {
        const radius = (BULLET.diameter * skills.size) / 2;
        page.drawCircle({ x: x + radius, y: y + BULLET.centre * skills.size, size: radius, color: WHITE });
      }
      drawAt(page, row.text, skillStyle, x + skills.indent, y);
    });
  });

  const footStyle = (size: number): Style => ({ face: body, size, spacing: FOOT.spacing });
  const volume = upper(c.volume);
  const volumeWidth = volume ? widthOf(volume, footStyle(FOOT.size)) + FOOT.gap : 0;
  const practical = fitBlock(upper(c.practicalLine), (s) => unitWidth(s, body, FOOT.spacing), {
    width: BOX.right - BOX.left - volumeWidth,
    size: FOOT.size,
    shrinkTo: FOOT.shrinkTo,
    twoLineSize: FOOT.shrinkTo,
  });
  practical.lines.forEach((line, i) => drawAt(page, line, footStyle(practical.size), BOX.left, skills.footBaseline - i * practical.size * FOOT.leading));
  if (volume) drawRight(page, volume, footStyle(FOOT.size), BOX.right, skills.footBaseline);

  drawLogo(page, sans, LOGO, WHITE);
  drawAt(page, `REGISTRIKOOD: ${oneLine(c.registryCode)}`, { face: body, size: LEFT_LINES.registrySize, spacing: LEFT_LINES.registrySpacing }, BOX.left, LEFT_LINES.baselines[0]);
  drawAt(page, `Tunnistuse nr. ${c.number}`, { face: body, size: LEFT_LINES.numberSize, spacing: LEFT_LINES.numberSpacing }, BOX.left, LEFT_LINES.baselines[1]);

  // Maria's signature: the trainer's name in the script font, fitted to the column; the block ends at the text block's right edge
  const trainer = scriptText(c.trainerName);
  const trainerSize = Math.min(SIGN.nameSize, SIGN.width / unitWidth(trainer, scriptFace, 0));
  drawRight(page, trainer, { face: scriptFace, size: trainerSize, spacing: 0 }, BOX.right, SIGN.nameBaseline);
  drawRight(page, "KOOLITAJA", { face: body, size: SIGN.labelSize, spacing: SIGN.labelSpacing }, BOX.right, SIGN.baselines[0]);
  const placeAndDate = `${oneLine(c.place)} ${tallinnDateText(c.issuedAt)}`;
  const placeUnit = unitWidth(placeAndDate, body, SIGN.spacing);
  const placeSize = Math.min(SIGN.placeSize, Math.max(SIGN.placeFloor, SIGN.width / placeUnit), SIGN.placeMaxWidth / placeUnit);
  drawRight(page, placeAndDate, { face: body, size: placeSize, spacing: SIGN.spacing }, BOX.right, SIGN.baselines[1]);

  return doc.save();
}
