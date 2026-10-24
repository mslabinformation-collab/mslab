"use client";

import { useId } from "react";
import { adminEt } from "@/i18n/dict/admin";
import { Choice } from "../Choice";
import ui from "../ui.module.css";
import ed from "../editor.module.css";
import styles from "../CourseEditor.module.css";

/**
 * „Avaldamine“ (README B2, the side column): „Avaldatud“ and „Näidissisu“. On a saved course both are instant switches, no part of the draft (R-a):
 * „Avaldatud“ goes through the R-d action (switched off with unpublished changes, they are published first; a part that cannot be refuses the
 * switch), „Näidissisu“ through its own. On the new-course page they are fields of the draft „Lisa koolitus“ sends. While a switch is on its way the
 * box shows what was asked and the card is aria-busy; `error` is its refusal, an alert under the switches.
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
  const f = t.fields;
  const uid = useId();
  return (
    <section className={ui.card} aria-labelledby={`${uid}-publish`} aria-busy={busy || undefined} data-publish-card="">
      <h2 id={`${uid}-publish`} className={`${ui.h3} ${styles.cardTitle}`}>
        {t.sections.publish}
      </h2>
      <Choice
        className={ed.check}
        label={f.published}
        hint={f.publishedHint}
        hintClassName={`${ui.muted} ${ui.small}`}
        type="checkbox"
        value="1"
        checked={published}
        onChange={(e) => onPublished(e.target.checked)}
        data-field="published"
      />
      <Choice
        className={ed.check}
        label={f.sample}
        hint={f.sampleHint}
        hintClassName={`${ui.muted} ${ui.small}`}
        type="checkbox"
        value="1"
        checked={sample}
        onChange={(e) => onSample(e.target.checked)}
        data-field="isSample"
      />
      {error && (
        <p role="alert" className={ui.error} data-switch-error="">
          {error}
        </p>
      )}
    </section>
  );
}
