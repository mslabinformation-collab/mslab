"use client";

import { useRouter } from "next/navigation";
import { startTransition } from "react";
import styles from "@/components/admin/PanelStates.module.css";
import ui from "@/components/admin/ui.module.css";
import { adminEt } from "@/i18n/dict/admin";

// The last net of the admin area: whatever the (panel) layout could not build (the shell, the sign-in check's own failure) lands here instead of
// on Next's bare error page. A page that could not be read is caught one level down by (panel)/error.tsx, inside the shell; this one has no menu
// round it, so it is the same card, alone on the canvas, with the same words and the same retry. The error is not logged from the browser
// (tests/unit/log.test.ts): the server has already logged it, with its digest.
export default function AdminError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const t = adminEt.panel;

  return (
    <main className={styles.rootError}>
      <div className={styles.error} role="alert" data-admin-error="">
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
    </main>
  );
}
