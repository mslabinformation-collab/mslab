"use client";

import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { euro } from "@/domain/money-text";
import { adminEt } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { addRegistrationDiscountAction, removeRegistrationDiscountAction } from "@/server/actions/admin-discounts";
import ui from "./ui.module.css";
import styles from "./RegistrationDiscount.module.css";

// The Raha card's discount rows (F1 Task 14; spec D11, §5, §6 „The course price changes“; the design „Raha-kaart“, approved), handed to MoneyCard as its
// `discountRow`: „Hind“ (the list price struck through and the total next to it while a code is on, else the price alone) and „Sooduskood“: no code
// yet, the quiet button „Lisa sooduskood“, which opens the field „Sooduskood“ with „Lisa“ and „Katkesta“ in place of it; with a code, „{code} · −{amount}“
// and „Eemalda sooduskood“, which asks „Kas eemaldan sooduskoodi? Hind on jälle {price}.“ („Jah, eemalda“, „Katkesta“) in place of the row. No rule of the code
// is checked (spec §10 answer 2), so the server's refusals are only the ones of adminEt.discounts.registration.errors (shown under the field or the
// question; the page is refreshed behind them when they say the drawer is out of date). The prices are the page's own (registrationTotal,
// registrationDiscount: the live list price and the euros frozen on the registration); a press sends only the registration's id and the typed text, so
// a stale drawer can neither charge nor remove anything but what the server then reads.
// The buttons are there only while D11 lets them work (the final review's M6, ruling F-M6; Dim's rule: no button that can only be refused): nothing in
// „Laekunud summa“, not cancelled, no unpaid invoice. Otherwise a code is its row „{code} · −{amount}“ alone, and no code is no „Sooduskood“ row at all
// (the approved design draws only the unpaid states). The server checks the same under its locks, so a refusal is left only for a race (money or an
// invoice arriving while the drawer is open), and a removal refused for money says so in its own words (M5).

type Texts = typeof adminEt.discounts.registration;
type Answer = Awaited<ReturnType<typeof addRegistrationDiscountAction>>;
type Refusal = Extract<Answer, { ok: false }>["error"];

/** A refusal in Maria's words; `invalid` (a field the server did not take) and a dropped connection say the save error; money refuses a removal in its own words (M5). */
function refusalText(error: Refusal, t: Texts, removing: boolean): string {
  if (error === "invalid") return t.errors.server;
  return removing && error === "paid" ? t.errors.removePaid : t.errors[error];
}

