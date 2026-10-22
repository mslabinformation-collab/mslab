"use client";

import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { filledContract } from "@/domain/contract";
import type { Locale } from "@/i18n/locales";
import { hintIn } from "@/lib/account-cookies";
import { navigate } from "@/lib/navigate";
import { useUrlQuery } from "@/lib/url-query";
import { buyEcourse } from "@/server/actions/public";
import { ContractPreview, type FormContract } from "./ContractPreview";
import { Icon } from "./Icon";
import ui from "./ui.module.css";
import styles from "./PurchaseInterest.module.css";
import buy from "./CourseBuy.module.css";

export type EcoursePurchaseTexts = {
  name: string;
  email: string;
  /** The box: the e-course contract (contracts, D1). */
  contractTerms: string;
  /** „Loe lepingut“: opens the contract in the cart. */
  readContract: string;
  /** The box's error when the contract's text changed since the cart was loaded (ruling R6): the new text is shown, the box cleared. */
  contractChanged: string;
  newsletterConsent: string;
  /** The legend of the choice while Järelmaks (Inbank) is offered: „Tasumine“. */
  paymentLabel: string;
  /** „Pangalink“ and „Järelmaks (Inbank)“: the two choices (instalments §4). */
  payBank: string;
  payFinancing: string;
  /** „Järelmaks on võimalik 100–5000 € hinnaga koolitusele.“: said at the choice when the server refused a järelmaks after all because of the price. */
  financingRange: string;
  /** „Järelmaks pole praegu saadaval. Saad maksta pangalingiga.“: said at the choice when the server refused it because it was switched off since the cart was loaded. */
  financingOff: string;
  /** "Maksa 190 €" */
  submit: string;
  /** The button while the payment page is being opened: "Avan makse…" */
  starting: string;
  /** In place of the form when this address paid the course in the last 30 minutes: "Makse on juba tehtud — vaata oma e-posti." */
  alreadyPaid: string;
  errorRequired: string;
  errorEmail: string;
  errorTooMany: string;
  errorGeneric: string;
};

type Field = "name" | "email" | "method" | "terms" | "form";
type Errors = Partial<Record<Field, string>>;
type State = { status: "idle" } | { status: "unavailable" } | { status: "alreadyPaid" } | { status: "error"; errors: Errors };

/** Where the focus goes after a failed submit: the first of these with an error, in page order. */
const ORDER: Field[] = ["name", "email", "method", "terms"];

/** How the start is made (server/payments/montonio.ts OrderMethod): the bank link, or Järelmaks (Inbank). */
type Method = "paymentInitiation" | "hirePurchase";

/** Only a web page is a place to send the browser to. */
const isPageUrl = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//i.test(url);

/**
 * The e-course cart's purchase (phase 2b, spec 6.4, D3): name, e-mail, the box (required), the newsletter box (unticked) and "Maksa {hind}"; the
 * bank or the card is chosen on Montonio's own page (D4). The box is the e-course contract (contracts, D1), and „Loe lepingut“ opens `contract`
 * in the cart, filled live with the name and the address she types, the course and the price (domain/contract.ts filledContract: the server keeps
 * the very same text on the payment when „Maksa“ starts it, and freezes it when it is paid). It sends the version of the text it shows (R6): when
 * Maria has saved another text since the cart was loaded, nothing starts, the box's error says so, the box is cleared and the cart is loaded again
 * with the new text. The price is
 * the course's own on the server: this form sends none. The cart is cached for everyone, so a signed-in browser (the hint cookie) fills name and
 * e-mail from /api/konto/me here, in the browser, never over what was typed; nothing personal is in the page the server renders.
 * When payments are not available after all (form "unavailable": Montonio down), `fallback` takes the form's place: the cart's
 * purchase-interest form, so nothing is lost. After a failed submit the focus goes to the first field with an error. "Avan makse…" stays while
 * the browser leaves for Montonio; if Back brings the page from the back-forward cache, the button is ready again, and pressing it after the
 * payment was made (form "alreadyPaid": this address paid the course in the last 30 minutes, Dim's decision of 10.10) shows "Makse on juba tehtud"
 * in the form's place instead of charging again. It says that and nothing else; a reload brings the form back once the 30 minutes are over.
 * Järelmaks (Inbank), while the cart's page says it is offered (`financing`: the toggle on, Montonio payments on, the price within 100–5000 €; instalments
 * D4, §4): a choice, „Pangalink“ (the default) and „Järelmaks (Inbank)“, between the e-mail and the box; the form sends it as `method` (paymentInitiation |
 * hirePurchase), the way the start is made. The result page's „Proovi uuesti“ for a pending application opens the cart with ?makse=jarelmaks, which chooses
 * the järelmaks (the cart is one cached page per course, so the address is read in the browser). A järelmaks the server refuses after all (the page is
 * a few minutes old: the toggle was switched off, or the price moved) starts nothing: the range is said at the choice, the bank link is chosen and the
 * next press starts it. Without `financing` there is no choice and no field, and the server starts the bank link, as it always did.
 */
