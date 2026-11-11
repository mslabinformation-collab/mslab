"use client";

import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { hasPickableSession, initialSession } from "@/domain/catalogue";
import { filledContract } from "@/domain/contract";
import type { SubmitCodeError } from "@/domain/discount-codes";
import { totalWith } from "@/domain/discount-codes";
import { financingChoice } from "@/domain/financing";
import type { PaymentChoice } from "@/domain/registration";
import type { SeatState } from "@/domain/sessions";
import type { Locale } from "@/i18n/locales";
import { navigate } from "@/lib/navigate";
import { useUrlQuery } from "@/lib/url-query";
import { registerContact, submitIndividual } from "@/server/actions/public";
import { ContractPreview, type FormContract } from "./ContractPreview";
import { DiscountField, type DiscountTexts } from "./DiscountField";
import { Icon } from "./Icon";
import ui from "./ui.module.css";
import styles from "./CourseBuy.module.css";
import { useDiscountCode } from "./useDiscountCode";

type Kind = "group" | "individual";

export type SessionOption = {
  id: number;
  /** When it starts (ISO): the inline contract's {toimumine} is its date on Tallinn's calendar (domain/contract.ts sessionText). */
  startsAt: string;
  date: string;
  weekday: string;
  city: string;
  venue: string;
  language: string;
  state: SeatState;
  /** "Vabu kohti · 4", "Viimased kohad · 2", "Täis", "Tühistatud" */
  stateLabel: string;
  disabled: boolean;
};

export type ContactRegisterTexts = {
  participationLabel: string;
  group: string;
  individual: string;
  pickSession: string;
  noSessions: string;
  switchIndividual: string;
  individualNote: string;
  sessionRequired: string;
  sessionFull: string;
  sessionUnavailable: string;
  name: string;
  email: string;
  phone: string;
  paymentLabel: string;
  payFull: string;
  payHalf: string;
  /** „Järelmaks (Inbank)“: the third choice, while it is offered (instalments D2, D4). */
  payFinancing: string;
  /** „Järelmaks on võimalik 100–5000 € hinnaga koolitusele.“: said when the server refused a järelmaks after all because of the price (§4). */
  financingRange: string;
  /** „Järelmaks pole praegu saadaval. Saad maksta pangalingiga.“: said when the server refused it because it was switched off since the page was loaded (§4). */
  financingOff: string;
  /** „Võimalik tasuda ka järelmaksuga (Inbank).“: the quiet line next to the prices while the choice is offered (D4). */
  financingLine: string;
  modelHelp: string;
  createAccount: string;
  newsletterConsent: string;
  /** The individual request's box and its link (D1: no contract for it). */
  terms: string;
  termsLink: { label: string; href: string };
  /** The group registration's box: the contract (D1). */
  contractTerms: string;
  /** „Loe lepingut“: opens the contract in the form. */
  readContract: string;
  /** {toimumine} in the inline contract until a date is chosen: „(vali toimumine)“. */
  contractNoSession: string;
  /** The box's error when the contract's text changed since the page was loaded (ruling R6): the new text is shown, the box cleared. */
  contractChanged: string;
  preferredPeriod: string;
  preferredPeriodPlaceholder: string;
  message: string;
  optional: string;
  register: string;
  requestSubmit: string;
  sending: string;
  confirmAfterPrepayment: string;
  registerSuccess: string;
  individualSent: string;
  errorRequired: string;
  errorEmail: string;
  errorTooMany: string;
  errorGeneric: string;
  /** The sooduskood field (F1): the dictionary's `discount` section with the check's "rate" and "server" answers (forms.errorTooMany, the generic error). */
  discount: DiscountTexts;
};

type Field = "session" | "name" | "email" | "phone" | "period" | "message" | "payment" | "terms" | "form";
type Errors = Partial<Record<Field, string>>;
/**
 * `rejected`: the date the server turned down (filled up or cancelled meanwhile); its error stays while it is picked.
 * `paymentUrl` (sent, group): the prepayment's page at Montonio, where the browser goes once this state is on the page (see the effect below).
 * `financingRefused` (sent, group): the registration is stored, but its Järelmaks (Inbank) was not allowed any more (the toggle was switched off, or the
 * price left 100–5000 €, since the page was loaded); there is no payment page, and the answer says why: "refused" (the price outside the range) what
 * Järelmaks needs, the range; "off" (any other refusal, the price within the range) that it is not available now and the bank is open.
 */
