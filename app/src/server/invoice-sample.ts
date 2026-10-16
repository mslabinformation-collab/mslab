import type { Db } from "@/db/client";
import { readSetting } from "@/db/queries/public";
import { paymentReference, PREPAYMENT_KEY } from "@/domain/account-cards";
import { tallinnYear } from "@/domain/certificate";
import { formatInvoiceNumber, INVOICE_LIMITS, partText, readInvoiceSettings } from "@/domain/invoice";
import { prepaymentDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";

// Seaded → „Näidisarve (PDF)“ (invoices Task 5, spec §5): a sample invoice drawn from the values the card shows right now, saved or not, so Maria
// sees what her invoice will look like before she saves. Nothing is stored and no number is used: the sample's number is only the one the
// next invoice would get. The values come as the card's text fields (the route's query), read as defensively as the stored setting is
// (domain/invoice.ts readInvoiceSettings: a value that does not fit is the default). A field the card leaves empty, the seller's or the bank's,
// is a stand-in in brackets (adminEt.invoices.sample), so the layout is whole. The course, the date and the buyer are made up. The PDF stack
// is imported when a sample is drawn, as invoicePdf does (tests/unit/invoices-lazy-pdf.test.ts).

/** The card's fields as the route reads them: text by name, anything missing absent. */
export type SampleValues = Partial<Record<"company" | "registryCode" | "address" | "vatNumber" | "vatOn" | "vatRate" | "prefix" | "nextYear" | "nextSeq" | "termDays" | "footer", string>>;

/** A whole number written in digits, else NaN (readInvoiceSettings then takes its default). */
const whole = (v: string | undefined): number => (typeof v === "string" && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : NaN);

/** The 17500 cents of the sample: a half of a 350 € course, the figure the spec's examples use. */
const SAMPLE_CENTS = 17500;
const DAY = 86_400_000;

/**
 * The PDF of a sample invoice as the card shows it at `now`. The seller is the card's company, registry code, address and VAT number, with the
 * bank details of Ettemaksu juhised as they are stored; VAT is on when the card says so and has a VAT number (as the save would keep it); the
 * number is the card's prefix (capitals, or MSL when it is no prefix), this Tallinn year and the card's next number (1 for another year).
 */
export async function sampleInvoicePdf(db: Db, values: SampleValues, now: Date): Promise<Uint8Array> {
  const t = adminEt.invoices.sample;
  const settings = readInvoiceSettings(
    {
      company: values.company,
      registryCode: values.registryCode,
      address: values.address,
      vatNumber: values.vatNumber,
      vatOn: values.vatOn === "1" || values.vatOn === "on" || values.vatOn === "true",
      vatRate: whole(values.vatRate),
      prefix: values.prefix,
      nextYear: whole(values.nextYear),
      nextSeq: whole(values.nextSeq),
      termDays: whole(values.termDays),
      footer: values.footer,
    },
    now,
  );
  const stored = await readSetting(db, PREPAYMENT_KEY);
  const bank = prepaymentDraft(stored);
  const prefix = /^[A-Za-z0-9]{1,10}$/.test(settings.prefix) && settings.prefix.length <= INVOICE_LIMITS.prefix ? settings.prefix.toUpperCase() : "MSL";
  const year = tallinnYear(now);
  const number = formatInvoiceNumber(prefix, year, settings.nextYear === year ? settings.nextSeq : 1);
  const [{ renderInvoice }, { loadCertificateAssets }] = await Promise.all([import("./invoice-pdf"), import("./certificate-pdf")]);
  const fonts = await loadCertificateAssets();
  // (the due date is the term after today on the clock, which is enough for a sample: no change of the clocks matters here)
  const dueAt = new Date(now.getTime() + settings.termDays * DAY);
  return renderInvoice(
    {
      number,
      kind: "prepayment",
      status: "unpaid",
      amountCents: SAMPLE_CENTS,
      vatRate: settings.vatOn ? settings.vatRate : null,
      line: { course: t.course, session: t.session, part: partText("prepayment") },
      seller: {
        company: settings.company || t.company,
        registryCode: settings.registryCode || t.registryCode,
        address: settings.address || t.address,
        vatNumber: settings.vatNumber,
        receiver: bank.receiver.trim() || t.receiver,
        iban: bank.iban.trim() || t.iban,
        bank: bank.bank.trim() || t.bank,
      },
      buyer: { name: t.buyer, email: t.buyerEmail, address: "", company: "", companyCode: "", companyAddress: "" },
      reference: paymentReference(bank, 42),
      issuedAt: now,
      dueAt,
      paidAt: null,
      paidMethod: null,
      footer: settings.footer,
    },
    { sans: fonts.sans },
  );
}
