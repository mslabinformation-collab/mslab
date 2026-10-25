"use client";

import { useCallback, useId, useMemo } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { useSeadedPart, type StatusReport } from "./useSeadedPart";
import ui from "./ui.module.css";
import site from "./site-editor.module.css";
import styles from "./FinancingSettings.module.css";

/** The switch as stored (domain/financing.ts readFinancingSettings: off unless exactly true) and its version. */
export type FinancingInitial = { enabled: boolean; version: string };

/**
 * Seaded → „Järelmaks (Inbank)“ (instalments Task 5, spec D4; admin UX pass piece 3b, Task 4: piece3-texts §4), in the „Maksmine“ section with its own
 * title: Maria's one switch, off by default. She ticks „Paku järelmaksu (Inbank)“ once her Montonio contract includes financing; only then do the
 * course page's line, the registration form's choice and the cart's choice appear (and only for a price of 100–5000 € with Montonio payments on:
 * domain/financing.ts financingOffered). The tick saves at once on api/admin/seaded/financing, under the page's one SaveStatus (`onStatus`): there is
 * no „Salvesta“ and no line of its own. Switched in another tab meanwhile (a conflict), „Taasta minu tekst“ saves what this box shows over it, as
 * on every other card. The frame draws no switch for it, so it stays the checkbox it was.
 */
export function FinancingSettings({ initial, onStatus }: { initial: FinancingInitial; onStatus?: StatusReport }) {
  const t = adminEt.financing.settings;
  const uid = useId();
  const fields = useMemo(() => ({ enabled: initial.enabled }), []); // eslint-disable-line react-hooks/exhaustive-deps -- the engine starts from the first read
  const focusField = useCallback(() => document.getElementById(`${uid}-enabled`)?.focus(), [uid]);
  const part = useSeadedPart({ part: "financing", version: initial.version, fields, label: () => t.enabled, focusField, onStatus });

  return (
    <section className={`${ui.card} ${styles.card}`} aria-labelledby={`${uid}-title`} data-financing-settings="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {t.title}
      </h2>
      <p id={`${uid}-lead`} className={`${ui.muted} ${site.cardLead}`}>
        {t.lead}
      </p>
      <div className={ui.field}>
        <label className={styles.check} htmlFor={`${uid}-enabled`}>
          <input
            id={`${uid}-enabled`}
            type="checkbox"
            checked={part.text("enabled") === true}
            onChange={(e) => {
              part.type("enabled", e.target.checked);
              void part.flush();
            }}
            aria-describedby={`${uid}-lead`}
            data-financing-enabled=""
          />
          <span>{t.enabled}</span>
        </label>
      </div>
      {part.conflict && (
        <p className={styles.restore}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => void part.restore()} data-financing-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
    </section>
  );
}