type State =
  | { status: "idle" }
  | { status: "sent"; kind: Kind; paymentUrl?: string; financingRefused?: "refused" | "off" }
  | { status: "error"; kind: Kind; errors: Errors; rejected?: number };

/** What the server's `discountCode` error may say (domain SubmitCodeError); anything else is read as "unknown". */
const SUBMIT_CODE_ERRORS: readonly SubmitCodeError[] = ["unknown", "paused", "ended", "notYet", "usedUp", "scope", "person", "changed"];

/** Where focus goes after a failed submit: the first of these with an error, in page order. */
const FIELD_ORDER: Field[] = ["session", "name", "email", "phone", "period", "message", "payment", "terms"];

/**
 * Contact course registration (Maria's overview, P10–P16). Only the participation kinds that have a price are offered,
 * each with its own price (P12, P13).
 * - Group: pick one of the upcoming sessions (full and cancelled ones are shown but cannot be picked), then the form with
 *   payment 100% now, 50% + 50% (P14) or, while `financingSwitch` and the total say it is offered (the course page says the toggle and the payments; the
 *   total, the group price less a code, within 100–5000 €: domain/financing.ts financingChoice; instalments D4), „Järelmaks (Inbank)“ — a third choice, and the quiet line „Võimalik tasuda ka järelmaksuga (Inbank).“ next to the
 *   prices; never a disabled placeholder. A järelmaks the server refuses after all (the page is a few minutes old) keeps the registration: the answer
 *   says so (`financing: "refused"`, or "off" when it was switched off), the form gives way to the confirmation, and `financingRange` (`financingOff`) is said first. The form never confirms a place: it is confirmed after at least 50% prepayment
 *   (P15), said under the button. With online payments the browser goes on to the prepayment's page (phase 2b). With no
 *   session to pick, the form is replaced by "new dates soon" and, when the course has an individual price, a way to ask
 *   for the individual course instead.
 * - Individual: a request with the preferred period or date; Maria agrees the time and the payment afterwards, so there
 *   is no payment choice and no prepayment line.
 * Both: help finding models (P11), create an account (P16), the newsletter consent and the optional message (phase 2c), the box.
 * - The group registration's box is the contract (contracts, D1): „Olen tutvunud lepingu tingimustega …“ with „Loe lepingut“, which opens
 *   `contract` in the form, filled live from what the form holds (the chosen date and place, the price, the payment choice, the name and the
 *   address; „(vali toimumine)“ before a date is chosen) by the server's own fill (domain/contract.ts filledContract, Review Focus 3). Submitting
 *   with it ticked is the acceptance: the server freezes the contract with the registration. The form sends the version of the text it shows
 *   (R6); when Maria has saved another text since the page was loaded, nothing is stored, the box's error says so, the box is cleared and the
 *   page is loaded again with the new text.
 * - The individual request keeps today's box and its link to „Õppetingimused“ (D1: no contract).
 * - Group only (F1): „Mul on sooduskood“ under „Sõnum“ opens the code field (DiscountField, useDiscountCode). The form shows the total (the group price
 *   less the code), fills the contract with it and decides järelmaks on it: the visitor's own choice stays in state, a chosen järelmaks that the total
 *   takes out of 100–5000 € is sent as „100% kohe“ and `payFinancingRange` shows under the choices, and removing the code brings it back. A typed code
 *   is applied by the submit itself (and one that is refused is not sent); the server's `discountCode` refusals go back to the field.
 * After a failed submit, focus goes to the first field with an error (its message is linked with aria-describedby).
 * "?sessioon=12" (the links from the home page and the calendar) preselects that date until the visitor picks one. The
 * page is cached for every visitor, so the address is read in the browser (useUrlQuery: after hydration).
 */
