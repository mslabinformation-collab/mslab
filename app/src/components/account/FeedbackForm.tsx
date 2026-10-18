"use client";

import Link from "next/link";
import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/site/Icon";
import ui from "@/components/site/ui.module.css";
import { FEEDBACK_CHOICES, FEEDBACK_ORDER, FEEDBACK_TEXT_MAX, feedbackQuestions, isChoice, type FeedbackKey } from "@/domain/protocols";
import { REVIEW_NAME_MAX } from "@/domain/review";
import { pick, type I18n } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import { toStorable } from "@/lib/to-storable";
import { AccountLoader } from "./AccountLoader";
import { AccountNotFound } from "./AccountNotFound";
import type { FeedbackTexts } from "./texts";
import { useHashTarget, type HashTarget } from "./useHashId";
import page from "./AccountPage.module.css";
import styles from "./FeedbackForm.module.css";

/** GET /api/konto/tagasiside's answer: the course, whether she has answered, and the name the tick offers ("" when her account has none). */
type FormAnswer = { ok: true; course: { slug: string; title: I18n }; sent: boolean; shownName: string };

/**
 * The personal part of /konto/tagasiside#id=<registration> or #kursus=<e-course slug> (phase protocols, spec §7; student reviews, D3; the page is a
 * static shell): the course from the fragment, its form's state from GET /api/konto/tagasiside?id= or ?kursus= (AccountLoader). Not hers or not open:
 * "Sellele koolitusele ei saa praegu tagasisidet anda." with the way back, as an address without a usable one. The address is not known until the
 * page has mounted (useHashTarget: undefined): until then an empty, busy block, never the not-open sentence.
 */
export function FeedbackForm({ locale, t }: { locale: Locale; t: FeedbackTexts }) {
  const target = useHashTarget();
  const notOpen = <AccountNotFound state="feedbackClosed" title={t.notOpen} back={t.back} locale={locale} />;
  if (target === undefined) return <div className={`${ui.wrap} ${page.wait}`} aria-busy="true" />;
  if (target === null) return notOpen;
  const query = "id" in target ? `id=${target.id}` : `kursus=${target.kursus}`;
  return (
    <AccountLoader<FormAnswer>
      key={query}
      path={`/api/konto/tagasiside?${query}`}
      locale={locale}
      t={{ ...t.loader, loading: t.loading }}
      notFound={notOpen}
      render={(data) => <FeedbackBody target={target} data={data} locale={locale} t={t} />}
    />
  );
}

type Answers = Partial<Record<FeedbackKey, string | number>>;

/** Has the text something to publish: as it is sent (toStorable), more than white space. */
const hasText = (value: string): boolean => toStorable(value).trim() !== "";

/** The name as it is sent: what Postgres can store, white space collapsed to single spaces, trimmed (the server collapses it the same way). */
const cleanName = (raw: string): string => toStorable(raw).replace(/\s+/g, " ").trim();

/**
 * Maria's paper form "Sinu kogemus MS LAB koolitusel" (spec §7), its ten questions in its order: the score (1–10, a row of number buttons), the
 * seven choices (a row of pills each), the two free texts (at most 2000 characters, the count under each). Nothing is required; "Saada
 * tagasiside" needs one answer. Sent: the closing line. Answered already (on load, or another tab's submit): it says so. The line that takes
 * the form's place takes the focus too when it comes from a send (the button she pressed is gone), and is announced as a status. The free
 * texts go without what Postgres cannot store (toStorable: a pasted document's control characters, as the admin's screen does), which the
 * server's check refuses: a pasted text would else fail every time.
 *
 * Her permission to publish (student reviews, D1): directly under the recommend question a tick, off and disabled while that answer has no text.
 * Ticked, it shows the name to show (prefilled with the offered one, 40 characters at most, with a counter), and the send carries `consent: { name }`;
 * unticked, it carries null and the typed name stays for the next tick. An answer emptied takes the tick back. A tick without a name stops before any
 * request; the server's refusals (consentName, consentText) show under the tick, the answers kept.
 */
