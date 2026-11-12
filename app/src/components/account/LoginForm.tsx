"use client";

import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/site/Icon";
import ui from "@/components/site/ui.module.css";
import { isEmail, normalizeEmail, typoSuggestion } from "@/domain/email";
import type { Dict } from "@/i18n/dict/et";
import { fill } from "@/i18n/format";
import type { Locale } from "@/i18n/locales";
import { forgetAccountFavourites } from "@/lib/favourites";
import { sendJson } from "@/lib/json-request";
import { PASSWORD_MARK, forwardsSignedIn, readLoginAddress } from "./login-address";
import { PENDING_KEY, hasAccountHint, rememberEmail, rememberedEmail } from "./useAccount";
import styles from "./LoginForm.module.css";

export type LoginTexts = Dict["account"]["login"] & { title: string; badEmail: string };

/** "Saada uus kood" waits this long after a code was sent (spec 5). */
export const RESEND_AFTER_MS = 60_000;
/**
 * The code step is kept for a reload within this time: the code's 30 minutes (server/client-auth.ts LOGIN_TTL_MS) less a
 * minute, because `sentAt` is stamped when the answer arrives, a little after the server issued the code.
 */
const KEEP_CODE_STEP_MS = 29 * 60_000;

type SendError = "email" | "rate" | "server";
/** `short`: Enter (a phone's "Go") with fewer than six digits. */
type CodeError = "short" | "code" | "expired" | "rate" | "server";
type FocusTarget = "email" | "code" | "resend" | "typo" | "password";
/** The password step's one sentence under the fields: a malformed address, any wrong answer, the lock, or a failure of ours. */
type PasswordError = "email" | "wrong" | "locked" | "server";
type Pending = { sentTo: string; sentAt: number };

/**
 * The code step this tab is in, when a code went out less than 30 minutes ago: a phone that dropped the tab (or a reload)
 * opens the login page at the code field again. Null when there is none, it is older, or storage is blocked.
 */
function pendingCode(now: number): Pending | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { sentTo, sentAt } = value as Record<string, unknown>;
    if (typeof sentTo !== "string" || !isEmail(sentTo) || typeof sentAt !== "number") return null;
    return now >= sentAt && now - sentAt < KEEP_CODE_STEP_MS ? { sentTo, sentAt } : null;
  } catch {
    return null;
  }
}

/** Keeps (or, with null, forgets) the code step of this tab; silently nothing when storage is blocked. */
function keepPendingCode(pending: Pending | null): void {
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // private mode or blocked storage: a reload simply starts at the e-mail again
  }
}

const noSubscription = () => () => {};

/** A dictionary sentence with one placeholder, the value in bold: "Saatsime … aadressile <b>{email}</b>." */
function withBold(template: string, name: string, value: string): React.ReactNode {
  const [before, after = ""] = template.split(`{${name}}`);
  return (
    <>
      {before}
      <b>{value}</b>
      {after}
    </>
  );
}

/**
 * The login page (/konto/sisene, spec 2.1 rules 1, 3, 8): the e-mail → "Saada kood" → the 6-digit code from the e-mail →
 * "Logi sisse". Below the e-mail step a quiet "Sisene parooliga" opens the e-mail and password step (phase 2c; the fragment `#parool`
 * keeps it for a reload), with "Logi sisse" and "Saada mulle hoopis kood" back: POST /api/konto/parool-login, one sentence for every
 * wrong answer, another for the lock. The code is the default; the password is optional (Minu andmed).
 *
 * - The field starts with the last e-mail used in this browser; the address is trimmed and lower-cased, and a common
 *   domain typo ("gmial.com") asks "Kas mõtlesid …?" first: "Jah, paranda" corrects it and sends, "Ei, saada nii" sends as typed.
 * - The code step says where the code went and has one primary button, "Logi sisse", enabled at six digits; the sixth digit
 *   also signs in by itself. Enter with fewer digits says "Sisesta kõik 6 numbrit.". Below: the spam-folder hint (the answer
 *   is the same whether or not a mail went out), then two quiet text buttons, "Saada uus kood" (after 60 s; until then
 *   the seconds left, as text) and "Muuda e-posti". Once a new code was asked for, one more quiet line says to try again in half
 *   an hour if no mail comes: the answer is the same for every address, and one with 3 logins in 30 minutes gets no new mail.
 * - The code step is kept in this tab (sessionStorage) for the code's 30 minutes: a phone that drops the tab while the
 *   student reads the e-mail comes back to the code field, with the rest of the 60 s.
 * - The page is static and the same for every visitor; the browser reads the parameters in the address's fragment, which never
 *   reaches a server or a cache (login-address.ts; the query too, for links already out there; the middleware moves a query into
 *   the fragment): `#viga=link` (the e-mail's button was used or too old) and `#viga=server` show a notice above the form,
 *   `#korda=1` (from "Saada uus kood" on an account page) sends a code to the remembered e-mail at once, `#email=…` fills the
 *   field once (before the remembered address), and `#email=…&kood=1` (the link under the code in a registration's confirmation
 *   e-mail) opens the code step for that address at once, sending nothing (the code is in the mailbox already; "Saada uus kood"
 *   works without the 60 s wait, as the code may be old; `viga` beats it, `korda` still sends, `kood` without an address is
 *   ignored, and the step is not kept in sessionStorage: nothing was sent from this tab). The parameters are then removed from
 *   the address, so a reload does not repeat them.
 * - The page's language goes with the login (the account a first login creates speaks it); signed in, the browser opens
 *   "Minu konto" in that language, in place of the login page in the history.
 * - A browser that is signed in already (the hint cookie) is sent on to "Minu konto" at once, unless the address asks this page for
 *   something (`viga`, `korda`, `kood`), names another address in `email` (a shared device), or carries `#valja=1`: an account page
 *   found the session gone and sent her here (login-address.ts forwardsSignedIn), so a stale hint never loops.
 */
