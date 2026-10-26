import type { Metadata } from "next";
import { adminTitle } from "@/components/admin/sections";
import { TrainerEditor } from "@/components/admin/TrainerEditor";
import { getDb } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { et } from "@/i18n/dict/et";
import { requireAdmin } from "@/server/auth";
import { readSiteEditor } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.trainer) };

/**
 * Koolitaja: the trainer's parts on the draft layer (admin UX pass piece 4a, Task 5): every part as it is now — its draft over live, and live — read
 * with the stamp (server/site-drafts.ts readSiteEditor), handed to the editor as it came (SiteEditorPage's `parts` contract).
 */
export default async function TrainerEditPage() {
  await requireAdmin();
  const { parts, stamp } = await readSiteEditor(getDb(), "trainer");
  // an empty story title falls back to the site's own heading for it
  return <TrainerEditor parts={parts} stamp={stamp} storyTitles={{ center_story: et.trainer.storyTitle, trainer_journey: et.trainer.journeyTitle }} />;
}
