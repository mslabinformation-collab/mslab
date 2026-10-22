// The invoices' pure rules (invoices, Task 1; spec §2 D2–D8, §6): the kinds, states and shapes an invoice freezes, Seaded → Arve andmed's limits
// and defaults with their defensive read, the number and its series, the VAT split, the euro text, the amounts still open on a registration,
// the kind of an online payment's invoice, the download's file name and headers, and the accountant's CSV. No database, no React: the server,
// Maria's screens and the student's account share them. It may run in the browser (Seaded's card): no lookbehind here nor in what it imports
// (tests/unit/old-safari.test.ts).

import type { Invoice } from "@/db/schema";
import { tallinnFormParts, tallinnInstant } from "./calendar";
import { seqToIssue, tallinnDateText, tallinnYear } from "./certificate";
import { prepaymentDue, type PaymentChoice } from "./registration";

/** What an invoice is for (D4): a contact course's half, whole sum or rest, or an e-course's price. */
export type InvoiceKind = "prepayment" | "full" | "balance" | "ecourse";
/** unpaid → paid (and back, by Maria's own mark); unpaid → cancelled. A cancelled invoice keeps its number. */
export type InvoiceStatus = "unpaid" | "paid" | "cancelled";
/** How an invoice was paid (D6): online ("montonio"; "financing" is Järelmaks (Inbank), instalments spec D6), or by Maria's mark. */
export type PaidMethod = "montonio" | "bank" | "cash" | "card" | "financing";
/** The ways Maria marks or records money herself: the online ones, Montonio's and Inbank's, are the site's own. */
export type ManualPaidMethod = Exclude<PaidMethod, "montonio" | "financing">;

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

/**
 * What a paid invoice whose online payment was refunded or voided reads (spec D5, the final review's I3): on Maria's screens, the student's card
 * and the CSV. Read-side only: the invoice stays stored paid, its sums as issued.
 */
export const REFUNDED = "Tagastatud";

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
    case "financing": return "Järelmaks (Inbank)";
  }
}

/**
 * The words of a part that is no half, whole sum or rest of the price (Draft, the final review's m4/m10): a sum typed by hand into „Laekunud
 * summa“, or an online payment of what such a sum left.
 */
export const ODD_PART = "Osamakse";

/**
 * The part an amount of `kind` is of the price, in words (the line's part, D4): the kind's own words (partText) when the amount is that part
 * exactly — the prepayment the site's own half (prepaymentDue, rounded up), the whole sum the price, the rest the price less that half — else
 * „Osamakse“ (ODD_PART): an „Ettemaks 50%“ of 100 € or a „Kogu summa (100%)“ of 250 € would say what the money is not (m10). An e-course, or a
 * registration without a price, keeps its kind's words.
 */
export function partOf(kind: InvoiceKind, cents: number, priceCents: number | null): string {
  if (kind === "ecourse" || priceCents === null) return partText(kind);
  const half = prepaymentDue(priceCents, "half");
  const exact = kind === "prepayment" ? half : kind === "full" ? priceCents : priceCents - half;
  return cents === exact ? partText(kind) : ODD_PART;
}

export type OpenAmount = { kind: InvoiceKind; cents: number; part: string };
/** What „Koosta arve“ offers, by the kind Maria picks: „Maksmiseks“ (a request to pay) and „Juba tasutud“ (a receipt). */
export type OpenAmounts = { request: OpenAmount[]; receipt: OpenAmount[] };
/** What covers a registration's price: an invoice (or a paid payment's money counted as one, coveringInvoices). */
export type Covering = { kind: InvoiceKind; status: InvoiceStatus; amountCents: number };

/**
 * The amounts Maria may still invoice on a registration (D5, §6.2, the final review's I1 and m4). `invoiced` is what covers its price
 * (coveringInvoices: its invoices, and its paid online payments that have no invoice yet, as paid). Covered is the sum of the unpaid and the
 * paid ones (a cancelled one counts for nothing); `paidCents` is Laekunud summa, and the part of it no paid one covers is money typed by hand
 * (uncovered; never more than the price leaves open).
 * - **Maksmiseks** never asks again for money already in: the prepayment (the site's own, prepaymentDue: half the price rounded up to the cent,
 *   so a paid one makes the 50 % that confirms the place, ruling R11) of the half choice while there is no prepayment or whole-sum invoice and
 *   nothing typed uncovered; the whole sum while nothing is covered or typed; the rest (price − covered − uncovered) once something is but not
 *   all. A prepayment and a whole sum exclude each other.
 * - **Juba tasutud**: with money typed uncovered, a receipt for exactly that money (it does not touch Laekunud summa, which holds it): the first
 *   money in (no paid prepayment or whole sum yet) is the whole sum when it is all of the price, else the half choice's prepayment or the whole
 *   choice's whole sum; later money is the rest. Its words are partOf's: „Osamakse“ when it is no half, whole or rest. Without such money, the
 *   same amounts as a request (money received and not typed: the rest paid at the venue).
 * An amount of nothing is never offered. Järelmaks (Inbank, `financing`) is the whole price, like „full“: only the half choice has a prepayment.
 */
