import type { Metadata } from "next";
import { CertificateSettings } from "@/components/admin/CertificateSettings";
import { ContractTexts } from "@/components/admin/ContractTexts";
import { InvoiceSettings } from "@/components/admin/InvoiceSettings";
import { adminTitle } from "@/components/admin/sections";
import { SettingsEditor } from "@/components/admin/SettingsEditor";
import { Shell } from "@/components/admin/Shell";
import { getDb } from "@/db/client";
import { readSetting } from "@/db/queries/public";
import { PREPAYMENT_KEY } from "@/domain/account-cards";
import { prepaymentDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { loadSettings } from "@/server/admin-site";
import { requireAdmin } from "@/server/auth";
import { certificateCard } from "@/server/certificates";
import { contractCard } from "@/server/contracts";
import { serverEnv } from "@/server/env";
import { invoiceCard } from "@/server/invoices";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.settings) };

/**
 * Seaded: contact details, social links, newsletter discount, legal pages; the admin addresses read-only (Task 13B). Then the e-course
 * certificate's card (phase 3d, spec §6): a form of its own after the settings' form, with its own save (a form cannot sit inside another,
 * and its rules are not a settings part's). Its "Koolitaja nimi" is the signature the PDF writes in the script font. Then „Arve andmed“
 * (invoices Task 5, spec D2): the seller every new invoice copies, with the bank details of „Ettemaksu juhised“ shown beside it, read-only. Last
 * „Lepingud“ (contracts Task 5, spec D2): the contact course's contract text and its sample; the e-course's contract keeps its card in the settings'
 * form („E-koolituse leping (tingimused)“).
 */
export default async function SettingsEditPage() {
  const email = await requireAdmin();
  const db = getDb();
  // the card shows the number the next issue will really get (in January, until the year's first issue, the stored one is still last year's)
  const now = new Date();
  const [initial, { settings: certificate, last }, invoice, storedBank, contract] = await Promise.all([
    loadSettings(db),
    certificateCard(db, now),
    invoiceCard(db, now),
    readSetting(db, PREPAYMENT_KEY),
    contractCard(db),
  ]);
  const bank = prepaymentDraft(storedBank);
  // the sign-in allow-list (the environment variable ADMIN_EMAILS): shown, never edited here
  const admins = serverEnv()
    .ADMIN_EMAILS.split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  return (
    <Shell email={email} active="settings">
      <SettingsEditor initial={initial} admins={admins} />
      <CertificateSettings
        initial={{
          place: certificate.place,
          registryCode: certificate.registryCode,
          practicalLine: certificate.practicalLine,
          trainerName: certificate.trainerName,
          nextYear: certificate.nextYear,
          nextSeq: certificate.nextSeq,
          last,
        }}
      />
      <InvoiceSettings initial={invoice} bank={{ receiver: bank.receiver, iban: bank.iban, bank: bank.bank }} />
      <ContractTexts initial={contract} />
    </Shell>
  );
}
