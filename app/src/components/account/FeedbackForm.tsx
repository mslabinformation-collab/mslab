"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import ui from "@/components/site/ui.module.css";
import { FEEDBACK_CHOICES, FEEDBACK_ORDER, FEEDBACK_TEXT_MAX, feedbackQuestions, isChoice, type FeedbackKey } from "@/domain/protocols";
import { pick, type I18n } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import { toStorable } from "@/lib/to-storable";
import { AccountLoader } from "./AccountLoader";
import { AccountNotFound } from "./AccountNotFound";
import type { FeedbackTexts } from "./texts";
import { useHashId } from "./useHashId";
import page from "./AccountPage.module.css";
import styles from "./FeedbackForm.module.css";

/** GET /api/konto/tagasiside's answer. */
type FormAnswer = { ok: true; course: { slug: string; title: I18n }; sent: boolean };

/**
 * The personal part of /konto/tagasiside#id=<registration> (phase protocols, spec §7; the page is a static shell): the registration from the
 * fragment, its form's state from GET /api/konto/tagasiside?id= (AccountLoader). Not hers or not open: "Sellele koolitusele ei saa praegu
 * tagasisidet anda." with the way back, as an address without an id. The id is not known until the page has mounted (useHashId: undefined):
 * until then an empty, busy block, never the not-open sentence.
 */
export function FeedbackForm({ locale, t }: { locale: Locale; t: FeedbackTexts }) {
  const id = useHashId();
  const notOpen = <AccountNotFound state="feedbackClosed" title={t.notOpen} back={t.back} locale={locale} />;
  if (id === undefined) return <div className={`${ui.wrap} ${page.wait}`} aria-busy="true" />;
  if (id === null) return notOpen;
  return (
    <AccountLoader<FormAnswer>
      key={id}
      path={`/api/konto/tagasiside?id=${id}`}
      locale={locale}
      t={{ ...t.loader, loading: t.loading }}
      notFound={notOpen}
      render={(data) => <FeedbackBody registrationId={id} data={data} locale={locale} t={t} />}
    />
  );
}

type Answers = Partial<Record<FeedbackKey, string | number>>;

/**
 * Maria's paper form "Sinu kogemus MS LAB koolitusel" (spec §7), its ten questions in its order: the score (1–10, a row of number buttons), the
 * seven choices (a row of pills each), the two free texts (at most 2000 characters, the count under each). Nothing is required; "Saada
 * tagasiside" needs one answer. Sent: the closing line. Answered already (on load, or another tab's submit): it says so. The line that takes
 * the form's place takes the focus too when it comes from a send (the button she pressed is gone), and is announced as a status. The free
 * texts go without what Postgres cannot store (toStorable: a pasted document's control characters, as the admin's screen does), which the
 * server's check refuses: a pasted text would else fail every time.
 */
function FeedbackBody({ registrationId, data, locale, t }: { registrationId: number; data: FormAnswer; locale: Locale; t: FeedbackTexts }) {
  const uid = useId();
  const q = feedbackQuestions(t.questions);
  const [answers, setAnswers] = useState<Answers>({});
  const [state, setState] = useState<"form" | "sending" | "done" | "sent" | "closed">(data.sent ? "sent" : "form");
  const [error, setError] = useState<string | null>(null);
  const line = useRef<HTMLParagraphElement>(null);
  const focusLine = useRef(false);
  // an answer given takes the last failure's line away ("Vasta vähemalt ühele küsimusele." must not stay beside an answered form)
  const set = (key: FeedbackKey, value: string | number) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    setError(null);
  };
  const given = Object.fromEntries(
    Object.entries(answers)
      .map(([k, v]) => [k, typeof v === "string" ? toStorable(v) : v] as const)
      .filter(([, v]) => typeof v === "number" || (typeof v === "string" && v.trim() !== "")),
  );

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
    setState("sending");
    setError(null);
    const answer = await sendJson("/api/konto/tagasiside", { registrationId, locale, answers: given });
    const end = isDone(answer) ? "done" : answer.status === 409 ? "sent" : answer.status === 404 ? "closed" : null;
    if (end) {
      focusLine.current = true;
      return setState(end);
    }
    setError(answer.status === 429 ? t.rate : t.failed);
    setState("form");
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
            <div key={key} className={styles.question} data-question={key}>
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
