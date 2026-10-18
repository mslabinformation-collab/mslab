"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { checkManualReview, REVIEW_NAME_MAX, REVIEW_NOTE_MAX, REVIEW_TEXT_MAX } from "@/domain/review";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { toStorable } from "@/lib/to-storable";
import { saveManualReviewAction } from "@/server/actions/admin-reviews";
import type { ReviewCourseOption } from "./review-view";
import ed from "./editor.module.css";
import ui from "./ui.module.css";
import styles from "./ReviewsPanel.module.css";

// „Lisa arvustus“ and „Muuda“ (student reviews, Task 4; spec D4): the form for a review Maria received elsewhere — the course, the name to show, the
// words, the day they were written, their language and her internal note „Kust see pärit on?“ (required, never shown publicly). Above its fields:
// „Lisa ainult päris õpilase sõnad tema loal.“ The rules are domain/review.ts checkManualReview, run here before anything is sent (the server checks
// them again). Text pasted from Word can carry a vertical tab or a form feed, which the rules refuse as invalid: before the check every control
// character becomes a space, and a line or page break a line break (`cleanPasted`). This file runs on old iPads: no regular expression with a
// lookbehind, here or in anything it imports (tests/unit/old-safari.test.ts).

export type ManualReviewValues = { courseId: string; name: string; text: string; writtenAt: string; locale: "et" | "ru"; note: string };

/**
 * The text as it is sent: a carriage return (alone or before a line feed) is a line break; every other control character but the line feed is a space,
 * except Word's line break (vertical tab) and page break (form feed), which are line breaks (lib/to-storable.ts, which also drops a broken surrogate).
 * Blank space at either end is left to checkManualReview, which trims.
 */
function cleanPasted(raw: string): string {
  return toStorable(raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u0009\u000e-\u001f\u007f]/g, " "));
}

type Line = { tone: "idle" | "busy" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };

