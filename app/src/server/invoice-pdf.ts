import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb } from "pdf-lib";
import type { Invoice } from "@/db/schema";
import { tallinnDateText } from "@/domain/certificate";
import { euro, paidMethodText, partText, vatSplit } from "@/domain/invoice";
import { drawLogo } from "./pdf-logo";

// The invoice as a PDF (invoices, Task 2, spec §7, D6, D8): drawn on every download from the invoice's frozen row and the sans (Jost, the
// same committed font as the certificate's: no new font), with pdf-lib and its fontkit. A4 portrait, a white page and black text, printable:
// the logo (server/pdf-logo.ts) and the invoice's number at the top, the seller at the left and the buyer ("Ostja") at the right, the one
// line of what is invoiced and its sum, the totals (the VAT lines only when VAT is on), then how to pay it (an unpaid invoice) or how it was
// paid (a paid one), and at the foot the VAT sentence (VAT off) and Maria's footer line. Every position below is in PDF points from the
// bottom left corner.
// Jost is embedded as a subset (only the letters drawn); the page is about 7 KB, and the test holds it under 100 KB. The output is
// deterministic: the same row gives the same bytes (the PDF's dates are the issue's).
// Fitting. Every text is cleaned (white space is one space; a character Jost lacks is "?", never a missing-glyph box), wrapped at its box (a
// word wider than the box is broken at the box) and, past the lines the box allows, cut with "…". The whole page is composed at a scale: if it
// does not fit between the top and the foot, it is composed again at a smaller one, so nothing leaves the page and nothing runs into
// anything else, whatever the texts.

/** A4 portrait, in PDF points. */
export const INVOICE_PAGE = { width: 595, height: 842 } as const;

/** What the footer of a VAT-off invoice says (D8, spec-quoted; the accountant is to confirm the wording once). */
export const VAT_OFF_NOTE = "Arve ei sisalda käibemaksu (müüja ei ole käibemaksukohustuslane).";

/** What the PDF prints: the invoice's frozen row, Maria's footer line too (frozen at the issue since migration 0012; the sample's from the card). */
export type InvoiceContent = Pick<
  Invoice,
  "number" | "kind" | "status" | "amountCents" | "vatRate" | "line" | "seller" | "buyer" | "reference" | "issuedAt" | "dueAt" | "paidAt" | "paidMethod" | "footer"
>;

// ---------- the layout (595 × 842 pt) ----------

const BLACK = rgb(0, 0, 0);
/** The ink's edges: 48 pt in from the left, right and bottom, and the top of the first line 48 pt under the page's top. */
const EDGE = { left: 48, right: INVOICE_PAGE.width - 48, top: INVOICE_PAGE.height - 48, bottom: 48 } as const;
/** The logo's box at the top left (drawn as designed, 3 : 1). */
const LOGO = { x: EDGE.left, y: EDGE.top - 40, width: 120, height: 40 } as const;
/** The distance between two lines' baselines, in sizes. */
const LEADING = 1.3;
/** Font sizes at scale 1; the lines' thickness. */
const SIZE = { heading: 20, company: 12, body: 10, line: 11, small: 9.5, label: 8, total: 13, footer: 8 } as const;
const RULE = 0.5;
/** The header's right column: the labels start at `label`, the dates end at the right edge; the number stands over them, as wide as the logo leaves. */
const HEADER = { label: 375, headingLeft: LOGO.x + LOGO.width + 24 } as const;
/** The seller (left) and the buyer (right) side by side. */
const PARTIES = { width: 235, rightX: EDGE.right - 235 } as const;
/** The line's description column and the sum column beside it (the sum ends at the right edge). */
const TABLE = { descriptionWidth: 380 } as const;
/** The totals: the labels start at `label`, the sums end at the right edge. */
const TOTALS = { label: 330 } as const;
/** The payment details: the labels at the left edge, the values from `value`. */
const PAY = { value: EDGE.left + 82, valueWidth: EDGE.right - EDGE.left - 82 } as const;
/** The least scale a page is composed at, and the step it comes down by. */
const SCALE = { min: 0.5, step: 0.05 } as const;

