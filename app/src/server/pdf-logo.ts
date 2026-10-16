import { setCharacterSpacing, type PDFFont, type PDFPage, type RGB } from "pdf-lib";

// The MS LAB logo as vector shapes (public/brand/logo.png is dark on transparent), shared by the PDFs that carry it: the e-course
// certificate (white on black, server/certificate-pdf.ts) and the invoice (black on white, server/invoice-pdf.ts). A thin frame, "MS LAB" in
// it, "KOOLITUSKESKUS" on its lower edge, the edge open under the small word. It is drawn in the sans (Jost) the caller has embedded, at the
// place, size and colour the caller gives.

/**
 * The logo as designed, in points: a 150 × 50 box, the frame's line 0.8 thick, "MS LAB" 30 pt spaced 0.12 em, the small word 5.2 pt spaced
 * 0.4 em with 4 pt of the frame's edge open on each side of it. A smaller box scales all of it together (by the smaller of its two ratios).
 */
const DESIGN = { width: 150, height: 50, thickness: 0.8, nameSize: 30, nameSpacing: 0.12, smallSize: 5.2, smallSpacing: 0.4, smallPad: 4 } as const;

/** The width of `text` at `size` with `spacing` em between its letters (none after the last). */
function spacedWidth(text: string, font: PDFFont, size: number, spacing: number): number {
  return (font.widthOfTextAtSize(text, 1) + spacing * Math.max(0, Array.from(text).length - 1)) * size;
}

/** Draws `text` centred on `centre`; the letter spacing is the PDF's character spacing (Tc), set around this text only. */
function drawSpacedCentred(page: PDFPage, text: string, font: PDFFont, size: number, spacing: number, color: RGB, centre: number, y: number): void {
  const tc = spacing * size;
  if (tc) page.pushOperators(setCharacterSpacing(tc));
  page.drawText(text, { x: centre - spacedWidth(text, font, size, spacing) / 2, y, size, font, color });
  if (tc) page.pushOperators(setCharacterSpacing(0));
}

/**
 * The logo in the box `at` (PDF points from the page's bottom left: `x`, `y` its lower left corner), all of it in `color`. `sans` must be Jost
 * (the capitals' height, 0.7 em, sets where the words stand).
 */
export function drawLogo(page: PDFPage, sans: PDFFont, at: { x: number; y: number; width: number; height: number }, color: RGB): void {
  const { x, y, width, height } = at;
  const scale = Math.min(width / DESIGN.width, height / DESIGN.height);
  const thickness = DESIGN.thickness * scale;
  const nameSize = DESIGN.nameSize * scale;
  const smallSize = DESIGN.smallSize * scale;
  const centre = x + width / 2;
  const line = (x1: number, y1: number, x2: number, y2: number) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
  const half = spacedWidth("KOOLITUSKESKUS", sans, smallSize, DESIGN.smallSpacing) / 2 + DESIGN.smallPad * scale;
  line(x, y + height, x + width, y + height);
  line(x, y, x, y + height);
  line(x + width, y, x + width, y + height);
  line(x, y, centre - half, y);
  line(centre + half, y, x + width, y);
  // Jost's capitals are 0.7 em high (700 of its 1000 units): "MS LAB" sits in the middle of the frame, the small word on its edge
  drawSpacedCentred(page, "MS LAB", sans, nameSize, DESIGN.nameSpacing, color, centre, y + (height - nameSize * 0.7) / 2);
  drawSpacedCentred(page, "KOOLITUSKESKUS", sans, smallSize, DESIGN.smallSpacing, color, centre, y - (smallSize * 0.7) / 2);
}
