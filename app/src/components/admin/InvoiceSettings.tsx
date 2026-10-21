"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { groupIban } from "@/domain/account-cards";
import { tallinnDateText } from "@/domain/certificate";
import { formatInvoiceNumber, INVOICE_LIMITS } from "@/domain/invoice";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { saveInvoiceSettingsAction } from "@/server/actions/admin-invoices";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import site from "./site-editor.module.css";
import styles from "./InvoiceSettings.module.css";

/** What the Seaded page reads for the card (server/invoices.ts invoiceCard: the settings, "Järgmine number" as the next issue takes it, and the last issued number). */
export type InvoiceSettingsInitial = {
  company: string;
  registryCode: string;
  address: string;
  vatNumber: string;
  vatOn: boolean;
  vatRate: number;
  prefix: string;
  nextYear: number;
  nextSeq: number;
  termDays: number;
  footer: string;
  /** The number last issued in `nextYear` under the prefix ("MSL2026-14"), or null. */
  last: string | null;
};

/** The bank details of Ettemaksu juhised, shown read-only (D2: the account lives in one place). */
export type InvoiceBank = { receiver: string; iban: string; bank: string };

/** The fields as typed: the numbers too (the server parses them). The year is not among them (B21: it is this Tallinn year). */
type Draft = {
  company: string;
  registryCode: string;
  address: string;
  vatNumber: string;
  vatOn: boolean;
  vatRate: string;
  prefix: string;
  nextSeq: string;
  termDays: string;
  footer: string;
};
type Field = keyof Draft;
type Stored = Omit<InvoiceSettingsInitial, "last">;

const draftOf = (s: Stored): Draft => ({
  company: s.company,
  registryCode: s.registryCode,
  address: s.address,
  vatNumber: s.vatNumber,
  vatOn: s.vatOn,
  vatRate: String(s.vatRate),
  prefix: s.prefix,
  nextSeq: String(s.nextSeq),
  termDays: String(s.termDays),
  footer: s.footer,
});

/** The status line: empty, on its way, done or refused. */
type Line = { tone: "idle" | "busy" | "done" | "error"; text: string };
const IDLE: Line = { tone: "idle", text: "" };
const toneClass = (tone: Line["tone"]) => (tone === "error" ? ui.error : tone === "done" ? ui.success : ui.hint);

/**
 * The address of the sample invoice (api/admin/naidisarve): the card's values as they stand on the screen, saved or not. The query holds the
 * fields by their names; the route reads them as defensively as the stored setting is read.
 */
function sampleHref(d: Draft): string {
  const q = new URLSearchParams();
  for (const [name, value] of Object.entries(d)) q.set(name, typeof value === "boolean" ? (value ? "1" : "0") : value);
  return `/api/admin/naidisarve?${q.toString()}`;
}

/**
 * Seaded → „Arve andmed“ (invoices Task 5, spec D2, D7, D8): the seller every new invoice copies — the company, its registry code and address,
 * the VAT number and whether VAT is on (with its rate), the number's prefix and „Järgmine number“ (this year's counter, with the number last
 * issued beside it; the year is never typed, admin UX pass B21, and from 1 December a line says what the new year's first number will be), the
 * payment term in days and an optional footer line — and, read-only, the bank details of „Ettemaksu juhised“ with a link to that card.
 * „Näidisarve (PDF)“ opens a sample drawn from the values on the screen without saving anything. A form of its own after the settings' form
 * (a form cannot sit inside another), with its own „Salvesta arve andmed“; a refused field is marked in words and the first one takes the
 * focus. The card keeps its own state; the page is not reloaded. `now` is the clock of the December line (a test sets it). This file runs on
 * old iPads: no regular expression with a lookbehind, here or in anything it imports (tests/unit/old-safari.test.ts).
 */
