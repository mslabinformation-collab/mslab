import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account/AccountShell";
import { EcourseView } from "@/components/account/EcourseView";
import { ecourseTexts, shellTexts } from "@/components/account/texts";
import { adminTitle } from "@/components/admin/sections";
import ui from "@/components/admin/ui.module.css";
import { getDb } from "@/db/client";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { getDict } from "@/i18n/locales";
import { parseRowId } from "@/lib/row-id";
import { isSlug } from "@/lib/slug";
import { clientViewInfo } from "@/server/admin-clients";
import { requireAdmin } from "@/server/auth";
import { loadEcourse } from "@/server/client-data";
import view from "../view.module.css";

// An admin page: rendered for every visit (the student's data, never a shared cache) and only for a signed-in admin.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: adminTitle(adminEt.viewAs.courseTitle) };

type Props = { params: Promise<{ id: string; slug: string }> };

/**
 * "Vaata tema vaadet" of one e-course (spec 3a section 4): the student's own course page as she sees it — the course, her progress
 * and each lesson's state, in her language, from the loader of her account (client-data.ts loadEcourse) — rendered here on the server
 * with the button and every link aria-disabled and doing nothing (AccountShell / EcourseView readOnly). The terms notice is not shown:
 * the admin looks, and nothing is accepted. Nothing of her account is touched: no session is read, made or ended, nothing is sent.
 * A student who does not exist, a course she has no active access to (none, ended, ran out), or a bad address: 404, as for her.
 */
export default async function ViewCoursePage({ params }: Props) {
  await requireAdmin();
  const { id: rawId, slug } = await params;
  const id = parseRowId(rawId);
  if (id === null || !isSlug(slug)) notFound();
  const db = getDb();
  const [data, info] = await Promise.all([loadEcourse(db, id, slug, new Date()), clientViewInfo(db, id)]);
  if (!data || !info) notFound();
  const d = getDict(info.locale);
  const t = adminEt.viewAs;

  return (
    <div className={ui.page}>
      <Link className={ui.link} href={`/admin/opilased?id=${id}`} aria-label={t.backLabel} data-view-as-back="">
        <span aria-hidden="true">←</span> {t.back}
      </Link>
      <div className={view.preview} lang={info.locale} data-view-as={id}>
        <AccountShell
          tab="courses"
          locale={info.locale}
          t={shellTexts(d)}
          readOnly
          banner={<span lang="et">{fill(t.banner, { nimi: info.label })}</span>}
        >
          <EcourseView data={data} locale={info.locale} t={ecourseTexts(d)} readOnly />
        </AccountShell>
      </div>
    </div>
  );
}
