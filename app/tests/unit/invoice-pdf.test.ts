import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { decodePDFRawStream, PDFArray, PDFDict, PDFName } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { euro, INVOICE_LIMITS, vatSplit, type InvoiceBuyer, type InvoiceSeller } from "@/domain/invoice";
import { CERT_FONT_DIR, CERT_FONTS } from "@/server/certificate-pdf";
import { INVOICE_PAGE, renderInvoice, VAT_OFF_NOTE, type InvoiceContent } from "@/server/invoice-pdf";
import { family, rawStream, readPdf, type Run } from "../pdf-read";

// The invoice's PDF (invoices, Task 2, spec §7, D8, D6): rendered from fixtures and read back the way a PDF reader reads it (tests/pdf-read.ts:
// the text of every run with its font, size and place, in PDF points from the bottom left of the 595 × 842 page). The layout is the builder's
// (spec §11); what is held here is what the PDF must say, that it says it in black Jost on one A4 page, that nothing leaves the page or runs
// into anything else, and that the same row gives the same file.

const SANS = new Uint8Array(readFileSync(join(CERT_FONT_DIR, CERT_FONTS.sans)));
const jost = fontkit.create(SANS);
const ASSETS = { sans: SANS };
const NBSP = "\u00a0";
/** The page's printable margin: the least that any ink keeps from every edge. */
const MARGIN = 36;

const SELLER: InvoiceSeller = {
  company: "Näidis Akadeemia OÜ",
  registryCode: "12345678",
  address: "Pärnu mnt 12, 10148 Tallinn",
  vatNumber: "EE123456789",
  receiver: "Näidis Õppekeskus MTÜ", // not the company: the bank block must print its own receiver
  iban: "EE382200221020145685",
  bank: "Swedbank",
};
const BUYER: InvoiceBuyer = { name: "Kertu Õunapuu", email: "kertu@example.test", address: "", company: "", companyCode: "", companyAddress: "" };
const ISSUED = new Date("2026-10-16T09:00:00Z");

/** An invoice born paid by Montonio, VAT off: the 50 % of a contact course. */
const PAID: InvoiceContent = {
  number: "MSL2026-001",
  kind: "prepayment",
  status: "paid",
  amountCents: 17500,
  vatRate: null,
  line: { course: "Kulmude kujundamise koolitus", session: "14.11.2026 Tallinn", part: "Ettemaks 50%" },
  seller: SELLER,
  buyer: BUYER,
  reference: "",
  issuedAt: ISSUED,
  dueAt: null,
  paidAt: ISSUED,
  paidMethod: "montonio",
  footer: "",
};
/** A request to pay, VAT on at 24 %, a week to pay, with Maria's own footer line. */
const UNPAID: InvoiceContent = {
  ...PAID,
  number: "MSL2026-002",
  status: "unpaid",
  vatRate: 24,
  reference: "MSLAB42",
  dueAt: new Date("2026-10-23T09:00:00Z"),
  paidAt: null,
  paidMethod: null,
  footer: "Küsimuste korral kirjuta aadressil info@example.test.",
};

/** A run's width as pdf-lib measured it when it laid the page out: the glyphs' advances (no kerning) plus the spacing between them. */
function widthOf(run: Run): number {
  const glyphs = jost.layout(run.text).glyphs;
  return (glyphs.reduce((sum, g) => sum + g.advanceWidth, 0) / jost.unitsPerEm) * run.size + run.spacing * run.size * Math.max(0, glyphs.length - 1);
}
/** The box a run's ink lies in: from a little under its baseline to the top of its accents (Õ), across its width. */
const boxOf = (r: Run) => ({ left: r.x, right: r.x + widthOf(r), bottom: r.y - 0.25 * r.size, top: r.y + 0.9 * r.size });

