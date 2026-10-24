"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { dropCourseCopies } from "@/lib/course-copies";
import styles from "./PreviewBar.module.css";

// The admin's ConfirmPanel (its words, its stylesheet and the admin's dictionary) is loaded when the question is first asked, never with the page: the
// bar sits on a public page, and nothing of the admin's code may reach a visitor (tests/e2e/admin-eelvaade.spec.ts checks the page's stylesheets and scripts).
const ConfirmPanel = lazy(() => import("@/components/admin/ConfirmPanel").then((m) => ({ default: m.ConfirmPanel })));

/** The words of the bar, filled by the server (server/preview-bar.ts): this module carries no dictionary. */
export type PreviewBarTexts = { count: string; exit: string; discard: string; question: string; yes: string; failed: string; signedOut: string };
/** The catalogue's bar's words: its name and the way out. */
export type PreviewLabelTexts = { label: string; exit: string };

/**
 * The bar of the admin's draft preview on the public course page (admin UX pass piece 3a, Task 6 review; spec C3: „Loobu muudatustest“ on the preview
 * page is shown only in draft mode; README §1.8, B2 Part 4: the phone's PublishBar leaves „Loobu muudatustest“ behind „Eelvaade“). The page renders it
 * only for a request that is the admin's preview (server/preview.ts previewActive), so a visitor's page, and the page Next keeps, never has it.
 *
 * - `count`: how many unpublished changes the course has (the PublishBar's count); „Avaldamata {n}“ (`t.count`), and „Loobu muudatustest“, are there when it is not 0.
 * - the way out is the link `exitHref` (api/admin/eelvaade?lopeta=1&tee=<this page>): draft mode off, the same page as a visitor sees it, „Lõpeta
 *   eelvaade“ (`t.exit`, Dim 24.10 D-1).
 * - „Loobu muudatustest“ asks in the PublishBar's ConfirmPanel (the same words), then discards the course's drafts (POST api/admin/koolitus/<id>/loobu,
 *   Task 4) and ends the preview. A discard that fails leaves the question open (as the PublishBar's does) and says so in the bar, as an alert, in the
 *   PublishBar's words: `t.failed` („Muudatustest loobumine ei õnnestunud. Proovi uuesti.“, D-2), or `t.signedOut` for a session that ended
 *   (withAdmin's 401; the leave guard's „Logi uuesti sisse.“).
 */
export function PreviewBar({ courseId, count, exitHref, t }: { courseId: number; count: number; exitHref: string; t: PreviewBarTexts }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
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
    setFailed(null);
    let done = false;
    let signedOut = false;
    try {
      const res = await fetch(`/api/admin/koolitus/${courseId}/loobu`, { method: "POST", cache: "no-store", credentials: "same-origin" });
      done = res.ok;
      signedOut = res.status === 401;
    } catch {
      done = false; // no connection: the question stays, and she can press again
    }
    if (done) {
      // what was thrown away must not come back: the course editor's copies of this course in this browser go too (lib/course-copies.ts), so its next
      // visit does not resume them (Task 7 review round 2)
      dropCourseCopies(courseId);
      // the preview ends with the drafts: the page comes back as a visitor sees it (the bar stays busy until it does)
      window.location.assign(exitHref);
      return;
    }
    running.current = false;
    setBusy(false);
    setFailed(signedOut ? t.signedOut : t.failed);
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
      {failed && (
        <p role="alert" className={styles.error} data-preview-error="">
          {failed}
        </p>
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
                setFailed(null);
                setConfirming(false);
              }}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

/**
 * The catalogue's bar in the admin's draft preview (Dim 24.10, D-4): „Eelvaade“ and the way out (`exitHref`, as the course page's bar), nothing to
 * discard (the catalogue is many courses). Rendered, as the course page's, only for a request that is the admin's preview.
 */
export function PreviewLabelBar({ exitHref, t }: { exitHref: string; t: PreviewLabelTexts }) {
  return (
    <div className={styles.bar} data-preview-bar="" data-fab-avoid="">
      <p className={styles.words}>
        <b data-preview-label="">{t.label}</b>
        {" · "}
        <a className={styles.exit} href={exitHref} data-preview-exit="">
          {t.exit}
        </a>
      </p>
    </div>
  );
}
