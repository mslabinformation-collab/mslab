import type { Metadata } from "next";
import { CampaignEditor } from "@/components/admin/CampaignEditor";
import { adminTitle } from "@/components/admin/sections";
import { getDb } from "@/db/client";
import { readSetting } from "@/db/queries/public";
import { welcomeCodeOf } from "@/domain/welcome-code";
import { adminEt } from "@/i18n/dict/admin";
import { requireAdmin } from "@/server/auth";
import { readPopupSwitch, readSiteEditor } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.campaign) };

/**
 * Hüpikaken (C4, admin UX pass piece 4b, Task 4; the route stays /admin/kampaania): the home page's popup on the draft layer — its part `offer` as it is
 * now, its draft over live and live, read with the stamp (server/site-drafts.ts readSiteEditor, handed to the editor as it came: SiteEditorPage's
 * `parts` contract) — then „Lehel näidatakse“ as the live row has it (readPopupSwitch, read after the stamp), and whether Seaded has a welcome code (the
 * preview's button follows it, S4-Q4).
 */
export default async function CampaignEditPage() {
  await requireAdmin();
  const db = getDb();
  const { parts, stamp } = await readSiteEditor(db, "popup");
  const [shown, newsletter] = await Promise.all([readPopupSwitch(db), readSetting(db, "newsletter")]);
  return <CampaignEditor parts={parts} stamp={stamp} shown={shown} code={welcomeCodeOf(newsletter) !== ""} />;
}
