"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { PRACTICE_CITIES, parsePackage } from "@/domain/practice";
import { fill } from "@/i18n/format";
import type { Locale } from "@/i18n/locales";
import { useUrlQuery } from "@/lib/url-query";
import { submitPractice } from "@/server/actions/public";
import { Icon } from "./Icon";
import ui from "./ui.module.css";
import styles from "./PracticeRequest.module.css";

export type PracticeOption = { code: string; name: string; duration: string; price: string };

export type PracticeRequestTexts = {
  selectedPackage: string;
  packageLabel: string;
  packageRequired: string;
  durationLabel: string;
  cityLabel: string;
  cityRequired: string;
  /** The label of each of PRACTICE_CITIES (the stored value is the key). */
  cities: Record<string, string>;
  name: string;
  email: string;
  phone: string;
  completedCourse: string;
  optional: string;
  preferredTimes: string;
  preferredTimesPlaceholder: string;
  note: string;
  submit: string;
  sending: string;
  sent: string;
  sentText: string;
  errorRequired: string;
  errorEmail: string;
  errorTooMany: string;
  errorGeneric: string;
};

type Text = "name" | "email" | "phone" | "course" | "times";
type Field = "package" | "city" | Text | "form";
type Errors = Partial<Record<Field, string>>;
type State = { status: "idle" } | { status: "sent" } | { status: "error"; errors: Errors };

/** Where focus goes after a failed submit: the first of these with an error, in page order. */
const FIELD_ORDER: Field[] = ["package", "city", "name", "email", "phone", "course", "times"];

/**
 * Practice request (prototype B `#registration`, R1): package, city (Pärnu or Tallinn, the student picks), name, e-mail, phone, completed course, preferred times
 * → submitPractice (stored as a `practice` request). It asks for a time; Maria confirms it, nothing is booked.
 *
 * The package follows ?pakett (the home and panel "Registreeru" links, Back/Forward); picking one here writes it
 * back in place (useUrlQuery), so the card outline in the panel and a reload agree with the form.
 */