type Op = { text: string; x: number; y: number; size: number } | { x1: number; x2: number; y: number; thickness: number };
/** One field of a column: its text, its size and the most lines its box takes. */
type Row = { s: string; size: number; max: number };

/** `text` cleaned for drawing: white space is one space, control and format characters are dropped, a character `chars` lacks is "?". */
function clean(text: string, chars: ReadonlySet<number>): string {
  const spaced = text.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/ {2,}/g, " ").trim();
  return Array.from(spaced, (ch) => (chars.has(ch.codePointAt(0)!) ? ch : "?")).join("");
}

/**
 * `text` broken at its spaces into lines that fit `width`, a word wider than the box broken at the box; past `maxLines` the last line is cut and
 * ends in "…".
 */
function wrap(text: string, fits: (line: string) => boolean, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (!word) continue;
    const joined = line ? `${line} ${word}` : word;
    if (fits(joined)) {
      line = joined;
      continue;
    }
    if (line) lines.push(line);
    let rest = word;
    while (!fits(rest)) {
      const chars = Array.from(rest);
      let n = 1;
      while (n < chars.length - 1 && fits(chars.slice(0, n + 1).join(""))) n++;
      lines.push(chars.slice(0, n).join(""));
      rest = chars.slice(n).join("");
    }
    line = rest;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = Array.from(kept[maxLines - 1]);
  while (last.length > 0 && !fits(`${last.join("").trimEnd()}…`)) last.pop();
  kept[maxLines - 1] = `${last.join("").trimEnd()}…`;
  return kept;
}

/**
 * The page as drawing operations at scale `k` (every size and gap times `k`; the boxes' widths stay): the text with its left end and its
 * baseline, and the rules. `bottom` is where the body ends, `limit` the lowest it may go (the foot's top and a gap).
 */
