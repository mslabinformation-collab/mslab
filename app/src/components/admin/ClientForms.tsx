"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { isEmail, normalizeEmail, typoSuggestion } from "@/domain/email";
import { addStudent, grantCourseAccess } from "@/server/actions/admin-clients";
import type { ClientResult } from "@/server/admin-clients";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import forms from "./RegistrationForms.module.css";
import styles from "./ClientDrawer.module.css";

// The Õpilased forms: "Lisa õpilane +" on the list (a button that opens a small form) and "Ava ligipääs" in a student's drawer (a folded row). Submitted
// through startTransition (React does not reset the fields after an error); while one is on its way its button is aria-disabled (a disabled button would
// drop the keyboard focus) and a second press does nothing. A card's own actions — "Hinda", "Pikenda ▾", "Veel ▾" with "Ava järgmine õppetund" and "Lõpeta
// ligipääs" — are AccessActions.tsx.

type Action = (fd: FormData) => void;
const submitWith = (action: Action, pending: boolean) => (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  if (pending) return;
  const fd = new FormData(e.currentTarget);
  startTransition(() => action(fd));
};

export type AddStudentTexts = {
  /** The header button that opens the form: „Lisa õpilane +“. */
  toggle: string;
  label: string;
  button: string;
  hint: string;
  invalid: string;
  typo: string;
  typoYes: string;
  typoNo: string;
  saving: string;
  error: string;
};

/**
 * "Lisa õpilane +" (README A5): a button in the list's header that opens a small form — an e-mail and "Lisa õpilane". The server opens the student's drawer
 * (new or existing) over the list this was opened from: `back` is that list's own address (its `vorm`, `otsi` and `leht`, without the leading "?"), sent
 * along with the e-mail. An obvious typo in a common domain ("gmial.com") asks first, as the login page does (spec 2.1 rule 8): "Kas mõtlesid …?" with
 * "Jah, paranda" (adds the corrected address) and "Ei, lisa nii" (adds it as typed); typing again takes the question away. The field takes the focus when
 * the form opens; the button again, and Esc, close it and the focus goes back to the button.
 */
export function AddStudentForm({ t, back }: { t: AddStudentTexts; back: string }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [typo, setTypo] = useState<string | null>(null);
  const [state, action, pending] = useActionState<ClientResult | null, FormData>(addStudent, null);
  const yes = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const error = state && !state.ok ? (state.error === "email" ? t.invalid : t.error) : null;

  useEffect(() => {
    if (typo) yes.current?.focus();
  }, [typo]);

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setTypo(null);
    // (once the form has gone: the button is where it was)
    requestAnimationFrame(() => toggle.current?.focus());
  };

  const send = (address: string) => {
    if (pending) return;
    setTypo(null);
    const fd = new FormData();
    fd.set("email", address);
    fd.set("back", back);
    startTransition(() => action(fd));
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const address = normalizeEmail(email);
    const fixed = isEmail(address) ? typoSuggestion(address) : null;
    if (fixed) setTypo(fixed);
    else send(email);
  };
  const [before, after = ""] = t.typo.split("{fixed}");

  return (
    <div className={styles.addBox}>
      <button
        ref={toggle}
        type="button"
        className={ui.btn}
        aria-expanded={open}
        aria-controls={open ? `${uid}-form` : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        data-add-toggle=""
      >
        {t.toggle}
      </button>
      {open && (
        <form
          id={`${uid}-form`}
          className={styles.add}
          onSubmit={submit}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            // only this form: a drawer around it stays open
            e.preventDefault();
            e.stopPropagation();
            close();
          }}
          noValidate
          data-add-student=""
        >
          <div className={ui.field}>
            <label htmlFor={`${uid}-email`}>{t.label}</label>
            <div className={forms.inline}>
              <input
                ref={field}
                id={`${uid}-email`}
                name="email"
                type="email"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                maxLength={254}
                className={`${ui.input} ${styles.addInput}`}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setTypo(null);
                }}
                aria-invalid={state && !state.ok && state.error === "email" ? true : undefined}
                aria-describedby={`${uid}-hint ${uid}-msg`}
              />
              {!typo && (
                <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined}>
                  {pending ? t.saving : t.button}
                </button>
              )}
            </div>
            {typo && (
              <div className={styles.typo} role="group" aria-labelledby={`${uid}-typo`} data-add-typo="">
                <p id={`${uid}-typo`}>
                  {before}
                  <b>{typo}</b>
                  {after}
                </p>
                <div className={forms.actions}>
                  <button
                    ref={yes}
                    type="button"
                    className={`${ui.btn} ${ui.smallBtn}`}
                    onClick={() => {
                      setEmail(typo);
                      send(typo);
                    }}
                  >
                    {t.typoYes}
                  </button>
                  <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => send(email)}>
                    {t.typoNo}
                  </button>
                </div>
              </div>
            )}
            <p id={`${uid}-hint`} className={ui.hint}>
              {t.hint}
            </p>
            <p id={`${uid}-msg`} role="status" className={ui.error}>
              {error ?? ""}
            </p>
          </div>
        </form>
      )}
    </div>
  );
}

