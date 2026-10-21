"use client";

import { useRouter } from "next/navigation";
import { startTransition } from "react";
import styles from "@/components/admin/PanelStates.module.css";
import ui from "@/components/admin/ui.module.css";
import { adminEt } from "@/i18n/dict/admin";

// A panel page that could not be read (README §1.10). It sits inside the layout, so the sidebar stays; before, a failed read took the whole
// page down with it. Typed text is not lost here: the editors keep their own copy in the browser. The error is not logged from the
// browser (tests/unit/log.test.ts): the server has already logged it, with its digest.
export default function PanelError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const t = adminEt.panel;

  return (
    <div className={styles.error} role="alert" data-panel-error="">
      <p className={styles.errorTitle}>{t.errorTitle}</p>
      <p className={styles.errorBody}>{t.errorBody}</p>
      {/* reset() alone shows the same failed server answer again: ask the server for the page once more, then reset */}
      <button
        type="button"
        className={ui.btn}
        onClick={() =>
          startTransition(() => {
            router.refresh();
            reset();
          })
        }
      >
        {t.errorRetry}
      </button>
    </div>
  );
}
