"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { tallinnFormParts } from "@/domain/calendar";
import type { ReviewStatus } from "@/domain/review";
import { adminEt } from "@/i18n/dict/admin";
import { fill, formatDate } from "@/i18n/format";
import { decideReviewAction, deleteManualReviewAction, setFeaturedAction } from "@/server/actions/admin-reviews";
import { emptyReview, ManualReviewForm, type ManualReviewValues } from "./ManualReviewForm";
import type { ReviewCourseOption, ReviewRowView } from "./review-view";
import ui from "./ui.module.css";
import styles from "./ReviewsPanel.module.css";

// „Arvustused“ (student reviews, Task 4; spec D2, D4, §4, §5): the reviews of Tagasiside's second view, a pending one first. Each row shows the words and
// the name they will appear under, the course, the day and the language, the status, and what Maria judges a student by (the registration's status
// and whether a protocol was sent, or the day an e-course was completed) or, for a review she added, „Lisatud käsitsi“ and her note. The buttons follow
// the status: pending „Avalda“ and „Peida“, published „Peida“ and the „Avalehel“ toggle, hidden „Avalda“; a review she added also has „Muuda“ and
// „Kustuta“ (one confirming step). A student's words have no edit control at all. „Lisa arvustus“ opens the form (ManualReviewForm). The page is
// refreshed by the actions, so the rows then show the new state; a review that is not there any more (the student took her permission back) is answered
// in words and its row goes. This file runs on old iPads: no regular expression with a lookbehind, here or in anything it imports
// (tests/unit/old-safari.test.ts).

type Line = { tone: "idle" | "busy" | "done" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Line["tone"]) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);
const STATUS_TONE: Record<ReviewStatus, string> = { pending: ui.warn, published: ui.ok, hidden: ui.bad };

type Outcome = { ok: true } | { ok: false; error: string; text: string };

/** The fields of the form for a review that is edited (the day in Estonian time, as the form's date field holds it). */
const valuesOf = (r: ReviewRowView): ManualReviewValues => ({
  courseId: String(r.course.id),
  name: r.name,
  text: r.text,
  writtenAt: tallinnFormParts(new Date(r.writtenAt)).date,
  locale: r.locale,
  note: r.note ?? "",
});

/** The proof of a student's review, in words: the registration's status and the protocol line, or the day the e-course was completed. */
function proofText(proof: NonNullable<ReviewRowView["proof"]>): string {
  const t = adminEt.reviews;
  if (proof.kind === "completed") return fill(adminEt.feedback.completed, { date: formatDate(new Date(proof.completedAt), "et") });
  const status = (adminEt.registrations.status as Record<string, string>)[proof.status] ?? proof.status;
  return fill(t.proof.registration, { status, protocol: proof.protocolSent ? t.proof.protocolSent : t.proof.protocolNotSent });
}