export function ManualReviewForm({
  courses,
  initial,
  id,
  onDone,
  onCancel,
}: {
  courses: ReviewCourseOption[];
  /** The fields to start from: the review's own when it is edited, else the empty form (today's day, Estonian). */
  initial: ManualReviewValues;
  /** The review being edited, or null for a new one. */
  id: number | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = adminEt.reviews.form;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<ManualReviewValues>(initial);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [line, setLine] = useState<Line>(IDLE);
  const [pending, start] = useTransition();
  const set = <K extends keyof ManualReviewValues>(key: K, value: ManualReviewValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    // typing in a refused field takes its mark away
    setFields((f) => (f[key] === undefined ? f : Object.fromEntries(Object.entries(f).filter(([k]) => k !== key))));
  };

  // the form opens with the first field in hand
  useEffect(() => {
    form.current?.querySelector<HTMLElement>("select, input, textarea")?.focus();
  }, []);
  // a refused field: the first marked one takes the focus
  useEffect(() => {
    if (Object.keys(fields).length > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fields]);

  const errorOf = (key: string): string | undefined => {
    const code = fields[key];
    if (code === undefined) return undefined;
    return (t.errors as Record<string, string>)[code] ?? t.errors.invalid;
  };
  const describedBy = (key: string, extra?: string) => [extra, fields[key] === undefined ? "" : `${uid}-${key}-error`].filter(Boolean).join(" ") || undefined;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const cleaned = { ...values, name: cleanPasted(values.name), text: cleanPasted(values.text), note: cleanPasted(values.note) };
    setValues(cleaned);
    const checked = checkManualReview(cleaned);
    if (!checked.ok) {
      setFields(checked.fields);
      setLine(IDLE);
      return;
    }
    setFields({});
    setLine({ tone: "busy", text: adminEt.reviews.working });
    start(async () => {
      // (a lost connection rejects the call: words, not an error page)
      const result = await saveManualReviewAction({ id, ...checked.value }).catch(() => ({ ok: false as const, error: "server" as const, text: adminEt.reviews.errors.server }));
      if (result.ok) {
        setLine(IDLE);
        onDone();
      } else if ("fields" in result) {
        setFields(result.fields);
        setLine({ tone: "error", text: t.errors.invalid });
      } else setLine({ tone: "error", text: result.text });
    });
  };

  const counter = (key: "name" | "text" | "note", max: number) => (
    <p id={`${uid}-${key}-count`} className={`${ui.hint} ${styles.count}`} data-review-count={key}>
      {fill(t.count, { n: values[key].length, max })}
    </p>
  );
  const error = (key: string) =>
    errorOf(key) && (
      <p id={`${uid}-${key}-error`} className={ui.error}>
        {errorOf(key)}
      </p>
    );

  return (
    <form ref={form} className={styles.form} onSubmit={submit} noValidate aria-labelledby={`${uid}-title`} data-review-form={id ?? "new"}>
      <h3 id={`${uid}-title`} className={ui.h3}>
        {id === null ? t.add : t.editTitle}
      </h3>
      <p className={ui.notice} data-review-warning="">
        {t.warning}
      </p>
      <div className={`${ed.grid} ${styles.fields}`}>
        <div className={ui.field}>
          <label htmlFor={`${uid}-courseId`}>{t.course}</label>
          <select
            id={`${uid}-courseId`}
            className={`${ui.input} ${ed.select}`}
            value={values.courseId}
            onChange={(e) => set("courseId", e.target.value)}
            aria-invalid={fields.courseId !== undefined ? true : undefined}
            aria-describedby={describedBy("courseId")}
            data-review-field="courseId"
          >
            {values.courseId === "" && <option value="">{t.chooseCourse}</option>}
            {courses.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.label}
              </option>
            ))}
          </select>
          {error("courseId")}
        </div>

        <div className={ui.field}>
          <label htmlFor={`${uid}-name`}>{t.name}</label>
          <input
            id={`${uid}-name`}
            className={ui.input}
            type="text"
            autoComplete="off"
            maxLength={REVIEW_NAME_MAX}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            aria-invalid={fields.name !== undefined ? true : undefined}
            aria-describedby={describedBy("name", `${uid}-name-count`)}
            data-review-field="name"
          />
          {counter("name", REVIEW_NAME_MAX)}
          {error("name")}
        </div>

        <div className={`${ui.field} ${ed.wide}`}>
          <label htmlFor={`${uid}-text`}>{t.text}</label>
          <textarea
            id={`${uid}-text`}
            className={ui.textarea}
            rows={5}
            maxLength={REVIEW_TEXT_MAX}
            value={values.text}
            onChange={(e) => set("text", e.target.value)}
            aria-invalid={fields.text !== undefined ? true : undefined}
            aria-describedby={describedBy("text", `${uid}-text-count`)}
            data-review-field="text"
          />
          {counter("text", REVIEW_TEXT_MAX)}
          {error("text")}
        </div>

        <div className={ui.field}>
          <label htmlFor={`${uid}-writtenAt`}>{t.writtenAt}</label>
          <input
            id={`${uid}-writtenAt`}
            className={`${ui.input} ${ed.dateTime}`}
            type="date"
            value={values.writtenAt}
            onChange={(e) => set("writtenAt", e.target.value)}
            aria-invalid={fields.writtenAt !== undefined ? true : undefined}
            aria-describedby={describedBy("writtenAt")}
            data-review-field="writtenAt"
          />
          {error("writtenAt")}
        </div>

        <div className={ui.field}>
          <label htmlFor={`${uid}-locale`}>{t.locale}</label>
          <select
            id={`${uid}-locale`}
            className={`${ui.input} ${ed.select}`}
            value={values.locale}
            onChange={(e) => set("locale", e.target.value === "ru" ? "ru" : "et")}
            aria-invalid={fields.locale !== undefined ? true : undefined}
            aria-describedby={describedBy("locale")}
            data-review-field="locale"
          >
            <option value="et">{t.localeOptions.et}</option>
            <option value="ru">{t.localeOptions.ru}</option>
          </select>
          {error("locale")}
        </div>

        <div className={`${ui.field} ${ed.wide}`}>
          <label htmlFor={`${uid}-note`}>{t.note}</label>
          <textarea
            id={`${uid}-note`}
            className={ui.textarea}
            rows={2}
            maxLength={REVIEW_NOTE_MAX}
            value={values.note}
            onChange={(e) => set("note", e.target.value)}
            aria-invalid={fields.note !== undefined ? true : undefined}
            aria-describedby={describedBy("note", `${uid}-note-hint ${uid}-note-count`)}
            data-review-field="note"
          />
          <p id={`${uid}-note-hint`} className={ui.hint}>
            {t.noteHint}
          </p>
          {counter("note", REVIEW_NOTE_MAX)}
          {error("note")}
        </div>
      </div>

      <div className={styles.formActions}>
        <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined} data-review-save="">
          {pending ? adminEt.reviews.working : t.save}
        </button>
        <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => !pending && onCancel()} data-review-cancel="">
          {t.cancel}
        </button>
      </div>
      <p role="status" className={`${styles.status} ${line.tone === "error" ? ui.error : ui.hint}`} data-review-form-status="">
        {line.text}
      </p>
    </form>
  );
}

/** The fields of a new review: no course chosen (an explicit choice, so that a review is never filed under the first course by mistake), today's day, Estonian. */
export const emptyReview = (today: string): ManualReviewValues => ({ courseId: "", name: "", text: "", writtenAt: today, locale: "et", note: "" });
