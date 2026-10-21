"use client";

import { useEffect, useId, useRef, useState } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { ConfirmPanel } from "./ConfirmPanel";
import ui from "./ui.module.css";
import styles from "./PublishBar.module.css";

/**
 * The bar of a published thing with unpublished changes (admin UX pass, README §1.8; the draft layer, server/drafts.ts). It stands under the H1:
 * „Avaldamata muudatused: {n}“ with the changed fields' labels, „Eelvaade ↗“ (the public page in draft mode, api/admin/eelvaade), „Loobu
 * muudatustest“ behind a ConfirmPanel (danger: „Kas loobun {n} muudatusest? Avalikul lehel jääb praegune versioon.“ / „Jah, loobu“) and „Avalda
 * muudatused“, which publishes only on its press.
 *
 * Below 900px (the admin's phone width) the CSS makes it the phone's bar at the bottom of the screen (strings.md W9): „Avaldamata {n} · Eelvaade“
 * with „Eelvaade“ as the link, and „Avalda“. „Loobu muudatustest“ is not there: on a phone it is on the preview page, in draft mode (spec C3).
 *
 * - `changed`: the labels of the changed fields, in screen order; none (and nothing blocked): no bar at all.
 * - `previewHref`: the preview link, `/api/admin/eelvaade?tee=<the public page's path>`; it opens in a tab of its own.
 * - `blocked`: after a publish, the labels of the fields it could not copy (changed live meanwhile); they are listed under the bar, labels only.
 * - `onDiscard`, `onPublish`: the screen's actions. While one runs, the bar is aria-busy and its buttons are aria-disabled (they keep the focus) and
 *   do nothing. The screen reports a failure itself; a rejected promise only ends the busy state (and a failed discard leaves the question open).
 */
export function PublishBar({
  changed,
  previewHref,
  blocked,
  onDiscard,
  onPublish,
}: {
  changed: string[];
  previewHref: string;
  blocked?: string[];
  onDiscard(): Promise<void>;
  onPublish(): Promise<void>;
}) {
  const t = adminEt.publish;
  const countId = useId();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // the guard of a second press before the render that shows busy (two clicks of one event loop turn)
  const running = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);

  // the question closed: the focus goes back to „Loobu muudatustest“ (ConfirmPanel's rule for „Katkesta“)
  useEffect(() => {
    if (confirming || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [confirming]);

  /** Runs one of the screen's actions, alone; true when it went through. */
  async function run(action: () => Promise<void>): Promise<boolean> {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    try {
      await action();
      return true;
    } catch {
      return false; // the screen has told what went wrong
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const closeQuestion = () => {
    refocus.current = true;
    setConfirming(false);
  };

  if (changed.length === 0 && !blocked?.length) return null;
  const n = changed.length;

  return (
    <div className={styles.wrap}>
      <div role="region" aria-labelledby={countId} aria-busy={busy || undefined} className={styles.bar} data-publish-bar="">
        <p className={styles.summary}>
          <span className={styles.wide}>
            <b id={countId} data-publish-count="">
              {fill(t.count, { n })}
            </b>
            {n > 0 && (
              <span className={styles.fields} data-publish-fields="">
                {" · "}
                {changed.join(", ")}
              </span>
            )}
          </span>
          <span className={styles.phone} data-publish-phone="">
            <b>{fill(t.phoneCount, { n })}</b>
            {" · "}
            <a className={styles.phoneLink} href={previewHref} target="_blank" rel="noopener">
              {t.phonePreview}
            </a>
          </span>
        </p>
        <div className={styles.actions}>
          <a className={`${styles.preview} ${styles.wide}`} href={previewHref} target="_blank" rel="noopener" data-publish-preview="">
            {t.preview}
          </a>
          {!confirming && (
            <button
              ref={trigger}
              type="button"
              className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.discard}`}
              aria-disabled={busy || undefined}
              data-publish-discard=""
              onClick={() => {
                if (!running.current) setConfirming(true);
              }}
            >
              {t.discard}
            </button>
          )}
          <button
            type="button"
            className={`${ui.btn} ${ui.smallBtn} ${styles.go}`}
            aria-disabled={busy || undefined}
            data-publish-go=""
            onClick={() => void run(onPublish)}
          >
            <span className={styles.wide} data-wide="">
              {t.publish}
            </span>
            <span className={styles.phone} data-phone="">
              {t.phonePublish}
            </span>
          </button>
        </div>
        {confirming && (
          <div className={styles.confirm}>
            <ConfirmPanel
              question={fill(t.confirm, { n })}
              yesLabel={t.confirmYes}
              tone="danger"
              busy={busy}
              onYes={() =>
                void run(onDiscard).then((done) => {
                  if (done) closeQuestion();
                })
              }
              onCancel={closeQuestion}
            />
          </div>
        )}
      </div>
      {blocked && blocked.length > 0 && (
        <ul className={styles.blocked} data-publish-blocked="">
          {blocked.map((label, i) => (
            <li key={i}>{label}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
