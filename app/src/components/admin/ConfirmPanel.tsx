"use client";

import { useEffect, useId, useRef } from "react";
import { adminEt } from "@/i18n/dict/admin";
import ui from "./ui.module.css";
import styles from "./ConfirmPanel.module.css";

/**
 * The one confirmation of the admin (admin UX pass, README §1.6; it replaces the three confirming steps of the old G8 patterns).
 * It takes the place of its trigger button and takes the focus, asks the question, lists what follows in plain lines (who gets mail, what
 * changes in public, what cannot be undone), and has two buttons: `yesLabel` (always „Jah, {tegusõna}[ {n} …]“) and „Katkesta“.
 *
 * - `tone` "danger": the yes button is the red outline; "send": the ink pill.
 * - `busy`: the action is running. Yes and „Katkesta“ are aria-disabled (they stay focusable, so the focus is not lost) and do nothing: the action
 *   completes whatever the panel does, and a closed panel would read as if it had been stopped. Esc does nothing either, but is still taken (a drawer
 *   round the panel stays open). The parent says in `yesLabel` what is happening, if it wants to.
 * - „Katkesta“ and Esc call `onCancel` (when not busy); the parent then shows its trigger again and focuses it. Esc goes no further: a drawer round
 *   the panel stays open (the next Esc closes it).
 */
export function ConfirmPanel({
  question,
  lines,
  yesLabel,
  tone,
  busy,
  onYes,
  onCancel,
}: {
  question: string;
  lines?: string[];
  yesLabel: string;
  tone: "danger" | "send";
  busy?: boolean;
  onYes: () => void;
  onCancel: () => void;
}) {
  const qid = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <div
      ref={panel}
      role="group"
      aria-labelledby={qid}
      tabIndex={-1}
      className={`${ui.notice} ${styles.panel}`}
      data-confirm-panel=""
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // the panel's own question: not the dialog's (a drawer round it) nor the page's
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <p id={qid} className={styles.question}>
        {question}
      </p>
      {lines && lines.length > 0 && (
        <ul className={styles.lines}>
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={`${ui.btn} ${tone === "danger" ? styles.dangerYes : ""}`.trim()}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onYes();
          }}
        >
          {yesLabel}
        </button>
        <button
          type="button"
          className={`${ui.btn} ${ui.secondary}`}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onCancel();
          }}
        >
          {adminEt.common.cancel}
        </button>
      </div>
    </div>
  );
}
