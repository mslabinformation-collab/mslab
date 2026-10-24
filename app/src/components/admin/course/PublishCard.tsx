"use client";

import { useId } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { Switch } from "../Switch";
import ui from "../ui.module.css";
import styles from "../CourseEditor.module.css";

/**
 * „Avaldamine“ (README B2, the side column; the Part 3 frame "B2 Course editor" L111, Part 4 L61): the switches „Avalikul lehel“ and „Näidissisu“,
 * as drawn (no hints). On a saved course both are instant, no part of the draft (R-a): „Avalikul lehel“ goes through the R-d action (switched off
 * with unpublished changes, they are published first; a part that cannot be refuses the switch), „Näidissisu“ through its own. On the new-course
 * page they are fields of the draft „Lisa koolitus“ sends. While a switch is on its way it shows what was asked and the card is aria-busy; `error` is
 * its refusal, an alert under the switches that describes them.
 */
export function PublishCard({
  published,
  sample,
  onPublished,
  onSample,
  busy,
  error,
}: {
  published: boolean;
  sample: boolean;
  onPublished: (on: boolean) => void;
  onSample: (on: boolean) => void;
  busy?: boolean;
  error?: string | null;
}) {
  const t = adminEt.courseEditor;
  const uid = useId();
  const errorId = error ? `${uid}-error` : undefined;
  return (
    <section className={ui.card} aria-labelledby={`${uid}-publish`} aria-busy={busy || undefined} data-publish-card="">
      <h2 id={`${uid}-publish`} className={`${ui.h3} ${styles.cardTitle}`}>
        {t.sections.publish}
      </h2>
      <Switch label={t.fields.published} checked={published} onChange={onPublished} describedBy={errorId} data-field="published" />
      <Switch label={t.fields.sample} checked={sample} onChange={onSample} describedBy={errorId} data-field="isSample" />
      {error && (
        <p id={errorId} role="alert" className={ui.error} data-switch-error="">
          {error}
        </p>
      )}
    </section>
  );
}
