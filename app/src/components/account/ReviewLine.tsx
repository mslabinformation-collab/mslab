"use client";

import { useState } from "react";
import type { AccountCard, ContactCard, EcourseCard, IndividualCard } from "@/domain/account-cards";
import { isDone, sendJson } from "@/lib/json-request";
import type { CoursesTexts } from "./texts";
import cardStyles from "./AccountCourseCard.module.css";
import styles from "./ReviewLine.module.css";

/**
 * Her permission to publish, on the course card it belongs to (student reviews, D6): while the card has a review (`review`, a contact card's or an
 * e-course's), a quiet line „Lubasid oma soovitust avaldada“ with the text button „Võta luba tagasi“. The press posts /api/konto/arvustus/tagasi
 * `{ reviewId }`, which deletes the review at once, whatever Maria has done with it (the line never says: Maria's choices stay hers):
 * - 200: the line is gone, and `onWithdrawn` lets the card put the focus on its heading (the button she pressed went with the line);
 * - 404 (Maria deleted it, another tab took it back): the line is gone too, there is no review to take back, and the cards are loaded again
 *   quietly (`onGone`, CoursesView's reload) so the card shows what is true;
 * - anything else: the line stays, with a sentence under it (429 the forms' "too many tries"), and the press can be made again.
 * One press at a time. `readOnly` (the admin's view of the client): the button is there but aria-disabled, and does nothing.
 * `title` is the course's name: it names the button for a screen reader, the visible words first.
 */
export function ReviewLine({
  card, title, t, readOnly, onGone, onWithdrawn,
}: {
  card: AccountCard;
  title: string;
  t: CoursesTexts;
  readOnly: boolean;
  /** Loads the cards again, quietly, and answers whether the server answered (CoursesView's `reloadForCard`); absent: nothing to load. */
  onGone?(card: ContactCard | IndividualCard | EcourseCard): Promise<boolean>;
  onWithdrawn(): void;
}) {
  const owner = card.kind === "contact" || card.kind === "individual" || card.kind === "ecourse" ? card : null;
  const review = owner?.review ?? null;
  // the review this line has seen go: the line stays away even while the cards are being loaded again
  const [taken, setTaken] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!owner || !review || review.id === taken) return null;

  async function withdraw() {
    if (!owner || !review || readOnly || busy) return;
    setBusy(true);
    setError(null);
    const answer = await sendJson("/api/konto/arvustus/tagasi", { reviewId: review.id });
    if (isDone(answer)) {
      setTaken(review.id);
      return onWithdrawn();
    }
    if (answer.status === 404) {
      setTaken(review.id);
      await onGone?.(owner);
      return;
    }
    setError(answer.status === 429 ? t.online.rate : t.review.failed);
    setBusy(false);
  }

  return (
    <div className={styles.review} data-card-review="">
      <div className={styles.head}>
        <span className={styles.line}>{t.review.line}</span>
        <button
          type="button"
          className={cardStyles.second}
          aria-label={`${t.review.withdraw}: ${title}`}
          aria-disabled={readOnly || busy || undefined}
          onClick={() => void withdraw()}
          data-card-review-withdraw=""
        >
          {t.review.withdraw}
        </button>
      </div>
      {error && (
        <p className={styles.error} role="alert" data-card-review-error="">
          {error}
        </p>
      )}
    </div>
  );
}
