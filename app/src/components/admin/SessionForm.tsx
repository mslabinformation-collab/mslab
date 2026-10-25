"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CALENDAR_CITIES } from "@/domain/calendar";
import { COURSE_LANGUAGES } from "@/domain/course-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import type { EditResult, FieldError } from "@/server/admin-content";
import { deleteSession, saveSession } from "@/server/actions/admin-content";
import { Choice } from "./Choice";
import ui from "./ui.module.css";
import styles from "./editor.module.css";

export type SessionValues = {
  id: number | null;
  courseId: number | null;
  date: string;
  time: string;
  city: string;
  venue: string;
  language: string;
  capacity: number;
  status: "scheduled" | "cancelled";
};

/**
 * One course session (admin calendar drawer): contact course, Estonian date and start time, city, venue, language,
 * seats and status. Saved with "Lisa toimumine" / "Salvesta toimumine"; a session nobody has registered for can be
 * deleted after a confirmation (one with registrations is cancelled instead). Submitted through startTransition, so a
 * refused save keeps what was typed.
 */
export function SessionForm({
  initial,
  courses,
  registrations,
}: {
  initial: SessionValues;
  courses: { id: number; title: string; published: boolean }[];
  registrations?: { confirmed: number; awaiting: number };
}) {
  const t = adminEt.calendar;
  const e = adminEt.courseEditor.errors;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<EditResult | null, FormData>(saveSession, null);
  const [delState, delAction, delPending] = useActionState<EditResult | null, FormData>(deleteSession, null);
  const [confirming, setConfirming] = useState(false);
  const confirmText = useRef<HTMLParagraphElement>(null);
  const isNew = initial.id === null;

  const fields = state && !state.ok ? (state.fields ?? {}) : {};
  // an empty date, time or city gets its own words, not the content editor's "fill in (in Estonian)"
  const required: Record<string, string> = { date: e.date, time: e.time, city: t.form.cityRequired, courseId: e.course };
  const err = (name: string) => {
    const code = fields[name] as FieldError | undefined;
    if (!code) return undefined;
    // („Kinnitatud on {n} — …“: n the confirmed registrations, R-c)
    return code === "required" ? (required[name] ?? e.required) : fill(e[code], { n: registrations?.confirmed ?? 0 });
  };

  useEffect(() => {
    if (!state || state.ok || state.error !== "invalid") return;
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);
  useEffect(() => {
    if (confirming) confirmText.current?.focus();
  }, [confirming]);

  const submit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    if (pending) return;
    const fd = new FormData(ev.currentTarget);
    startTransition(() => action(fd));
  };
  const remove = () => {
    if (delPending || initial.id === null) return;
    const fd = new FormData();
    fd.set("id", String(initial.id));
    startTransition(() => delAction(fd));
  };

  /** Label, control, hint and error of one field. */
  const described = (name: string, hint?: string) => [hint ? `${uid}-${name}-hint` : "", err(name) ? `${uid}-${name}-error` : ""].filter(Boolean).join(" ") || undefined;
  const after = (name: string, hint?: string) => (
    <>
      {hint && (
        <p id={`${uid}-${name}-hint`} className={ui.hint}>
          {hint}
        </p>
      )}
      {err(name) && (
        <p id={`${uid}-${name}-error`} className={ui.error}>
          {err(name)}
        </p>
      )}
    </>
  );

  const message = pending
    ? { text: adminEt.common.saving, cls: ui.hint }
    : state && !state.ok
      ? { text: state.error === "invalid" ? adminEt.courseEditor.invalid : state.error === "notFound" ? t.drawer.notFound : adminEt.common.saveError, cls: ui.error }
      : state?.ok
        ? { text: t.form.saved, cls: ui.success }
        : { text: "", cls: ui.hint };

  return (
    <div className={styles.list}>
      <form ref={form} className={styles.list} onSubmit={submit} noValidate data-session-form="">
        <input type="hidden" name="id" value={initial.id ?? ""} />
        <div className={ui.field}>
          <label htmlFor={`${uid}-course`}>{t.form.course}</label>
          <select
            id={`${uid}-course`}
            name="courseId"
            className={`${ui.input} ${styles.select}`}
            defaultValue={initial.courseId ?? ""}
            aria-invalid={err("courseId") ? true : undefined}
            aria-describedby={described("courseId")}
          >
            {isNew && initial.courseId === null && <option value="">—</option>}
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.published ? c.title : `${c.title} (${t.draft})`}
              </option>
            ))}
          </select>
          {after("courseId")}
        </div>

        <div className={styles.grid}>
          <div className={ui.field}>
            <label htmlFor={`${uid}-date`}>{t.form.date}</label>
            <input id={`${uid}-date`} name="date" type="date" className={`${ui.input} ${styles.dateTime}`} defaultValue={initial.date} aria-invalid={err("date") ? true : undefined} aria-describedby={described("date")} />
            {after("date")}
          </div>
          <div className={ui.field}>
            <label htmlFor={`${uid}-time`}>{t.form.time}</label>
            <input
              id={`${uid}-time`}
              name="time"
              type="time"
              step={300}
              className={`${ui.input} ${styles.dateTime}`}
              defaultValue={initial.time}
              aria-invalid={err("time") ? true : undefined}
              aria-describedby={described("time", t.form.timeHint)}
            />
            {after("time", t.form.timeHint)}
          </div>
          <div className={ui.field}>
            <label htmlFor={`${uid}-city`}>{t.form.city}</label>
            <input
              id={`${uid}-city`}
              name="city"
              className={ui.input}
              list={`${uid}-cities`}
              maxLength={60}
              autoComplete="off"
              defaultValue={initial.city}
              aria-invalid={err("city") ? true : undefined}
              aria-describedby={described("city")}
            />
            <datalist id={`${uid}-cities`}>
              {CALENDAR_CITIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            {after("city")}
          </div>
          <div className={ui.field}>
            <label htmlFor={`${uid}-capacity`}>{t.form.capacity}</label>
            <input
              id={`${uid}-capacity`}
              name="capacity"
              className={ui.input}
              inputMode="numeric"
              maxLength={2}
              autoComplete="off"
              defaultValue={String(initial.capacity)}
              aria-invalid={err("capacity") ? true : undefined}
              aria-describedby={described("capacity")}
            />
            {after("capacity")}
          </div>
          <div className={`${ui.field} ${styles.wide}`}>
            <label htmlFor={`${uid}-venue`}>{t.form.venue}</label>
            <input
              id={`${uid}-venue`}
              name="venue"
              className={ui.input}
              maxLength={120}
              autoComplete="off"
              defaultValue={initial.venue}
              placeholder={t.form.venueHint}
              aria-invalid={err("venue") ? true : undefined}
              aria-describedby={described("venue")}
            />
            {after("venue")}
          </div>
          <div className={ui.field}>
            <label htmlFor={`${uid}-language`}>{t.form.language}</label>
            <select id={`${uid}-language`} name="language" className={`${ui.input} ${styles.select}`} defaultValue={initial.language}>
              {COURSE_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={ui.legend}>{t.form.status}</legend>
          <div className={styles.choices}>
            {(["scheduled", "cancelled"] as const).map((s) => (
              <Choice key={s} className={styles.choice} label={t.status[s]} type="radio" name="status" value={s} defaultChecked={initial.status === s} />
            ))}
          </div>
          <p className={ui.hint}>{t.form.statusHint}</p>
        </fieldset>

        {registrations && (
          <p className={`${ui.muted} ${ui.small}`} data-session-registrations="">
            {fill(t.form.registrations, registrations)}
          </p>
        )}

        <div className={styles.listHead}>
          <button type="submit" className={ui.btn} aria-disabled={pending || undefined}>
            {pending ? adminEt.common.saving : isNew ? t.form.create : t.form.save}
          </button>
          <p role="status" className={message.cls}>
            {message.text}
          </p>
        </div>
      </form>

      {!isNew && (
        <div className={styles.list} data-session-delete="">
          {confirming ? (
            <>
              <p ref={confirmText} tabIndex={-1} className={ui.notice}>
                {t.remove.confirm}
              </p>
              <span className={styles.chips}>
                <button type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} aria-disabled={delPending || undefined} onClick={remove}>
                  {delPending ? adminEt.common.saving : t.remove.yes}
                </button>
                <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => setConfirming(false)}>
                  {t.remove.no}
                </button>
              </span>
            </>
          ) : (
            <button type="button" className={`${ui.btn} ${ui.danger} ${ui.smallBtn} ${styles.addBtn}`} onClick={() => setConfirming(true)}>
              {t.remove.button}
            </button>
          )}
          {delState && !delState.ok && (
            <p role="alert" className={ui.error}>
              {delState.error === "inUse" ? t.remove.inUse : delState.error === "notFound" ? t.drawer.notFound : adminEt.common.saveError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
