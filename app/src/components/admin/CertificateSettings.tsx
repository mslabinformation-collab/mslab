"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { CERT_LIMITS } from "@/domain/certificate";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { saveCertificateSettingsAction } from "@/server/actions/admin-certificates";
import type { CertificateFieldError } from "@/server/certificates";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import site from "./site-editor.module.css";
import styles from "./CertificateSettings.module.css";

/** What the Seaded page reads for the card (server/certificates.ts getCertificateSettings and lastIssued). */
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
};

/** The fields as typed: the two numbers too (the server parses them, as the course editor's). */
type Draft = { place: string; registryCode: string; practicalLine: string; trainerName: string; nextYear: string; nextSeq: string };
type Field = keyof Draft;
type Stored = Omit<CertificateSettingsInitial, "last">;

const draftOf = (s: Stored): Draft => ({
  place: s.place,
  registryCode: s.registryCode,
  practicalLine: s.practicalLine,
  trainerName: s.trainerName,
  nextYear: String(s.nextYear),
  nextSeq: String(s.nextSeq),
});

/** The status line: empty, on its way, done or refused. */
type Line = { tone: "idle" | "busy" | "done" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Line["tone"]) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);

/**
 * Seaded → "Tunnistus" (phase 3d, spec §6, §4): what every new e-course certificate prints besides the student's name and her course — the
 * place, the registry code, the practical work's line and the trainer's name, which the PDF writes in the script font as Maria's signature
 * (owner, 15.10: no picture) — and "Järgmine number" (year and number), with the number last issued in that year beside it. A form
 * of its own after the settings' form, with its own "Salvesta tunnistuse andmed" (a secondary button: the page's primary one is the
 * settings' save bar); a refused field is marked in words and the first one takes the focus (Review Focus 4: a next number at or below one
 * already issued is "taken"; a trainer's name the name rules refuse is "letters" or "length"). The card keeps its own state; the page is not
 * refreshed.
 */
export function CertificateSettings({ initial }: { initial: CertificateSettingsInitial }) {
  const t = adminEt.certificates.settings;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [last, setLast] = useState(initial.last);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Line>(IDLE);
  const [pending, start] = useTransition();

  // a refused save: the first marked field takes the focus
  useEffect(() => {
    if (Object.keys(fields).length > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [fields]);

  const id = (name: Field) => `${uid}-${name}`;
  const change = (name: Field) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [name]: e.target.value }));
  const errorOf = (name: Field): string | undefined => {
    const code = fields[name];
    if (code === undefined) return undefined;
    // Task 3's codes (CertificateFieldError) have their own words; anything else the general line
    const known: Record<CertificateFieldError, string> & Record<string, string | undefined> = t.errors;
    return known[code] ?? t.errors.other;
  };
  /** A field's marks: invalid when refused, described by its hint and its error. */
  const aria = (name: Field, hint?: string) => ({
    "aria-invalid": errorOf(name) ? (true as const) : undefined,
    "aria-describedby": [hint ? `${id(name)}-hint` : "", errorOf(name) ? `${id(name)}-error` : ""].filter(Boolean).join(" ") || undefined,
  });
  /** A field's label, its input, its hint and its error. */
  const box = (name: Field, label: string, input: ReactNode, hint?: string, className = "") => (
    <div className={`${ui.field} ${className}`}>
      <label htmlFor={id(name)}>{label}</label>
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

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setStatus({ tone: "busy", text: t.saving });
    start(async () => {
      const result = await saveCertificateSettingsAction(draft);
      if (result.ok) {
        setDraft(draftOf(result.settings));
        setLast(result.last);
        setFields({});
        setStatus({ tone: "done", text: t.saved });
      } else if (result.fields) {
        // (the action's literal result types are normalised to one another's optional members, so `"fields" in result` would not narrow)
        setFields(result.fields);
        setStatus({ tone: "error", text: t.invalid });
      } else setStatus({ tone: "error", text: t.error });
    });
  };

  return (
    <section id="tunnistus" className={`${ui.card} ${styles.card}`} aria-labelledby={`${uid}-title`} data-certificate-settings="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {t.title}
      </h2>
      <p className={`${ui.muted} ${site.cardLead}`}>{t.lead}</p>
      <form ref={form} onSubmit={save} noValidate data-cert-form="">
        <div className={ed.grid}>
          {box(
            "place",
            t.place,
            <input id={id("place")} className={ui.input} type="text" autoComplete="off" maxLength={CERT_LIMITS.place} value={draft.place} onChange={change("place")} {...aria("place", t.placeHint)} data-cert-place="" />,
            t.placeHint,
          )}
          {box(
            "registryCode",
            t.registryCode,
            <input
              id={id("registryCode")}
              className={ui.input}
              type="text"
              autoComplete="off"
              maxLength={CERT_LIMITS.registryCode}
              value={draft.registryCode}
              onChange={change("registryCode")}
              {...aria("registryCode")}
              data-cert-registry=""
            />,
          )}
          {box(
            "practicalLine",
            t.practicalLine,
            <input
              id={id("practicalLine")}
              className={ui.input}
              type="text"
              autoComplete="off"
              maxLength={CERT_LIMITS.practicalLine}
              value={draft.practicalLine}
              onChange={change("practicalLine")}
              {...aria("practicalLine", t.practicalLineHint)}
              data-cert-practical=""
            />,
            t.practicalLineHint,
            ed.wide,
          )}
          {box(
            "trainerName",
            t.trainerName,
            <input
              id={id("trainerName")}
              className={ui.input}
              type="text"
              autoComplete="off"
              maxLength={CERT_LIMITS.trainerName}
              value={draft.trainerName}
              onChange={change("trainerName")}
              {...aria("trainerName", t.trainerNameHint)}
              data-cert-trainer=""
            />,
            t.trainerNameHint,
          )}
          <fieldset className={ed.fieldset} aria-describedby={`${uid}-next-hint ${uid}-last`}>
            <legend className={ui.legend}>{t.nextNumber}</legend>
            <div className={styles.number}>
              {box(
                "nextYear",
                t.nextYear,
                <input
                  id={id("nextYear")}
                  className={ui.input}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                  value={draft.nextYear}
                  onChange={change("nextYear")}
                  {...aria("nextYear")}
                  data-cert-next-year=""
                />,
              )}
              {box(
                "nextSeq",
                t.nextSeq,
                <input
                  id={id("nextSeq")}
                  className={ui.input}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={5}
                  value={draft.nextSeq}
                  onChange={change("nextSeq")}
                  {...aria("nextSeq")}
                  data-cert-next-seq=""
                />,
              )}
            </div>
            <p id={`${uid}-next-hint`} className={ui.hint}>
              {t.nextHint}
            </p>
            <p id={`${uid}-last`} className={ui.hint} data-cert-last="">
              {last ? fill(t.last, { number: last }) : t.lastNone}
            </p>
          </fieldset>
        </div>
        <div className={styles.actions}>
          <p role="status" className={toneClass(status.tone)} data-cert-status="">
            {status.text}
          </p>
          <button type="submit" className={`${ui.btn} ${ui.secondary}`} aria-disabled={pending || undefined} data-cert-save="">
            {pending ? t.saving : t.save}
          </button>
        </div>
      </form>
    </section>
  );
}
