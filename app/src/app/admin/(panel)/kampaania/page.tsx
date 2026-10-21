import type { Metadata } from "next";
import { CampaignEditor } from "@/components/admin/CampaignEditor";
import { adminTitle } from "@/components/admin/sections";
import { getDb } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { loadCampaign } from "@/server/admin-site";
import { requireAdmin } from "@/server/auth";
import { linkSuggestions } from "@/server/site-links";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.campaign) };

/** Hüpikaken: what the home page shows (Kampaania, Uudiskiri or Väljas) and both popups' editors with their live previews (Task 13B, M2–M5; phase 2c). */
export default async function CampaignEditPage() {
  await requireAdmin();
  const db = getDb();
  const [initial, links] = await Promise.all([loadCampaign(db), linkSuggestions(db)]);
  return <CampaignEditor initial={initial} links={links} />;
}