export function ContactRegister({
  course,
  locale,
  financingSwitch,
  kinds,
  sessions,
  contract,
  t,
}: {
  course: string;
  locale: Locale;
  /** Maria's Järelmaks (Inbank) toggle and Montonio's payments, as the course page read them; whether it is offered is decided here, on the total (financingChoice). */
  financingSwitch: { enabled: boolean; paymentsOn: boolean };
  kinds: { kind: Kind; price: string }[];
  sessions: SessionOption[];
  /** The group registration's contract, unfilled (FormContract). */
  contract: FormContract;
  t: ContactRegisterTexts;
}) {
  const id = useId();
  const offered = kinds.map((k) => k.kind);
  const [query] = useUrlQuery();
  const linked = initialSession(sessions, query.get("sessioon") ?? undefined);
  // undefined: not chosen on this page yet, the link's date (and the group kind with it) applies
  const [kindChosen, setKind] = useState<Kind>();
  const [sessionChosen, setSession] = useState<number | null>();
  const kind: Kind = kindChosen ?? (linked !== null && offered.includes("group") ? "group" : (offered[0] ?? "group"));
  const session = sessionChosen === undefined ? linked : sessionChosen;
  const [values, setValues] = useState({ name: "", email: "", phone: "", period: "", message: "" });
  // the sooduskood (group only): its price is the total below; the individual request has no code
  const discount = useDiscountCode({ course, listCents: contract.priceCents ?? 0 });
  const total = contract.priceCents === null ? null : discount.totalCents;
  // The visitor's own choice stays in state; what is sent is the effective one. A chosen järelmaks that the total (or the switch) takes out of
  // 100–5000 € is "100% kohe" and the range line is said, and removing the code brings järelmaks back as selected.
  const [chosenPayment, setPayment] = useState<PaymentChoice>("full");
  const fin = financingChoice({ totalCents: total ?? 0, financingSwitch, chosen: chosenPayment });
  const financing = total !== null && fin.offered;
  const payment: PaymentChoice = fin.choice;
  const choices: PaymentChoice[] = financing ? ["full", "half", "financing"] : ["full", "half"];
  const [checks, setChecks] = useState({ modelHelp: false, account: false, newsletter: false, terms: false });
  const [switched, setSwitched] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const individualRef = useRef<HTMLInputElement>(null);
  const sessionRefs = useRef(new Map<number, HTMLButtonElement>());
  const sentRef = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  // counts the times the visitor must be taken to the code field (a refusal at submit): the effect below runs after the screen has the new state
  const [discountFocus, setDiscountFocus] = useState(0);
  const router = useRouter();

  const [state, formAction, pending] = useActionState<State, FormData>(async (_prev, formData) => {
    const k: Kind = formData.get("kind") === "individual" ? "individual" : "group";
    try {
      const result = k === "individual" ? await submitIndividual(formData) : await registerContact(formData);
      if (result.ok) {
        // phase 2b (spec 6.1): the prepayment's page at Montonio (the bank or the card is chosen there); the answer shows meanwhile. The
        // browser leaves from the effect below, not here: the action's answer carries the revalidated course page (the seats changed), which
        // Next streams after this result, and leaving at once cut it off mid-stream ("The destination stream closed early" in the server's log).
        return { status: "sent", kind: k, paymentUrl: k === "group" && result.paymentUrl ? result.paymentUrl : undefined, financingRefused: k === "group" ? result.financing : undefined };
      }
      const errors: Errors = {};
      let rejected: number | undefined;
      let changed = false;
      let discountRefused: SubmitCodeError | undefined;
      for (const [f, code] of Object.entries(result.errors)) {
        if (f === "discountCode") discountRefused = SUBMIT_CODE_ERRORS.includes(code as SubmitCodeError) ? (code as SubmitCodeError) : "unknown";
        else if (f === "form") errors.form = code === "rate" ? t.errorTooMany : t.errorGeneric;
        else if (f === "terms" && code === "changed") {
          errors.terms = t.contractChanged;
          changed = true;
        }
        else if (f === "email") errors.email = t.errorEmail;
        else if (f === "session" && (code === "full" || code === "unavailable")) {
          errors.session = code === "full" ? t.sessionFull : t.sessionUnavailable;
          rejected = Number(formData.get("session"));
        } else if (f === "session") errors.session = t.sessionRequired;
        else errors[f as Field] = t.errorRequired;
      }
      // the code's refusal belongs to the field, which says it (and re-checks the code); it is not a form error
      if (discountRefused) void discount.serverRefused(discountRefused).then(() => setDiscountFocus((n) => n + 1));
      if (Object.keys(errors).length === 0 && !discountRefused) errors.form = t.errorGeneric;
      // The contract's text changed since the page was loaded (R6): her tick was for the old one, so the box is cleared, and the page is loaded
      // again for the new text (and its version) to read.
      if (changed) setChecks((c) => ({ ...c, terms: false }));
      // The date list on the page is out of date: load the current seat states. The same for a changed contract text.
      if (rejected !== undefined || changed) router.refresh();
      return { status: "error", kind: k, errors, rejected };
    } catch {
      return { status: "error", kind: k, errors: { form: t.errorGeneric } };
    }
  }, { status: "idle" });

  // Land keyboard and screen-reader users on the confirmation, or on the first field that needs fixing. A registration that has a payment page
  // goes on to it from here: the state is on the page, so the action's whole answer (with the revalidated page) has been received.
  useEffect(() => {
    if (state.status === "sent") {
      sentRef.current?.focus();
      if (state.paymentUrl) navigate(state.paymentUrl);
      return;
    }
    if (state.status !== "error") return;
    const first = FIELD_ORDER.find((f) => state.errors[f]);
    const target =
      first === "session"
        ? formRef.current?.querySelector<HTMLElement>("[data-session]:not([aria-disabled='true'])")
        : document.getElementById(first ? `${id}-${first}` : `${id}-form-error`);
    target?.focus();
  }, [state, id]);

  // The code's refusal at „Registreeru“ sits above „Tasumine“, out of sight on a phone: focus goes to the box while it is there, else to what the
  // field says (its message, or the range line when the submit's own check moved the total), and that is scrolled into view.
  useEffect(() => {
    if (discountFocus === 0) return;
    const form = formRef.current;
    const target = form?.querySelector<HTMLElement>("[data-discount] input") ?? form?.querySelector<HTMLElement>("[data-discount-error], [data-financing-range]");
    target?.focus();
    target?.scrollIntoView?.({ block: "center" });
  }, [discountFocus]);

  // "Vali individuaalkoolitus" disappears with the group view: keep focus on the choice that was made.
  useEffect(() => {
    if (switched) individualRef.current?.focus();
  }, [switched]);

  if (kinds.length === 0) return null;

  if (state.status === "sent") {
    return (
      <div ref={sentRef} className={styles.sent} role="status" tabIndex={-1} data-register-sent="">
        <span className={styles.tick} aria-hidden="true">
          <Icon name="check" size={18} />
        </span>
        {state.kind === "group" && state.financingRefused ? (
          <div className={styles.sentText}>
            <p data-financing-refused="">{state.financingRefused === "off" ? t.financingOff : t.financingRange}</p>
            <p>{t.registerSuccess}</p>
          </div>
        ) : (
          <p>{state.kind === "group" ? t.registerSuccess : t.individualSent}</p>
        )}
      </div>
    );
  }

  // Errors belong to the kind that was submitted; the date error goes away once a date (another one, if the server
  // turned the picked date down) is picked.
  const errors: Errors = state.status === "error" && state.kind === kind ? { ...state.errors } : {};
  if (session !== null && !(state.status === "error" && state.rejected === session)) delete errors.session;
  const err = (f: Field) =>
    errors[f] ? (
      <span id={`${id}-${f}-error`} className={styles.error}>
        {errors[f]}
      </span>
    ) : null;
  const text = (f: "name" | "email" | "phone" | "period" | "message") => ({
    id: `${id}-${f}`,
    name: f,
    value: values[f],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues((v) => ({ ...v, [f]: e.target.value })),
    "aria-invalid": errors[f] ? true : undefined,
    "aria-describedby": errors[f] ? `${id}-${f}-error` : undefined,
  });

  // Sessions are a radio group (WAI-ARIA): arrows move between the dates that can be picked.
  const pickable = sessions.filter((s) => !s.disabled);
  const groupOpen = hasPickableSession(sessions);
  const showForm = kind === "individual" || groupOpen;
  const tabStop = session ?? pickable[0]?.id ?? null;
  const onSessionKey = (e: React.KeyboardEvent, current: number) => {
    const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir || pickable.length === 0) return;
    e.preventDefault();
    const at = pickable.findIndex((s) => s.id === current);
    const next = pickable[(at + dir + pickable.length) % pickable.length];
    setSession(next.id);
    sessionRefs.current.get(next.id)?.focus();
  };

  const price = (k: Kind) => kinds.find((x) => x.kind === k)?.price ?? "";

  // the group registration's contract as the form fills it now (the server fills the frozen one with the same function, from what is stored)
  const chosen = sessions.find((s) => s.id === session) ?? null;
  const contractText = filledContract(
    contract,
    {
      name: values.name,
      email: values.email,
      course: contract.course,
      session: chosen ? { startsAt: new Date(chosen.startsAt), city: chosen.city, venue: chosen.venue } : null,
      priceCents: total,
      choice: payment,
      locale: contract.locale,
    },
    t.contractNoSession,
  );

  return (
    <form
      ref={formRef}
      className={styles.register}
      method="post"
      noValidate
      data-register-form=""
      // Submitted by hand rather than with <form action>: React resets a form after an action, which would clear the
      // checkboxes and radios in the page while their state says otherwise (all fields here are controlled).
      // method="post" keeps the personal data out of the URL even if the script has not loaded.
      onSubmit={async (e) => {
        e.preventDefault();
        if (pending || submitting.current) return;
        const formData = new FormData(e.currentTarget);
        if (formData.get("kind") !== "individual") {
          // a typed code that was not applied yet is applied now; one the check refuses is not sent (the field says why)
          submitting.current = true;
          try {
            const d = await discount.beforeSubmit();
            if (!d.send) {
              setDiscountFocus((n) => n + 1);
              return;
            }
            // The code the submit itself applied may have moved the total out of järelmaks' range: the choice then is "100% kohe", and it is not sent
            // before she has seen that (the screen shows the flipped choice and the range line).
            const sentChoice = formData.get("payment");
            if (sentChoice !== null && contract.priceCents !== null) {
              const after = financingChoice({ totalCents: totalWith(contract.priceCents, d.discountCents ?? 0), financingSwitch, chosen: chosenPayment }).choice;
              if (after !== sentChoice) {
                setDiscountFocus((n) => n + 1);
                return;
              }
            }
            formData.set("discountCode", d.code ?? "");
            formData.set("discountCents", d.discountCents === null ? "" : String(d.discountCents));
          } finally {
            submitting.current = false;
          }
        }
        startTransition(() => formAction(formData));
      }}
    >
      <fieldset className={styles.options}>
        <legend className={styles.legend}>{t.participationLabel}</legend>
        <div className={styles.kinds}>
          {kinds.map((k) => (
            <label key={k.kind} className={styles.option}>
              <input
                ref={k.kind === "individual" ? individualRef : undefined}
                type="radio"
                name="kind"
                value={k.kind}
                checked={kind === k.kind}
                onChange={() => setKind(k.kind)}
              />
              <span className={styles.optionName}>{k.kind === "group" ? t.group : t.individual}</span>
              <span className={styles.optionPrice}>{price(k.kind)}</span>
            </label>
          ))}
        </div>
        {/* D4: next to the price, only while the choice is offered, and only for the course that has an online payment (not the individual request) */}
        {financing && kind === "group" && (
          <p className={styles.financingLine} data-financing-line="">
            {t.financingLine}
          </p>
        )}
      </fieldset>

      {kind === "group" ? (
        <div className={styles.sessionsBlock}>
          <p id={`${id}-sessions`} className={styles.legend}>
            {t.pickSession}
          </p>
          {sessions.length > 0 && (
            <div
              className={styles.sessions}
              role="radiogroup"
              aria-labelledby={`${id}-sessions`}
              aria-required="true"
              aria-invalid={errors.session ? true : undefined}
              aria-describedby={errors.session ? `${id}-session-error` : undefined}
            >
              {sessions.map((s) => (
                <button
                  key={s.id}
                  ref={(el) => {
                    if (el) sessionRefs.current.set(s.id, el);
                    else sessionRefs.current.delete(s.id);
                  }}
                  type="button"
                  role="radio"
                  className={styles.session}
                  data-session={s.id}
                  data-state={s.state}
                  aria-checked={session === s.id}
                  aria-disabled={s.disabled ? true : undefined}
                  tabIndex={!s.disabled && s.id === tabStop ? 0 : -1}
                  onClick={() => !s.disabled && setSession(s.id)}
                  onKeyDown={(e) => onSessionKey(e, s.id)}
                >
                  <span className={styles.sDate}>
                    <b>{s.date}</b>
                    <small>{s.weekday}</small>
                  </span>
                  <span className={styles.sPlace}>
                    <b>{s.city}</b>
                    {s.venue && <small>{s.venue}</small>}
                  </span>
                  <span className={styles.sLang}>{s.language}</span>
                  <span className={styles.sState}>
                    <i aria-hidden="true" />
                    {s.stateLabel}
                  </span>
                </button>
              ))}
            </div>
          )}
          {!groupOpen && (
            <div className={styles.noDates} data-no-sessions="">
              <p>{t.noSessions}</p>
              {offered.includes("individual") && (
                <button
                  type="button"
                  className={ui.btnOutline}
                  onClick={() => {
                    setKind("individual");
                    setSwitched((n) => n + 1);
                  }}
                >
                  {t.switchIndividual}
                  <Icon name="arrow" />
                </button>
              )}
            </div>
          )}
          {err("session")}
          {session !== null && <input type="hidden" name="session" value={session} />}
        </div>
      ) : (
        <p className={styles.note}>{t.individualNote}</p>
      )}

      {showForm && (
        <>
          <div className={styles.fields}>
            <div className={`${styles.field} ${styles.wide}`}>
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
            {kind === "individual" && (
              <div className={`${styles.field} ${styles.wide}`}>
                <label htmlFor={`${id}-period`}>{t.preferredPeriod}</label>
                <input {...text("period")} type="text" required maxLength={200} placeholder={t.preferredPeriodPlaceholder} />
                {err("period")}
              </div>
            )}
            {/* Optional, for both kinds (phase 2c): the welcome code is written here. */}
            <div className={`${styles.field} ${styles.wide}`}>
              <label htmlFor={`${id}-message`}>
                {t.message} <span className={styles.optional}>({t.optional})</span>
              </label>
              <textarea {...text("message")} rows={3} maxLength={2000} />
              {err("message")}
            </div>
          </div>

          {/* Group only (F1): under „Sõnum“, above „Tasumine“; the individual request has no code. */}
          {kind === "group" && contract.priceCents !== null && <DiscountField state={discount} t={t.discount} locale={locale} idPrefix={id} />}

          {/* Group only: an individual course's time and payment are agreed with Maria afterwards. */}
          {kind === "group" && (
            <fieldset className={styles.options}>
              <legend className={styles.legend}>{t.paymentLabel}</legend>
              <div className={styles.pay}>
                {/* P14, instalments D2/D4: the third choice is Järelmaks (Inbank), there only while it is offered; the server accepts it for the whole price
                    and refuses it again at the start if it is not allowed by then (§4). */}
                {choices.map((p) => (
                  <label key={p} className={styles.option}>
                    <input id={p === "full" ? `${id}-payment` : undefined} type="radio" name="payment" value={p} checked={payment === p} onChange={() => setPayment(p)} />
                    <span className={styles.optionName}>{p === "full" ? t.payFull : p === "half" ? t.payHalf : t.payFinancing}</span>
                  </label>
                ))}
              </div>
              {/* §4.4: a chosen järelmaks the total has taken out of 100–5000 € */}
              {fin.rangeLine && (
                <p className={styles.financingLine} data-financing-range="" tabIndex={-1}>
                  {t.financingRange}
                </p>
              )}
            </fieldset>
          )}

          <div className={styles.checks}>
            <label className={styles.check}>
              <input type="checkbox" name="modelHelp" checked={checks.modelHelp} onChange={(e) => setChecks((c) => ({ ...c, modelHelp: e.target.checked }))} />
              <span>{t.modelHelp}</span>
            </label>
            <label className={styles.check}>
              <input type="checkbox" name="account" checked={checks.account} onChange={(e) => setChecks((c) => ({ ...c, account: e.target.checked }))} />
              <span>{t.createAccount}</span>
            </label>
            <label className={styles.check}>
              <input type="checkbox" name="newsletter" checked={checks.newsletter} onChange={(e) => setChecks((c) => ({ ...c, newsletter: e.target.checked }))} />
              <span>{t.newsletterConsent}</span>
            </label>
            <div>
              <label className={styles.check}>
                <input
                  id={`${id}-terms`}
                  type="checkbox"
                  name="terms"
                  required
                  checked={checks.terms}
                  onChange={(e) => setChecks((c) => ({ ...c, terms: e.target.checked }))}
                  aria-invalid={errors.terms ? true : undefined}
                  aria-describedby={errors.terms ? `${id}-terms-error` : undefined}
                />
                <span>{kind === "group" ? t.contractTerms : t.terms}</span>
              </label>
              {kind === "group" ? (
                <ContractPreview label={t.readContract} text={contractText} />
              ) : (
                <a className={styles.termsLink} href={t.termsLink.href} target="_blank" rel="noopener">
                  {t.termsLink.label} ↗
                </a>
              )}
              {err("terms")}
            </div>
          </div>

          <input type="hidden" name="course" value={course} />
          <input type="hidden" name="locale" value={locale} />
          {/* the version of the contract this page shows (R6): the server freezes nothing from another text */}
          {kind === "group" && <input type="hidden" name="contractVersion" value={contract.version} />}
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
            {pending ? t.sending : kind === "group" ? t.register : t.requestSubmit}
            <Icon name="arrow" />
          </button>
          {kind === "group" && <p className={styles.info}>{t.confirmAfterPrepayment}</p>}
        </>
      )}
    </form>
  );
}
