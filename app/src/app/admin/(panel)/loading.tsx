import styles from "@/components/admin/PanelStates.module.css";

// What a panel page shows while it loads (README §1.10): four static grey rows, shown after 400 ms (PanelStates.module.css: the README's
// 300 ms, and a margin over React's own 300 ms hold on a fallback's replacement). It has no text and no page header: the layout's Shell stays
// on screen around it. A plain server component, so it reaches the browser with nothing to load.
export default function PanelLoading() {
  return (
    <div className={styles.loading} aria-busy="true" data-panel-loading="">
      <span className={styles.row} />
      <span className={styles.row} />
      <span className={styles.row} />
      <span className={styles.row} />
    </div>
  );
}
