"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/site/Icon";
import { LegalText } from "@/components/site/LegalText";
import ui from "@/components/site/ui.module.css";
import { fillContract, oneLine } from "@/domain/contract";
import type { Locale } from "@/i18n/locales";
import type { GateTerms, GateText } from "@/server/client-data";
import type { EcourseTexts } from "./texts";
import page from "./EcoursePage.module.css";
import styles from "./TermsGate.module.css";

/** A ref that focuses its element once, when it appears (stable, so a later render does not focus it again). */
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/** The longest name the server takes (server/account-input.ts LIMITS.name, Minu andmed's): the field stops there. */
const NAME_MAX = 120;

/**
 * The terms notice before an e-course is opened (spec S5/C54): a notice on the page, not a dialog that can be dismissed. The title
 * "Enne alustamist", the contract she accepts (its title and its text, filled as the server freezes them: rulings R18, R19; the text in the same
 * renderer as the public legal pages, in their 750 px column), one checkbox and one button, "Alusta koolitust", directly under it, which is off
 * until the box is ticked.
 *
 * An account with no name (`terms.askName`, ruling R19) gets one required field „Nimi“ above the box: {nimi} in the text above is filled as she
 * types (domain/contract.ts fillContract, the one-pass fill the server runs again with the name she sends), so what she reads is still what is
 * frozen. Without a name the press says so under the field and sends nothing; the server refuses a missing one too (400 `{ error: "name" }`).
 *
 * The acceptance is POST /api/konto/tingimused `{ slug, version, locale, name? }` with the version of the text shown here and the page's language
 * (the language of the contract it freezes and of the mail that brings it: contracts, D1, D6), and the name only when the field is shown:
 * - ok → `onAccepted()` (the course view takes over);
 * - 400 `{ error: "name" }`: the field's error, the box stays ticked (with no field shown, her account lost its name since the page was
 *   loaded: `onRefresh()`, as below, and the fresh notice has the field);
 * - 409 (the admin saved new terms since this page was loaded; nothing was stored), 401 (signed out or replaced) or 404 (the
 *   access ended): `onRefresh()` loads the page again, quietly. The fresh notice shows the new text with an empty box (the page
 *   keys this by the version, so a new text brings a new notice), or the page says what is true now: no message of its own. The box
 *   is cleared by that new notice and by nothing else: if the page could not be loaded again (`onRefresh` answers false), the same
 *   plain sentence as for any failure is shown, with the box ticked;
 * - anything else, or no answer: that sentence, the box stays ticked, and the button can be pressed again.
 * `focusTitle`: the notice was put up again after a refresh, so the title takes the focus (a screen reader learns that the text changed).
 */
export function TermsGate({
  slug,
  terms,
  locale,
  t,
  onAccepted,
  onRefresh,
  focusTitle = false,
}: {
  slug: string;
  terms: GateTerms;
  locale: Locale;
  t: EcourseTexts;
  onAccepted(): void;
  /** Loads the page again; true when the server answered (the page now shows what it said), false when it could not be reached. */
  onRefresh(): Promise<boolean>;
  focusTitle?: boolean;
}) {
  const titleId = useId();
  const nameId = useId();
  const [checked, setChecked] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // one request at a time, also between two quick presses (state is read after the render)
  const sending = useRef(false);
  const nameField = useRef<HTMLInputElement>(null);
  const asked = terms.askName?.[locale] ?? null;

  const accept = async (e: FormEvent) => {
    e.preventDefault();
    if (!checked || sending.current) return;
    if (asked && !oneLine(name)) {
      setNameError(true);
      nameField.current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setFailed(false);
    setNameError(false);
    let status = 0; // 0: no answer
    let ok = false;
    let fromApi = false; // the answer is the API's own ({ ok: false, … }), not a page of the platform or a proxy
    let error: unknown;
    try {
      const res = await fetch("/api/konto/tingimused", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ slug, version: terms.version, locale, ...(asked ? { name } : {}) }),
      });
      status = res.status;
      const body = (await res.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
      ok = res.ok && body?.ok === true;
      fromApi = typeof body === "object" && body !== null && !Array.isArray(body) && body.ok === false;
      error = fromApi ? body?.error : undefined;
    } catch {
      // no answer at all: the sentence below
    }
    // no name: the field says so; an account that had a name when this page was loaded and has none now: the page loaded again brings the field
    const nameRefused = !ok && fromApi && status === 400 && error === "name";
    if (nameRefused && asked) {
      sending.current = false;
      setBusy(false);
      setNameError(true);
      nameField.current?.focus();
      return;
    }
    const outdated = !ok && fromApi && (status === 409 || status === 401 || status === 404 || nameRefused);
    const answered = outdated ? await onRefresh() : true;
    sending.current = false;
    setBusy(false);
    if (ok) return onAccepted();
    if (!outdated || !answered) setFailed(true);
  };

  // what she reads is what is frozen: the server's filled text, or with no name on the account, {nimi} filled from the field as she types
  const shown: GateText = asked
    ? (() => {
        const values = { ...asked.values, nimi: oneLine(name) };
        return { title: fillContract(asked.template.title, values), body: fillContract(asked.template.body, values) };
      })()
    : terms.text[locale];
  const title = shown.title.trim();
  const body = shown.body.trim() ? shown.body : "";
  return (
    <section className={`${ui.wrap} ${page.page}`} aria-labelledby={titleId} data-terms-gate="" data-terms-version={terms.version}>
      <h1 id={titleId} ref={focusTitle ? focusOnMount : undefined} className={page.title} tabIndex={-1}>
        {t.termsTitle}
      </h1>
      <div className={styles.column}>
        {(title || body) && (
          <div className={styles.notice} data-terms-text="">
            {title && (
              <h2 className={styles.contractTitle} data-terms-contract-title="">
                {title}
              </h2>
            )}
            {body && <LegalText text={body} />}
          </div>
        )}
        <form className={styles.accept} onSubmit={accept} noValidate>
          {asked && (
            <div className={styles.field}>
              <label htmlFor={nameId}>{t.termsName}</label>
              <input
                ref={nameField}
                id={nameId}
                name="name"
                type="text"
                autoComplete="name"
                required
                aria-required="true"
                maxLength={NAME_MAX}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (nameError && oneLine(e.target.value)) setNameError(false);
                }}
                aria-invalid={nameError || undefined}
                aria-describedby={`${nameId}-error`}
                data-terms-name=""
              />
              <p id={`${nameId}-error`} className={styles.error} role="alert" data-terms-name-error="">
                {nameError ? t.termsNameRequired : ""}
              </p>
            </div>
          )}
          <label className={styles.check}>
            <input type="checkbox" name="terms" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{t.termsAccept}</span>
          </label>
          <button type="submit" className={`${ui.btn} ${styles.start}`} disabled={!checked} aria-disabled={busy || undefined}>
            {t.start}
            <Icon name="arrow" />
          </button>
        </form>
        <p className={styles.failed} role="alert" data-terms-failed="">
          {failed ? t.termsFailed : ""}
        </p>
      </div>
    </section>
  );
}
