import type { Metadata } from "next";
import { PracticeEditor } from "@/components/admin/PracticeEditor";
import { adminTitle } from "@/components/admin/sections";
import { getDb } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { requireAdmin } from "@/server/auth";
import { readSiteEditor } from "@/server/site-drafts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.practice) };

/**
 * Praktika: the MINI and MAXI packages on the draft layer (admin UX pass piece 4a, Task 4): every package's part as it is now — its draft over live, and
 * live — read with the stamp (server/site-drafts.ts readSiteEditor), handed to the editor as it came (SiteEditorPage's `parts` contract).
 */
export default async function PracticeEditPage() {
  await requireAdmin();
  const { parts, stamp } = await readSiteEditor(getDb(), "practice");
  return <PracticeEditor parts={parts} stamp={stamp} />;
}
