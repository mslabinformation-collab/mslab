"use client";

import { useRouter } from "next/navigation";
import { startTransition, useCallback, useId, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { tallinnDateText } from "@/domain/certificate";
import { formatInvoiceNumber, invoiceForm, INVOICE_LIMITS, vatNeedsNumber, type InvoiceForm } from "@/domain/invoice";
import { SITE_LIMITS, type PrepaymentDraft } from "@/domain/site-editor";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { useSeadedPart, type StatusReport } from "./useSeadedPart";
import ui from "./ui.module.css";
import ed from "./editor.module.css";
import site from "./site-editor.module.css";
import styles from "./InvoiceSettings.module.css";

/**
 * What the Seaded page reads for the invoice part of the card (server/invoices.ts invoiceCard): the settings, „Arve järgmine number“ as the next issue
 * takes it, the last issued number, and the part's version (its autosave goes from it).
 */
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
  version: string;
};

/** The prepayment instructions as stored (the bank part of the card: one set of bank fields for both, ruling R-f) and their version. */
export type InvoiceBank = { version: string; value: PrepaymentDraft };

type Field = keyof InvoiceForm;
type BankField = keyof PrepaymentDraft;

/** The fields that commit on blur (behaviours conflict 13): the number, and the prefix, which a half-typed one would give an invoice issued meanwhile. */
const ON_BLUR = ["prefix", "nextSeq"] as const;

/** The box „Arvel on käibemaks“ waits for the VAT number (the server's rule, domain/invoice.ts vatNeedsNumber): both go together once it is typed. */
const validate = (f: Record<string, unknown>): Record<string, string> =>
  vatNeedsNumber({ vatOn: f.vatOn === true, vatNumber: typeof f.vatNumber === "string" ? f.vatNumber : "" }) ? { vatOn: "required" } : {};

/**
 * The address of the sample invoice (api/admin/naidisarve): the card's values as they stand on the screen, saved or not. The query holds the
 * fields by their names; the route reads them as defensively as the stored setting is read.
 */
function sampleHref(d: InvoiceForm): string {
  const q = new URLSearchParams();
  for (const [name, value] of Object.entries(d)) q.set(name, typeof value === "boolean" ? (value ? "1" : "0") : value);
  return `/api/admin/naidisarve?${q.toString()}`;
}

/**
 * Seaded → „Maksmine“ (admin UX pass piece 3b, Task 4; README B4, B21; ruling R-f; piece3-texts P-9, P-10, §4; the Part 3 frame „B4 Seaded“ and the
 * Part 4 phone frame): ONE card for the bank details of the prepayment instructions and the invoice settings, since the invoice reads that bank
 * (one source). The lead as drawn with the sentence on issued invoices (they keep their frozen copy, the IBAN too); the bank fields first — Saaja
 * and IBAN with the instructions' hint under them, Pank, Selgituse algus — then the seller every new invoice copies: the company, its registry code
 * and address, the VAT number and whether VAT is on (with its rate), the number's prefix, the term in days, „Arve järgmine number“ (this year's
 * counter: the year is never typed, B21) with the preview „Järgmine arve: {prefix}{year}-{nnn}“ under it — 001 while the typed prefix is not the stored
 * one (R3) — and, from 1 December, the new year's first number on the same line, then „Viimati väljastatud …“; the footer line; „Näidisarve (PDF)“, a
 * sample drawn from the values on the screen without saving anything.
 *
 * Every field autosaves (useSeadedPart): the bank fields on the prepayment part, the rest on the invoice part, under the page's one SaveStatus
 * (`onStatus`); a text 1.5 s after typing and at once when left, the VAT box at once (without a VAT number it waits for it, said on the box: the server's rule,
 * vatNeedsNumber), the prefix and the number when left (they commit on blur). A
 * refused field says why in its own words (a number already issued: `taken`). Once a new prefix is stored the page is read again (router.refresh):
 * the number the next issue takes under it (1, or the old series' next) comes into the field if nobody typed in it since (taken as
 * stored, nothing sent), and the last issued line follows. `now` is the page's
 * clock (the preview's year and the December line). This file runs on old iPads: no regular expression with a lookbehind, here or in anything it
 * imports (tests/unit/old-safari.test.ts).
 */
