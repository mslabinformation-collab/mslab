import type { Db } from "@/db/client";
import { contractLocale, contractParts, filledContract, schoolOf } from "@/domain/contract";
import { adminEt } from "@/i18n/dict/admin";
import { getInvoiceSettings } from "./invoices";

// Seaded → „Näidisleping (PDF)“ (contracts Task 5, spec §4): a sample contract drawn from the texts the card shows right now — its draft, published or
// not (admin UX pass piece 3b, ruling R-d: api/admin/naidisleping reads the stored draft when the card posts no text) —, so Maria sees what her
// contract will look like before she publishes it. Nothing is stored. The student, the course and the session are made up (adminEt.contracts.sample);
// the school is Seaded → Maksmine as it is stored, "MS LAB" before she names the company (domain/contract.ts schoolOf), the price and the
// payment choice are a 350 € course paid in halves, so that every placeholder has a value. The text is filled by the very function the registration form
// fills its inline contract with (domain/contract.ts filledContract), in the language chosen: Russian when asked for and the Russian text is written
// (domain/contract.ts contractLocale), else Estonian, a language's empty title falling back to the Estonian one as a student's contract does
// (server/contracts.ts contractTemplate). A text the card leaves empty is a stand-in in brackets, so the layout is whole. The PDF stack is imported
// when a sample is drawn, as contractPdf does (tests/unit/contract-lazy-pdf.test.ts).

/** The card's texts as the route reads them: text by name, anything missing absent. */
export type ContractSampleValues = Partial<Record<"titleEt" | "titleRu" | "bodyEt" | "bodyRu" | "lang", string>>;

/** The sample's course: a 350 € day on 14.11.2026, which the payment choice "half" splits into two halves of 175 €. */
const PRICE_CENTS = 35_000;
const SESSION_STARTS = new Date("2026-11-14T08:00:00Z");

/** The PDF of a sample contract as the card shows it at `now`. */
export async function sampleContractPdf(db: Db, values: ContractSampleValues, now: Date): Promise<Uint8Array> {
  const t = adminEt.contracts.sample;
  const ru = (values.bodyRu ?? "").trim() !== "";
  const locale = contractLocale(values.lang === "ru" ? "ru" : "et", ru);
  const pick = (et: string | undefined, other: string | undefined): string => {
    const text = locale === "ru" && (other ?? "").trim() ? (other as string) : (et ?? "");
    return text.trim();
  };
  const input = {
    name: t.student,
    email: t.email,
    course: locale === "ru" ? t.courseRu : t.course,
    session: { startsAt: SESSION_STARTS, city: t.city },
    priceCents: PRICE_CENTS,
    choice: "half" as const,
    locale,
  };
  const filled = filledContract({ title: pick(values.titleEt, values.titleRu) || t.title, body: pick(values.bodyEt, values.bodyRu) || t.body }, input);
  const { fields } = contractParts(input);
  const school = schoolOf(await getInvoiceSettings(db, now));
  const [{ renderContract }, { loadCertificateAssets }] = await Promise.all([import("./contract-pdf"), import("./certificate-pdf")]);
  const assets = await loadCertificateAssets();
  return renderContract(
    { title: filled.title, body: filled.body, fields: { school, ...fields }, acceptedAt: now, acceptedVia: "form", locale, supersededAt: null },
    { sans: assets.sans },
  );
}
