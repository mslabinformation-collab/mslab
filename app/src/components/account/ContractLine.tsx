"use client";

import { useId, useRef, useState } from "react";
import { Icon } from "@/components/site/Icon";
import ui from "@/components/site/ui.module.css";
import { contractOf, type AccountCard, type CardContract, type ContactCard } from "@/domain/account-cards";
import { paragraphs } from "@/domain/catalogue";
import { fill, formatDate } from "@/i18n/format";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import type { CoursesTexts } from "./texts";
import card from "./AccountCourseCard.module.css";
import styles from "./ContractLine.module.css";

/** A ref that focuses its element once, when it appears (stable, so a later render does not focus it again). */
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/**
 * The contract on a course card (contracts Task 6; spec §4 Account), for a contact or e-course card that has one (domain/account-cards.ts contractOf):
 * - her current contract: a quiet line „Leping · kinnitatud 15.10.2026“ with „Laadi alla (PDF)“ (GET /api/konto/leping/<id>, a download; `readOnly`:
 *   aria-disabled, as the invoice's and the certificate's links);
 * - once Maria has asked her to confirm it (`contractRequested`, a contact registration's), the card instead offers „Kinnita leping“ (AskedContract).
 * An individual registration, a request and a waitlist entry have none (nothing here), nor has a card with neither a contract nor an ask.
 * `title` is the course's name: it names the download for a screen reader, the visible words first.
 * `onChanged` loads the cards again, quietly, and answers whether the server answered (CoursesView's `reloadForCard`); absent: the admin's view.
 */
export function ContractLine({ card: c, title, locale, t, readOnly, onChanged }: { card: AccountCard; title: string; locale: Locale; t: CoursesTexts; readOnly: boolean; onChanged?(): Promise<boolean> }) {
  const state = contractOf(c);
  if (!state) return null;
  if (state.requested && c.kind === "contact") return <AskedContract card={c} locale={locale} t={t} readOnly={readOnly} onChanged={onChanged} />;
  return state.contract ? <ContractDownload contract={state.contract} title={title} locale={locale} t={t} readOnly={readOnly} /> : null;
}

/** „Leping · kinnitatud {date}“ and its PDF: the day is the Estonian day she accepted it. */
function ContractDownload({ contract, title, locale, t, readOnly }: { contract: CardContract; title: string; locale: Locale; t: CoursesTexts; readOnly: boolean }) {
  // (named by its course for a screen reader: a student may have several cards, and the visible words come first)
  const label = `${t.contract.download}: ${title}`;
  return (
    <div className={styles.contract} data-card-contract="line">
      <div className={styles.head}>
        <span className={styles.line} data-contract-line="">
          {fill(t.contract.line, { date: formatDate(new Date(contract.acceptedAt), locale) })}
        </span>
        {readOnly ? (
          <a className={card.second} role="link" aria-disabled="true" aria-label={label} data-card-contract-download="">
            {t.contract.download}
          </a>
        ) : (
          <a className={card.second} href={`/api/konto/leping/${contract.id}`} download aria-label={label} data-card-contract-download="">
            {t.contract.download}
          </a>
        )}
      </div>
    </div>
  );
}

/** What the card holds of the text: not asked for yet, being read, read (the version goes back with „Kinnitan“), or not readable. */
type Text = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; title: string; body: string; version: string; locale: "et" | "ru" } | { kind: "failed" };

/**
 * Reads GET /api/konto/leping-tekst/<registration>?l=<page language>: the current text filled with her registration. `"gone"`: the server says there is
 * none to show any more (a 404: the ask is answered, the registration cancelled or not hers; a 401: signed out or replaced), so the card is out of date.
 */
async function readText(registrationId: number, locale: Locale): Promise<Text | "gone"> {
  try {
    const res = await fetch(`/api/konto/leping-tekst/${registrationId}?l=${locale}`, { credentials: "same-origin", headers: { accept: "application/json" } });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && body?.ok === true && typeof body.title === "string" && typeof body.body === "string" && typeof body.version === "string") {
      return { kind: "ready", title: body.title, body: body.body, version: body.version, locale: body.locale === "ru" ? "ru" : "et" };
    }
    if (res.status === 404 || res.status === 401) return "gone";
  } catch {
    // no answer at all: the sentence
  }
  return { kind: "failed" };
}

