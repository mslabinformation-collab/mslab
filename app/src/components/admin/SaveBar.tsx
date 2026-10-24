"use client";

import { adminEt } from "@/i18n/dict/admin";
import { useFootBar } from "./foot-bar";
import type { SaveStatus } from "./useSiteDraft";
import ui from "./ui.module.css";
import styles from "./site-editor.module.css";

/** The site editors' save bar: the draft's status and "Salvesta", always within reach (sticky at the foot: the UndoBar stands above it, foot-bar.ts). */
export function SaveBar({ status, pending, reloadHref }: { status: SaveStatus; pending: boolean; reloadHref: string }) {
  const t = adminEt.editor;
  const foot = useFootBar();
  return (
    <div ref={foot} className={styles.saveBar} data-save-bar="" data-fab-avoid="">
      <p role="status" className={status.tone === "error" ? ui.error : status.tone === "success" ? ui.success : ui.hint} data-save-status="">
        {status.text}
        {status.stale && (
          <>
            {" "}
            <a className={ui.link} href={reloadHref}>
              {t.reload}
            </a>
          </>
        )}
      </p>
      <button type="submit" className={ui.btn} aria-disabled={pending || undefined}>
        {pending ? t.saving : t.save}
      </button>
    </div>
  );
}
