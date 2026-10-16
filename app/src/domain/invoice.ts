// The invoices' pure rules (invoices, Task 1; spec §2 D2–D8, §6): the kinds, states and shapes an invoice freezes, Seaded → Arve andmed's limits
// and defaults with their defensive read, the number and its series, the VAT split, the euro text, the amounts still open on a registration,
// the kind of an online payment's invoice, the download's file name and headers, and the accountant's CSV. No database, no React: the server,
// Maria's screens and the student's account share them. It may run in the browser (Seaded's card): no lookbehind here nor in what it imports
// (tests/unit/old-safari.test.ts).

import type { Invoice } from "@/db/schema";
import { seqToIssue, tallinnDateText, tallinnYear } from "./certificate";
import { prepaymentDue } from "./registration";

/** What an invoice is for (D4): a contact course's half, whole sum or rest, or an e-course's price. */
export type InvoiceKind = "prepayment" | "full" | "balance" | "ecourse";
/** unpaid → paid (and back, by Maria's own mark); unpaid → cancelled. A cancelled invoice keeps its number. */
export type InvoiceStatus = "unpaid" | "paid" | "cancelled";
/** How an invoice was paid (D6): online, or by Maria's mark. */
export type PaidMethod = "montonio" | "bank" | "cash" | "card";

/** The one line of an invoice, frozen at its creation (D4): the course's Estonian title, its session ("14.11.2026 Tallinn"; empty for an e-course) and the part ("Ettemaks 50%"). */
export type InvoiceLine = { course: string; session: string; part: string };
/** The seller as Seaded → Arve andmed and Ettemaksu juhised held it at the creation, frozen (D2). */
export type InvoiceSeller = { company: string; registryCode: string; address: string; vatNumber: string; receiver: string; iban: string; bank: string };
/** The buyer (D9): the registration's or the payment's name and e-mail, and what Maria added; a company only when it pays. */
export type InvoiceBuyer = { name: string; email: string; address: string; company: string; companyCode: string; companyAddress: string };

/** The `settings` key "invoice" as read (readInvoiceSettings): Seaded → Arve andmed and the series' next number. */
export type InvoiceSettings = {
  company: string;
  registryCode: string;
  address: string;
  /** The seller's VAT number (KMKR); empty: not VAT-registered. */
  vatNumber: string;
  /** VAT lines on the invoice. Only with a VAT number (readInvoiceSettings). */
  vatOn: boolean;
  /** Percent, whole: the rate the prices already contain (D8). */
  vatRate: number;
  /** The number's letters before the year: {prefix}{year}-{nnn}. Each prefix has its own series (D7). */
  prefix: string;
  /** The next invoice of `nextYear` (in the prefix's series) gets `nextSeq`; another year starts at 1. */
  nextYear: number;
  nextSeq: number;
  /** The days from the issue to the due date of an unpaid invoice. */
  termDays: number;
  /** An optional line at the foot of the PDF. */
  footer: string;
};

export const INVOICE_KEY = "invoice";

/** Before Maria saves Seaded → Arve andmed (D2, spec §3): nothing but the prefix, VAT off at the rate Estonia has used since 1.7.2025, a week to pay. */
export const INVOICE_DEFAULTS: Omit<InvoiceSettings, "nextYear" | "nextSeq"> = {
  company: "",
  registryCode: "",
  address: "",
  vatNumber: "",
  vatOn: false,
  vatRate: 24,
  prefix: "MSL",
  termDays: 7,
  footer: "",
};

/** The most characters of each field (Seaded's card, the buyer's editor); `termDays` and `vatRate` are the largest values. */
export const INVOICE_LIMITS = { company: 120, registryCode: 20, address: 200, vatNumber: 20, prefix: 10, footer: 300, termDays: 90, vatRate: 50, name: 120, buyerAddress: 200, note: 200 } as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The largest value of a Postgres integer column (invoices.seq). */
const INT4_MAX = 2_147_483_647;
const wholeIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * The stored setting read defensively (jsonb: anything), as readCertificateSettings reads its own. Each text is trimmed; a missing, blank or
 * over-long one is the default. The VAT rate is a whole 1–50 (VAT off is `vatOn`, not a rate of 0) and the term a whole 0–90 days, else the
 * default. VAT is on only with a VAT number (D8), whatever was stored. The next number is a pair: a whole year 2000–9999 and a whole number
 * from 1 up to the largest the seq column holds (INT4_MAX: a larger one would fail the insert, inside the transaction that marks a payment
 * paid), else both are the default (this Tallinn year, 1).
 */