/**
 * „Kinnita leping“ after Maria's ask (spec D4): a quiet sentence and a text button that opens the current filled text on the card, as a panel, with
 * „Kinnitan“ (POST /api/konto/leping { registrationId, version, locale } with the version of the text shown here and the page's language).
 * - 200, or 409 `nothing` (a second tap, or the contract was accepted on another device): „Leping on kinnitatud.“ takes the place of the panel and
 *   the focus, and the cards are loaded again (`onChanged`), which turns the block into the contract's line.
 * - 409 `version` (Maria saved a new text after this one was read): the text is read again and shown with the box's words, „Lepingu tekst on
 *   vahepeal muutunud — loe see uuesti ja kinnita.“; the next „Kinnitan“ sends the new version.
 * - 404 or 401 (the registration is cancelled, not hers, or the session ended): the cards are loaded again; a sentence only when that got no answer.
 * - anything else, or no answer: a sentence under the text, which stays, and „Kinnitan“ can be pressed again.
 * One request at a time, also between two quick presses. `readOnly` (the admin's view): the button is there but aria-disabled, and does nothing.
 */
function AskedContract({ card: c, locale, t, readOnly, onChanged }: { card: ContactCard; locale: Locale; t: CoursesTexts; readOnly: boolean; onChanged?(): Promise<boolean> }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<Text>({ kind: "idle" });
  const [problem, setProblem] = useState<"changed" | "rate" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // one request at a time, also between two quick presses (state is read after the render)
  const sending = useRef(false);
  const k = t.contract;

  /** The card is out of date: the cards are loaded again. True when the server answered, so the card now shows what is true. */
  const reload = async (): Promise<boolean> => (onChanged ? onChanged() : false);

  async function toggle() {
    if (readOnly) return;
    if (open) return setOpen(false);
    setOpen(true);
    if (text.kind === "ready" || text.kind === "loading") return;
    setText({ kind: "loading" });
    const read = await readText(c.registrationId, locale);
    if (read !== "gone") return setText(read);
    // nothing to show any more: the cards are loaded again, which turns this block into what is true; if they could not be, the sentence
    const reloaded = await reload();
    setText(reloaded ? { kind: "idle" } : { kind: "failed" });
    if (reloaded) setOpen(false);
  }

  async function submit() {
    if (readOnly || text.kind !== "ready" || sending.current) return;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    const answer = await sendJson("/api/konto/leping", { registrationId: c.registrationId, version: text.version, locale });
    if (isDone(answer) || (answer.status === 409 && answer.data.error === "nothing")) {
      setDone(true);
      void reload();
    } else if (answer.status === 409 && answer.data.error === "version") {
      const read = await readText(c.registrationId, locale);
      if (read === "gone") {
        if (!(await reload())) setProblem("failed");
      } else {
        setText(read);
        if (read.kind === "ready") setProblem("changed");
      }
    } else if (answer.status === 404 || answer.status === 401) {
      if (!(await reload())) setProblem("failed");
    } else {
      setProblem(answer.status === 429 ? "rate" : "failed");
    }
    sending.current = false;
    setBusy(false);
  }

  if (done) {
    return (
      <div className={styles.contract} data-card-contract="done">
        <p ref={focusOnMount} className={card.sent} role="status" tabIndex={-1} data-contract-done="">
          <Icon name="check" size={18} />
          {k.done}
        </p>
      </div>
    );
  }
  const ready = text.kind === "ready" ? text : null;
  return (
    <div className={styles.contract} data-card-contract="asked">
      <p className={styles.asked} data-contract-asked="">
        {k.asked}
      </p>
      <button
        type="button"
        className={card.second}
        aria-expanded={readOnly ? undefined : open}
        aria-controls={readOnly || !open ? undefined : panelId}
        aria-disabled={readOnly || undefined}
        onClick={() => void toggle()}
        data-card-contract-open=""
      >
        {open ? k.hide : k.open}
      </button>
      {open && !readOnly && (
        <div id={panelId} className={styles.panel} role="region" aria-label={ready?.title.trim() || k.region} lang={ready?.locale} tabIndex={0} data-contract-panel="">
          {text.kind === "loading" && <p role="status">{k.loading}</p>}
          {text.kind === "failed" && <p role="alert">{k.loadFailed}</p>}
          {ready && (
            <>
              {ready.title.trim() && <p className={styles.title}>{ready.title}</p>}
              {paragraphs(ready.body).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </>
          )}
        </div>
      )}
      {open && !readOnly && ready && (
        <>
          {problem && (
            <p className={card.payError} role="alert" {...(problem === "changed" ? { "data-contract-notice": "" } : { "data-contract-error": "" })}>
              {problem === "changed" ? k.changed : problem === "rate" ? k.rate : k.failed}
            </p>
          )}
          <button type="button" className={`${ui.btnOutline} ${styles.accept}`} aria-disabled={busy || undefined} onClick={() => void submit()} data-card-contract-accept="">
            {k.accept}
          </button>
        </>
      )}
    </div>
  );
}