export type GrantTexts = {
  title: string;
  course: string;
  until: string;
  untilHint: string;
  /** the hint when the course has no access months of its own and the default filled the day in */
  untilHintDefault: string;
  button: string;
  done: string;
  courseError: string;
  date: string;
  notFound: string;
  saving: string;
  error: string;
};
/** `defaulted`: the course has no access months of its own, so `until` is the default length from today. */
export type GrantCourse = { id: number; label: string; until: string; defaulted: boolean };

/**
 * "Ava ligipääs" (the folded row "Ava ligipääs e-koolitusele", README A5): the e-course (a draft is marked "mustand", one she can open now "avatud kuni …") and
 * the last day, filled in with today + the course's access months (a new course choice fills in its own); one button. Granting a course the student had
 * before opens it again until the new day. The form is named by the row it is in.
 */
export function GrantAccessForm({ clientId, courses, initialCourseId, today, t }: { clientId: number; courses: GrantCourse[]; initialCourseId: number; today: string; t: GrantTexts }) {
  const uid = useId();
  const [courseId, setCourseId] = useState(initialCourseId);
  const [until, setUntil] = useState(() => courses.find((c) => c.id === initialCourseId)?.until ?? "");
  const [state, action, pending] = useActionState<ClientResult | null, FormData>(grantCourseAccess, null);
  // the last answer is about what was sent: a changed course or day is not "opened" (nor refused) yet
  const [edited, setEdited] = useState(false);
  const answer = edited ? null : state;
  const error = answer && !answer.ok ? (answer.error === "date" ? t.date : answer.error === "course" ? t.courseError : answer.error === "notFound" ? t.notFound : t.error) : null;
  const message = pending ? t.saving : (error ?? (answer?.ok ? t.done : ""));
  const courseError = answer && !answer.ok && answer.error === "course";
  const dateError = answer && !answer.ok && answer.error === "date";
  const defaulted = courses.find((c) => c.id === courseId)?.defaulted ?? false;
  return (
    <form
      className={`${forms.form} ${styles.grant}`}
      onSubmit={(e) => {
        setEdited(false);
        submitWith(action, pending)(e);
      }}
      noValidate
      aria-label={t.title}
      data-grant-form=""
    >
      <input type="hidden" name="clientId" value={clientId} />
      <div className={ui.field}>
        <label htmlFor={`${uid}-course`}>{t.course}</label>
        <select
          id={`${uid}-course`}
          name="courseId"
          className={`${ui.input} ${ed.select}`}
          value={courseId}
          onChange={(e) => {
            const next = Number(e.target.value);
            setCourseId(next);
            setUntil(courses.find((c) => c.id === next)?.until ?? until);
            setEdited(true);
          }}
          aria-invalid={courseError || undefined}
          aria-describedby={courseError ? `${uid}-msg` : undefined}
        >
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className={ui.field}>
        <label htmlFor={`${uid}-until`}>{t.until}</label>
        <input
          id={`${uid}-until`}
          name="until"
          type="date"
          min={today}
          className={`${ui.input} ${ed.dateTime} ${styles.date}`}
          value={until}
          onChange={(e) => {
            setUntil(e.target.value);
            setEdited(true);
          }}
          aria-invalid={dateError || undefined}
          aria-describedby={dateError ? `${uid}-hint ${uid}-msg` : `${uid}-hint`}
        />
        <p id={`${uid}-hint`} className={ui.hint} data-grant-hint="">
          {defaulted ? t.untilHintDefault : t.untilHint}
        </p>
      </div>
      <div className={forms.actions}>
        <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined}>
          {pending ? t.saving : t.button}
        </button>
      </div>
      <p id={`${uid}-msg`} role="status" className={error ? ui.error : ui.success} data-grant-status="">
        {message}
      </p>
    </form>
  );
}