export function LoginForm({ locale, t }: { locale: Locale; t: LoginTexts }) {
  const id = useId();
  // false in the server's HTML and while it hydrates, true once this form handles its own submit: before that a tap posts
  // the plain form (method="post", nothing in the address) and the page simply opens again. `data-login-ready` says so.
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  const [step, setStep] = useState<"email" | "code" | "password">("email");
  const [email, setEmail] = useState("");
  const [banner, setBanner] = useState<"link" | "server" | null>(null);
  const [typo, setTypo] = useState<string | null>(null);
  const [sendError, setSendError] = useState<SendError | null>(null);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [codeError, setCodeError] = useState<CodeError | null>(null);
  const [resent, setResent] = useState(false);
  // a new code was asked for in this code step: the line on what to do when no mail comes shows from then on
  const [askedAgain, setAskedAgain] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<PasswordError | null>(null);

  // One request at a time (a double tap, the sixth digit and Enter): a ref, so a second call in the same tick sees it.
  const busy = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const resendRef = useRef<HTMLButtonElement>(null);
  const typoRef = useRef<HTMLButtonElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // Where the focus goes once the render that shows it is on screen: kept until that element exists (an effect may run
  // before the state that shows it has rendered, as Strict Mode's second run in development does).
  const focusAfterRender = useRef<FocusTarget | null>(null);
  useEffect(() => {
    const target = focusAfterRender.current;
    const element = target && { email: emailRef, code: codeRef, resend: resendRef, typo: typoRef, password: passwordRef }[target].current;
    if (!element) return;
    focusAfterRender.current = null;
    element.focus();
  });

  /**
   * The address with or without the password step's fragment (history.replaceState: no new entry, the page is not loaded again). Off takes
   * away `#parool` only: any other fragment is not ours.
   */
  const markPasswordStep = (on: boolean) => {
    if (!on && window.location.hash !== `#${PASSWORD_MARK}`) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${on ? `#${PASSWORD_MARK}` : ""}`);
  };

  /** Opens the code step for `address`, the code sent at `sentAt` (null: nothing was sent from this tab, a new code can be asked for at once). */
  function showCodeStep(address: string, sentAt: number | null): void {
    markPasswordStep(false); // the address says what the step is: a code step never has #parool
    setNow(Date.now());
    setResendAt(sentAt === null ? 0 : sentAt + RESEND_AFTER_MS);
    setSentTo(address);
    setEmail(address);
    setStep("code");
    setCode("");
    setCodeError(null);
    setSendError(null);
    setTypo(null);
    setBanner(null);
    focusAfterRender.current = "code";
  }

  /** Asks for a code for `address`: on success the code step (again, for a resend), else the error where it belongs. */
  async function send(address: string, again = false): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    const { status, data } = await sendJson("/api/konto/login", { email: address, locale });
    busy.current = false;
    setSending(false);
    if (status === 200 && data.ok === true) {
      const sentAt = Date.now();
      rememberEmail(address);
      keepPendingCode({ sentTo: address, sentAt });
      showCodeStep(address, sentAt);
      setResent(again);
      setAskedAgain(again);
      return;
    }
    const error: SendError = status === 400 && data.error === "email" ? "email" : status === 429 ? "rate" : "server";
    if (again) {
      setCodeError(error === "rate" ? "rate" : "server");
      focusAfterRender.current = "resend";
    } else {
      setTypo(null);
      setSendError(error);
      focusAfterRender.current = "email";
    }
  }

  /** The six digits: signs in and opens "Minu konto", or says what to do. */
  async function verify(digits: string): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    setCodeError(null);
    setResent(false);
    // the page's language: an account this login creates speaks it (an existing one keeps its own)
    const { status, data } = await sendJson("/api/konto/code", { email: sentTo, code: digits, locale });
    if (status === 200 && data.ok === true) {
      keepPendingCode(null);
      rememberEmail(sentTo); // a code typed for an address the page was opened for was never remembered by a send
      forgetAccountFavourites(); // a previous session's copy of the favourites must not show for this account
      // The field stays as it is while the page opens. replace, not assign: Back from "Minu konto" goes to the page before
      // the login, never to a code that is used up (nor to this form as it was left, from the browser's page cache).
      window.location.replace(locale === "ru" ? "/ru/konto" : "/konto");
      return;
    }
    busy.current = false;
    setChecking(false);
    const error: CodeError =
      status === 400 && data.error === "code" ? "code" : status === 400 && data.error === "expired" ? "expired" : status === 429 ? "rate" : "server";
    setCodeError(error);
    if (error === "code" || error === "expired") setCode(""); // a wrong or dead code is typed again; after a failure of ours "Logi sisse" tries the same one
    if (error === "expired") {
      keepPendingCode(null); // the server says the code is dead: a reload must not bring its step back
      setResendAt(0); // a new code is the only way on: "Saada uus kood" works at once and has the focus
      focusAfterRender.current = "resend";
    } else focusAfterRender.current = "code";
  }

  /** "Logi sisse", Enter or a phone's "Go": the code when it has six digits, else the hint, the focus kept in the field. */
  const submitCode = () => {
    if (busy.current) return;
    if (code.length === 6) {
      void verify(code);
      return;
    }
    setCodeError("short");
    focusAfterRender.current = "code";
  };

  // The page's query, the remembered e-mail and a code step of this tab exist in the browser only: read once after
  // hydration (once per mount: Strict Mode runs the effect twice in development).
  const arrived = useRef(false);
  const arrive = useEffectEvent(() => {
    if (arrived.current) return;
    arrived.current = true;
    const saved = rememberedEmail();
    if (forwardsSignedIn(window.location.href, hasAccountHint(), saved)) {
      // Signed in already (the "Ava minu konto" button of a confirmation e-mail): "Minu konto" in this page's language, in place
      // of this page in the history. A stale hint comes back here once, with the signed-out mark, and the form shows.
      window.location.replace(locale === "ru" ? "/ru/konto" : "/konto");
      return;
    }
    const { problem, again, code: haveCode, email: given, cleaned } = readLoginAddress(window.location.href);
    if (cleaned !== null) window.history.replaceState(window.history.state, "", cleaned);
    const prefill = given || saved;
    if (prefill) setEmail((typed) => typed || prefill);
    if (problem) {
      keepPendingCode(null); // a code step kept in this tab belongs to a send the notice says to replace
      setBanner(problem); // the notice belongs to the e-mail step: a new code is what it asks for
      return;
    }
    if (window.location.hash === `#${PASSWORD_MARK}`) {
      setStep("password"); // "Sisene parooliga" kept for a reload (#parool); the e-mail is the remembered one
      return;
    }
    if (again && saved) {
      void send(saved);
      return;
    }
    if (haveCode) {
      // The code is in the mailbox already (the confirmation e-mail of a registration that asked for an account): the code step for
      // that address at once, nothing sent, and not remembered as a step of this tab. The code may be old: "Saada uus kood" works now.
      showCodeStep(given, null);
      return;
    }
    const pending = pendingCode(Date.now());
    if (pending) showCodeStep(pending.sentTo, pending.sentAt);
  });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the address and the storage are only known in the browser, after hydration
    arrive();
  }, []);

  // "Uue koodi saad saata 45 s pärast.": the seconds count down while the code step waits.
  useEffect(() => {
    if (step !== "code" || resendAt === 0) return;
    const timer = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= resendAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [step, resendAt]);

  const submitEmail = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    const address = normalizeEmail(email);
    setEmail(address);
    if (!isEmail(address)) {
      setTypo(null);
      setSendError("email");
      focusAfterRender.current = "email";
      return;
    }
    const fixed = typoSuggestion(address);
    if (fixed) {
      setSendError(null);
      setTypo(fixed);
      focusAfterRender.current = "typo";
      return;
    }
    void send(address);
  };

  const typeCode = (raw: string) => {
    if (checking) return;
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (codeError) setCodeError(null);
    if (resent) setResent(false);
    if (digits.length === 6) void verify(digits);
  };

  const changeEmail = () => {
    keepPendingCode(null);
    setStep("email");
    setEmail(sentTo);
    setCode("");
    setCodeError(null);
    setResent(false);
    setAskedAgain(false);
    focusAfterRender.current = "email";
  };

  /** "Sisene parooliga": the e-mail and password step (#parool, kept for a reload). Not while a request is out (a code on its way would open its own step). */
  const toPassword = () => {
    if (busy.current) return;
    setStep("password");
    setPassword("");
    setPasswordError(null);
    setSendError(null);
    setTypo(null);
    setBanner(null);
    markPasswordStep(true);
    focusAfterRender.current = email ? "password" : "email";
  };

  /** "Saada mulle hoopis kood": back to the e-mail step (the code), the address without #parool. */
  const toCode = () => {
    setStep("email");
    setPassword("");
    setPasswordError(null);
    markPasswordStep(false);
    focusAfterRender.current = "email";
  };

  /** The e-mail and password: signs in and opens "Minu konto", or says what to do (every wrong answer is the same sentence). */
  async function signInWithPassword(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy.current) return;
    const address = normalizeEmail(email);
    setEmail(address);
    if (!isEmail(address)) {
      setPasswordError("email");
      focusAfterRender.current = "email";
      return;
    }
    if (!password) {
      setPasswordError("wrong");
      focusAfterRender.current = "password";
      return;
    }
    busy.current = true;
    setChecking(true);
    setPasswordError(null);
    const { status, data } = await sendJson("/api/konto/parool-login", { email: address, password, locale });
    if (status === 200 && data.ok === true) {
      keepPendingCode(null); // a code step this tab kept is of no use now: it must not come back after a logout
      rememberEmail(address);
      forgetAccountFavourites(); // a previous session's copy of the favourites must not show for this account
      // replace, as for the code: Back from "Minu konto" never returns to this form
      window.location.replace(locale === "ru" ? "/ru/konto" : "/konto");
      return;
    }
    busy.current = false;
    setChecking(false);
    setPasswordError(status === 400 ? "wrong" : status === 429 ? "locked" : "server");
    if (status === 400) setPassword(""); // a wrong password is typed again; after the lock or a failure of ours the same one can be tried
    focusAfterRender.current = "password";
  }

  const secondsLeft = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const sendErrorText = sendError === "email" ? t.badEmail : sendError === "rate" ? t.rate : sendError === "server" ? t.server : "";
  const codeMessage = codeError
    ? { short: t.allDigits, code: t.wrongCode, expired: t.expired, rate: t.rate, server: t.server }[codeError]
    : resent
      ? t.resent
      : "";
  const passwordMessage = passwordError ? { email: t.badEmail, wrong: t.passwordWrong, locked: t.passwordLocked, server: t.server }[passwordError] : "";
  const messageClass = codeError === "short" ? styles.note : codeError ? styles.error : styles.status;

  return (
    <section className={styles.page} data-login-step={step} data-login-ready={hydrated ? "" : undefined}>
      <div className={styles.box}>
        <h1 className={styles.title}>{t.title}</h1>

        {step === "email" ? (
          <>
            <p className={styles.lead} data-login-intro="">
              {t.intro}
            </p>
            <form method="post" noValidate onSubmit={submitEmail} data-login-email="">
              {banner && (
                <p className={styles.notice} role="status" data-login-banner={banner}>
                  {banner === "link" ? t.linkExpired : t.server}
                </p>
              )}
              <div className={styles.field}>
                <label htmlFor={`${id}-email`}>{t.email}</label>
                <input
                  ref={emailRef}
                  id={`${id}-email`}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={254}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setTypo(null);
                    setSendError(null);
                  }}
                  aria-invalid={sendError === "email" ? true : undefined}
                  aria-describedby={`${id}-email-message`}
                />
                <p id={`${id}-email-message`} className={styles.error} aria-live="polite">
                  {sendErrorText}
                </p>
              </div>
              {typo ? (
                <div className={styles.typo} role="group" aria-labelledby={`${id}-typo`} data-login-typo="">
                  <p id={`${id}-typo`}>{withBold(t.typo, "fixed", typo)}</p>
                  <div className={styles.choices}>
                    <button
                      ref={typoRef}
                      type="button"
                      className={ui.btn}
                      aria-disabled={sending || undefined}
                      onClick={() => {
                        setEmail(typo);
                        void send(typo);
                      }}
                    >
                      {t.typoYes}
                    </button>
                    <button type="button" className={ui.btnOutline} aria-disabled={sending || undefined} onClick={() => void send(normalizeEmail(email))}>
                      {t.typoNo}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="submit" className={`${ui.btn} ${ui.btnFull}`} aria-disabled={sending || undefined}>
                  {t.send}
                  <Icon name="arrow" />
                </button>
              )}
            </form>
            <div className={styles.actions}>
              <button type="button" className={styles.textButton} onClick={toPassword} data-login-to-password="">
                {t.toPassword}
              </button>
            </div>
          </>
        ) : step === "password" ? (
          <>
            <form method="post" noValidate onSubmit={(e) => void signInWithPassword(e)} data-login-password="">
              <div className={styles.field}>
                <label htmlFor={`${id}-pw-email`}>{t.email}</label>
                <input
                  ref={emailRef}
                  id={`${id}-pw-email`}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={254}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setPasswordError(null);
                  }}
                  aria-invalid={passwordError === "email" ? true : undefined}
                  aria-describedby={`${id}-pw-message`}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor={`${id}-password`}>{t.password}</label>
                <input
                  ref={passwordRef}
                  id={`${id}-password`}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={400}
                  value={password}
                  readOnly={checking}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setPasswordError(null);
                  }}
                  aria-invalid={passwordError === "wrong" ? true : undefined}
                  aria-describedby={`${id}-pw-message`}
                  aria-busy={checking || undefined}
                />
                <p id={`${id}-pw-message`} className={styles.error} aria-live="polite" data-login-password-error="">
                  {passwordMessage}
                </p>
              </div>
              <button type="submit" className={`${ui.btn} ${ui.btnFull}`} aria-disabled={checking || undefined}>
                {t.submit}
                <Icon name="arrow" />
              </button>
            </form>
            <div className={styles.actions}>
              <button type="button" className={styles.textButton} onClick={toCode} data-login-to-code="">
                {t.toCode}
              </button>
            </div>
          </>
        ) : (
          <form
            method="post"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submitCode();
            }}
            data-login-code=""
          >
            <p id={`${id}-sent`} className={styles.lead}>
              {withBold(t.sent, "email", sentTo)}
            </p>
            <div className={styles.field}>
              <label htmlFor={`${id}-code`}>{t.code}</label>
              <input
                ref={codeRef}
                id={`${id}-code`}
                className={styles.code}
                name="code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                enterKeyHint="go"
                maxLength={6}
                value={code}
                readOnly={checking}
                onChange={(e) => typeCode(e.target.value)}
                // Enter / "Go": handled here, since the form's own Enter does nothing while "Logi sisse" is disabled
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  submitCode();
                }}
                // a pasted "123 456" is the code too (maxLength would cut it to "123 45")
                onPaste={(e) => {
                  e.preventDefault();
                  typeCode(e.clipboardData.getData("text"));
                }}
                aria-invalid={codeError === "code" || codeError === "expired" ? true : undefined}
                aria-describedby={`${id}-sent ${id}-code-message`}
                aria-busy={checking || undefined}
              />
              <p id={`${id}-code-message`} className={messageClass} aria-live="polite">
                {codeMessage}
              </p>
            </div>
            <button type="submit" className={`${ui.btn} ${ui.btnFull}`} disabled={code.length < 6 || checking}>
              {t.submit}
              <Icon name="arrow" />
            </button>
            <p className={styles.hint}>{t.spam}</p>
            <div className={styles.actions}>
              {secondsLeft > 0 ? (
                <p className={styles.wait} data-login-wait="">
                  {fill(t.resendIn, { s: secondsLeft })}
                </p>
              ) : (
                <button ref={resendRef} type="button" className={styles.textButton} aria-disabled={sending || undefined} onClick={() => void send(sentTo, true)}>
                  {t.resend}
                </button>
              )}
              <button type="button" className={styles.textButton} onClick={changeEmail}>
                {t.changeEmail}
              </button>
            </div>
            {askedAgain && (
              <p className={styles.hint} data-login-no-mail="">
                {t.noMail}
              </p>
            )}
          </form>
        )}
      </div>
    </section>
  );
}
