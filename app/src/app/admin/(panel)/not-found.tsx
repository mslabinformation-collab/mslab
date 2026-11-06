import Link from "next/link";
import styles from "@/components/admin/PanelStates.module.css";
import ui from "@/components/admin/ui.module.css";
import { adminEt } from "@/i18n/dict/admin";

/**
 * A panel address that is no page, or a page whose record is gone (notFound() of a panel page without a not-found of its own): one white card in the
 * page column, as the panel's error state, with the way to Ülevaade (06.11 polish board 7). The layout round it has already checked the session.
 */
export default function PanelNotFound() {
  const t = adminEt.panel;
  return (
    <div className={styles.notFound} data-panel-not-found="">
      <h1 className={styles.errorTitle}>{t.notFoundTitle}</h1>
      <p className={styles.errorBody}>{t.notFoundBody}</p>
      <Link className={ui.btn} href="/admin">
        {t.notFoundHome}
      </Link>
    </div>
  );
}
