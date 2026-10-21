import Link from "next/link";
import ui from "@/components/admin/ui.module.css";
import { adminEt } from "@/i18n/dict/admin";
import { requireAdmin } from "@/server/auth";

/** "Vaata tema vaadet" of a student who does not exist (deleted her account, or a typed address): a 404 with the way back. */
export default async function ViewAsNotFound() {
  await requireAdmin();
  const t = adminEt.viewAs;
  return (
    <div className={ui.page}>
      <div className={ui.heading}>
        <h1 className={ui.h1}>{adminEt.nav.clients}</h1>
      </div>
      <section className={ui.card}>
        <p className={ui.empty}>{t.notFound}</p>
        <Link className={ui.link} href="/admin/opilased">
          {t.toList}
        </Link>
      </section>
    </div>
  );
}