export function readInvoiceSettings(value: unknown, now: Date): InvoiceSettings {
  const v = isObject(value) ? value : {};
  const text = (key: "company" | "registryCode" | "address" | "vatNumber" | "prefix" | "footer"): string => {
    const s = typeof v[key] === "string" ? (v[key] as string).trim() : "";
    return s && s.length <= INVOICE_LIMITS[key] ? s : INVOICE_DEFAULTS[key];
  };
  const numbered = wholeIn(v.nextYear, 2000, 9999) && wholeIn(v.nextSeq, 1, INT4_MAX);
  const vatNumber = text("vatNumber");
  return {
    company: text("company"),
    registryCode: text("registryCode"),
    address: text("address"),
    vatNumber,
    vatOn: v.vatOn === true && vatNumber !== "",
    vatRate: wholeIn(v.vatRate, 1, INVOICE_LIMITS.vatRate) ? v.vatRate : INVOICE_DEFAULTS.vatRate,
    prefix: text("prefix"),
    nextYear: numbered ? (v.nextYear as number) : tallinnYear(now),
    nextSeq: numbered ? (v.nextSeq as number) : 1,
    termDays: wholeIn(v.termDays, 0, INVOICE_LIMITS.termDays) ? v.termDays : INVOICE_DEFAULTS.termDays,
    footer: text("footer"),
  };
}

/** No invoice is made before the seller is named (D3): the company, its registry code and its address. */
export function sellerReady(s: InvoiceSettings): boolean {
  return s.company !== "" && s.registryCode !== "" && s.address !== "";
}

/** "MSL2026-001" (D7): the number padded to at least 3 digits, so 2026-1000 once the year reaches it. */
export function formatInvoiceNumber(prefix: string, year: number, seq: number): string {
  return `${prefix}${year}-${String(seq).padStart(3, "0")}`;
}

/**
 * The seq an invoice issued in `year` (its Tallinn year, tallinnYear) takes under the setting's prefix, and the setting after it (D7): the
 * certificate's rule (seqToIssue) for this series. `top` is the highest seq already issued under that prefix in that year (0 for none), so
 * a new prefix, which has none, starts at the setting's number, 1 unless Maria set it higher.
 */
export function invoiceSeq(s: { nextYear: number; nextSeq: number }, year: number, top: number): { seq: number; next: { nextYear: number; nextSeq: number } } {
  const { seq, next } = seqToIssue(s, year, top);
  return { seq, next };
}

/**
 * A gross sum in cents split into its net and its VAT (D8): vat = round(gross × rate / (100 + rate)), net = gross − vat, so the two always
 * add up to the gross. No rate (VAT off): all net.
 */
export function vatSplit(grossCents: number, rate: number | null): { net: number; vat: number; gross: number } {
  const vat = rate === null ? 0 : Math.round((grossCents * rate) / (100 + rate));
  return { net: grossCents - vat, vat, gross: grossCents };
}

const NBSP = "\u00a0";

/**
 * "175,00 €": the euros and always two cents, a comma, the thousands and the sign set off by no-break spaces so that an amount never breaks
 * across lines. The amounts are positive (an invoice's amount_cents is above 0).
 */
export function euro(cents: number): string {
  const whole = String(Math.floor(cents / 100));
  let grouped = "";
  for (let i = 0; i < whole.length; i++) grouped += (i > 0 && (whole.length - i) % 3 === 0 ? NBSP : "") + whole[i];
  return `${grouped},${String(cents % 100).padStart(2, "0")}${NBSP}€`;
}

/** What an invoice is for, in words (D4, the line's part). */
export function partText(kind: InvoiceKind): string {
  switch (kind) {
    case "prepayment": return "Ettemaks 50%";
    case "full": return "Kogu summa (100%)";
    case "balance": return "Jääk 50%";
    case "ecourse": return "E-koolitus";
  }
}

/** The state in words (D6, the CSV and the screens). */
export function invoiceStatusText(status: InvoiceStatus): string {
  switch (status) {
    case "unpaid": return "Tasumata";
    case "paid": return "Tasutud";
    case "cancelled": return "Tühistatud";
  }
}

/** How it was paid, in words (D6). */
export function paidMethodText(method: PaidMethod): string {
  switch (method) {
    case "montonio": return "Montonio";
    case "bank": return "Pangaülekanne";
    case "cash": return "Sularaha";
    case "card": return "Kaardimakse kohapeal";
  }
}

export type OpenAmount = { kind: InvoiceKind; cents: number; part: string };

/**
 * The amounts Maria may still invoice on a registration (D5, §6.2): "open" is not yet covered by an invoice, where covered is the sum of its
 * unpaid and paid invoices (a cancelled one counts for nothing). With the half choice: the prepayment (the site's own, prepaymentDue: half the
 * price rounded up to the cent, so a paid one makes the 50 % that confirms the place, ruling R11) while there is no prepayment or whole-sum
 * invoice, the whole sum while nothing is covered, and the rest (price − covered) once something is covered but not all. With the whole-sum choice: the whole sum while nothing is covered. A prepayment and a whole sum exclude
 * each other; an amount of nothing is never offered.
 */