export function EcoursePurchase({
  course,
  locale,
  financing,
  t,
  contract,
  fallback,
}: {
  course: string;
  locale: Locale;
  /** Is Järelmaks (Inbank) offered for this course's price (domain/financing.ts financingOffered, read by the cart's page)? */
  financing: boolean;
  t: EcoursePurchaseTexts;
  /** The e-course contract, unfilled (FormContract). */
  contract: FormContract;
  fallback: React.ReactNode;
}) {
  const id = useId();
  const [values, setValues] = useState({ name: "", email: "" });
  const [agreed, setAgreed] = useState(false);
  const [newsletter, setNewsletter] = useState(false);
  // undefined: not chosen on this page yet, the address (?makse=jarelmaks) applies
  const [methodChosen, setMethod] = useState<Method>();
  const [query] = useUrlQuery();
  const method: Method = financing ? (methodChosen ?? (query.get("makse") === "jarelmaks" ? "hirePurchase" : "paymentInitiation")) : "paymentInitiation";
  const [away, setAway] = useState(false);
  const paidRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!hintIn(document.cookie)) return;
    let live = true;
    void fetch("/api/konto/me", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then((res) => (res.ok ? (res.json() as Promise<{ ok?: unknown; email?: unknown; name?: unknown }>) : null))
      .then((me) => {
        if (!live || me?.ok !== true) return;
        setValues((v) => ({ name: v.name || (typeof me.name === "string" ? me.name : ""), email: v.email || (typeof me.email === "string" ? me.email : "") }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) setAway(false);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  const [state, formAction, pending] = useActionState<State, FormData>(async (_prev, formData) => {
    try {
      const result = await buyEcourse(formData);
      if (result.ok) {
        // an ok with no payment page (the honeypot's answer) is no purchase: the interest form takes the place
        if (!isPageUrl(result.paymentUrl)) return { status: "unavailable" };
        setAway(true);
        navigate(result.paymentUrl);
        return { status: "idle" };
      }
      if (result.errors.form === "unavailable") return { status: "unavailable" };
      if (result.errors.form === "alreadyPaid") return { status: "alreadyPaid" };
      const errors: Errors = {};
      let changed = false;
      for (const [f, code] of Object.entries(result.errors)) {
        if (f === "form") errors.form = code === "rate" ? t.errorTooMany : t.errorGeneric;
        else if (f === "method" && (code === "financing" || code === "financingOff")) {
          // a järelmaks that is not allowed any more: why at the choice (the range, or that it is switched off), and the bank link chosen for the next press
          errors.method = code === "financingOff" ? t.financingOff : t.financingRange;
          setMethod("paymentInitiation");
        } else if (f === "email") errors.email = t.errorEmail;
        else if (f === "terms" && code === "changed") {
          errors.terms = t.contractChanged;
          changed = true;
        } else if (f === "name" || f === "terms") errors[f] = t.errorRequired;
      }
      if (Object.keys(errors).length === 0) errors.form = t.errorGeneric;
      // the contract's text changed since the cart was loaded (R6): her tick was for the old one, so the box is cleared and the cart is loaded
      // again for the new text (and its version) to read; nothing was started
      if (changed) {
        setAgreed(false);
        router.refresh();
      }
      return { status: "error", errors };
    } catch {
      return { status: "error", errors: { form: t.errorGeneric } };
    }
  }, { status: "idle" });

  useEffect(() => {
    if (state.status === "alreadyPaid") paidRef.current?.focus();
    if (state.status !== "error") return;
    const first = ORDER.find((f) => state.errors[f]);
    document.getElementById(first ? `${id}-${first}` : `${id}-form-error`)?.focus();
  }, [state, id]);

  if (state.status === "unavailable") return <>{fallback}</>;
  if (state.status === "alreadyPaid")
    return (
      <div ref={paidRef} className={styles.sent} role="status" tabIndex={-1}>
        <span className={styles.tick} aria-hidden="true">
          <Icon name="check" size={16} />
        </span>
        <p>{t.alreadyPaid}</p>
      </div>
    );
  const errors: Errors = state.status === "error" ? state.errors : {};
  const busy = pending || away;
  // the contract as the cart fills it now: what „Maksa“ keeps on the payment (server/submit.ts handleEcoursePurchase fills it the same way)
  const contractText = filledContract(contract, {
    name: values.name,
    email: values.email,
    course: contract.course,
    session: null,
    priceCents: contract.priceCents,
    choice: null,
    locale: contract.locale,
  });
  const described = (f: Field) => ({ "aria-invalid": errors[f] ? true : undefined, "aria-describedby": errors[f] ? `${id}-${f}-error` : undefined });
  const err = (f: Field) =>
    errors[f] ? (
      <p id={`${id}-${f}-error`} className={styles.error}>
        {errors[f]}
      </p>
    ) : null;

  return (
    <form
      className={styles.form}
      method="post"
      noValidate
      data-ecourse-form=""
      // Submitted by hand (as the registration form); method="post" keeps the name and e-mail out of the URL without the script.
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        const formData = new FormData(e.currentTarget);
        startTransition(() => formAction(formData));
      }}
    >
      <label className={styles.label} htmlFor={`${id}-name`}>
        {t.name}
      </label>
      <input id={`${id}-name`} className={styles.input} name="name" type="text" required autoComplete="name" maxLength={120} value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} {...described("name")} />
      {err("name")}
      <label className={styles.label} htmlFor={`${id}-email`}>
        {t.email}
      </label>
      <input id={`${id}-email`} className={styles.input} name="email" type="email" required autoComplete="email" maxLength={200} value={values.email} onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))} {...described("email")} />
      {err("email")}
      {financing && (
        <fieldset className={buy.options}>
          <legend className={buy.legend}>{t.paymentLabel}</legend>
          <div className={buy.pay}>
            {(["paymentInitiation", "hirePurchase"] as const).map((m) => (
              <label key={m} className={buy.option}>
                <input
                  id={m === "paymentInitiation" ? `${id}-method` : undefined}
                  type="radio"
                  name="method"
                  value={m}
                  checked={method === m}
                  onChange={() => setMethod(m)}
                  aria-describedby={errors.method ? `${id}-method-error` : undefined}
                />
                <span className={buy.optionName}>{m === "paymentInitiation" ? t.payBank : t.payFinancing}</span>
              </label>
            ))}
          </div>
          {errors.method && (
            <p id={`${id}-method-error`} className={styles.error} data-financing-range="">
              {errors.method}
            </p>
          )}
        </fieldset>
      )}
      <div>
        <label className={buy.check}>
          <input id={`${id}-terms`} type="checkbox" name="terms" required checked={agreed} onChange={(e) => setAgreed(e.target.checked)} {...described("terms")} />
          <span>{t.contractTerms}</span>
        </label>
        <ContractPreview label={t.readContract} text={contractText} />
        {err("terms")}
      </div>
      <label className={buy.check}>
        <input type="checkbox" name="newsletter" checked={newsletter} onChange={(e) => setNewsletter(e.target.checked)} />
        <span>{t.newsletterConsent}</span>
      </label>
      <input type="hidden" name="course" value={course} />
      <input type="hidden" name="locale" value={locale} />
      {/* the version of the contract this cart shows (R6): the server starts nothing for another text */}
      <input type="hidden" name="contractVersion" value={contract.version} />
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
      <button className={`${ui.btn} ${ui.btnFull}`} type="submit" aria-disabled={busy || undefined}>
        {busy ? t.starting : t.submit}
        <Icon name="arrow" />
      </button>
    </form>
  );
}