function compose(c: InvoiceContent, measure: (text: string, size: number) => number, chars: ReadonlySet<number>, k: number): { ops: Op[]; bottom: number; limit: number } {
  const ops: Op[] = [];
  const text = (s: string, x: number, y: number, size: number) => ops.push({ text: s, x, y, size });
  const rule = (y: number, x1: number = EDGE.left, x2: number = EDGE.right) => ops.push({ x1, x2, y, thickness: RULE });
  const clear = (s: string) => clean(s, chars);
  const wrapped = (s: string, size: number, width: number, max: number) => wrap(clear(s), (t) => measure(t, size) <= width, max);
  const rightText = (s: string, size: number, y: number, right: number = EDGE.right) => text(s, right - measure(s, size), y, size);
  /** The lines at x with the first one's top at `top`: the top under the last. */
  const lines = (ls: string[], x: number, top: number, size: number): number => {
    ls.forEach((l, i) => text(l, x, top - size - i * size * LEADING, size));
    return top - ls.length * size * LEADING;
  };
  const column = (rows: Row[], x: number, top: number, width: number): number =>
    rows.reduce((y, r) => lines(wrapped(r.s, r.size * k, width, r.max), x, y, r.size * k), top);
  const labelled = (label: string, value: string) => (clear(value) ? `${label} ${value}` : "");

  // the foot first: it stands at the bottom, and the body must end above it
  const foot = [...wrapped(c.vatRate === null ? VAT_OFF_NOTE : "", SIZE.footer * k, EDGE.right - EDGE.left, 3), ...wrapped(c.footer, SIZE.footer * k, EDGE.right - EDGE.left, 8)];
  const footTop = EDGE.bottom + foot.length * SIZE.footer * k * LEADING;
  if (foot.length > 0) {
    rule(footTop + 6 * k);
    lines(foot, EDGE.left, footTop, SIZE.footer * k);
  }
  const limit = foot.length > 0 ? footTop + 6 * k + 14 * k : EDGE.bottom + 14 * k;

  // the header: the logo, the number, the dates
  const heading = clear(`ARVE ${c.number}`);
  const headingSize = Math.min(SIZE.heading * k, (EDGE.right - HEADER.headingLeft) / measure(heading, 1));
  const headingBase = EDGE.top - 0.7 * headingSize;
  rightText(heading, headingSize, headingBase);
  const dates: [string, string][] = [["Kuupäev", tallinnDateText(c.issuedAt)]];
  if (c.status === "unpaid" && c.dueAt) dates.push(["Maksetähtaeg", tallinnDateText(c.dueAt)]);
  let dateBase = headingBase - 26 * k;
  for (const [label, value] of dates) {
    text(label, HEADER.label, dateBase, SIZE.body * k);
    rightText(value, SIZE.body * k, dateBase);
    dateBase -= SIZE.body * k * LEADING + 2 * k;
  }
  const headerBottom = Math.min(LOGO.y, dateBase + SIZE.body * k * LEADING);
  rule(headerBottom - 10 * k);

  // the seller and the buyer, side by side under their labels
  const partiesTop = headerBottom - 22 * k;
  text("Müüja", EDGE.left, partiesTop - SIZE.label * k, SIZE.label * k);
  text("Ostja", PARTIES.rightX, partiesTop - SIZE.label * k, SIZE.label * k);
  const columnsTop = partiesTop - SIZE.label * k * LEADING - 3 * k;
  const { seller, buyer } = c;
  const sellerBottom = column(
    [
      { s: seller.company, size: SIZE.company, max: 6 },
      { s: labelled("Registrikood", seller.registryCode), size: SIZE.body, max: 2 },
      { s: seller.address, size: SIZE.body, max: 5 },
      // a VAT number beside a sentence that says the seller has none would contradict itself: it stands on a VAT invoice only
      { s: c.vatRate === null ? "" : labelled("KMKR", seller.vatNumber), size: SIZE.body, max: 2 },
    ],
    EDGE.left,
    columnsTop,
    PARTIES.width,
  );
  const hasCompany = clear(buyer.company) !== "";
  const buyerBottom = column(
    hasCompany
      ? [
          { s: buyer.company, size: SIZE.company, max: 6 },
          { s: labelled("Registrikood", buyer.companyCode), size: SIZE.body, max: 2 },
          { s: buyer.companyAddress, size: SIZE.body, max: 5 },
          { s: buyer.name, size: SIZE.body, max: 4 },
          { s: buyer.email, size: SIZE.body, max: 4 },
        ]
      : [
          { s: buyer.name, size: SIZE.company, max: 4 },
          { s: buyer.address, size: SIZE.body, max: 5 },
          { s: buyer.email, size: SIZE.body, max: 4 },
        ],
    PARTIES.rightX,
    columnsTop,
    PARTIES.width,
  );

  // the line: what is invoiced, once, and its sum
  const tableTop = Math.min(sellerBottom, buyerBottom) - 22 * k;
  text("Kirjeldus", EDGE.left, tableTop - SIZE.label * k, SIZE.label * k);
  rightText("Summa", SIZE.label * k, tableTop - SIZE.label * k);
  const headRule = tableTop - SIZE.label * k * LEADING - 2 * k;
  rule(headRule);
  const rowTop = headRule - 8 * k;
  rightText(euro(c.amountCents), SIZE.line * k, rowTop - SIZE.line * k);
  const rowBottom = column(
    [
      { s: c.line.course, size: SIZE.line, max: 8 },
      { s: c.line.session, size: SIZE.small, max: 3 },
      { s: c.line.part || partText(c.kind), size: SIZE.small, max: 3 },
    ],
    EDGE.left,
    rowTop,
    TABLE.descriptionWidth,
  );
  rule(rowBottom - 4 * k);

  // the totals: net, VAT and the total when VAT is on, the total alone when it is off
  let y = rowBottom - 4 * k - 10 * k;
  if (c.vatRate !== null) {
    const { net, vat } = vatSplit(c.amountCents, c.vatRate);
    for (const [label, sum] of [["Summa käibemaksuta", net], [`Käibemaks ${c.vatRate}%`, vat]] as const) {
      text(label, TOTALS.label, y - SIZE.body * k, SIZE.body * k);
      rightText(euro(sum), SIZE.body * k, y - SIZE.body * k);
      y -= SIZE.body * k * LEADING + 3 * k;
    }
    rule(y - 1 * k, TOTALS.label);
    y -= 7 * k;
  }
  text("Kokku", TOTALS.label, y - SIZE.total * k, SIZE.total * k);
  rightText(euro(c.amountCents), SIZE.total * k, y - SIZE.total * k);
  y -= SIZE.total * k * LEADING;

  // how to pay it, or how it was paid. An unpaid invoice with no bank details at all (the request-to-pay invoice is not made without an
  // IBAN) prints no payment block, not a heading with nothing under it.
  if (c.status === "unpaid") {
    if ([seller.receiver, seller.iban, seller.bank].some((v) => clear(v) !== "")) {
      y -= 24 * k;
      text("Maksmiseks", EDGE.left, y - SIZE.label * k, SIZE.label * k);
      y -= SIZE.label * k * LEADING + 3 * k;
      // the reference is „Selgitus“, as the account and the mails call it, also when it is digits alone: it is no viitenumber (no 7-3-1 check
      // digit), and a bank refuses it in that field (the final review's m3)
      const details: [string, string, number][] = [
        ["Saaja", seller.receiver, 4],
        ["IBAN", seller.iban, 2],
        ["Pank", seller.bank, 3],
        ["Selgitus", c.reference, 4],
      ];
      for (const [label, value, max] of details) {
        if (!clear(value)) continue;
        text(label, EDGE.left, y - SIZE.body * k, SIZE.body * k);
        y = lines(wrapped(value, SIZE.body * k, PAY.valueWidth, max), PAY.value, y, SIZE.body * k);
      }
    }
  } else {
    y -= 24 * k;
    const paid = c.status === "paid";
    const said = paid
      ? ["Tasutud", c.paidAt ? tallinnDateText(c.paidAt) : "", c.paidMethod ? `(${paidMethodText(c.paidMethod)})` : ""].filter(Boolean).join(" ")
      : "Tühistatud";
    y = lines(wrapped(said, SIZE.line * k, EDGE.right - EDGE.left, 2), EDGE.left, y, SIZE.line * k);
  }
  return { ops, bottom: y, limit };
}