export function InvoiceSettings({ initial, bank, now = new Date() }: { initial: InvoiceSettingsInitial; bank: InvoiceBank; now?: Date }) {
  const t = adminEt.invoices.settings;
  const uid = useId();
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  // the last issued number belongs to the year it was read for (the loaded one, then the saved one)
  const [last, setLast] = useState({ number: initial.last, year: initial.nextYear });
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
    const e = t.errors;
    if (code === "required") return name === "vatNumber" ? e.vatNumber : e.required;
    if (code === "tooLong") return e.tooLong;
    if (code === "taken") return e.taken;
    if (code === "invalid") {
      const own: Partial<Record<Field, string>> = { prefix: e.prefix, vatRate: e.vatRate, termDays: e.termDays, nextSeq: e.nextSeq };
      return own[name] ?? e.other;
    }
    return e.other;
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
  const text = (name: "company" | "registryCode" | "address" | "vatNumber" | "footer" | "prefix", label: string, limit: number, hint?: string, className = "") =>
    box(
      name,
      label,
      <input id={id(name)} className={ui.input} type="text" autoComplete="off" maxLength={limit} value={draft[name]} onChange={change(name)} {...aria(name, hint)} data-invoice-field={name} />,
      hint,
      className,
    );

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setStatus({ tone: "busy", text: t.saving });
    start(async () => {
      const result = await saveInvoiceSettingsAction(draft);
      if (result.ok) {
        setDraft(draftOf(result.card));
        setLast({ number: result.card.last, year: result.card.nextYear });
        setFields({});
        setStatus({ tone: "done", text: t.saved });
      } else if ("fields" in result && result.fields) {
        setFields(result.fields);
        setStatus({ tone: "error", text: t.invalid });
      } else setStatus({ tone: "error", text: t.error });
    });
  };

  // B21: in December (the Tallinn date, not UTC) the next year's first number, as the prefix will be stored (in capitals)
  const [, month, thisYear] = tallinnDateText(now).split(".");
  const january = month === "12" ? formatInvoiceNumber((draft.prefix.trim() || initial.prefix).toUpperCase(), Number(thisYear) + 1, 1) : null;

  const bankReady = bank.receiver.trim() !== "" && bank.iban.trim() !== "";
  const rows: [string, string][] = [
    [adminEt.settings.receiver, bank.receiver],
    [adminEt.settings.iban, groupIban(bank.iban)],
    [adminEt.settings.bank, bank.bank],
  ];

  return (
    <section id="arve" className={`${ui.card} ${styles.card}`} aria-labelledby={`${uid}-title`} data-invoice-settings="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {t.title}
      </h2>
      <p className={`${ui.muted} ${site.cardLead}`}>{t.lead}</p>
      <form ref={form} onSubmit={save} noValidate data-invoice-form="">
        <div className={ed.grid}>
          {text("company", t.company, INVOICE_LIMITS.company)}
          {text("registryCode", t.registryCode, INVOICE_LIMITS.registryCode)}
          {text("address", t.address, INVOICE_LIMITS.address, undefined, ed.wide)}
          <div className={`${styles.vat} ${ed.wide}`}>
            {text("vatNumber", t.vatNumber, INVOICE_LIMITS.vatNumber, t.vatNumberHint)}
            {box(
              "vatRate",
              t.vatRate,
              <input id={id("vatRate")} className={ui.input} type="text" inputMode="numeric" autoComplete="off" maxLength={2} value={draft.vatRate} onChange={change("vatRate")} {...aria("vatRate")} data-invoice-field="vatRate" />,
            )}
          </div>
          <div className={`${ui.field} ${ed.wide}`}>
            <label className={styles.check} htmlFor={id("vatOn")}>
              <input
                id={id("vatOn")}
                type="checkbox"
                checked={draft.vatOn}
                onChange={(e) => setDraft((d) => ({ ...d, vatOn: e.target.checked }))}
                aria-describedby={`${id("vatOn")}-hint`}
                data-invoice-field="vatOn"
              />
              <span>{t.vatOn}</span>
            </label>
            <p id={`${id("vatOn")}-hint`} className={ui.hint}>
              {t.vatOnHint}
            </p>
          </div>
          {text("prefix", t.prefix, INVOICE_LIMITS.prefix, t.prefixHint)}
          {box(
            "termDays",
            t.termDays,
            <input id={id("termDays")} className={ui.input} type="text" inputMode="numeric" autoComplete="off" maxLength={2} value={draft.termDays} onChange={change("termDays")} {...aria("termDays", t.termDaysHint)} data-invoice-field="termDays" />,
            t.termDaysHint,
          )}
          <fieldset className={ed.fieldset} aria-describedby={`${uid}-next-hint ${uid}-last${january ? ` ${uid}-january` : ""}`}>
            <legend className={ui.legend}>{t.nextNumber}</legend>
            <div className={styles.number}>
              {box(
                "nextSeq",
                t.nextSeq,
                <input id={id("nextSeq")} className={ui.input} type="text" inputMode="numeric" autoComplete="off" maxLength={10} value={draft.nextSeq} onChange={change("nextSeq")} {...aria("nextSeq")} data-invoice-field="nextSeq" />,
              )}
            </div>
            <p id={`${uid}-next-hint`} className={ui.hint}>
              {t.nextHint}
            </p>
            <p id={`${uid}-last`} className={ui.hint} data-invoice-last="">
              {last.number ? fill(t.last, { number: last.number }) : fill(t.lastNone, { year: last.year })}
            </p>
            {january && (
              <p id={`${uid}-january`} className={ui.hint} data-invoice-january="">
                {fill(t.fromJanuary, { number: january })}
              </p>
            )}
          </fieldset>
          {text("footer", t.footer, INVOICE_LIMITS.footer, t.footerHint, ed.wide)}
        </div>

        <div className={styles.bank} data-invoice-bank="">
          <h3 className={ui.h3}>{t.bank}</h3>
          <p className={ui.muted}>{t.bankLead}</p>
          {bankReady ? (
            <dl>
              {rows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value || adminEt.common.none}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className={ui.notice} data-invoice-bank-missing="">
              {t.bankMissing}
            </p>
          )}
          <p>
            <Link className={ui.link} href="/admin/seaded#ettemaks">
              {t.bankLink}
            </Link>
          </p>
        </div>

        <div className={styles.actions}>
          <p role="status" className={toneClass(status.tone)} data-invoice-status="">
            {status.text}
          </p>
          <div className={styles.sampleBox}>
            <a className={`${ui.btn} ${ui.secondary}`} href={sampleHref(draft)} target="_blank" rel="noopener" data-invoice-sample="">
              {t.sample}
            </a>
            <p className={ui.hint}>{t.sampleHint}</p>
          </div>
          <button type="submit" className={`${ui.btn} ${ui.secondary}`} aria-disabled={pending || undefined} data-invoice-save="">
            {pending ? t.saving : t.save}
          </button>
        </div>
      </form>
    </section>
  );
}
