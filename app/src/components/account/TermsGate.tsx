"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/site/Icon";
import { LegalText } from "@/components/site/LegalText";
import ui from "@/components/site/ui.module.css";
import { pick, type I18n } from "@/i18n/field";
import type { Locale } from "@/i18n/locales";
import type { EcourseTexts } from "./texts";
import page from "./EcoursePage.module.css";
import styles from "./TermsGate.module.css";

/** A ref that focuses its element once, when it appears (stable, so a later render does not focus it again). */
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/**
 * The terms notice before an e-course is opened (spec S5/C54): a notice on the page, not a dialog that can be dismissed. The title
 * "Enne alustamist", the terms text (the same renderer as the public legal pages, in their 750 px column), one checkbox and one
 * button, "Alusta koolitust", directly under it, which is off until the box is ticked.
 *
 * The acceptance is POST /api/konto/tingimused `{ slug, version, locale }` with the version of the text shown here and the page's language
 * (the language of the contract it freezes and of the mail that brings it: contracts, D1, D6):
 * - ok → `onAccepted()` (the course view takes over);
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
  version,
  text,
  locale,
  t,
  onAccepted,
  onRefresh,
  focusTitle = false,
}: {
  slug: string;
  version: string;
  text: I18n | null;
  locale: Locale;
  t: EcourseTexts;
  onAccepted(): void;
  /** Loads the page again; true when the server answered (the page now shows what it said), false when it could not be reached. */
  onRefresh(): Promise<boolean>;
  focusTitle?: boolean;
}) {
  const titleId = useId();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // one request at a time, also between two quick presses (state is read after the render)
  const sending = useRef(false);

  const accept = async (e: FormEvent) => {
    e.preventDefault();
    if (!checked || sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailed(false);
    let status = 0; // 0: no answer
    let ok = false;
    let fromApi = false; // the answer is the API's own ({ ok: false, … }), not a page of the platform or a proxy
    try {
      const res = await fetch("/api/konto/tingimused", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ slug, version, locale }),
      });
      status = res.status;
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      ok = res.ok && body?.ok === true;
      fromApi = typeof body === "object" && body !== null && !Array.isArray(body) && body.ok === false;
    } catch {
      // no answer at all: the sentence below
    }
    const outdated = !ok && fromApi && (status === 409 || status === 401 || status === 404);
    const answered = outdated ? await onRefresh() : true;
    sending.current = false;
    setBusy(false);
    if (ok) return onAccepted();
    if (!outdated || !answered) setFailed(true);
  };

  const body = pick(text, locale);
  return (
    <section className={`${ui.wrap} ${page.page}`} aria-labelledby={titleId} data-terms-gate="" data-terms-version={version}>
      <h1 id={titleId} ref={focusTitle ? focusOnMount : undefined} className={page.title} tabIndex={-1}>
        {t.termsTitle}
      </h1>
      <div className={styles.column}>
        {body && (
          <div className={styles.notice} data-terms-text="">
            <LegalText text={body} />
          </div>
        )}
        <form className={styles.accept} onSubmit={accept} noValidate>
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