/** A4 portrait (595 × 842), white with black text, laid out as spec §7 (the constants above). */
export async function renderInvoice(c: InvoiceContent, assets: { sans: Uint8Array }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // neutral metadata; the dates are the issue's, so the same row gives the same file
  doc.setTitle(`Arve ${c.number}`);
  doc.setAuthor("MS LAB");
  doc.setCreator("MS LAB");
  doc.setProducer("MS LAB");
  doc.setCreationDate(c.issuedAt);
  doc.setModificationDate(c.issuedAt);
  const sans = await doc.embedFont(assets.sans, { subset: true });
  const chars = new Set(sans.getCharacterSet());
  const page = doc.addPage([INVOICE_PAGE.width, INVOICE_PAGE.height]);
  const measure = (t: string, size: number) => sans.widthOfTextAtSize(t, size);

  // the largest scale at which the body ends above the foot
  let composed = compose(c, measure, chars, 1);
  for (let k = 1 - SCALE.step; composed.bottom < composed.limit && k >= SCALE.min - 1e-9; k -= SCALE.step) composed = compose(c, measure, chars, k);

  drawLogo(page, sans, LOGO, BLACK);
  for (const op of composed.ops) {
    if ("text" in op) page.drawText(op.text, { x: op.x, y: op.y, size: op.size, font: sans, color: BLACK });
    else page.drawLine({ start: { x: op.x1, y: op.y }, end: { x: op.x2, y: op.y }, thickness: op.thickness, color: BLACK });
  }
  return doc.save();
}
