"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import styles from "./PreviewBar.module.css";

// The admin's ConfirmPanel (its words, its stylesheet and the admin's dictionary) is loaded when the question is first asked, never with the page: the
// bar sits on a public page, and nothing of the admin's code may reach a visitor (tests/e2e/admin-eelvaade.spec.ts checks the page's stylesheets and scripts).
const ConfirmPanel = lazy(() => import("@/components/admin/ConfirmPanel").then((m) => ({ default: m.ConfirmPanel })));

/** The words of the bar, filled by the server (server/preview-bar.ts): this module carries no dictionary. */
export type PreviewBarTexts = { count: string; exit: string; discard: string; question: string; yes: string };

/**
 * The bar of the admin's draft preview on the public course page (admin UX pass piece 3a, Task 6 review; spec C3: „Loobu muudatustest“ on the preview
 * page is shown only in draft mode; README §1.8, B2 Part 4: the phone's PublishBar leaves „Loobu muudatustest“ behind „Eelvaade“). The page renders it
 * only for a request that is the admin's preview (server/preview.ts previewActive), so a visitor's page, and the page Next keeps, never has it.
 *
 * - `count`: how many unpublished changes the course has (the PublishBar's count); „Avaldamata {n}“ (`t.count`), and „Loobu muudatustest“, are there when it is not 0.
 * - the way out is the link `exitHref` (api/admin/eelvaade?lopeta=1&tee=<this page>): draft mode off, the same page as a visitor sees it. Its words are
 *   the admin's „Vaata kodulehte“ (shell.preview), which does the same: no frame of the design draws the preview page's own bar, so no word for it is new.
 * - „Loobu muudatustest“ asks in the PublishBar's ConfirmPanel (the same words), then discards the course's drafts (POST api/admin/koolitus/<id>/loobu,
 *   Task 4) and ends the preview. A discard that fails leaves the question open (as the PublishBar's does), and tells nothing: the design has no words
 *   for it yet.
 */
export function PreviewBar({ courseId, count, exitHref, t }: { courseId: number; count: number; exitHref: string; t: PreviewBarTexts }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // a second press before the render that shows busy (two clicks of one event loop turn)
  const running = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);

  // the question closed: the focus goes back to „Loobu muudatustest“ (ConfirmPanel's rule for „Katkesta“)
  useEffect(() => {
    if (confirming || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [confirming]);

  async function discard(): Promise<void> {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    let done = false;
    try {
      const res = await fetch(`/api/admin/koolitus/${courseId}/loobu`, { method: "POST", cache: "no-store", credentials: "same-origin" });
      done = res.ok;
    } catch {
      done = false; // no connection: the question stays, and she can press again
    }
    if (done) {
      // the preview ends with the drafts: the page comes back as a visitor sees it (the bar stays busy until it does)
      window.location.assign(exitHref);
      return;
    }
    running.current = false;
    setBusy(false);
  }

  return (
    <div className={styles.bar} data-preview-bar="" data-fab-avoid="" aria-busy={busy || undefined}>
      <p className={styles.words}>
        {count > 0 && (
          <>
            <b data-preview-count="">{t.count}</b>
            {" · "}
          </>
        )}
        <a className={styles.exit} href={exitHref} data-preview-exit="">
          {t.exit}
        </a>
      </p>
      {count > 0 && !confirming && (
        <button
          ref={trigger}
          type="button"
          className={styles.discard}
          aria-disabled={busy || undefined}
          data-preview-discard=""
          onClick={() => {
            if (!running.current) setConfirming(true);
          }}
        >
          {t.discard}
        </button>
      )}
      {count > 0 && confirming && (
        <div className={styles.confirm}>
          <Suspense fallback={null}>
            <ConfirmPanel
              question={t.question}
              yesLabel={t.yes}
              tone="danger"
              busy={busy}
              onYes={() => void discard()}
              onCancel={() => {
                refocus.current = true;
                setConfirming(false);
              }}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