export function PracticeRequest({ packages, locale, t }: { packages: PracticeOption[]; locale: Locale; t: PracticeRequestTexts }) {
  const id = useId();
  const [query, writeQuery] = useUrlQuery();
  const fromUrl = parsePackage(query.get("pakett"), packages.map((p) => p.code));
  const [pkg, setPkg] = useState<string | null>(fromUrl);
  const [seen, setSeen] = useState<string | null>(fromUrl);
  // A new ?pakett (a card's "Registreeru" link while on this page) picks that package.
  if (fromUrl !== seen) {
    setSeen(fromUrl);
    setPkg(fromUrl);
  }
  const [city, setCity] = useState<string | null>(null);
  const [values, setValues] = useState({ name: "", email: "", phone: "", course: "", times: "" });
  const sentRef = useRef<HTMLDivElement>(null);

  const [state, formAction, pending] = useActionState<State, FormData>(async (_prev, formData) => {
    try {
      const result = await submitPractice(formData);
      if (result.ok) return { status: "sent" };
      const errors: Errors = {};
      for (const [f, code] of Object.entries(result.errors)) {
        if (f === "form") errors.form = code === "rate" ? t.errorTooMany : t.errorGeneric;
        else if (f === "email") errors.email = t.errorEmail;
        else if (f === "package") errors.package = t.packageRequired;
        else if (f === "city") errors.city = t.cityRequired;
        else errors[f as Field] = t.errorRequired;
      }
      if (Object.keys(errors).length === 0) errors.form = t.errorGeneric;
      return { status: "error", errors };
    } catch {
      return { status: "error", errors: { form: t.errorGeneric } };
    }
  }, { status: "idle" });

  useEffect(() => {
    if (state.status === "sent") {
      sentRef.current?.focus();
      return;
    }
    if (state.status !== "error") return;
    const first = FIELD_ORDER.find((f) => state.errors[f]);
    document.getElementById(first ? `${id}-${first}` : `${id}-form-error`)?.focus();
  }, [state, id]);

  const choose = (code: string) => {
    setPkg(code);
    const live = new URLSearchParams(window.location.search);
    live.set("pakett", code);
    writeQuery(live);
  };

  // Nothing to request without a package (the page does not render the form then either).
  if (packages.length === 0) return null;

  if (state.status === "sent") {
    return (
      <div ref={sentRef} className={styles.sent} role="status" tabIndex={-1} data-practice-sent="">
        <span className={styles.tick} aria-hidden="true">
          <Icon name="check" size={22} />
        </span>
        <p className={styles.sentTitle}>{t.sent}</p>
        <p className={styles.sentText}>{t.sentText}</p>
      </div>
    );
  }

  const errors: Errors = state.status === "error" ? { ...state.errors } : {};
  if (pkg) delete errors.package;
  if (city) delete errors.city;
  const err = (f: Field) =>
    errors[f] ? (
      <span id={`${id}-${f}-error`} className={styles.error}>
        {errors[f]}
      </span>
    ) : null;
  const text = (f: Text) => ({
    id: `${id}-${f}`,
    name: f,
    value: values[f],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((v) => ({ ...v, [f]: e.target.value })),
    "aria-invalid": errors[f] ? true : undefined,
    "aria-describedby": errors[f] ? `${id}-${f}-error` : undefined,
  });
  const chosen = packages.find((p) => p.code === pkg);

  return (
    <>
      {chosen && <p className={styles.selected}>{fill(t.selectedPackage, { name: chosen.name })}</p>}
      <form
        className={styles.form}
        method="post"
        noValidate
        data-practice-form=""
        // Submitted by hand (as the course registration): React resets a form after an action, which would un-check the
        // package radio while the state says otherwise. method="post" keeps the details out of the URL without the script.
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          const formData = new FormData(e.currentTarget);
          startTransition(() => formAction(formData));
        }}
      >
        <fieldset
          className={`${styles.packages} ${styles.wide}`}
          role="radiogroup"
          aria-labelledby={`${id}-package-label`}
          aria-required="true"
          aria-invalid={errors.package ? true : undefined}
          aria-describedby={errors.package ? `${id}-package-error` : undefined}
        >
          <legend id={`${id}-package-label`} className={styles.legend}>
            {t.packageLabel}
          </legend>
          <div className={styles.options}>
            {packages.map((p, i) => (
              <label key={p.code} className={styles.option}>
                <input
                  id={i === 0 ? `${id}-package` : undefined}
                  type="radio"
                  name="package"
                  value={p.code}
                  checked={pkg === p.code}
                  onChange={() => choose(p.code)}
                />
                <span className={styles.optionName}>{p.name}</span>
                {p.duration && (
                  <span className={styles.optionDuration}>
                    <span className={ui.srOnly}>{t.durationLabel}: </span>≈ {p.duration}
                  </span>
                )}
                <span className={styles.optionPrice}>{p.price}</span>
              </label>
            ))}
          </div>
          {err("package")}
        </fieldset>

        <fieldset
          className={`${styles.packages} ${styles.wide}`}
          role="radiogroup"
          aria-labelledby={`${id}-city-label`}
          aria-required="true"
          aria-invalid={errors.city ? true : undefined}
          aria-describedby={errors.city ? `${id}-city-error` : undefined}
        >
          <legend id={`${id}-city-label`} className={styles.legend}>
            {t.cityLabel}
          </legend>
          <div className={styles.options}>
            {PRACTICE_CITIES.map((c, i) => (
              <label key={c} className={styles.option}>
                <input id={i === 0 ? `${id}-city` : undefined} type="radio" name="city" value={c} checked={city === c} onChange={() => setCity(c)} />
                <span className={styles.optionName}>{t.cities[c] ?? c}</span>
              </label>
            ))}
          </div>
          {err("city")}
        </fieldset>

        <div className={styles.field}>
          <label htmlFor={`${id}-name`}>{t.name}</label>
          <input {...text("name")} type="text" required autoComplete="name" maxLength={120} />
          {err("name")}
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-email`}>{t.email}</label>
          <input {...text("email")} type="email" required autoComplete="email" maxLength={200} />
          {err("email")}
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-phone`}>{t.phone}</label>
          <input {...text("phone")} type="tel" required autoComplete="tel" maxLength={40} />
          {err("phone")}
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-course`}>
            {t.completedCourse} <span className={styles.optional}>({t.optional})</span>
          </label>
          <input {...text("course")} type="text" maxLength={200} />
          {err("course")}
        </div>
        <div className={`${styles.field} ${styles.wide}`}>
          <label htmlFor={`${id}-times`}>{t.preferredTimes}</label>
          <textarea {...text("times")} required rows={3} maxLength={2000} placeholder={t.preferredTimesPlaceholder} />
          {err("times")}
        </div>

        <p className={`${styles.note} ${styles.wide}`}>{t.note}</p>

        <input type="hidden" name="locale" value={locale} />
        {/* Honeypot: people never see or fill it. */}
        <div className={styles.honeypot} aria-hidden="true">
          <label>
            Website
            <input name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
          </label>
        </div>

        {errors.form && (
          <p id={`${id}-form-error`} className={`${styles.error} ${styles.wide}`} role="alert" tabIndex={-1}>
            {errors.form}
          </p>
        )}
        {/* aria-disabled, not disabled: a disabled button would drop keyboard focus to the page while sending. */}
        <button className={`${ui.btn} ${ui.btnFull} ${styles.wide}`} type="submit" aria-disabled={pending || undefined}>
          {pending ? t.sending : t.submit}
          <Icon name="arrow" />
        </button>
      </form>
    </>
  );
}