const render = async (c: InvoiceContent) => readPdf(await renderInvoice(c, ASSETS));
/** The visible text of the runs: one line per run, a no-break space shown as a space. */
const plain = (s: string) => s.split(NBSP).join(" ");
const textOf = (runs: Run[]) => runs.map((r) => plain(r.text)).join("\n");
const one = (runs: Run[], text: string): Run => {
  const found = runs.filter((r) => r.text === text);
  expect(found.map((r) => r.text), text).toEqual([text]);
  return found[0];
};
const find = (runs: Run[], text: string): Run => {
  const found = runs.filter((r) => r.text.includes(text));
  expect(found.length, `a run with "${text}"`).toBeGreaterThan(0);
  return found[0];
};

/** Every run lies inside the page's margins, and no two runs' boxes touch. */
function expectFitsAndApart(runs: Run[]) {
  for (const r of runs) {
    const b = boxOf(r);
    expect(b.left, r.text).toBeGreaterThanOrEqual(MARGIN - 0.01);
    expect(b.right, r.text).toBeLessThanOrEqual(INVOICE_PAGE.width - MARGIN + 0.01);
    expect(b.bottom, r.text).toBeGreaterThanOrEqual(MARGIN - 0.01);
    expect(b.top, r.text).toBeLessThanOrEqual(INVOICE_PAGE.height - MARGIN + 0.01);
  }
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++) {
      const [a, b] = [boxOf(runs[i]), boxOf(runs[j])];
      const apart = a.right <= b.left + 0.01 || b.right <= a.left + 0.01 || a.top <= b.bottom + 0.01 || b.top <= a.bottom + 0.01;
      expect(apart, `"${runs[i].text}" and "${runs[j].text}" overlap`).toBe(true);
    }
}

describe("Jost and the euro text", () => {
  test("Jost has the glyphs euro() prints: the no-break space (U+00A0) and the euro sign (U+20AC), so neither is substituted", () => {
    expect(jost.hasGlyphForCodePoint(0x00a0)).toBe(true);
    expect(jost.hasGlyphForCodePoint(0x20ac)).toBe(true);
    for (const ch of euro(123456789)) expect(jost.hasGlyphForCodePoint(ch.codePointAt(0)!), `U+${ch.codePointAt(0)!.toString(16)}`).toBe(true);
  });
});

