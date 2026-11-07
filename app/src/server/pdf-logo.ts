import type { PDFImage, PDFPage } from "pdf-lib";

// The MS LAB logo on the PDFs: the site's own logo image (public/brand/logo.png, the same design as on Maria's Canva certificate), made white
// for the certificate's black page and black for the invoice and the contract (server/certificate-pdf.ts LOGO_FILES). Dim, 07.11.2026: "The
// canva logo that we use should be used everywhere where we have a logo, so on invoices and contracts as well." Until then the PDFs drew it
// as vector shapes in Jost.

/** Where a logo may stand: its lower left corner (PDF points from the page's bottom left) and the most room it may take. */
export type LogoBox = { x: number; y: number; width: number; height: number };

/**
 * Draws the embedded logo image as large as fits `box`, in its own proportions (by the smaller of the two ratios), from the box's lower left
 * corner; returns the size it took.
 */
export function drawLogo(page: PDFPage, logo: PDFImage, box: LogoBox): { width: number; height: number } {
  const scale = Math.min(box.width / logo.width, box.height / logo.height);
  const size = { width: logo.width * scale, height: logo.height * scale };
  page.drawImage(logo, { x: box.x, y: box.y, ...size });
  return size;
}
