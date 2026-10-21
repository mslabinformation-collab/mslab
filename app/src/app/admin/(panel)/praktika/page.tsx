import type { Metadata } from "next";
import { PracticeEditor } from "@/components/admin/PracticeEditor";
import { adminTitle } from "@/components/admin/sections";
import { getDb } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { loadPractice } from "@/server/admin-site";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.nav.practice) };

/** Praktika: the MINI and MAXI packages (Task 13B, A8, R3). */
export default async function PracticeEditPage() {
  await requireAdmin();
  const { codes, ...initial } = await loadPractice(getDb());
  return <PracticeEditor initial={initial} codes={codes} />;
}
