"use client";

import Link from "next/link";
import { useId, useState } from "react";
import ui from "@/components/site/ui.module.css";
import { feedbackFragment, feedbackTargetBody, promptKey, type FeedbackPrompt } from "@/domain/account-cards";
import { pick } from "@/i18n/field";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import type { CoursesTexts } from "./texts";
import styles from "./AccountCourseCard.module.css";

/**
 * The feedback form's card on Minu koolitused (phase protocols, spec §7; student reviews, D3), once the form opens for a contact course's
 * registration or an e-course she has completed: the course, "Kuidas koolitus läks?", the one button "Jäta tagasiside" (the form,
 * /konto/tagasiside#id=<registration> or #kursus=<slug>) and the text button "Ei soovi", which posts /api/konto/tagasiside/peida with the same
 * target and takes the card away for good. No reminder is ever sent. The course cards' own box and buttons. `readOnly` (the admin's view): the
 * buttons are aria-disabled and do nothing. `onDismissed` is given the prompt's key (domain/account-cards.ts promptKey).
 */
export function FeedbackCard({ prompt, locale, t, readOnly, onDismissed }: { prompt: FeedbackPrompt; locale: Locale; t: CoursesTexts; readOnly: boolean; onDismissed(key: string): void }) {
  const f = t.feedbackCard;
  const titleId = useId();
  const key = promptKey(prompt);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function dismiss() {
    if (readOnly || busy) return;
    setBusy(true);
    setFailed(false);
    const answer = await sendJson("/api/konto/tagasiside/peida", feedbackTargetBody(prompt.target));
    if (isDone(answer)) return onDismissed(key);
    setFailed(true);
    setBusy(false);
  }

  return (
    <article className={styles.card} aria-labelledby={titleId} data-feedback-card={key}>
      <span className={styles.tag}>{"registrationId" in prompt.target ? t.tag.contact : t.tag.ecourse}</span>
      <h2 id={titleId} className={styles.title}>
        {pick(prompt.course.title, locale)}
      </h2>
      <p className={styles.next}>{f.question}</p>
      <div className={styles.foot}>
        {readOnly ? (
          <a className={`${ui.btn} ${styles.action}`} role="link" aria-disabled="true" data-feedback-open="">
            {f.open}
          </a>
        ) : (
          <Link className={`${ui.btn} ${styles.action}`} href={`${href(locale, "/konto/tagasiside")}#${feedbackFragment(prompt.target)}`} data-feedback-open="">
            {f.open}
          </Link>
        )}
      </div>
      <div className={styles.secondRow}>
        <button type="button" className={styles.second} aria-disabled={readOnly || busy || undefined} onClick={() => void dismiss()} data-feedback-dismiss="">
          {f.dismiss}
        </button>
      </div>
      {failed && (
        <p className={styles.payError} role="alert">
          {f.dismissFailed}
        </p>
      )}
    </article>
  );
}
