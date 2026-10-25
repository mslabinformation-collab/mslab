import type { Metadata } from "next";
import { adminTitle } from "@/components/admin/sections";
import { SettingsEditor } from "@/components/admin/SettingsEditor";
import { getDb } from "@/db/client";
import { readSetting } from "@/db/queries/public";
import { FINANCING_KEY, readFinancingSettings } from "@/domain/financing";
import { adminEt } from "@/i18n/dict/admin";
import { loadSettings } from "@/server/admin-site";
import { requireAdmin } from "@/server/auth";
import { certificateCard } from "@/server/certificates";
import { serverEnv } from "@/server/env";
import { invoiceCard } from "@/server/invoices";
import { reacceptCount, readLegalTexts } from "@/server/legal-drafts";
import { financingVersionOf } from "@/server/seaded";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.settings) };

/**
 * Seaded (admin UX pass piece 3b, Task 4; README B4, B21): one page with a section map — Kontakt, Uudiskiri, Maksmine, Tunnistus, Lepingud ja
 * tingimused, Halduse ligipääs — whose cards autosave under one SaveStatus (components/admin/SettingsEditor.tsx; api/admin/seaded/<part>). It reads
 * each part with the version its autosave goes from: the contact details, „Uudiskiri“ and the prepayment instructions (loadSettings), the invoice
 * settings as the next issue takes them (invoiceCard: the number, the last issued, B21: this Tallinn year), the certificate's card (certificateCard),
 * „Järelmaks (Inbank)“'s switch (off unless the stored value is exactly { enabled: true }, domain/financing.ts), the four legal texts with their
 * drafts (readLegalTexts, Task 5) and the students the e-course contract's publish asks again (reacceptCount, ruling R-e), and the admin addresses,
 * read-only. Its `now` is the cards' clock too (the invoice preview's year and the December line, the active accesses), so the page and its cards
 * never read two different days.
 */
export default async function SettingsEditPage() {
  await requireAdmin();
  const db = getDb();
  // the cards show the number the next issue will really get (in January, until the year's first issue, the stored one is still last year's)
  const now = new Date();
  const [initial, certificate, invoice, storedFinancing, legal, reaccept] = await Promise.all([
    loadSettings(db),
    certificateCard(db, now),
    invoiceCard(db, now),
    readSetting(db, FINANCING_KEY),
    readLegalTexts(db),
    reacceptCount(db, now),
  ]);
  // the sign-in allow-list (the environment variable ADMIN_EMAILS): shown, never edited here
  const admins = serverEnv()
    .ADMIN_EMAILS.split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  return (
    <SettingsEditor
      initial={initial}
      admins={admins}
      invoice={invoice}
      certificate={{ ...certificate.settings, last: certificate.last, version: certificate.version }}
      financing={{ ...readFinancingSettings(storedFinancing), version: await financingVersionOf(storedFinancing) }}
      legal={legal}
      reaccept={reaccept}
      now={now}
    />
  );
}
