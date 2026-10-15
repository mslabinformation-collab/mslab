"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { CERT_LIMITS } from "@/domain/certificate";
import type { AdminDict } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { reissueCertificateAction } from "@/server/actions/admin-certificates";
import ui from "./ui.module.css";
import forms from "./RegistrationForms.module.css";
import styles from "./ClientDrawer.module.css";

export type ReissueTexts = AdminDict["certificates"]["reissue"] & { saving: string; error: string };

/**
 * "Paranda nimi" (phase 3d, spec §6, D3) on a certificate in a student's drawer: a small form in place with the name as it is printed; the
 * same rules as hers (server/certificates.ts reissueCertificate: 2–80 characters, the Latin letters the script font draws — the name as in
 * her passport; Cyrillic is refused —, spaces, hyphens, apostrophes and dots; Review Focus 2: an emoji or digits are refused on the field,
 * nothing stored). "Väljasta uuesti" re-issues it under the same number, sets its re-issue day and mails nobody; the page is refreshed (the
 * drawer's line and the register show the new name), and the line that says what was done stays and takes the focus. "Katkesta" closes the
 * form with the focus back on the button.
 */
export function ReissueCertificate({ certificateId, name, t }: { certificateId: number; name: string; t: ReissueTexts }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [pending, start] = useTransition();
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const doneLine = useRef<HTMLParagraphElement>(null);

  // the form opened, or a refusal: the field has the focus
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open, error]);
  useEffect(() => {
    if (done) doneLine.current?.focus();
  }, [done]);

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    start(async () => {
      const result = await reissueCertificateAction({ certificateId, name: value });
      if (result.kind === "reissued") {
        setError("");
        setOpen(false);
        setDone(fill(t.done, { number: result.certificate.number, name: result.certificate.name }));
      } else if (result.kind === "invalid") setError(t.errors[result.error]);
      else setError(result.kind === "notFound" ? t.errors.notFound : t.error);
    });
  };

  return (
    <>
      {!open && (
        <button
          ref={opener}
          type="button"
          className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
          onClick={() => {
            setValue(name);
            setError("");
            setDone("");
            setOpen(true);
          }}
          data-reissue=""
        >
          {t.button}
        </button>
      )}
      {open && (
        <form className={styles.confirm} onSubmit={save} noValidate data-reissue-form="">
          <div className={ui.field}>
            <label htmlFor={`${uid}-name`}>{t.label}</label>
            <input
              ref={field}
              id={`${uid}-name`}
              className={ui.input}
              type="text"
              autoComplete="off"
              maxLength={CERT_LIMITS.nameMax}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${uid}-hint ${uid}-error` : `${uid}-hint`}
              data-reissue-name=""
            />
            <p id={`${uid}-hint`} className={ui.hint}>
              {t.hint}
            </p>
            {error && (
              <p id={`${uid}-error`} role="alert" className={ui.error} data-reissue-error="">
                {error}
              </p>
            )}
          </div>
          <div className={forms.actions}>
            <button type="submit" className={`${ui.btn} ${ui.smallBtn}`} aria-disabled={pending || undefined} data-reissue-save="">
              {pending ? t.saving : t.save}
            </button>
            <button
              type="button"
              className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
              onClick={() => {
                setOpen(false);
                setError("");
                requestAnimationFrame(() => opener.current?.focus());
              }}
            >
              {t.cancel}
            </button>
          </div>
        </form>
      )}
      <p ref={doneLine} tabIndex={-1} role="status" className={`${ui.success} ${styles.done}`} data-reissue-done="">
        {done}
      </p>
    </>
  );
}
