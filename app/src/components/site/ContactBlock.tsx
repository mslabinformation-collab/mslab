"use client";

import Image from "next/image";
import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { circleCrop } from "@/domain/site-editor";
import type { Locale } from "@/i18n/locales";
import { submitContact } from "@/server/actions/public";
import { Icon } from "./Icon";
import ui from "./ui.module.css";
import styles from "./ContactBlock.module.css";

export type ContactTexts = {
  eyebrow: string;
  title: string;
  lead: string;
  name: string;
  email: string;
  message: string;
  messagePlaceholder: string;
  submit: string;
  sending: string;
  sent: string;
  errorRequired: string;
  errorEmail: string;
  errorTooMany: string;
  errorGeneric: string;
};

type Errors = Partial<Record<"name" | "email" | "message" | "form", string>>;
type State = { status: "idle" } | { status: "sent" } | { status: "error"; errors: Errors };

/**
 * Prototype D contact block (Maria C31 / H15): "Ei tea, milline koolitus sobib?" with Maria's photo and a form
 * that posts to the `submitContact` server action (stored as a contact request, then Maria is notified). Used on the home page
 * and on /kontakt. After a failed submit focus goes to the first field with an error, after success to the confirmation.
 */
export function ContactBlock({ locale, t, person }: { locale: Locale; t: ContactTexts; person: { name: string; photo: string; crop?: { pos: string; zoom: number } | null } }) {
  const id = useId();
  const [values, setValues] = useState({ name: "", email: "", message: "" });
  const sentRef = useRef<HTMLDivElement>(null);
  const [state, formAction, pending] = useActionState<State, FormData>(async (_prev, formData) => {
    try {
      const result = await submitContact(formData);
      if (result.ok) return { status: "sent" };
      const e = result.errors;
      const errors: Errors = {};
      if (e.name) errors.name = t.errorRequired;
      if (e.email) errors.email = t.errorEmail;
      if (e.message) errors.message = t.errorRequired;
      if (e.form) errors.form = e.form === "rate" ? t.errorTooMany : t.errorGeneric;
      if (Object.keys(errors).length === 0) errors.form = t.errorGeneric;
      return { status: "error", errors };
    } catch {
      return { status: "error", errors: { form: t.errorGeneric } };
    }
  }, { status: "idle" });

  // Land keyboard and screen-reader users on the confirmation, or on the first field that needs fixing.
  useEffect(() => {
    if (state.status === "sent") sentRef.current?.focus();
    else if (state.status === "error") {
      const first = (["name", "email", "message"] as const).find((f) => state.errors[f]);
      document.getElementById(first ? `${id}-${first}` : `${id}-form-error`)?.focus();
    }
  }, [state, id]);

  const errors: Errors = state.status === "error" ? state.errors : {};
  const fieldProps = (k: "name" | "email" | "message") => ({
    id: `${id}-${k}`,
    name: k,
    value: values[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((v) => ({ ...v, [k]: e.target.value })),
    "aria-invalid": errors[k] ? true : undefined,
    "aria-describedby": errors[k] ? `${id}-${k}-error` : undefined,
  });
  const fieldError = (k: "name" | "email" | "message") =>
    errors[k] && (
      <span id={`${id}-${k}-error`} className={styles.error}>
        {errors[k]}
      </span>
    );

  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={ui.wrap}>
        <div className={styles.contact}>
          <div>
            <p className={`${ui.caps} ${styles.eyebrow}`}>{t.eyebrow}</p>
            <h2 id={`${id}-title`} className={ui.h2}>
              {t.title}
            </h2>
            <p className={`${ui.lead} ${styles.lead}`}>{t.lead}</p>
            {person.name && (
              <div className={styles.who}>
                {/* (the contact photo cut as Koolitaja's circle frames it: UX pass 11.11 P7; the reply time is the lead's, said once: P8) */}
                {person.photo && (
                  <span className={styles.avatar} data-contact-avatar="">
                    <Image src={person.photo} alt="" width={52} height={52} unoptimized style={person.crop ? circleCrop(person.crop.pos, person.crop.zoom) : undefined} />
                  </span>
                )}
                <b>{person.name}</b>
              </div>
            )}
          </div>

          {state.status === "sent" ? (
            <div ref={sentRef} className={styles.sent} role="status" tabIndex={-1}>
              <span className={styles.tick} aria-hidden="true">
                <Icon name="check" size={18} />
              </span>
              <p>{t.sent}</p>
            </div>
          ) : (
            <form
              className={styles.form}
              method="post"
              noValidate
              data-contact-form=""
              // Submitted by hand, as the other forms (no React form reset); method="post" keeps the message out of the URL.
              onSubmit={(e) => {
                e.preventDefault();
                if (pending) return;
                const formData = new FormData(e.currentTarget);
                startTransition(() => formAction(formData));
              }}
            >
              <div className={styles.field}>
                <label htmlFor={`${id}-name`}>{t.name}</label>
                <input {...fieldProps("name")} type="text" required autoComplete="name" maxLength={120} />
                {fieldError("name")}
              </div>
              <div className={styles.field}>
                <label htmlFor={`${id}-email`}>{t.email}</label>
                <input {...fieldProps("email")} type="email" required autoComplete="email" maxLength={200} />
                {fieldError("email")}
              </div>
              <div className={styles.field}>
                <label htmlFor={`${id}-message`}>{t.message}</label>
                <textarea {...fieldProps("message")} required rows={4} maxLength={2000} placeholder={t.messagePlaceholder} />
                {fieldError("message")}
              </div>
              <input type="hidden" name="locale" value={locale} />
              {/* Honeypot: people never see or fill it. */}
              <div className={styles.honeypot} aria-hidden="true">
                <label>
                  Website
                  <input name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
                </label>
              </div>
              {errors.form && (
                <p id={`${id}-form-error`} className={styles.error} role="alert" tabIndex={-1}>
                  {errors.form}
                </p>
              )}
              {/* aria-disabled, not disabled: a disabled button would drop keyboard focus to the page while sending. */}
              <button className={`${ui.btn} ${ui.btnFull}`} type="submit" aria-disabled={pending || undefined}>
                {pending ? t.sending : t.submit}
                <Icon name="arrow" />
              </button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