describe("renderInvoice: the page", () => {
  test("one A4 portrait page, white with black text, only Jost (a subset), no image, neutral metadata dated by the issue, under 100 KB", async () => {
    const bytes = await renderInvoice(UNPAID, ASSETS);
    expect(bytes.length).toBeLessThan(100 * 1024);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    const { doc, pages, page, fontNames, ops } = await readPdf(bytes);
    expect(INVOICE_PAGE).toEqual({ width: 595, height: 842 });
    expect(pages).toHaveLength(1);
    expect(page.getSize()).toEqual({ width: 595, height: 842 });
    expect(fontNames.map(family)).toEqual([family(jost.postscriptName)]);
    // black on white: the page is not painted, nothing is drawn in white or in a colour but black (the text, the logo's lines, the rules)
    expect(ops).not.toMatch(/ re\n/);
    expect(ops).toContain("0 0 0 rg");
    expect(ops).toContain("0 0 0 RG");
    const colours = [...ops.matchAll(/^([-\d. ]+) (rg|RG)$/gm)].map((m) => m[1]);
    expect(new Set(colours)).toEqual(new Set(["0 0 0"]));
    // no image; the font's file is a subset, much smaller than the font
    const xobjects = page.node.Resources()!.lookup(PDFName.of("XObject"));
    expect(xobjects instanceof PDFDict ? xobjects.keys() : []).toEqual([]);
    const fontDicts = doc.context.enumerateIndirectObjects().flatMap(([, o]) => (o instanceof PDFDict && o.get(PDFName.of("Subtype"))?.toString() === "/Type0" ? [o] : []));
    expect(fontDicts).toHaveLength(1);
    const cid = doc.context.lookup(fontDicts[0].lookup(PDFName.of("DescendantFonts"), PDFArray).get(0), PDFDict);
    const file = cid.lookup(PDFName.of("FontDescriptor"), PDFDict).lookup(PDFName.of("FontFile2"));
    expect(decodePDFRawStream(rawStream(file)).decode().length).toBeLessThan(SANS.length / 2);
    expect([doc.getTitle(), doc.getAuthor(), doc.getProducer(), doc.getCreator()]).toEqual(["Arve MSL2026-002", "MS LAB", "MS LAB", "MS LAB"]);
    expect(doc.getCreationDate()).toEqual(ISSUED);
    expect(doc.getModificationDate()).toEqual(ISSUED);
  });

  test("the same invoice gives the same file on every download", async () => {
    for (const c of [PAID, UNPAID]) expect(Buffer.from(await renderInvoice(c, ASSETS)).equals(Buffer.from(await renderInvoice(c, ASSETS)))).toBe(true);
  });

  test("the file is dated by the issue and by nothing else: another instant gives another file, the same instant the same one", async () => {
    const a = await renderInvoice({ ...PAID, issuedAt: new Date("2026-10-16T09:00:00Z") }, ASSETS);
    const b = await renderInvoice({ ...PAID, issuedAt: new Date("2026-10-17T09:00:00Z") }, ASSETS);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("renderInvoice: a paid invoice, VAT off", () => {
  test("it says the number, the seller, the buyer, the line, the sum, that it is paid and how, and that it carries no VAT", async () => {
    const { runs } = await render(PAID);
    const text = textOf(runs);
    expect(text).toContain("ARVE MSL2026-001");
    expect(text).toContain("Näidis Akadeemia OÜ");
    expect(text).toContain("12345678");
    expect(text).toContain("Pärnu mnt 12, 10148 Tallinn");
    expect(text).toContain("Kertu Õunapuu");
    expect(text).toContain("Kulmude kujundamise koolitus");
    expect(text).toContain("14.11.2026 Tallinn");
    expect(text).toContain("Ettemaks 50%");
    expect(text).toContain("175,00 €");
    expect(text).toContain("Tasutud 16.10.2026 (Montonio)");
    expect(text).toContain(VAT_OFF_NOTE);
    expect(VAT_OFF_NOTE).toBe("Arve ei sisalda käibemaksu (müüja ei ole käibemaksukohustuslane).");
    expect(text).toContain("Kuupäev");
    expect(text).toContain("16.10.2026");
    expect(text).toContain("Müüja");
    expect(text).toContain("Ostja");
    // no VAT line, no due date, no payment instructions
    expect(text).not.toContain("Käibemaks");
    expect(text).not.toContain("Summa käibemaksuta");
    expect(text).not.toContain("Maksetähtaeg");
    expect(text).not.toContain("IBAN");
    expect(text).not.toContain("Saaja"); // the payee's label: on an invoice with no bank block it is nowhere (the buyer is „Ostja")
    expect(text).not.toContain(SELLER.receiver);
    // the seller is not VAT-registered on this invoice, so no VAT number is printed beside the sentence that says so
    expect(text).not.toContain("EE123456789");
    // the sum is the sum, once in the line and once as the total
    expect(runs.filter((r) => r.text === euro(17500))).toHaveLength(2);
  });

  test("the amounts are one text each, with a no-break space before €, and the total is the sum of the line", async () => {
    const { runs } = await render({ ...PAID, amountCents: 123456 });
    expect(runs.filter((r) => r.text === `1${NBSP}234,56${NBSP}€`)).toHaveLength(2);
  });

  test("the payment is the paid line, by Maria's mark too: bank, cash, card, with the Tallinn date of the payment", async () => {
    for (const [paidMethod, word] of [["bank", "Pangaülekanne"], ["cash", "Sularaha"], ["card", "Kaardimakse kohapeal"]] as const) {
      const { runs } = await render({ ...PAID, paidMethod, paidAt: new Date("2026-12-31T22:30:00Z") });
      expect(textOf(runs)).toContain(`Tasutud 01.01.2027 (${word})`);
    }
  });

  test("Järelmaks (Inbank), whose words have brackets of their own, follows a middle dot: never brackets in brackets (instalments D6)", async () => {
    const { runs } = await render({ ...PAID, paidMethod: "financing", paidAt: new Date("2026-12-31T22:30:00Z") });
    expect(textOf(runs)).toContain("Tasutud 01.01.2027 · Järelmaks (Inbank)");
    expect(textOf(runs)).not.toContain("(Järelmaks (Inbank))");
  });

  test("the blocks stand in order from the top: the number, the buyer (Ostja), the line, the total, the payment, the footer", async () => {
    const { runs } = await render({ ...PAID, footer: "Küsimuste korral kirjuta Mariale." });
    const ys = ["ARVE MSL2026-001", "Ostja", "Kulmude kujundamise koolitus", "Kokku", "Tasutud 16.10.2026 (Montonio)", VAT_OFF_NOTE].map((t) => find(runs, t).y);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    expect(new Set(ys).size).toBe(ys.length);
    // the footer line follows the VAT sentence
    expect(find(runs, "Küsimuste korral kirjuta Mariale.").y).toBeLessThan(find(runs, VAT_OFF_NOTE).y);
  });
});

describe("renderInvoice: an unpaid invoice, VAT on", () => {
  test("it says the due date, the bank details and the reference, the net, the VAT and the total", async () => {
    const { runs } = await render(UNPAID);
    const text = textOf(runs);
    expect(text).toContain("ARVE MSL2026-002");
    expect(text).toContain("Maksetähtaeg");
    expect(text).toContain("23.10.2026");
    expect(text).toContain("EE382200221020145685");
    expect(text).toContain("Swedbank");
    expect(text).toContain("MSLAB42");
    // the bank block's first row is the receiver, its own text (not the seller's company), under its label „Saaja" on one baseline;
    // the buyer's heading is „Ostja", so „Saaja" stands once on the page: the payee's
    const receiver = one(runs, SELLER.receiver);
    const payee = one(runs, "Saaja");
    expect([receiver.x, receiver.size]).toEqual([48 + 82, 10]);
    expect([payee.x, payee.y, payee.size]).toEqual([48, receiver.y, 10]);
    expect(one(runs, "Ostja").x).toBe(312);
    expect(find(runs, "Maksmiseks").y).toBeGreaterThan(receiver.y);
    expect(text).toContain("Summa käibemaksuta");
    expect(text).toContain("141,13 €");
    expect(text).toContain("Käibemaks 24%");
    expect(text).toContain("33,87 €");
    expect(text).toContain("Kokku");
    expect(text).toContain("175,00 €");
    const { net, vat, gross } = vatSplit(UNPAID.amountCents, 24);
    expect([euro(net), euro(vat), euro(gross)]).toEqual(["141,13 €".replace(" ", NBSP), "33,87 €".replace(" ", NBSP), "175,00 €".replace(" ", NBSP)]);
    for (const sum of [net, vat, gross]) expect(runs.some((r) => r.text === euro(sum)), euro(sum)).toBe(true);
    // the seller's VAT number is on a VAT invoice, the VAT-off sentence is not, Maria's footer line is
    expect(text).toContain("EE123456789");
    expect(text).not.toContain("käibemaksukohustuslane");
    expect(text).toContain("Küsimuste korral kirjuta aadressil info@example.test.");
    // not paid: no paid line
    expect(text).not.toContain("Tasutud");
    // the reference is a name, not a number: an explanation
    expect(text).toContain("Selgitus");
    expect(text).not.toContain("Viitenumber");
  });

  test("m3: the reference is a „Selgitus“, as the account and the mails call it, digits alone too (no check digit: no viitenumber); none, no line", async () => {
    for (const reference of ["1234567", "42", "MSLAB-42"]) {
      const text = textOf((await render({ ...UNPAID, reference })).runs);
      expect(text, reference).toContain("Selgitus");
      expect(text, reference).toContain(reference);
      expect(text, reference).not.toContain("Viitenumber");
    }
    expect(textOf((await render({ ...UNPAID, reference: "" })).runs)).not.toMatch(/Viitenumber|Selgitus/);
  });

  test("the VAT split is the domain's: the rounding of 10 cents at 24 %", async () => {
    const { runs } = await render({ ...UNPAID, amountCents: 1001, vatRate: 24 });
    const { net, vat } = vatSplit(1001, 24);
    expect(runs.some((r) => r.text === euro(net))).toBe(true);
    expect(runs.some((r) => r.text === euro(vat))).toBe(true);
    expect(runs.filter((r) => r.text === euro(1001))).toHaveLength(2);
  });

  test("a VAT-on invoice born paid shows the VAT lines and the paid line, no due date", async () => {
    const { runs } = await render({ ...UNPAID, status: "paid", dueAt: null, paidAt: ISSUED, paidMethod: "montonio", reference: "" });
    const text = textOf(runs);
    expect(text).toContain("Käibemaks 24%");
    expect(text).toContain("Tasutud 16.10.2026 (Montonio)");
    expect(text).not.toContain("Maksetähtaeg");
    expect(text).not.toContain("IBAN");
  });

  test("an unpaid invoice shows its current buyer, a company when it pays: the company, its registry code and address, then the contact's name", async () => {
    const buyer: InvoiceBuyer = { name: "Kertu Õunapuu", email: "kertu@example.test", address: "Kase 5, Tartu", company: "Õunapuu Ilusalong FIE", companyCode: "87654321", companyAddress: "Riia 1, 51010 Tartu" };
    const { runs } = await render({ ...UNPAID, buyer });
    const text = textOf(runs);
    for (const s of ["Õunapuu Ilusalong FIE", "87654321", "Riia 1, 51010 Tartu", "Kertu Õunapuu"]) expect(text, s).toContain(s);
    const ys = ["Õunapuu Ilusalong FIE", "87654321", "Riia 1, 51010 Tartu"].map((t) => find(runs, t).y);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    expectFitsAndApart(runs);
  });

  test("an individual buyer's own address stands under her name and over her e-mail; when a company pays, the company's address is printed and the person's is not", async () => {
    const address = "Kase 5, 50409 Tartu";
    const { runs } = await render({ ...UNPAID, buyer: { ...BUYER, address } });
    const [name, at, mail] = [one(runs, BUYER.name), one(runs, address), one(runs, BUYER.email)];
    expect([name.x, at.x, mail.x]).toEqual([312, 312, 312]);
    expect(name.y).toBeGreaterThan(at.y);
    expect(at.y).toBeGreaterThan(mail.y);
    expectFitsAndApart(runs);
    const company: InvoiceBuyer = { ...BUYER, address, company: "Õunapuu Ilusalong FIE", companyCode: "87654321", companyAddress: "Riia 1, 51010 Tartu" };
    const text = textOf((await render({ ...UNPAID, buyer: company })).runs);
    expect(text).toContain("Riia 1, 51010 Tartu");
    expect(text).not.toContain(address);
  });

  test("with no bank details at all (receiver, IBAN and bank empty) there is no payment block: no heading, no reference, nothing between the total and the foot", async () => {
    const { runs } = await render({ ...UNPAID, seller: { ...SELLER, receiver: "", iban: "  ", bank: "" } });
    const text = textOf(runs);
    for (const word of ["Maksmiseks", "Saaja", "IBAN", "Pank", "Selgitus", "Viitenumber", "MSLAB42"]) expect(text, word).not.toContain(word);
    // the due date is still the invoice's own; the total is the last of the body, only Maria's footer line stands under it
    expect(text).toContain("23.10.2026");
    const total = find(runs, "Kokku").y;
    expect(runs.filter((r) => r.y < total).map((r) => r.text)).toEqual([UNPAID.footer]);
    // one detail is enough for the block
    for (const seller of [{ ...SELLER, receiver: "", bank: "" }, { ...SELLER, iban: "", bank: "" }, { ...SELLER, receiver: "", iban: "" }])
      expect(textOf((await render({ ...UNPAID, seller })).runs), JSON.stringify(seller)).toContain("Maksmiseks");
  });

  test("a cancelled invoice says so and asks for no payment", async () => {
    const { runs } = await render({ ...UNPAID, status: "cancelled" });
    const text = textOf(runs);
    expect(text).toContain("Tühistatud");
    expect(text).not.toContain("IBAN");
    expect(text).not.toContain("Maksetähtaeg");
    expect(text).not.toContain("Tasutud");
    expect(text).toContain("ARVE MSL2026-002");
  });
});

describe("renderInvoice: the line", () => {
  test("an e-course has no session: no empty line, and an empty part is the kind's own words", async () => {
    const { runs } = await render({ ...PAID, kind: "ecourse", line: { course: "Kulmude e-koolitus", session: "", part: "" } });
    expect(textOf(runs)).toContain("Kulmude e-koolitus");
    expect(textOf(runs)).toContain("E-koolitus");
    expect(runs.every((r) => r.text.trim() !== "")).toBe(true);
  });

  test("the line stands as the course, the session and the part, one under the other, the sum at the right on the course's baseline", async () => {
    const { runs } = await render(PAID);
    const [course, session, part] = [one(runs, PAID.line.course), one(runs, PAID.line.session), one(runs, PAID.line.part)];
    expect(course.y).toBeGreaterThan(session.y);
    expect(session.y).toBeGreaterThan(part.y);
    expect(course.x).toBe(session.x);
    const total = runs.filter((r) => r.text === euro(17500)).sort((a, b) => b.y - a.y);
    expect(total[0].y).toBe(course.y);
    expect(total[0].x + widthOf(total[0])).toBeCloseTo(INVOICE_PAGE.width - 48, 1);
  });
});

describe("renderInvoice: long texts stay on the page", () => {
  const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i + 1}`).join(" ");

  test("a 200-character course title and a 120-character company name wrap inside their boxes", async () => {
    const longCourse = words(40, "Kursus").slice(0, 200).trim();
    expect(longCourse.length).toBeGreaterThanOrEqual(190);
    const company = words(20, "Firma").slice(0, 120).trim();
    expect(company.length).toBeGreaterThanOrEqual(110);
    const receiver = words(12, "Vastu"); // a receiver of its own, not the company's text
    for (const status of ["paid", "unpaid"] as const) {
      const { runs } = await render({ ...UNPAID, status, line: { ...UNPAID.line, course: longCourse }, seller: { ...SELLER, company, receiver }, buyer: { ...BUYER, company } });
      expectFitsAndApart(runs);
      // nothing is lost: the course's lines, one under the other, read as the title; the company's too, wherever it is printed
      const first = find(runs, "Kursus1 ");
      const course = runs.filter((r) => r.x === first.x && r.size === first.size && r.y > find(runs, "Kokku").y).sort((a, b) => b.y - a.y);
      expect(course.map((r) => r.text).join(" ")).toBe(longCourse);
      expect(course.length).toBeGreaterThan(1);
      expect(runs.filter((r) => r.text.startsWith("Firma1 ")).map((r) => r.x)).toEqual([48, 312]); // the seller's block and the buyer's
      const receiverLines = runs.filter((r) => /^Vastu\d/.test(r.text)).sort((a, b) => b.y - a.y);
      if (status === "unpaid") {
        expect(receiverLines.map((r) => r.text).join(" ")).toBe(receiver);
        expect(receiverLines.every((r) => r.x === 48 + 82)).toBe(true);
      } else expect(receiverLines).toEqual([]); // a paid invoice has no bank block
    }
  });

  test("words with no space in them are broken at the box, not drawn past it", async () => {
    const long = "A".repeat(200);
    const { runs } = await render({ ...UNPAID, line: { course: long, session: "B".repeat(120), part: "C".repeat(120) }, seller: { ...SELLER, company: "D".repeat(120), address: "E".repeat(200) }, buyer: { ...BUYER, name: "F".repeat(120), email: `${"g".repeat(240)}@example.test` }, footer: "H".repeat(300) });
    expectFitsAndApart(runs);
    // the 200 letters are all there, in lines
    expect(runs.filter((r) => /^A+$/.test(r.text)).map((r) => r.text).join("")).toBe(long);
  });

  test("past the lines its box allows a text is cut with an ellipsis: a title of thousands of characters takes eight lines", async () => {
    const { runs } = await render({ ...UNPAID, line: { ...UNPAID.line, course: words(500, "Kursus") } });
    expectFitsAndApart(runs);
    const first = find(runs, "Kursus1 ");
    const course = runs.filter((r) => r.x === first.x && r.size === first.size && r.y > find(runs, "Kokku").y).sort((a, b) => b.y - a.y);
    expect(course).toHaveLength(8);
    expect(course[7].text).toMatch(/^Kursus\d+( Kursus\d+)*…$/);
    expect(course.slice(0, 7).every((r) => !r.text.endsWith("…"))).toBe(true);
  });

  test("everything at its largest at once (every field at its limit in the widest letter, the largest sum, a long footer) shrinks to one page and touches nothing", async () => {
    const L = INVOICE_LIMITS;
    const wide = (n: number) => "W".repeat(n);
    const c: InvoiceContent = {
      ...UNPAID,
      number: "MSLMSLMSL2026-2147483647",
      amountCents: 2_147_483_647,
      line: { course: wide(300), session: wide(120), part: wide(120) },
      seller: { company: wide(L.company), registryCode: "9".repeat(L.registryCode), address: wide(L.address), vatNumber: "EE" + "9".repeat(L.vatNumber - 2), receiver: wide(L.company), iban: "EE" + "9".repeat(32), bank: wide(60) },
      buyer: { name: wide(L.name), email: `${wide(60)}@${wide(60)}.example.test`, address: wide(L.buyerAddress), company: wide(L.company), companyCode: "8".repeat(L.registryCode), companyAddress: wide(L.address) },
      reference: wide(120),
      footer: wide(L.footer),
    };
    const { runs, pages } = await render(c);
    expect(pages).toHaveLength(1);
    expectFitsAndApart(runs);
    // it did not fit at its nominal size: the whole page was composed smaller (the number's heading is 20 pt)
    expect(find(runs, "ARVE").size).toBeLessThan(20);
    // the largest sum is a whole text too
    expect(runs.filter((r) => r.text === euro(2_147_483_647))).toHaveLength(2);
  });
});

describe("renderInvoice: text the font cannot draw", () => {
  test("a character Jost lacks is drawn as a question mark, not as a missing-glyph box; control characters and line breaks are dropped or become a space", async () => {
    const { runs } = await render({ ...PAID, buyer: { ...BUYER, name: "Anna 😀\u0007 Tamm\nJr" } });
    expect(textOf(runs)).toContain("Anna ? Tamm Jr");
    expect(textOf(runs)).not.toContain("�");
  });

  test("Russian names are drawn as they are (Jost has Cyrillic)", async () => {
    const { runs } = await render({ ...PAID, buyer: { ...BUYER, name: "Анна Иванова" } });
    expect(textOf(runs)).toContain("Анна Иванова");
  });
});
