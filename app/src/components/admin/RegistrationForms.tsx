"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { NOTE_MAX, type RegStatus } from "@/domain/registration";
import type { AdminResult } from "@/server/admin";
import { cancelRegistration, saveRegistrationStatus } from "@/server/actions/admin";
import ui from "./ui.module.css";
import styles from "./RegistrationForms.module.css";

export type RegistrationFormTexts = {
  statusLabel: string;
  noteLabel: string;
  noteHint: string;
  noteTooLong: string;
  statusSave: string;
  statusSaved: string;
  stale: string;
  cancel: string;
  cancelled: string;
  saving: string;
  error: string;
  status: Record<RegStatus, string>;
};

const STATUSES: RegStatus[] = ["awaiting_prepayment", "confirmed", "cancelled"];

/**
 * The registration drawer's forms: status + note, and "Tühista" (money is added with „Lisa laekumine“ on the Raha card,
 * admin UX pass B4: the typed „Laekunud summa“ field is gone). The fields follow the saved values: after any save the
 * page is refreshed and new props come in (a payment can change the status, so the status choice must not keep a stale
 * value and overwrite it later). Submitted through startTransition, so React does not reset the fields after an error.
 */
export function RegistrationForms({
  id,
  status,
  note,
  t,
}: {
  id: number;
  status: RegStatus;
  note: string;
  t: RegistrationFormTexts;
}) {
  const uid = useId();
  const [chosen, setChosen] = useState<RegStatus>(status);
  const [text, setText] = useState(note);
  const [seen, setSeen] = useState({ status, note });
  if (seen.status !== status || seen.note !== note) {
    setSeen({ status, note });
    if (seen.status !== status) setChosen(status);
    if (seen.note !== note) setText(note);
  }

  const [statusState, statusAction, statusPending] = useActionState<AdminResult | null, FormData>(saveRegistrationStatus, null);
  const [cancelState, cancelAction, cancelPending] = useActionState<AdminResult | null, FormData>(cancelRegistration, null);

  // aria-disabled, not disabled, while saving: a disabled button would drop the keyboard focus.
  const submit = (action: (fd: FormData) => void, pending: boolean) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const fd = new FormData(e.currentTarget);
    startTransition(() => action(fd));
  };

  // "Tühista" disappears once the registration is cancelled: the focus moves to the line that replaces it.
  const cancelledNote = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (cancelState?.ok && status === "cancelled") cancelledNote.current?.focus();
  }, [cancelState, status]);

  const statusError =
    statusState && !statusState.ok ? (statusState.error === "note" ? t.noteTooLong : statusState.error === "stale" ? t.stale : t.error) : null;
  const cancelError = cancelState && !cancelState.ok ? t.error : null;

  return (
    <div className={styles.forms}>
      <form className={styles.form} onSubmit={submit(statusAction, statusPending)} data-status-form="">
        <input type="hidden" name="id" value={id} />
        {/* the status this form shows: the server refuses the change if the stored one is different by now */}
        <input type="hidden" name="expected" value={status} />
        <fieldset className={styles.fieldset}>
          <legend className={ui.legend}>{t.statusLabel}</legend>
          <div className={styles.choices}>
            {STATUSES.map((s) => (
              <label key={s} className={styles.choice}>
                <input type="radio" name="status" value={s} checked={chosen === s} onChange={() => setChosen(s)} />
                <span>{t.status[s]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className={ui.field}>
          <label htmlFor={`${uid}-note`}>{t.noteLabel}</label>
          <textarea
            id={`${uid}-note`}
            name="note"
            className={ui.textarea}
            maxLength={NOTE_MAX}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-describedby={`${uid}-note-hint`}
          />
          <p id={`${uid}-note-hint`} className={ui.hint}>
            {t.noteHint}
          </p>
        </div>
        <div className={styles.actions}>
          <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={statusPending || undefined}>
            {statusPending ? t.saving : t.statusSave}
          </button>
        </div>
        <p role="status" className={statusError ? ui.error : ui.success}>
          {statusError ?? (statusState?.ok ? t.statusSaved : "")}
        </p>
      </form>

      <form className={styles.form} onSubmit={submit(cancelAction, cancelPending)} data-cancel-form="">
        <input type="hidden" name="id" value={id} />
        {status === "cancelled" ? (
          <p ref={cancelledNote} tabIndex={-1} className={ui.muted} data-cancelled="">
            {t.cancelled}
          </p>
        ) : (
          <button type="submit" className={`${ui.btn} ${ui.danger} ${ui.smallBtn}`} aria-disabled={cancelPending || undefined}>
            {cancelPending ? t.saving : t.cancel}
          </button>
        )}
        {cancelError && (
          <p role="alert" className={ui.error}>
            {cancelError}
          </p>
        )}
      </form>
    </div>
  );
}