export function ReviewsPanel({
  rows,
  courses,
  today,
  filtered,
}: {
  rows: ReviewRowView[];
  /** The courses „Lisa arvustus“ can name, in the public order. */
  courses: ReviewCourseOption[];
  /** Today, "YYYY-MM-DD" (Estonian time): the day a new review starts with. */
  today: string;
  /** The list is narrowed by a status: an empty list then says so in its own words. */
  filtered: boolean;
}) {
  const t = adminEt.reviews;
  const uid = useId();
  const [line, setLine] = useState<Line>(IDLE);
  const [pending, start] = useTransition();
  /** The forms that are open: "new" for „Lisa arvustus“, a review's id for its „Muuda“. Several may be open at once, so that nothing typed is lost. */
  const [editing, setEditing] = useState<ReadonlySet<number | "new">>(() => new Set());
  const [confirming, setConfirming] = useState<number | null>(null);
  const [gone, setGone] = useState<ReadonlySet<number>>(() => new Set());
  const panel = useRef<HTMLElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);

  // an answer in words (a refusal, or a deletion) takes the focus: the row it was about may be gone
  useEffect(() => {
    if (line.tone === "error" || line.tone === "done") statusLine.current?.focus();
  }, [line]);

  const visible = rows.filter((r) => !gone.has(r.id));

  const run = (id: number, work: () => Promise<Outcome>, after?: () => void) => {
    if (pending) return;
    setLine({ tone: "busy", text: t.working });
    start(async () => {
      // (a lost connection rejects the call: words, not an error page)
      const r = await work().catch((): Outcome => ({ ok: false, error: "server", text: t.errors.server }));
      if (r.ok) {
        setLine(IDLE);
        after?.();
        return;
      }
      setConfirming(null);
      setLine({ tone: "error", text: r.text });
      if (r.error === "gone" || r.error === "manualGone") setGone((g) => new Set(g).add(id));
    });
  };
  const decide = (id: number, decision: "publish" | "hide") =>
    run(id, () => decideReviewAction({ id, decision }), () => document.getElementById(`${uid}-review-${id}`)?.focus());
  const feature = (r: ReviewRowView) => run(r.id, () => setFeaturedAction({ id: r.id, featured: !r.featured }));
  const remove = (id: number) =>
    run(
      id,
      () => deleteManualReviewAction({ id }),
      () => {
        setConfirming(null);
        setGone((g) => new Set(g).add(id));
        setLine({ tone: "done", text: t.deleted });
      },
    );

  const open = (which: number | "new") => setEditing((set) => new Set(set).add(which));
  /** A form closes (saved, or „Tühista“): the focus goes back to the button that opened it, which is a new element once the form has gone. */
  const close = (which: number | "new") => {
    setEditing((set) => new Set([...set].filter((x) => x !== which)));
    const opener = which === "new" ? "[data-review-add]" : `[data-review="${which}"] [data-review-edit]`;
    setTimeout(() => panel.current?.querySelector<HTMLElement>(opener)?.focus(), 0);
  };

  return (
    <section ref={panel} className={styles.panel} aria-labelledby={`${uid}-title`} data-reviews-panel="">
      <div className={styles.toolbar}>
        <h2 id={`${uid}-title`} className={ui.h2}>
          {t.title}
        </h2>
        {!editing.has("new") && (
          <button type="button" className={`${ui.btn} ${ui.smallBtn}`} onClick={() => open("new")} data-review-add="">
            {t.form.add}
          </button>
        )}
      </div>

      {editing.has("new") && (
        <div className={`${ui.card} ${styles.addCard}`}>
          <ManualReviewForm courses={courses} initial={emptyReview(today)} id={null} onDone={() => close("new")} onCancel={() => close("new")} />
        </div>
      )}

      <p ref={statusLine} tabIndex={-1} role="status" className={`${styles.status} ${toneClass(line.tone)}`} data-reviews-status="">
        {line.text}
      </p>

      {visible.length === 0 ? (
        <p className={ui.empty} data-reviews-empty="">
          {filtered ? t.emptyFiltered : t.empty}
        </p>
      ) : (
        <ul className={styles.list} data-review-list="">
          {visible.map((r) => {
            const label = (action: string) => fill(t.label, { action, name: r.name });
            const manual = r.kind === "manual";
            return (
              <li
                key={r.id}
                id={`${uid}-review-${r.id}`}
                tabIndex={-1}
                className={styles.row}
                data-review={r.id}
                data-review-kind={r.kind}
                data-review-status={r.status}
                data-review-featured={r.featured || undefined}
              >
                {editing.has(r.id) ? (
                  <ManualReviewForm courses={courses} initial={valuesOf(r)} id={r.id} onDone={() => close(r.id)} onCancel={() => close(r.id)} />
                ) : (
                  <>
                    <div className={styles.head}>
                      <strong className={styles.name} data-review-name="">
                        {r.name}
                      </strong>
                      <span className={`${ui.tag} ${STATUS_TONE[r.status]}`} data-review-tag="">
                        {t.status[r.status]}
                      </span>
                      {manual && (
                        <span className={ui.tag} data-review-manual="">
                          {t.manual}
                        </span>
                      )}
                    </div>
                    <p className={styles.text} data-review-text="">
                      {r.text}
                    </p>
                    <p className={styles.meta} data-review-facts="">
                      <span>{r.course.title}</span>
                      <span>{formatDate(new Date(r.writtenAt), "et")}</span>
                      <span>{fill(t.language, { locale: adminEt.common.locale[r.locale] })}</span>
                    </p>
                    {r.proof && (
                      <p className={styles.meta} data-review-proof="">
                        {proofText(r.proof)}
                      </p>
                    )}
                    {manual && r.note && (
                      <p className={styles.meta} data-review-note="">
                        {fill(t.source, { note: r.note })}
                      </p>
                    )}
                    <div className={styles.actions}>
                      {r.status !== "published" && (
                        <button type="button" className={`${ui.btn} ${ui.smallBtn}`} aria-label={label(t.publish)} aria-disabled={pending || undefined} onClick={() => decide(r.id, "publish")} data-review-publish="">
                          {t.publish}
                        </button>
                      )}
                      {r.status !== "hidden" && (
                        <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} aria-label={label(t.hide)} aria-disabled={pending || undefined} onClick={() => decide(r.id, "hide")} data-review-hide="">
                          {t.hide}
                        </button>
                      )}
                      {r.status === "published" && (
                        <button
                          type="button"
                          className={`${ui.btn} ${ui.secondary} ${ui.smallBtn} ${styles.toggle}`}
                          aria-label={label(t.featured)}
                          aria-pressed={r.featured}
                          aria-disabled={pending || undefined}
                          onClick={() => feature(r)}
                          data-review-featured-toggle=""
                        >
                          {t.featured}
                        </button>
                      )}
                      {manual && (
                        <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} aria-label={label(t.edit)} aria-disabled={pending || undefined} onClick={() => open(r.id)} data-review-edit="">
                          {t.edit}
                        </button>
                      )}
                      {manual && confirming !== r.id && (
                        <button type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} aria-label={label(t.delete)} aria-disabled={pending || undefined} onClick={() => setConfirming(r.id)} data-review-delete="">
                          {t.delete}
                        </button>
                      )}
                    </div>
                    {manual && confirming === r.id && (
                      <div className={styles.confirm} role="group" aria-label={label(t.delete)} data-review-confirm="">
                        <p>{t.deleteConfirm}</p>
                        <div className={styles.actions}>
                          <button type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} aria-disabled={pending || undefined} onClick={() => remove(r.id)} data-review-delete-yes="">
                            {t.deleteYes}
                          </button>
                          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => !pending && setConfirming(null)} data-review-delete-no="">
                            {t.deleteNo}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
