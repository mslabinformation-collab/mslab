"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Locale } from "@/i18n/locales";
import { codeHint } from "@/domain/discount-codes";
import { formatEUR } from "@/domain/money";
import styles from "./DiscountField.module.css";
import type { useDiscountCode } from "./useDiscountCode";

/**
 * The words of the field: the dictionary's `discount` section (open, label, apply, applied, remove, total, the three hints and the refusals) with
 * the two answers the check can give without judging the code, which the page fills from `forms.errorTooMany` and the form's generic error.
 * `applied` has {code} and {amount}; `total` has {total}; `errors.notYet` has {date}.
 */
export type DiscountTexts = {
  open: string;
  label: string;
  apply: string;
  applied: string;
  remove: string;
  total: string;
  hintWelcome: string;
  hintFirst: string;
  hintReturning: string;
  errors: {
    empty: string;
    unknown: string;
    paused: string;
    ended: string;
    notYet: string;
    usedUp: string;
    scope: string;
    person: string;
    changed: string;
    rate: string;
    server: string;
  };
};

/** "2026-12-01" → "01.12.2026" (the date format of the pages). */
const dotted = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}.${y}` : iso;
};

/** A template with {name} slots, its slots filled with nodes: the text around them stays text. */
function fill(template: string, slots: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{[a-z]+\})/).map((part, i) => {
    const key = /^\{([a-z]+)\}$/.exec(part)?.[1];
    return key && key in slots ? <span key={i}>{slots[key]}</span> : part;
  });
}

/**
 * The sooduskood field of a form (design "Sooduskoodi väli — olekud"): closed (a quiet „Mul on sooduskood“), open (the field and „Rakenda“),
 * refused (the field with the reason under it), applied (one line with the code and the euros taken off, „Eemalda“, the code's hint, and the one
 * total line „Kokku“ with the list price struck through). Enter applies the code and does not submit the form. The box has no `name`, so the
 * form's own data never carries it: the form sets `discountCode` and `discountCents` itself when it sends (ContactRegister onSubmit).
 */
export function DiscountField({ state, t, locale, idPrefix }: { state: ReturnType<typeof useDiscountCode>; t: DiscountTexts; locale: Locale; idPrefix: string }) {
  const { typed, applied, error, checking } = state;
  const [opened, setOpened] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusInput = useRef(false);
  const open = opened || typed !== "" || applied !== null || error !== null;

  // the box takes focus when the visitor opens it, or removes the code to try another
  useEffect(() => {
    if (focusInput.current && inputRef.current) {
      focusInput.current = false;
      inputRef.current.focus();
    }
  });

  const errorText = (() => {
    if (!error) return null;
    // a "not yet" without its date cannot be said as written: the plain "no longer valid" is the closest true sentence
    if (error.code === "notYet") return error.startsOn ? t.errors.notYet.replace("{date}", dotted(error.startsOn)) : t.errors.paused;
    return t.errors[error.code];
  })();
  const hint = applied ? codeHint(applied) : null;
  const hintText = hint === "welcome" ? t.hintWelcome : hint === "first" ? t.hintFirst : hint === "returning" ? t.hintReturning : null;
  const errorId = `${idPrefix}-discount-error`;

  if (!open) {
    return (
      <div className={styles.discount} data-discount="">
        <button
          type="button"
          className={styles.quiet}
          data-discount-open=""
          onClick={() => {
            focusInput.current = true;
            setOpened(true);
          }}
        >
          {t.open}
        </button>
      </div>
    );
  }

  const totalLabel = t.total.replace("{total}", "").trim();
  return (
    <div className={styles.discount} data-discount="">
      {applied ? (
        <div className={styles.line} data-discount-applied="">
          <span>{fill(t.applied, { code: <strong>{applied.code}</strong>, amount: formatEUR(applied.discountCents, locale) })}</span>
          <button
            type="button"
            className={styles.quiet}
            data-discount-remove=""
            onClick={() => {
              focusInput.current = true;
              setOpened(true);
              state.remove();
            }}
          >
            {t.remove}
          </button>
        </div>
      ) : (
        <div>
          <label className={styles.label} htmlFor={`${idPrefix}-discount`}>
            {t.label}
          </label>
          <div className={styles.entry}>
            <input
              ref={inputRef}
              id={`${idPrefix}-discount`}
              className={styles.input}
              type="text"
              value={typed}
              maxLength={60}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => state.setTyped(e.target.value)}
              onKeyDown={(e) => {
                // Enter applies the code; it never submits the registration
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void state.apply();
                }
              }}
            />
            <button type="button" className={styles.apply} data-discount-apply="" aria-busy={checking || undefined} onClick={() => void state.apply()}>
              {t.apply}
            </button>
          </div>
        </div>
      )}
      <div aria-live="polite">
        {errorText && (
          <p id={errorId} className={styles.error} data-discount-error={error?.code} tabIndex={-1}>
            {errorText}
          </p>
        )}
        {hintText && (
          <p className={styles.hint} data-discount-hint="">
            {hintText}
          </p>
        )}
      </div>
      {applied && (
        <p className={styles.total} data-discount-total="">
          <span className={styles.totalLabel}>{totalLabel}</span>
          <span className={styles.totalSum}>
            <s>{formatEUR(state.listCents, locale)}</s>
            <strong>{formatEUR(state.totalCents, locale)}</strong>
          </span>
        </p>
      )}
    </div>
  );
}
