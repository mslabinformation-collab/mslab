"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./login.module.css";

/** localStorage key of the address a link was last sent to from this browser (R-h): filled in on the next visit. */
export const ADMIN_EMAIL_KEY = "mslab-admin-email";

export type LoginTexts = {
  emailLabel: string;
  submit: string;
  sending: string;
  sentTitle: string;
  /** „Saatsime lingi aadressile {email}. …“: {email} is the address as typed, in bold */
  sent: string;
  sentHint: string;
  /** „Muu aadress“: beside the remembered address, and under the sent state */
  other: string;
  errorEmail: string;
  /** the per-IP limit (429 `rate`) */
  errorTooMany: string;
  /** the 4th request for the address (429 `address`, B20) */
  errorAddress: string;
  errorGeneric: string;
};

type State = { status: "idle" } | { status: "sent"; email: string } | { status: "error"; field: "email" | "form"; message: string };

/** The remembered address, or "" (nothing kept, or storage blocked: the field starts empty). */
function rememberedAddress(): string {
  try {
    return localStorage.getItem(ADMIN_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberAddress(email: string): void {
  try {
    localStorage.setItem(ADMIN_EMAIL_KEY, email);
  } catch {
    // private mode or blocked storage: the field simply starts empty next time
  }
}

/**
 * The way back sent with the request (B19): the page's ?tagasi= with the address bar's #fragment (a fragment never reaches the server, and a
 * redirect without one keeps it), unless the way back has its own already (SaveStatus's link). None for the panel's front page, where a sign-in
 * lands anyway. The server checks it (lib/admin-return.ts).
 */
function wayBack(tagasi: string | undefined): string | undefined {
  const back = (tagasi ?? "/admin") + (tagasi?.includes("#") ? "" : window.location.hash);
  return back === "/admin" ? undefined : back;
}

/** Why a 429 was answered: the address's own limit (B20) or the per-IP one (also for an answer that cannot be read). */
async function refusal(res: Response): Promise<"address" | "rate"> {
  try {
    return ((await res.json()) as { error?: unknown }).error === "address" ? "address" : "rate";
  } catch {
    return "rate";
  }
}

/**
 * E-mail field and "Saada sisselogimislink" (C8, README §4; texts S4-47). The answer is the same for every address (the server never tells which
 * are allowed), so the sent state is the same for any address: „Link on teel“ and the address it went to. The address of the last sent answer
 * is kept in this browser and filled in next time, with „Muu aadress“ to empty the field (R-h). As in the public forms: submitted by hand, the
 * e-mail stays in the field after an error, the first invalid field gets focus, the button is aria-disabled while sending (a disabled one would
 * drop keyboard focus), and the sent state lives in a polite status region that takes focus (the form it replaces had it).
 */
export function LoginForm({ t, notice, tagasi }: { t: LoginTexts; notice?: string; tagasi?: string }) {
  const id = useId();
  const [email, setEmail] = useState("");
  // the remembered address while the field still holds exactly it ("" otherwise): „Muu aadress“ beside it empties the field. Edited, the field no
  // longer holds the remembered address and the button goes; typing the address back does not bring it back (final review N-2)
  const [remembered, setRemembered] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const [pending, setPending] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // read after hydration (the server's page is the same for everybody); an address typed before that is hers and stays
  useEffect(() => {
    const kept = rememberedAddress();
    if (!kept || emailRef.current?.value) return;
    setEmail(kept);
    setRemembered(kept);
  }, []);

  useEffect(() => {
    if (state.status === "sent") statusRef.current?.focus();
    else if (state.status === "error") (state.field === "email" ? emailRef.current : errorRef.current)?.focus();
  }, [state]);

  /** „Muu aadress“: an empty field with the cursor in it (from the sent state, back to the form first). */
  function otherAddress() {
    setEmail("");
    setRemembered("");
    setState({ status: "idle" });
    requestAnimationFrame(() => emailRef.current?.focus());
  }

  async function submit() {
    setPending(true);
    try {
      const back = wayBack(tagasi);
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(back ? { email, tagasi: back } : { email }),
      });
      if (res.ok) {
        const sentTo = email.trim();
        rememberAddress(sentTo);
        setState({ status: "sent", email: sentTo });
      } else if (res.status === 400) setState({ status: "error", field: "email", message: t.errorEmail });
      else if (res.status === 429) setState({ status: "error", field: "form", message: (await refusal(res)) === "address" ? t.errorAddress : t.errorTooMany });
      else setState({ status: "error", field: "form", message: t.errorGeneric });
    } catch {
      setState({ status: "error", field: "form", message: t.errorGeneric });
    } finally {
      setPending(false);
    }
  }

  const error = state.status === "error" ? state : null;
  const [sentBefore, sentAfter] = t.sent.split("{email}");

  return (
    <>
      {notice && state.status !== "sent" && (
        <p className={styles.notice} role="alert">
          {notice}
        </p>
      )}
      <div ref={statusRef} className={styles.status} role="status" tabIndex={-1} data-login-status="">
        {state.status === "sent" && (
          <>
            <h2 className={styles.sentTitle}>{t.sentTitle}</h2>
            <p className={styles.sent} data-login-sent="">
              {sentBefore}
              <b>{state.email}</b>
              {sentAfter}
            </p>
            <p className={styles.hint}>{t.sentHint}</p>
            <button type="button" className={styles.sentOther} onClick={otherAddress}>
              {t.other}
            </button>
          </>
        )}
      </div>
      {/* Kept mounted (hidden once sent), so the field and its id stay for „Muu aadress“. */}
      <form
        method="post"
        noValidate
        hidden={state.status === "sent"}
        data-login-form=""
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          void submit();
        }}
      >
        <label className={styles.label} htmlFor={`${id}-email`}>
          {t.emailLabel}
        </label>
        <div className={styles.field} data-remembered={remembered !== "" || undefined}>
          <input
            ref={emailRef}
            id={`${id}-email`}
            className={styles.input}
            name="email"
            type="email"
            required
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={200}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (e.target.value !== remembered) setRemembered("");
            }}
            {...(error?.field === "email" ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {})}
          />
          {remembered !== "" && (
            <button type="button" className={styles.other} onClick={otherAddress}>
              {t.other}
            </button>
          )}
        </div>
        {/* aria-disabled, not disabled: a disabled button would drop keyboard focus to the page while sending. */}
        <button className={styles.submit} type="submit" aria-disabled={pending || undefined}>
          {pending ? t.sending : t.submit}
        </button>
        {error && (
          <p ref={errorRef} id={`${id}-error`} className={styles.error} role="alert" tabIndex={error.field === "form" ? -1 : undefined}>
            {error.message}
          </p>
        )}
      </form>
    </>
  );
}
