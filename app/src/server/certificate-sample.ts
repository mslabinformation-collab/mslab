import { formatCertificateNumber, readCertificateSettings } from "@/domain/certificate";
import type { FrozenDesign } from "@/domain/certificate-design";
import { adminEt } from "@/i18n/dict/admin";
import type { MediaSource } from "./media";

// Seaded → „Näidistunnistus (PDF)“ (Dim 07.11.2026, as the sample invoice and contract): a sample certificate drawn from the values the card
// „Tunnistus“ shows right now, saved or not, so Maria sees her certificate before any student gets one. Nothing is stored and no number is used:
// the sample's number is only the one the card says the next certificate gets. The values come as the card's text fields (the route's query), read
// as defensively as the stored setting is (domain/certificate.ts readCertificateSettings: a blank or over-long text is the default, a trainer's name
// the name rules refuse is Maria Sosnina, a number pair that does not fit is this Tallinn year's 1). The student and her course are made up
// (adminEt.certificates.sample). The PDF stack is imported when a sample is drawn, as certificatePdf does (tests/unit/certificate-lazy-pdf.test.ts).

/** The card's fields as the route reads them: text by name, anything missing absent. */
export type CertificateSampleValues = Partial<Record<"place" | "registryCode" | "practicalLine" | "trainerName" | "nextYear" | "nextSeq", string>>;

/** A whole number written in digits, else NaN (readCertificateSettings then takes its default). */
const whole = (v: string | undefined): number => (typeof v === "string" && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : NaN);

/**
 * The PDF of a sample certificate as the card shows it at `now`, issued today: the made-up student, course, lines and volume, in `design` (2026-11-11
 * certificate designs: its tone, and its photo read from `store`, which must have it; none: today's dark page).
 */
export async function sampleCertificatePdf(values: CertificateSampleValues, now: Date, design: FrozenDesign | null = null, store: MediaSource | null = null): Promise<Uint8Array> {
  const t = adminEt.certificates.sample;
  const settings = readCertificateSettings(
    {
      place: values.place,
      registryCode: values.registryCode,
      practicalLine: values.practicalLine,
      trainerName: values.trainerName,
      nextYear: whole(values.nextYear),
      nextSeq: whole(values.nextSeq),
    },
    now,
  );
  const { lookOf, loadCertificateAssets, renderCertificate } = await import("./certificate-pdf");
  const [assets, look] = await Promise.all([loadCertificateAssets(), lookOf(design, store)]);
  return renderCertificate(
    {
      number: formatCertificateNumber(settings.nextYear, settings.nextSeq),
      name: t.name,
      courseTitle: t.course,
      skills: [...t.skills],
      volume: t.volume,
      practicalLine: settings.practicalLine,
      place: settings.place,
      registryCode: settings.registryCode,
      issuedAt: now,
      trainerName: settings.trainerName,
    },
    assets,
    look,
  );
}
