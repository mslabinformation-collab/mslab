import Link from "next/link";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import ui from "./ui.module.css";
import styles from "./TestplanCard.module.css";

/**
 * The Avaleht card "Testimine: N avatud, M viga" (phase 4, piece 1, spec D1, §5): how many of the signed-in admin's checks are open and how many
 * stand failed, and "Ava" to /admin/testimine. The overview shows it only while server/testplan.ts testplanCard has numbers (an open or a failed check).
 */
export function TestplanCard({ open, bad }: { open: number; bad: number }) {
  const t = adminEt.testplan;
  return (
    <section className={`${ui.card} ${styles.card}`} aria-labelledby="testplan-title" data-testplan-card="">
      <div className={`${ui.cardHead} ${styles.head}`}>
        <h2 id="testplan-title" className={ui.h2}>
          {fill(t.card, { open, bad })}
        </h2>
        <Link className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} href="/admin/testimine" aria-describedby="testplan-title">
          {t.open}
        </Link>
      </div>
    </section>
  );
}
