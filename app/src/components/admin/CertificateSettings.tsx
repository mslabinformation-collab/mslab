"use client";

import { useRouter } from "next/navigation";
import { startTransition, useCallback, useId, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { CERT_LIMITS, certificateForm, formatCertificateNumber, type CertificateForm } from "@/domain/certificate";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import type { CertificateFieldError } from "@/server/certificates";
import { useSeadedPart, type FieldGroup, type StatusReport } from "./useSeadedPart";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import site from "./site-editor.module.css";
import styles from "./CertificateSettings.module.css";

/**
 * What the Seaded page reads for the card (server/certificates.ts certificateCard: the settings, "Järgmine number" as the next issue takes it, the
 * last issued number, and the card's version: its autosave goes from it).
 */
export type CertificateSettingsInitial = {
  place: string;
  registryCode: string;
  practicalLine: string;
  /** Maria's signature on the certificate: the PDF writes it in the script font (owner, 15.10). */
  trainerName: string;
  nextYear: number;
  nextSeq: number;
  /** The number last issued in `nextYear` ("MS LAB 2026-14"), or null. */
  last: string | null;
  version: string;
};

type Field = keyof CertificateForm;

/** „Aasta“ and „Number“ commit on blur (behaviours conflict 13), and save together: one patch with both when either changes (review M-3). */
const ON_BLUR = ["nextYear", "nextSeq"] as const;
const NUMBER: FieldGroup = { name: "number", members: ON_BLUR };

/** A whole number as typed, or null. */
const whole = (typed: string): number | null => (/^\d{1,9}$/.test(typed.trim()) ? Number(typed.trim()) : null);

/**
 * Seaded → "Tunnistus" (phase 3d, spec §6, §4; admin UX pass piece 3b, Task 4: README B4, P-10, spec D6): what every new e-course certificate prints
 * besides the student's name and her course — the place, the registry code, the practical work's line and the trainer's name, which the PDF writes in
 * the script font as Maria's signature (owner, 15.10: no picture) — and "Järgmine number" (its „Aasta“ and „Number“, D6: certificates unchanged) with
 * the preview „Järgmine tunnistus: MS LAB {year}-{nn}“ under it and the number last issued in the card's year. Every field autosaves on
 * api/admin/seaded/certificate under the page's one SaveStatus (`onStatus`): a text 1.5 s after typing and at once when left, the two numbers when
 * left (they commit on blur), always together (one patch with both: the server judges the pair as one); another year stored, the page is read
 * again for the year's last issued number. A refused field says why in its own words, in the field (Review Focus 4: a number at or below one already issued is
 * `taken`; a trainer's name the name rules refuse is "letters" or "length"; a year that is not this one or the next is "invalid" on the year).
 */
export function CertificateSettings({ initial, onStatus }: { initial: CertificateSettingsInitial; onStatus?: StatusReport }) {
  const t = adminEt.certificates.settings;
  const uid = useId();
  const labels: Record<Field, string> = {
    place: t.place,
    registryCode: t.registryCode,
    practicalLine: t.practicalLine,
    trainerName: t.trainerName,
    nextYear: t.nextYear,
    nextSeq: t.nextSeq,
  };
  const label = (f: string) => labels[f as Field] ?? f;
  const id = (name: Field) => `${uid}-${name}`;
  const focusById = useCallback((name: string) => document.getElementById(`${uid}-${name}`)?.focus(), [uid]);
  const router = useRouter();
  const nav = useRef(router);
  useLayoutEffect(() => {
    nav.current = router;
  });
  // another year stored: the page is read again, for the number last issued in that year (the line under the numbers)
  const yearStored = useRef(String(initial.nextYear));
  const onSaved = useCallback((patch: Record<string, unknown>) => {
    if (patch.nextYear === undefined || String(patch.nextYear) === yearStored.current) return;
    yearStored.current = String(patch.nextYear);
    startTransition(() => nav.current.refresh());
  }, []);
  const fields = useMemo(() => certificateForm(initial), []); // eslint-disable-line react-hooks/exhaustive-deps -- the engine starts from the first read
  const part = useSeadedPart({ part: "certificate", version: initial.version, fields, label, focusField: focusById, onStatus, onBlur: ON_BLUR, group: NUMBER, onSaved });
  const value = (name: Field): string => String(part.text(name) ?? "");

  const errorOf = (name: Field): string | undefined => {
    const code = part.codeOf(name);
    if (code === undefined) return undefined;
    // a year that is not this one or the next (M-5) has its own words; the number's "invalid" is about the number
    if (name === "nextYear" && code === "invalid") return t.errors.year;
    // Task 3's codes (CertificateFieldError) have their own words; anything else the general line
    const known: Record<CertificateFieldError, string> & Record<string, string | undefined> = t.errors;
    return known[code] ?? t.errors.other;
  };
  /** A field's marks: invalid when refused, described by its hints and its error. */
  const aria = (name: Field, hints: string[] = []) => ({
    "aria-invalid": errorOf(name) ? (true as const) : undefined,
    "aria-describedby": [...hints, errorOf(name) ? `${id(name)}-error` : ""].filter(Boolean).join(" ") || undefined,
  });
  /** A field's label, its input, its hint and its error. */
  const box = (name: Field, input: ReactNode, hint?: string, className = "") => (
    <div className={`${ui.field} ${className}`}>
      <label htmlFor={id(name)}>{labels[name]}</label>
      {input}
      {hint && (
        <p id={`${id(name)}-hint`} className={ui.hint}>
          {hint}
        </p>
      )}
      {errorOf(name) && (
        <p id={`${id(name)}-error`} className={ui.error}>
          {errorOf(name)}
        </p>
      )}
    </div>
  );
  const text = (name: "place" | "registryCode" | "practicalLine" | "trainerName", hook: string, limit: number, hint?: string, className = "") =>
    box(
      name,
      <input
        id={id(name)}
        className={ui.input}
        type="text"
        autoComplete="off"
        maxLength={limit}
        value={value(name)}
        onChange={(e) => part.type(name, e.target.value)}
        {...aria(name, hint ? [`${id(name)}-hint`] : [])}
        {...{ [`data-cert-${hook}`]: "" }}
      />,
      hint,
      className,
    );
  const number = (name: "nextYear" | "nextSeq", hook: string, maxLength: number) =>
    box(
      name,
      <input
        id={id(name)}
        className={ui.input}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={maxLength}
        value={value(name)}
        onChange={(e) => part.type(name, e.target.value)}
        {...aria(name)}
        {...{ [`data-cert-${hook}`]: "" }}
      />,
    );

  // P-10: the next number as it will be printed, from the two fields as typed
  const year = whole(value("nextYear"));
  const seq = whole(value("nextSeq"));
  const preview = year !== null && year >= 2000 && seq !== null && seq >= 1 ? fill(t.preview, { number: formatCertificateNumber(year, seq) }) : null;
  // the last issued number belongs to the year the page read it for (the card's year, as stored or as the page read it again)
  const lastLine = initial.last ? fill(t.last, { number: initial.last }) : fill(t.lastNone, { year: initial.nextYear });

  /** Leaving a field: the numbers waiting to be left are committed, and what is typed goes at once. */
  const leave = () => {
    part.commit();
    void part.flush();
  };

  return (
    <section className={`${ui.card} ${styles.card}`} aria-labelledby={`${uid}-title`} onBlur={leave} data-certificate-settings="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {t.title}
      </h2>
      <p className={`${ui.muted} ${site.cardLead}`}>{t.lead}</p>
      <div className={ed.grid}>
        {text("place", "place", CERT_LIMITS.place, t.placeHint)}
        {text("registryCode", "registry", CERT_LIMITS.registryCode)}
        {text("practicalLine", "practical", CERT_LIMITS.practicalLine, t.practicalLineHint, ed.wide)}
        {text("trainerName", "trainer", CERT_LIMITS.trainerName, t.trainerNameHint)}
        <fieldset className={ed.fieldset} aria-describedby={[preview ? `${uid}-preview` : "", `${uid}-next-hint`, `${uid}-last`].filter(Boolean).join(" ")}>
          <legend className={ui.legend}>{t.nextNumber}</legend>
          <div className={styles.number}>
            {number("nextYear", "next-year", 4)}
            {number("nextSeq", "next-seq", 5)}
          </div>
          {preview && (
            <p id={`${uid}-preview`} className={ui.hint} data-cert-preview="">
              {preview}
            </p>
          )}
          <p id={`${uid}-next-hint`} className={ui.hint}>
            {t.nextHint}
          </p>
          <p id={`${uid}-last`} className={ui.hint} data-cert-last="">
            {lastLine}
          </p>
        </fieldset>
      </div>
      {part.conflict && (
        <p className={styles.restore}>
          <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => void part.restore()} data-cert-restore="">
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
    </section>
  );
}