export function openAmounts(
  r: { priceCents: number; paymentChoice: "full" | "half" },
  invoiced: { kind: InvoiceKind; status: InvoiceStatus; amountCents: number }[],
): OpenAmount[] {
  const live = invoiced.filter((i) => i.status !== "cancelled");
  const covered = live.reduce((sum, i) => sum + i.amountCents, 0);
  const out: OpenAmount[] = [];
  const offer = (kind: InvoiceKind, cents: number) => {
    if (cents > 0) out.push({ kind, cents, part: partText(kind) });
  };
  if (r.paymentChoice === "half") {
    if (!live.some((i) => i.kind === "prepayment" || i.kind === "full")) offer("prepayment", prepaymentDue(r.priceCents, "half"));
    if (covered === 0) offer("full", r.priceCents);
    if (covered > 0 && covered < r.priceCents) offer("balance", r.priceCents - covered);
  } else if (covered === 0) {
    offer("full", r.priceCents);
  }
  return out;
}

/**
 * The kind of the invoice an online payment makes (D5): a prepayment paid by someone who chose to pay the whole sum is the whole sum
 * ("Kogu summa (100%)"), a prepayment of the half choice (or of a registration since deleted) is the prepayment; the rest and an e-course keep their own.
 */
export function invoiceKindOfPayment(p: { kind: "prepayment" | "balance" | "ecourse" }, r: { paymentChoice: "full" | "half" } | null): InvoiceKind {
  if (p.kind === "prepayment") return r?.paymentChoice === "full" ? "full" : "prepayment";
  return p.kind;
}

/**
 * "MS-LAB-arve-MSL2026-001.pdf": the download's file name (Content-Disposition). The prefix is Maria's free text, so a character outside
 * letters, digits, dot, underscore and hyphen (a quote, a line break, a letter a header cannot carry) becomes a hyphen.
 */
export function invoiceFileName(number: string): string {
  return `MS-LAB-arve-${number.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`;
}

/**
 * The three headers every invoice download carries (spec §4), whoever asks: the type, the file name by its number, nosniff. The caller adds
 * `cache-control: private, no-store` (the student's route through BASE_HEADERS, Maria's route by itself).
 */
export function invoiceDownloadHeaders(number: string): Record<string, string> {
  return {
    "content-type": "application/pdf",
    "content-disposition": `attachment; filename="${invoiceFileName(number)}"`,
    "x-content-type-options": "nosniff",
  };
}

/** The columns of the accountant's file (§6.5), in order. */
const CSV_HEADER = [
  "Arve nr", "Kuupäev", "Tasumise tähtaeg", "Ostja", "Ostja ettevõte", "Registrikood", "Kirjeldus", "Summa käibemaksuta", "Käibemaks", "Kokku",
  "Olek", "Tasumise kuupäev", "Makseviis",
];

/** "175,50": cents as euros with a comma and no grouping, which a spreadsheet reads as a number. */
const csvAmount = (cents: number): string => `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;

/**
 * A text the buyer or Maria typed, as one field. A text that a spreadsheet would read as a formula (a name typed into the public form lands
 * in Maria's file), that is one whose first character after any white space is = + - @ (or a tab or CR), gets a leading apostrophe. Then it
 * is always quoted, a quote doubled, so that neither `;` nor `,` splits it in any locale's spreadsheet. The sums are not texts: they stay bare.
 */
function csvText(raw: string): string {
  const s = /^\s*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * The CSV for the accountant (§6.5): a row per invoice in the order given, `;`-separated for Estonian Excel, UTF-8 with a BOM, CRLF line
 * ends. Dates are Tallinn dd.mm.yyyy. A cancelled invoice stays in the file marked „Tühistatud" with zero sums; the paid date and the way
 * are those of a paid invoice only. Sums are net, VAT and total (the invoice's amount is the gross; no rate: all net).
 */
export function invoiceCsv(rows: Invoice[]): string {
  const lines = rows.map((i) => {
    const sums = i.status === "cancelled" ? { net: 0, vat: 0, gross: 0 } : vatSplit(i.amountCents, i.vatRate);
    const paid = i.status === "paid";
    return [
      csvText(i.number),
      tallinnDateText(i.issuedAt),
      i.dueAt ? tallinnDateText(i.dueAt) : "",
      csvText(i.buyer.name),
      csvText(i.buyer.company),
      csvText(i.buyer.companyCode),
      csvText(`${i.line.course} — ${i.line.part}`),
      csvAmount(sums.net),
      csvAmount(sums.vat),
      csvAmount(sums.gross),
      invoiceStatusText(i.status),
      paid && i.paidAt ? tallinnDateText(i.paidAt) : "",
      paid && i.paidMethod ? paidMethodText(i.paidMethod) : "",
    ].join(";");
  });
  return `\uFEFF${[CSV_HEADER.join(";"), ...lines].join("\r\n")}\r\n`;
}