export function RegistrationDiscount({
  registrationId,
  listCents,
  totalCents,
  code,
  cancelled,
  paidCents,
  unpaidInvoice,
}: {
  registrationId: number;
  /** The course's price now, in cents. */
  listCents: number;
  /** What the registration costs: the list price less the discount (never below 1 €). */
  totalCents: number;
  /** The code stored on the registration, or null for none (kept even when the price has since fallen so that it takes nothing off: Maria can still remove it). */
  code: string | null;
  cancelled: boolean;
  /** „Laekunud summa“, in cents: above 0, the code can no longer be added or removed (D11). */
  paidCents: number;
  /** Whether the registration has an invoice that is neither paid nor cancelled (D11: „Tühista enne maksmata arve.“). */
  unpaidInvoice: boolean;
}) {
  const t = adminEt.discounts.registration;
  const uid = useId();
  const [chosenMode, setMode] = useState<"idle" | "adding" | "removing">("idle");
  // D11's „When“ (the server's openRegistration checks the same under its locks)
  const changeable = !cancelled && paidCents === 0 && !unpaidInvoice;
  // (a refresh that brings money or an invoice closes an open field or question)
  const mode = changeable ? chosenMode : "idle";
  const [typed, setTyped] = useState("");
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [pending, start] = useTransition();
  const field = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const open = (next: "adding" | "removing") => {
    setRefusal(null);
    setMode(next);
    if (next === "adding") setTimeout(() => field.current?.focus(), 0);
  };
  const close = () => {
    setMode("idle");
    setTyped("");
    setRefusal(null);
    setTimeout(() => trigger.current?.focus(), 0);
  };

  const run = (send: () => Promise<Answer>) => {
    if (pending) return;
    setRefusal(null);
    start(async () => {
      let answer: Answer;
      try {
        answer = await send();
      } catch {
        // no answer (the connection dropped): the state is unknown, so the press can be repeated; a repeated add is refused as `stale`, never doubled
        return setRefusal("server");
      }
      if (!answer.ok) return setRefusal(answer.error);
      close();
    });
  };

  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (typed.trim() === "") return setRefusal("unknown");
    run(() => addRegistrationDiscountAction({ registrationId, code: typed }));
  };
  const remove = () => run(() => removeRegistrationDiscountAction({ registrationId }));

  const off = listCents - totalCents;
  const applied = code !== null;
  const refusalLine = refusal ? refusalText(refusal, t, mode === "removing") : "";

  return (
    <div className={styles.rows} data-registration-discount="">
      <div className={styles.row}>
        <span className={styles.k}>{t.price}</span>
        <span className={styles.v} data-discount-price="">
          {applied && <s className={styles.list}>{euro(listCents)}</s>}
          <span>{euro(totalCents)}</span>
        </span>
      </div>

      {mode === "adding" ? (
        <form className={styles.field} onSubmit={add} noValidate data-discount-form="">
          <label htmlFor={`${uid}-code`} className={styles.label}>
            {t.code}
          </label>
          <div className={styles.line}>
            <input
              ref={field}
              id={`${uid}-code`}
              className={`${ui.input} ${styles.input}`}
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={200}
              aria-invalid={refusal ? true : undefined}
              aria-describedby={`${uid}-refusal`}
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                setRefusal(null);
              }}
              data-discount-code-input=""
            />
            <button type="submit" className={`${ui.btn} ${styles.submit}`} aria-disabled={pending || undefined} data-discount-add-submit="">
              {pending ? adminEt.common.saving : t.submit}
            </button>
            <button type="button" className={styles.quiet} onClick={close}>
              {adminEt.common.cancel}
            </button>
          </div>
          <p id={`${uid}-refusal`} role="alert" className={`${ui.error} ${styles.refusal}`} data-discount-error="">
            {refusalLine}
          </p>
        </form>
      ) : applied || changeable ? (
        <div className={styles.row}>
          <span className={styles.k}>{t.code}</span>
          <span className={styles.v} data-discount-code="">
            {applied && <span>{fill(t.applied, { code, amount: euro(off) })}</span>}
            {/* „Eemalda sooduskood“ stays while its question is asked (design C, P29) */}
            {changeable && (
              <button
                ref={trigger}
                type="button"
                className={styles.quiet}
                onClick={() => open(applied ? "removing" : "adding")}
                aria-expanded={applied ? mode === "removing" : undefined}
                data-discount-open=""
              >
                {applied ? t.remove : t.add}
              </button>
            )}
          </span>
        </div>
      ) : null}

      {mode === "removing" && (
        <div className={styles.sure} role="group" aria-label={t.remove} data-discount-remove-sure="">
          <p className={styles.question}>{fill(t.removeQuestion, { price: euro(listCents) })}</p>
          <div className={styles.actions}>
            <button type="button" className={ui.btn} aria-disabled={pending || undefined} onClick={remove} data-discount-remove-yes="">
              {pending ? adminEt.common.saving : t.removeYes}
            </button>
            <button type="button" className={`${ui.btn} ${ui.secondary}`} onClick={close}>
              {adminEt.common.cancel}
            </button>
          </div>
          <p role="alert" className={`${ui.error} ${styles.refusal}`} data-discount-error="">
            {refusalLine}
          </p>
        </div>
      )}
    </div>
  );
}