function FeedbackBody({ target, data, locale, t }: { target: HashTarget; data: FormAnswer; locale: Locale; t: FeedbackTexts }) {
  const uid = useId();
  const q = feedbackQuestions(t.questions);
  const [answers, setAnswers] = useState<Answers>({});
  const [ticked, setTicked] = useState(false);
  const [shownName, setShownName] = useState(data.shownName);
  const [state, setState] = useState<"form" | "sending" | "done" | "sent" | "closed">(data.sent ? "sent" : "form");
  const [error, setError] = useState<string | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const line = useRef<HTMLParagraphElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const focusLine = useRef(false);
  const nameError = fill(t.consent.nameError, { max: REVIEW_NAME_MAX });
  // an answer given takes the last failure's line away ("Vasta vähemalt ühele küsimusele." must not stay beside an answered form)
  const set = (key: FeedbackKey, value: string | number) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    setError(null);
    if (key !== "recommend") return;
    setConsentError(null);
    // the permission is for an answer: with none left the tick is taken back, and typing again does not give it anew
    if (typeof value === "string" && !hasText(value)) setTicked(false);
  };
  const given = Object.fromEntries(
    Object.entries(answers)
      .map(([k, v]) => [k, typeof v === "string" ? toStorable(v) : v] as const)
      .filter(([, v]) => typeof v === "number" || (typeof v === "string" && v.trim() !== "")),
  );
  const canTick = typeof given.recommend === "string";
  const consentOn = ticked && canTick;

  useEffect(() => {
    if (focusLine.current && (state === "done" || state === "sent" || state === "closed")) {
      focusLine.current = false;
      line.current?.focus();
    }
  }, [state]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state === "sending") return;
    if (Object.keys(given).length === 0) {
      setError(t.empty);
      return;
    }
    const name = cleanName(shownName);
    if (consentOn && name === "") {
      setConsentError(nameError);
      nameInput.current?.focus();
      return;
    }
    setState("sending");
    setError(null);
    setConsentError(null);
    const body = "id" in target ? { id: target.id } : { kursus: target.kursus };
    const answer = await sendJson("/api/konto/tagasiside", { ...body, locale, answers: given, consent: consentOn ? { name } : null });
    const end = isDone(answer) ? "done" : answer.status === 409 ? "sent" : answer.status === 404 ? "closed" : null;
    if (end) {
      focusLine.current = true;
      return setState(end);
    }
    setState("form");
    if (answer.status === 400 && (answer.data.error === "consentName" || answer.data.error === "consentText")) {
      setConsentError(answer.data.error === "consentName" ? nameError : t.consent.needsAnswer);
      if (answer.data.error === "consentName") nameInput.current?.focus();
      return;
    }
    setError(answer.status === 429 ? t.rate : t.failed);
  }

  if (state === "done" || state === "sent" || state === "closed")
    return (
      <div className={`${ui.wrap} ${page.page}`} data-feedback-done={state}>
        <div className={page.column}>
          <h1 className={page.title}>{t.title}</h1>
          <p ref={line} className={styles.thanks} role="status" tabIndex={-1}>
            {state === "done" ? t.thanks : state === "sent" ? t.sent : t.notOpen}
          </p>
          <Link className={ui.btnOutline} href={href(locale, "/konto")}>
            {t.back}
          </Link>
        </div>
      </div>
    );

  /** The tick and, ticked, the name it shows: directly under the recommend question. */
  const consentBlock = (
    <div className={styles.consent} data-consent="">
      <label className={styles.tick}>
        <input
          type="checkbox"
          checked={consentOn}
          disabled={!canTick}
          onChange={(e) => {
            setTicked(e.target.checked);
            setConsentError(null);
          }}
          aria-describedby={consentError ? `${uid}-consent-error` : undefined}
          data-consent-tick=""
        />
        <span className={styles.box} aria-hidden="true">
          <Icon name="check" size={14} />
        </span>
        <span>{t.consent.tick}</span>
      </label>
      {consentOn && (
        <div className={styles.shownName} data-consent-name-field="">
          <label htmlFor={`${uid}-shown-name`} className={styles.nameLabel}>
            {t.consent.name}
          </label>
          <input
            ref={nameInput}
            id={`${uid}-shown-name`}
            type="text"
            className={styles.nameInput}
            maxLength={REVIEW_NAME_MAX}
            autoComplete="off"
            value={shownName}
            onChange={(e) => {
              setShownName(e.target.value);
              setConsentError(null);
            }}
            aria-invalid={consentError ? true : undefined}
            aria-describedby={`${uid}-shown-name-count`}
            data-consent-name=""
          />
          <p id={`${uid}-shown-name-count`} className={styles.count}>
            {fill(t.count, { n: shownName.length, max: REVIEW_NAME_MAX })}
          </p>
        </div>
      )}
      {consentError && (
        <p id={`${uid}-consent-error`} className={styles.error} role="alert" data-consent-error="">
          {consentError}
        </p>
      )}
    </div>
  );

  return (
    <form className={`${ui.wrap} ${page.page}`} onSubmit={submit} noValidate data-feedback-form="">
      <div className={page.column}>
        <h1 className={page.title}>{t.title}</h1>
        <p className={styles.course}>{pick(data.course.title, locale)}</p>
        <p className={styles.lead}>{t.lead}</p>
        {FEEDBACK_ORDER.map((key) => {
          if (key === "score")
            return (
              <fieldset key={key} className={styles.question} data-question={key}>
                <legend className={styles.label}>{q.score.label}</legend>
                <div className={styles.scores}>
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                    <label key={n} className={styles.score}>
                      <input type="radio" name={`${uid}-score`} value={n} checked={answers.score === n} onChange={() => set("score", n)} />
                      <span>{n}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          if (isChoice(key))
            return (
              <fieldset key={key} className={styles.question} data-question={key}>
                <legend className={styles.label}>{q[key].label}</legend>
                <div className={styles.options}>
                  {FEEDBACK_CHOICES[key].map((option) => (
                    <label key={option} className={styles.option}>
                      <input type="radio" name={`${uid}-${key}`} value={option} checked={answers[key] === option} onChange={() => set(key, option)} />
                      <span>{q[key].options?.[option]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          const value = typeof answers[key] === "string" ? (answers[key] as string) : "";
          return (
            <Fragment key={key}>
              <div className={styles.question} data-question={key}>
                <label htmlFor={`${uid}-${key}`} className={styles.label}>
                  {q[key].label}
                </label>
                <textarea
                  id={`${uid}-${key}`}
                  className={styles.text}
                  rows={4}
                  maxLength={FEEDBACK_TEXT_MAX}
                  value={value}
                  onChange={(e) => set(key, e.target.value)}
                  aria-describedby={`${uid}-${key}-count`}
                />
                <p id={`${uid}-${key}-count`} className={styles.count}>
                  {fill(t.count, { n: value.length, max: FEEDBACK_TEXT_MAX })}
                </p>
              </div>
              {key === "recommend" && consentBlock}
            </Fragment>
          );
        })}
        {error && (
          <p className={styles.error} role="alert" data-feedback-error="">
            {error}
          </p>
        )}
        <button type="submit" className={ui.btn} aria-disabled={state === "sending" || undefined} data-feedback-submit="">
          {state === "sending" ? t.sending : t.submit}
        </button>
      </div>
    </form>
  );
}
