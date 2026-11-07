import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { LOGO_FILES } from "@/server/certificate-pdf";
import { drawLogo, type LogoBox } from "@/server/pdf-logo";
import { readPdf } from "../pdf-read";

// The MS LAB logo on the PDFs (server/pdf-logo.ts): the site's logo image (1280 × 464 px), drawn as large as fits the box it is given, in its
// own proportions, from the box's lower left corner. The certificate gives it a box its width fills; the invoice and the contract one their
// height fills.

/** The logo drawn alone on a page: the size drawLogo returned, and where the page's content stream puts the image. */
async function draw(box: LogoBox) {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(readFileSync(LOGO_FILES.black));
  const size = drawLogo(doc.addPage([595, 842]), image, box);
  const { ops } = await readPdf(await doc.save());
  const placed = [...ops.matchAll(/q\n1 0 0 1 ([\d.]+) ([\d.]+) cm\n1 0 0 1 0 0 cm\n([\d.]+) 0 0 ([\d.]+) 0 0 cm\n1 0 0 1 0 0 cm\n\/\S+ Do\nQ/g)].map((m) => m.slice(1).map(Number));
  return { size, placed };
}

describe("drawLogo", () => {
  test("a box wider than the logo's proportions (the invoice's and the contract's 120 × 40): the height fills it, from the lower left corner", async () => {
    const { size, placed } = await draw({ x: 48, y: 754, width: 120, height: 40 });
    expect(size.height).toBe(40);
    expect(size.width).toBeCloseTo((40 * 1280) / 464, 6);
    expect(placed).toHaveLength(1);
    const [x, y, w, h] = placed[0];
    expect([x, y, h]).toEqual([48, 754, 40]);
    expect(w).toBeCloseTo(110.345, 3);
  });

  test("a box taller than the logo's proportions (the certificate's): the width fills it", async () => {
    const { size, placed } = await draw({ x: 97, y: 84.4, width: 148.4, height: 54 });
    expect(size.width).toBe(148.4);
    expect(size.height).toBeCloseTo((148.4 * 464) / 1280, 6);
    const [x, y, w] = placed[0];
    expect([x, y, w]).toEqual([97, 84.4, 148.4]);
  });
});
