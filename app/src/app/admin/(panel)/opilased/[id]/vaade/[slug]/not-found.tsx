import Link from "next/link";
import ui from "@/components/admin/ui.module.css";
import { adminEt } from "@/i18n/dict/admin";
import { requireAdmin } from "@/server/auth";

/**
 * "Vaata tema vaadet" of one e-course she has no open access to (ended, run out, never given), a course that is not there or a
 * mistyped address: a 404 that says only that this view is not there (the student may well exist: vaade/not-found.tsx says that
 * of a missing student), with the way back.
 */
export default async function ViewCourseNotFound() {
  await requireAdmin();
  const t = adminEt.viewAs;
  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <h1 className={ui.h1}>{adminEt.nav.clients}</h1>
      </div>
      <section className={ui.card}>
        <p className={ui.empty}>{t.courseNotFound}</p>
        <Link className={ui.link} href="/admin/opilased">
          {t.toList}
        </Link>
      </section>
    </div>
  );
}
