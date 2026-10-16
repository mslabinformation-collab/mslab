import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type RGB } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { CERT_FONT_DIR, CERT_FONTS } from "@/server/certificate-pdf";
import { drawLogo } from "@/server/pdf-logo";
import { readPdf, type Run } from "../pdf-read";

// The MS LAB logo (server/pdf-logo.ts), shared by the certificate (white, in its 150 × 50 box) and the invoice (black, smaller): drawn at the
// place, size and colour it is given. The certificate must not move by a point (its own test, and the golden numbers here, which are what
// the certificate's private drawLogo drew before the move).

const SANS = new Uint8Array(readFileSync(join(CERT_FONT_DIR, CERT_FONTS.sans)));
const jost = fontkit.create(SANS);

/** A run's width as pdf-lib measured it: the glyphs' advances (no kerning) plus the spacing between the letters. */
function widthOf(run: Run): number {
  const glyphs = jost.layout(run.text).glyphs;
  return (glyphs.reduce((sum, g) => sum + g.advanceWidth, 0) / jost.unitsPerEm) * run.size + run.spacing * run.size * Math.max(0, glyphs.length - 1);
}

/** The logo drawn alone on a page: its text runs, and its lines as [x1, y1, x2, y2] with their thickness and stroke colour. */
async function draw(at: { x: number; y: number; width: number; height: number }, color: RGB) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const sans = await doc.embedFont(SANS, { subset: true });
  drawLogo(doc.addPage([842, 595]), sans, at, color);
  const { runs, ops } = await readPdf(await doc.save());
  const lines = [...ops.matchAll(/q\n([-\d. ]+) RG\n([\d.]+) w\n\[\] 0 d\n[-\d.]+ [-\d.]+ m\n([-\d.]+) ([-\d.]+) m\n([-\d.]+) ([-\d.]+) l\nS\nQ/g)].map((m) => ({
    colour: m[1],
    thickness: Number(m[2]),
    from: [Number(m[3]), Number(m[4])],
    to: [Number(m[5]), Number(m[6])],
  }));
  return { runs, lines, ops };
}

describe("drawLogo", () => {
  test("in the certificate's box, in white, it is what the certificate always drew", async () => {
    const { runs, lines } = await draw({ x: 56, y: 80, width: 150, height: 50 }, rgb(1, 1, 1));
    // the frame: the top, the sides, the lower edge in two pieces with the small word's gap between them
    expect(lines.map((l) => [...l.from, ...l.to])).toEqual([
      [56, 130, 206, 130],
      [56, 80, 56, 130],
      [206, 80, 206, 130],
      [56, 80, 92.9894, 80],
      [169.0106, 80, 206, 80],
    ]);
    for (const l of lines) expect([l.colour, l.thickness]).toEqual(["1 1 1", 0.8]);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ font: "Jost", text: "MS LAB", size: 30, x: 72.11, y: 94.5 });
    expect(runs[0].spacing).toBeCloseTo(0.12, 10);
    expect(runs[1]).toMatchObject({ font: "Jost", text: "KOOLITUSKESKUS", size: 5.2, spacing: 0.4, x: 96.9894, y: 78.18 });
  });

  test("a smaller box scales all of it together: half the box, half the sizes and the line, the same em spacing; a colour of its own", async () => {
    const { runs, lines, ops } = await draw({ x: 10, y: 20, width: 75, height: 25 }, rgb(0, 0, 0));
    // the small word's half width, 34.0106 pt at the certificate's 5.2 pt, is 17.0053 pt at 2.6 pt, and the gap around it 2 pt on each side
    expect(lines.map((l) => [...l.from, ...l.to])).toEqual([
      [10, 45, 85, 45],
      [10, 20, 10, 45],
      [85, 20, 85, 45],
      [10, 20, expect.closeTo(47.5 - 17.0053 - 2, 3), 20],
      [expect.closeTo(47.5 + 17.0053 + 2, 3), 20, 85, 20],
    ]);
    for (const l of lines) expect([l.colour, l.thickness]).toEqual(["0 0 0", 0.4]);
    expect(ops).not.toContain("1 1 1");
    expect(runs.map((r) => [r.text, r.size])).toEqual([["MS LAB", 15], ["KOOLITUSKESKUS", 2.6]]);
    // both words centred on the box's middle (47.5), "MS LAB" in the middle of the frame's height, the small word on the lower edge
    for (const r of runs) expect(r.x + widthOf(r) / 2).toBeCloseTo(47.5, 2);
    expect(runs[0].y).toBeCloseTo(20 + (25 - 15 * 0.7) / 2, 2);
    expect(runs[1].y).toBeCloseTo(20 - (2.6 * 0.7) / 2, 2);
  });
});
