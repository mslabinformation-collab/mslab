import type { Metadata } from "next";
import { adminTitle } from "@/components/admin/sections";
import { TrainerEditor } from "@/components/admin/TrainerEditor";
import { getDb } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { et } from "@/i18n/dict/et";
import { loadTrainer } from "@/server/admin-site";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.trainer) };

/** Koolitaja: portrait, name, role, stats, bio, works gallery and the two stories (Task 13B, T1–T4). */
export default async function TrainerEditPage() {
  await requireAdmin();
  const initial = await loadTrainer(getDb());
  // an empty story title falls back to the site's own heading for it
  return <TrainerEditor initial={initial} storyTitles={{ center_story: et.trainer.storyTitle, trainer_journey: et.trainer.journeyTitle }} />;
}
