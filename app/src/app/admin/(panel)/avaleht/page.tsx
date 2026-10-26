import type { Metadata } from "next";
import { HomeEditor } from "@/components/admin/HomeEditor";
import { adminTitle } from "@/components/admin/sections";
import { getDb } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { requireAdmin } from "@/server/auth";
import { readSiteEditor } from "@/server/site-drafts";
import { linkSuggestions } from "@/server/site-links";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.home) };

/**
 * Avaleht: the home page's parts on the draft layer (admin UX pass piece 4a, Task 6) — the slides, the statement, the trainer card's text and the FAQ —
 * every part as it is now (its draft over live, and live) read with the stamp (server/site-drafts.ts readSiteEditor), handed to the editor as it came
 * (SiteEditorPage's `parts` contract); and the links a slide's button may take (site pages and courses).
 */
export default async function HomeEditPage() {
  await requireAdmin();
  const db = getDb();
  const [{ parts, stamp }, links] = await Promise.all([readSiteEditor(db, "home"), linkSuggestions(db)]);
  return <HomeEditor parts={parts} stamp={stamp} links={links} />;
}
