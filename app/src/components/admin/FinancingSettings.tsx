"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import type { FinancingSettings as FinancingSettingsValue } from "@/domain/financing";
import { adminEt } from "@/i18n/dict/admin";
import { saveFinancingSettingsAction } from "@/server/actions/admin-financing";
import ui from "./ui.module.css";
import site from "./site-editor.module.css";
import styles from "./FinancingSettings.module.css";

/** The status line: empty, on its way, done or refused. */
type Line = { tone: "idle" | "busy" | "done" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Line["tone"]) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);

/**
 * Seaded → „Järelmaks (Inbank)“ (instalments Task 5, spec D4): Maria's one switch, off by default. She ticks „Paku järelmaksu (Inbank)“ once her
 * Montonio contract includes financing; only then do the course page's line, the registration form's choice and the cart's choice appear (and
 * only for a price of 100–5000 € with Montonio payments on: domain/financing.ts financingOffered). A form of its own after „Arve andmed“ with
 * its own „Salvesta“ (a secondary button, as the certificate's: the page's primary one is the settings' save bar); ticking alone saves nothing.
 * The card keeps its own state; what the server stored is what the box shows after a save.
 */
export function FinancingSettings({ initial }: { initial: FinancingSettingsValue }) {
  const t = adminEt.financing.settings;
  const uid = useId();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [status, setStatus] = useState<Line>(IDLE);
  const [pending, start] = useTransition();

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setStatus({ tone: "busy", text: t.saving });
    start(async () => {
      try {
        const result = await saveFinancingSettingsAction({ enabled });
        if (result.ok) {
          setEnabled(result.enabled);
          setStatus({ tone: "done", text: t.saved });
        } else setStatus({ tone: "error", text: t.error });
      } catch {
        // the call itself failed (offline, a timeout): the same words, and what she ticked stays
        setStatus({ tone: "error", text: t.error });
      }
    });
  };

  return (
    <section id="jarelmaks" className={`${ui.card} ${styles.card}`} aria-labelledby={`${uid}-title`} data-financing-settings="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {t.title}
      </h2>
      <p id={`${uid}-lead`} className={`${ui.muted} ${site.cardLead}`}>
        {t.lead}
      </p>
      <form onSubmit={save} noValidate data-financing-form="">
        <div className={ui.field}>
          <label className={styles.check} htmlFor={`${uid}-enabled`}>
            <input
              id={`${uid}-enabled`}
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                // the saved line no longer tells the truth about what is ticked
                setStatus(IDLE);
              }}
              aria-describedby={`${uid}-lead`}
              data-financing-enabled=""
            />
            <span>{t.enabled}</span>
          </label>
        </div>
        <div className={styles.actions}>
          <p role="status" className={toneClass(status.tone)} data-financing-status="">
            {status.text}
          </p>
          <button type="submit" className={`${ui.btn} ${ui.secondary}`} aria-disabled={pending || undefined} data-financing-save="">
            {pending ? t.saving : t.save}
          </button>
        </div>
      </form>
    </section>
  );
}