export function openAmounts(r: { priceCents: number; paymentChoice: PaymentChoice; paidCents: number }, invoiced: readonly Covering[]): OpenAmounts {
  const price = r.priceCents;
  const live = invoiced.filter((i) => i.status !== "cancelled");
  const sum = (list: readonly Covering[]) => list.reduce((total, i) => total + i.amountCents, 0);
  const covered = sum(live);
  const paid = live.filter((i) => i.status === "paid");
  const uncovered = Math.max(0, Math.min(r.paidCents - sum(paid), price - covered));
  const accounted = covered + uncovered;
  const head = (list: readonly Covering[]) => list.some((i) => i.kind === "prepayment" || i.kind === "full");
  const amount = (kind: InvoiceKind, cents: number): OpenAmount[] => (cents > 0 ? [{ kind, cents, part: partOf(kind, cents, price) }] : []);
  const request = [
    ...(r.paymentChoice === "half" && !head(live) && uncovered === 0 ? amount("prepayment", prepaymentDue(price, "half")) : []),
    ...(accounted === 0 ? amount("full", price) : []),
    ...(accounted > 0 && accounted < price ? amount("balance", price - accounted) : []),
  ];
  if (uncovered === 0) return { request, receipt: request };
  const first = !head(paid);
  const kind: InvoiceKind = first && uncovered === price ? "full" : first ? (r.paymentChoice === "half" ? "prepayment" : "full") : "balance";
  return { request, receipt: amount(kind, uncovered) };
}

/** A paid online payment of a registration that no invoice names yet: it waits in „Arveta maksed“ (I1). */
export type UninvoicedPayment = { id: number; kind: "prepayment" | "balance" | "ecourse"; invoiceId: number | null; amountCents: number };

/** `payments` that are paid and that no invoice of `invoices` names as its payment (invoices.payment_id: ruling R13's "invoiced"). */
export function uninvoicedOf<P extends { id: number; status: string }>(payments: P[], invoices: { paymentId: number | null }[]): P[] {
  return payments.filter((p) => p.status === "paid" && !invoices.some((i) => i.paymentId === p.id));
}

/**
 * What covers a registration's price for openAmounts (the final review's I1): its invoices, and its paid online payments that have no invoice
 * yet (`uninvoiced`, uninvoicedOf), whose money is in Laekunud summa already and so counts as paid. Each such payment counts as what its
 * catch-up (server/invoices.ts catchUpInvoice) will make of it:
 * - started for an invoice of the registration that is still unpaid and of its sum (markLinkedInvoicePaid's test; R14): that invoice, paid —
 *   the first such payment only, a second one has its own;
 * - otherwise a paid invoice of its own, of the kind of the invoice it was started for (R7) or else of invoiceKindOfPayment's.
 */
export function coveringInvoices(
  r: { paymentChoice: PaymentChoice },
  invoices: (Covering & { id: number })[],
  uninvoiced: UninvoicedPayment[],
): Covering[] {
  const paidByCatchUp = new Set<number>();
  const own: Covering[] = [];
  for (const p of uninvoiced) {
    const linked = invoices.find((i) => i.id === p.invoiceId && i.amountCents === p.amountCents);
    if (linked && linked.status === "unpaid" && !paidByCatchUp.has(linked.id)) paidByCatchUp.add(linked.id);
    else own.push({ kind: linked?.kind ?? invoiceKindOfPayment(p, r), status: "paid", amountCents: p.amountCents });
  }
  return [...invoices.map((i) => ({ kind: i.kind, status: paidByCatchUp.has(i.id) ? ("paid" as const) : i.status, amountCents: i.amountCents })), ...own];
}

/**
 * The kind of the invoice an online payment makes (D5): a prepayment paid by someone who chose to pay the whole sum (Järelmaks (Inbank) too: it is
 * always the whole price, instalments spec D3) is the whole sum ("Kogu summa (100%)"), a prepayment of the half choice (or of a registration since
 * deleted) is the prepayment; the rest and an e-course keep their own.
 */
export function invoiceKindOfPayment(p: { kind: "prepayment" | "balance" | "ecourse" }, r: { paymentChoice: PaymentChoice } | null): InvoiceKind {
  if (p.kind === "prepayment") return r !== null && r.paymentChoice !== "half" ? "full" : "prepayment";
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

/** A month of Tallinn's calendar as the „Arved“ page's `?kuu=` and the CSV's name it, "2026-10"; null for anything else (a day, a space, a list, a month 00 or 13). */
export function parseMonth(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value) ? value : null;
}

/**
 * The instant of a day Maria gives for money received (the date of „Juba tasutud“ and of „Märgi tasutuks“): `date` is "YYYY-MM-DD" on
 * Tallinn's calendar. Today it is `now` itself; another day is noon of it in Tallinn, so that no zone reads it as the day before or after.
 * null for anything that is no real date. A day after today is returned as it is: the server refuses it (an invoice cannot be paid ahead).
 */
export function paidDay(date: unknown, now: Date): Date | null {
  if (typeof date !== "string") return null;
  return date === tallinnFormParts(now).date ? now : tallinnInstant(date, "12:00");
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
 * are those of a paid invoice only. Sums are net, VAT and total (the invoice's amount is the gross; no rate: all net). A paid invoice whose
 * payment was refunded or voided (`refunded`, D5, the final review's I3) reads „Tagastatud“, its sums, paid date and way as issued: the
 * accountant books the return (credit notes are out of scope).
 */
export function invoiceCsv(rows: (Invoice & { refunded?: boolean })[]): string {
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
      paid && i.refunded ? REFUNDED : invoiceStatusText(i.status),
      paid && i.paidAt ? tallinnDateText(i.paidAt) : "",
      paid && i.paidMethod ? paidMethodText(i.paidMethod) : "",
    ].join(";");
  });
  return `\uFEFF${[CSV_HEADER.join(";"), ...lines].join("\r\n")}\r\n`;
}
