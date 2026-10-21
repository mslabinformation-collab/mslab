import type { Metadata } from "next";
import { HomeEditor } from "@/components/admin/HomeEditor";
import { adminTitle } from "@/components/admin/sections";
import { getDb } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { loadHome } from "@/server/admin-site";
import { requireAdmin } from "@/server/auth";
import { linkSuggestions } from "@/server/site-links";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.home) };

/** Avaleht: hero slides, the statement and the FAQ (Task 13B, A9). */
export default async function HomeEditPage() {
  await requireAdmin();
  const db = getDb();
  const [initial, links] = await Promise.all([loadHome(db), linkSuggestions(db)]);
  return <HomeEditor initial={initial} links={links} />;
}
