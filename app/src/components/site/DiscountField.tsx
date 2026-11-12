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
 * The one „Kokku“ line of a form (P17/P21): the dictionary's `total` („Kokku {total}“) with the sum in its {total} slot. The words before and after
 * the slot keep their places, so a reworded text can neither lose the sum nor put it on the wrong side (a text without the slot gets the sum
 * after it). `listCents` is struck through beside the sum while a code takes something off; null: the plain total. The field's own line under an
 * applied code (`data-discount-total`) and the cart's plain total (`data-cart-total`) are this one line.
 */
export function TotalLine({
  template,
  listCents,
  totalCents,
  locale,
  marker,
  className,
}: {
  template: string;
  listCents: number | null;
  totalCents: number;
  locale: Locale;
  marker: "data-discount-total" | "data-cart-total";
  className?: string;
}) {
  const at = template.indexOf("{total}");
  const before = (at < 0 ? template : template.slice(0, at)).trim();
  const after = at < 0 ? "" : template.slice(at + "{total}".length).trim();
  return (
    <p className={className ? `${styles.total} ${className}` : styles.total} {...{ [marker]: "" }}>
      {before && <span className={styles.totalLabel}>{before}</span>}
      <span className={styles.totalSum}>
        {listCents !== null && <s>{formatEUR(listCents, locale)}</s>}
        <strong>{formatEUR(totalCents, locale)}</strong>
      </span>
      {after && <span className={styles.totalLabel}>{after}</span>}
    </p>
  );
}

/**
 * The sooduskood field of a form (design "Sooduskoodi väli — olekud"): closed (a quiet „Mul on sooduskood“), open (the field and „Rakenda“),
 * refused (the field with the reason under it), applied (one line with the code and the euros taken off, „Eemalda“, the code's hint, and the one
 * total line „Kokku“ with the list price struck through). Enter applies the code and does not submit the form. The box has no `name`, so the
 * form's own data never carries it: the form sets `discountCode` and `discountCents` itself when it sends (ContactRegister onSubmit).
 * `place` is its host's spacing (the registration form's block flow, or the cart's grid): the field itself has none (P16).
 */
export function DiscountField({
  state,
  t,
  locale,
  idPrefix,
  place,
}: {
  state: ReturnType<typeof useDiscountCode>;
  t: DiscountTexts;
  locale: Locale;
  idPrefix: string;
  place: "form" | "cart";
}) {
  const root = `${styles.discount} ${place === "form" ? styles.inForm : styles.inCart}`;
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
      <div className={root} data-discount="">
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

  return (
    <div className={root} data-discount="">
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
      <div className={styles.live} aria-live="polite">
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
      {applied && <TotalLine template={t.total} listCents={state.listCents} totalCents={state.totalCents} locale={locale} marker="data-discount-total" />}
    </div>
  );
}