export function InvoiceSettings({ initial, bank, now, onStatus }: { initial: InvoiceSettingsInitial; bank: InvoiceBank; now: Date; onStatus?: StatusReport }) {
  const t = adminEt.invoices.settings;
  const s = adminEt.settings;
  const uid = useId();
  const router = useRouter();
  const nav = useRef(router);
  useLayoutEffect(() => {
    nav.current = router;
  });

  const labels: Record<Field | BankField, string> = {
    company: t.company,
    registryCode: t.registryCode,
    address: t.address,
    vatNumber: t.vatNumber,
    vatOn: t.vatOn,
    vatRate: t.vatRate,
    prefix: t.prefix,
    nextSeq: t.nextNumber,
    termDays: t.termDays,
    footer: t.footer,
    receiver: s.receiver,
    iban: s.iban,
    bank: s.bank,
    referencePrefix: s.referencePrefix,
  };
  const label = (f: string) => labels[f as Field] ?? f;
  const id = (name: string) => `${uid}-${name}`;
  const focusById = useCallback((name: string) => document.getElementById(`${uid}-${name}`)?.focus(), [uid]);

  // A new prefix (ruling R3): the number its save left is the page's to say, so the page is read again once it is stored. The number shown when the
  // prefix went out is noted: the page's number is taken (as stored, nothing sent: useSeadedPart adopt) only if the field still holds it then —
  // a number she typed meanwhile (or one on its way) stays hers, and no refusal is ever shown for a number she did not type (review I-1).
  const latest = useRef<{ text: (name: string) => unknown } | null>(null);
  const prefixSent = useRef<{ prefix: string; number: string; stored: boolean } | null>(null);
  const onSend = useCallback((patch: Record<string, unknown>) => {
    if ("prefix" in patch && typeof patch.prefix === "string")
      prefixSent.current = { prefix: patch.prefix.trim().toUpperCase(), number: String(latest.current?.text("nextSeq") ?? ""), stored: false };
  }, []);
  const onSaved = useCallback((patch: Record<string, unknown>) => {
    if (!("prefix" in patch)) return;
    if (prefixSent.current) prefixSent.current = { ...prefixSent.current, stored: true };
    startTransition(() => nav.current.refresh());
  }, []);
  const fields = useMemo(() => invoiceForm(initial), []); // eslint-disable-line react-hooks/exhaustive-deps -- the engine starts from the first read
  const invoice = useSeadedPart({ part: "invoice", version: initial.version, fields, label, focusField: focusById, onStatus, onBlur: ON_BLUR, onSend, onSaved, validate });
  const bankFields = useMemo(() => ({ ...bank.value }), []); // eslint-disable-line react-hooks/exhaustive-deps -- the engine starts from the first read
  const pay = useSeadedPart({ part: "prepayment", version: bank.version, fields: bankFields, label, focusField: focusById, onStatus });
  useLayoutEffect(() => {
    latest.current = invoice;
  });

  // the page's read with the stored prefix: the number it gives (1, or the series' next for a prefix used before) comes into an untouched field
  useLayoutEffect(() => {
    const sent = prefixSent.current;
    if (!sent?.stored || initial.prefix !== sent.prefix) return;
    prefixSent.current = null;
    if (invoice.typing("nextSeq") || String(invoice.text("nextSeq")) !== sent.number) return;
    invoice.adopt("nextSeq", String(initial.nextSeq));
  });

  const value = (name: Field): string => String(invoice.text(name) ?? "");
  const bankValue = (name: BankField): string => String(pay.text(name) ?? "");

  const errorOf = (name: Field): string | undefined => {
    const code = invoice.codeOf(name);
    if (code === undefined) return undefined;
    const e = t.errors;
    if (code === "required") return name === "vatNumber" || name === "vatOn" ? e.vatNumber : e.required;
    if (code === "tooLong") return e.tooLong;
    if (code === "taken") return e.taken;
    if (code === "invalid") {
      const own: Partial<Record<Field, string>> = { prefix: e.prefix, vatRate: e.vatRate, termDays: e.termDays, nextSeq: e.nextSeq };
      return own[name] ?? e.other;
    }
    return e.other;
  };
  const bankErrorOf = (name: BankField): string | undefined => {
    const code = pay.codeOf(name);
    return code === undefined ? undefined : ((adminEt.courseEditor.errors as Record<string, string>)[code] ?? t.errors.other);
  };

  /** A field's marks: invalid when refused, described by its hints and its error. */
  const aria = (name: string, error: string | undefined, hints: string[] = []) => ({
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": [...hints, error ? `${id(name)}-error` : ""].filter(Boolean).join(" ") || undefined,
  });
  /** A field's label, its input, its hint and its error. */
  const box = (name: string, labelText: string, input: ReactNode, error: string | undefined, hint?: string, className = "") => (
    <div className={`${ui.field} ${className}`}>
      <label htmlFor={id(name)}>{labelText}</label>
      {input}
      {hint && (
        <p id={`${id(name)}-hint`} className={ui.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id(name)}-error`} className={ui.error}>
          {error}
        </p>
      )}
    </div>
  );
  const text = (name: "company" | "registryCode" | "address" | "vatNumber" | "footer" | "prefix", limit: number, hint?: string, className = "") =>
    box(
      name,
      labels[name],
      <input
        id={id(name)}
        className={ui.input}
        type="text"
        autoComplete="off"
        maxLength={limit}
        value={value(name)}
        onChange={(e) => invoice.type(name, e.target.value)}
        {...aria(name, errorOf(name), hint ? [`${id(name)}-hint`] : [])}
        data-invoice-field={name}
      />,
      errorOf(name),
      hint,
      className,
    );
  const short = (name: "vatRate" | "termDays", maxLength: number, hint?: string) =>
    box(
      name,
      labels[name],
      <input
        id={id(name)}
        className={ui.input}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={maxLength}
        value={value(name)}
        onChange={(e) => invoice.type(name, e.target.value)}
        {...aria(name, errorOf(name), hint ? [`${id(name)}-hint`] : [])}
        data-invoice-field={name}
      />,
      errorOf(name),
      hint,
    );
  const bankBox = (name: BankField, limit: number, hint?: string, describedBy: string[] = []) =>
    box(
      name,
      labels[name],
      <input
        id={id(name)}
        className={ui.input}
        type="text"
        autoComplete="off"
        maxLength={limit}
        value={bankValue(name)}
        onChange={(e) => pay.type(name, e.target.value)}
        {...aria(name, bankErrorOf(name), [...(hint ? [`${id(name)}-hint`] : []), ...describedBy])}
        data-bank-field={name}
      />,
      bankErrorOf(name),
      hint,
    );

  // B21 and P-10: the preview of the next number, in capitals as the prefix is stored; 001 while the typed prefix is not the stored one (R3); from
  // 1 December (the Tallinn date) the next year's first number on the same line
  const [, month, thisYear] = tallinnDateText(now).split(".");
  const year = Number(thisYear);
  const prefix = (value("prefix").trim() || initial.prefix).toUpperCase();
  const typedSeq = value("nextSeq").trim();
  const seq = prefix !== initial.prefix ? 1 : /^\d{1,10}$/.test(typedSeq) && Number(typedSeq) >= 1 ? Number(typedSeq) : null;
  const preview = seq === null ? null : fill(t.preview, { number: formatInvoiceNumber(prefix, year, seq) });
  const january = month === "12" ? fill(t.fromJanuary, { number: formatInvoiceNumber(prefix, year + 1, 1) }) : null;
  const previewLine = preview && january ? fill(t.previewLine, { preview, january }) : preview;
  const lastLine = initial.last ? fill(t.last, { number: initial.last }) : fill(t.lastNone, { year: initial.nextYear });

  const bankReady = bankValue("receiver").trim() !== "" && bankValue("iban").trim() !== "";
  const sample: InvoiceForm = { ...invoiceForm(initial), ...(Object.fromEntries(Object.keys(fields).map((f) => [f, invoice.text(f)])) as InvoiceForm) };

  /** Leaving a field: what waits to be left is committed, and what is typed goes at once. */
  const leave = () => {
    invoice.commit();
    void invoice.flush();
    void pay.flush();
  };

  return (
    <section className={`${ui.card} ${styles.card}`} aria-labelledby={`${uid}-title`} onBlur={leave} data-invoice-settings="">
      <h2 id={`${uid}-title`} className={`${ui.h2} ${site.cardTitle}`}>
        {s.sections.payment}
      </h2>
      <p className={`${ui.muted} ${site.cardLead}`} data-invoice-lead="">
        {t.lead}
      </p>
      <div className={ed.grid} data-prepayment-editor="">
        {bankBox("receiver", SITE_LIMITS.receiver, undefined, [`${uid}-bank-hint`])}
        {bankBox("iban", SITE_LIMITS.iban, undefined, [`${uid}-bank-hint`])}
        <div className={ed.wide}>
          <p id={`${uid}-bank-hint`} className={ui.hint} data-bank-hint="">
            {s.prepaymentHint}
          </p>
          {!bankReady && (
            <p className={`${ui.notice} ${styles.missing}`} data-invoice-bank-missing="">
              {t.bankMissing}
            </p>
          )}
        </div>
        {bankBox("bank", SITE_LIMITS.bank)}
        {bankBox("referencePrefix", SITE_LIMITS.referencePrefix, s.referenceHint)}
      </div>
      <div className={`${ed.grid} ${styles.seller}`}>
        {text("company", INVOICE_LIMITS.company)}
        {text("registryCode", INVOICE_LIMITS.registryCode)}
        {text("address", INVOICE_LIMITS.address, undefined, ed.wide)}
        <div className={`${styles.vat} ${ed.wide}`}>
          {text("vatNumber", INVOICE_LIMITS.vatNumber, t.vatNumberHint)}
          {short("vatRate", 2)}
        </div>
        <div className={`${ui.field} ${ed.wide}`}>
          <label className={styles.check} htmlFor={id("vatOn")}>
            <input
              id={id("vatOn")}
              type="checkbox"
              checked={invoice.text("vatOn") === true}
              onChange={(e) => {
                invoice.type("vatOn", e.target.checked);
                void invoice.flush();
              }}
              {...aria("vatOn", errorOf("vatOn"), [`${id("vatOn")}-hint`])}
              data-invoice-field="vatOn"
            />
            <span>{t.vatOn}</span>
          </label>
          <p id={`${id("vatOn")}-hint`} className={ui.hint}>
            {t.vatOnHint}
          </p>
          {errorOf("vatOn") && (
            <p id={`${id("vatOn")}-error`} className={ui.error}>
              {errorOf("vatOn")}
            </p>
          )}
        </div>
        {text("prefix", INVOICE_LIMITS.prefix, t.prefixHint)}
        {short("termDays", 2, t.termDaysHint)}
        <div className={ui.field}>
          <label htmlFor={id("nextSeq")}>{t.nextNumber}</label>
          <input
            id={id("nextSeq")}
            className={`${ui.input} ${styles.number}`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={10}
            value={value("nextSeq")}
            onChange={(e) => invoice.type("nextSeq", e.target.value)}
            {...aria("nextSeq", errorOf("nextSeq"), [...(previewLine ? [`${uid}-preview`] : []), `${uid}-last`])}
            data-invoice-field="nextSeq"
          />
          {previewLine && (
            <p id={`${uid}-preview`} className={ui.hint} data-invoice-preview="">
              {previewLine}
            </p>
          )}
          <p id={`${uid}-last`} className={ui.hint} data-invoice-last="">
            {lastLine}
          </p>
          {errorOf("nextSeq") && (
            <p id={`${id("nextSeq")}-error`} className={ui.error}>
              {errorOf("nextSeq")}
            </p>
          )}
        </div>
        {text("footer", INVOICE_LIMITS.footer, t.footerHint, ed.wide)}
      </div>

      {(invoice.conflict || pay.conflict) && (
        <p className={styles.restore}>
          <button
            type="button"
            className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`}
            onClick={() => {
              if (invoice.conflict) void invoice.restore();
              if (pay.conflict) void pay.restore();
            }}
            data-invoice-restore=""
          >
            {adminEt.courseEditor.restore}
          </button>
        </p>
      )}
      <div className={styles.sampleBox}>
        <a className={`${ui.btn} ${ui.secondary}`} href={sampleHref(sample)} target="_blank" rel="noopener" data-invoice-sample="">
          {t.sample}
        </a>
        <p className={ui.hint}>{t.sampleHint}</p>
      </div>
    </section>
  );
}
