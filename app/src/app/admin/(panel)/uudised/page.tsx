import type { Metadata } from "next";
import { adminTitle } from "@/components/admin/sections";
import { adminEt } from "@/i18n/dict/admin";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.news) };

/** Uudised with no post open (piece 4b R-f): the list is the page, drawn by the uudised layout (layout.tsx), so this page adds nothing to it. */
export default async function NewsListPage() {
  await requireAdmin();
  return null;
}
