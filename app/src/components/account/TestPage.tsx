"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "@/components/site/Icon";
import { Notice } from "@/components/site/Notice";
import ui from "@/components/site/ui.module.css";
import type { TestAnswers } from "@/db/schema";
import { TEST_LIMITS, type PublicQuestion } from "@/domain/completion";
import { pick } from "@/i18n/field";
import { fill } from "@/i18n/format";
import { href } from "@/i18n/href";
import type { Locale } from "@/i18n/locales";
import { isDone, sendJson } from "@/lib/json-request";
import type { AttemptView, TestView } from "@/server/test-attempts";
import { AccountLoader, type Reload } from "./AccountLoader";
import { GreetingSkeleton } from "./CardSkeleton";
import type { TestTexts } from "./texts";
import page from "./AccountPage.module.css";
import styles from "./TestPage.module.css";

// The student's knowledge test (e-course completion, spec §4.2). This file runs on the students' phones: no lookbehind here nor in what it
// imports (tests/unit/old-safari.test.ts).

/** GET /api/konto/kursus/<slug>/test's answer, and an accepted submit's: the test as it stands for her. */
type TestAnswer = TestView & { ok: true };

/** Why a submit did not go through: the line under the questions. */
type Problem = "incomplete" | "tooLong" | "changed" | "rate" | "failed";

/** Her unsent answers in this browser, per course (spec §4.2): `{ answers, at }`, kept until an attempt is accepted, so a reload loses nothing. */
export const draftKey = (slug: string): string => `mslab-test:${slug}`;

/** The draft's answers; anything else in the store (another shape, a store that is off) is no draft. Never throws. */
function readDraft(slug: string): TestAnswers {
  try {
    const raw = window.localStorage.getItem(draftKey(slug));
    const answers: unknown = raw ? (JSON.parse(raw) as { answers?: unknown } | null)?.answers : null;
    if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return {};
    const out: TestAnswers = {};
    for (const [id, a] of Object.entries(answers)) {
      if (typeof a === "string") out[id] = a;
      else if (Array.isArray(a) && a.every((x) => typeof x === "string")) out[id] = a as string[];
    }
    return out;
  } catch {
    return {};
  }
}

function writeDraft(slug: string, answers: TestAnswers): void {
  try {
    window.localStorage.setItem(draftKey(slug), JSON.stringify({ answers, at: new Date().toISOString() }));
  } catch {
    // a private window or a full store: the page still works, only a reload would lose the answers
  }
}

function clearDraft(slug: string): void {
  try {
    window.localStorage.removeItem(draftKey(slug));
  } catch {
    // as above
  }
}

/**
 * The answers of `from` that fit `questions`, in their order: a choice keeps the options still there (one for a single-answer question), an
 * open question its text; answers to questions that are gone are left out. What a changed test (Maria's edit) keeps of a draft, and what a
 * submit sends.
 */
function fitting(questions: readonly PublicQuestion[], from: TestAnswers): TestAnswers {
  const out: TestAnswers = {};
  for (const q of questions) {
    const a = from[q.id];
    if (q.kind === "open") {
      if (typeof a === "string") out[q.id] = a;
    } else if (Array.isArray(a)) {
      const known = q.options.filter((o) => a.includes(o.id)).map((o) => o.id);
      const kept = q.multiple ? known : known.slice(0, 1);
      if (kept.length > 0) out[q.id] = kept;
    }
  }
  return out;
}

const answered = (q: PublicQuestion, a: string[] | string | undefined): boolean => (q.kind === "open" ? typeof a === "string" && a.trim() !== "" : Array.isArray(a) && a.length > 0);

/** What the questions and the state are: a new answer that changes them starts the page's body afresh (its form reads the draft again). */
const shapeOf = (v: TestView): string =>
  [v.state.kind, v.last?.id ?? 0, ...v.questions.map((q) => (q.kind === "choice" ? `${q.id}:${q.options.map((o) => o.id).join(".")}` : q.id))].join(",");

/**
 * The personal part of /konto/kursus/<slug>/test (the page is a static shell, the same for every visitor): loads GET
 * /api/konto/kursus/<slug>/test in the browser (AccountLoader: skeleton, signed out → the login page, another device, error + retry). No
 * test for her (no access, a revoked one, a course without questions): "Seda testi ei leitud." with the way back to the course.
 */
export function TestPage({ slug, locale, t }: { slug: string; locale: Locale; t: TestTexts }) {
  const course = href(locale, `/konto/kursus/${slug}`);
  return (
    <AccountLoader<TestAnswer>
      path={`/api/konto/kursus/${encodeURIComponent(slug)}/test`}
      locale={locale}
      t={{ ...t.loader, loading: t.loading }}
      skeleton={
        <div className={`${ui.wrap} ${page.wait}`}>
          <GreetingSkeleton />
        </div>
      }
      notFound={
        <div data-account-state="noTest">
          <Notice title={t.notFound}>
            <Link className={ui.btn} href={course}>
              {t.back}
              <Icon name="arrow" />
            </Link>
          </Notice>
        </div>
      }
      render={(data, reload) => <TestBody key={shapeOf(data)} data={data} slug={slug} locale={locale} t={t} reload={reload} />}
    />
  );
}

/**
 * The test as it stands, one plain sentence and at most one primary button per state (phase 2a spec 2.1 rule 5): locked (the lessons not
 * done) → the way back; none → the questions; open (the last try failed) → her score, then "Proovi uuesti" → the questions again; used →
 * Maria's promise; review → "Ootab Maria hinnangut" with her answers; fix → the answers to rewrite; passed → the practical work (a course
 * with points) or the course; readOnly (the access has ended) → her results only. An accepted submit's answer replaces the view, and the
 * focus goes to its outcome (the button she pressed is gone).
 */
function TestBody({ data, slug, locale, t, reload }: { data: TestAnswer; slug: string; locale: Locale; t: TestTexts; reload: Reload }) {
  const [view, setView] = useState<TestAnswer>(data);
  const [retrying, setRetrying] = useState(false);
  const status = useRef<HTMLParagraphElement>(null);
  const moved = useRef(false);
  const api = `/api/konto/kursus/${encodeURIComponent(slug)}/test`;
  const courseHref = href(locale, `/konto/kursus/${slug}`);
  const { last } = view;
  // an ended access first: she can no longer finish the lessons, so "opens when the lessons are done" would be wrong
  const kind = view.readOnly ? "readOnly" : view.locked ? "locked" : view.state.kind;

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    status.current?.focus();
  }, [view]);

  const accepted = (next: TestAnswer) => {
    moved.current = true;
    setRetrying(false);
    setView(next);
  };

  /** The outcome's line: what her newest attempt came to (focused after a submit). */
  const outcome = (text: string, wrong?: number[]) => (
    <p ref={status} className={styles.status} tabIndex={-1} data-test-result="" data-test-wrong={wrong?.join(",")}>
      {text}
    </p>
  );
  const failedLine = (a: AttemptView) => outcome(fill(t.result, { percent: a.percent, pass: view.passPercent, list: a.wrong.join(", ") }), a.wrong);
  const lastLine = (a: AttemptView) => (a.status === "failed" ? failedLine(a) : outcome(a.status === "review" ? t.review : a.status === "fix" ? t.fix : t.passed));
  const back = (main: boolean) =>
    main ? (
      <Link className={ui.btn} href={courseHref} data-test-back="">
        {t.back}
        <Icon name="arrow" />
      </Link>
    ) : (
      <Link className={ui.btnOutline} href={courseHref} data-test-back="">
        {t.back}
      </Link>
    );
  const form = <AttemptForm view={view} slug={slug} api={api} t={t} reload={reload} onAccepted={accepted} />;

  let body: ReactNode = null;
  switch (kind) {
    case "locked":
      body = (
        <>
          <p className={styles.lead}>{t.locked}</p>
          {back(true)}
        </>
      );
      break;
    case "readOnly":
      body = (
        <>
          <p className={styles.lead}>{t.readOnly}</p>
          {last && lastLine(last)}
          {last && (last.status === "review" || last.status === "fix") && <AnswerList attempt={last} t={t} />}
          {back(true)}
        </>
      );
      break;
    case "none":
      body = form;
      break;
    case "open":
      body =
        retrying || !last ? (
          form
        ) : (
          <>
            {failedLine(last)}
            <button type="button" className={ui.btn} onClick={() => setRetrying(true)} data-test-retry="">
              {view.triesLeft === 1 ? t.retryOne : fill(t.retry, { n: view.triesLeft })}
            </button>
            {back(false)}
          </>
        );
      break;
    case "used":
      body = (
        <>
          {last && failedLine(last)}
          <p className={styles.lead}>{t.used}</p>
          {back(false)}
        </>
      );
      break;
    case "review":
      body = (
        <>
          {outcome(t.review)}
          <p className={styles.lead}>{t.reviewLead}</p>
          {last && <AnswerList attempt={last} t={t} />}
          {back(false)}
        </>
      );
      break;
    case "fix":
      body = last ? (
        <>
          {outcome(t.fix)}
          <FixForm attempt={last} slug={slug} api={api} t={t} reload={reload} onAccepted={accepted} />
        </>
      ) : (
        back(true)
      );
      break;
    case "passed":
      body = (
        <>
          {outcome(t.passed)}
          {view.hasPoints ? (
            <Link className={ui.btn} href={href(locale, `/konto/kursus/${slug}/praktiline`)} data-test-next="">
              {t.practical}
              <Icon name="arrow" />
            </Link>
          ) : (
            back(true)
          )}
        </>
      );
      break;
  }

  return (
    <div className={`${ui.wrap} ${page.page}`} data-test-page="" data-test-state={kind}>
      <div className={page.column}>
        <p className={styles.eyebrow}>{t.title}</p>
        <h1 className={page.title}>{pick(view.course.title, locale)}</h1>
        {body}
      </div>
    </div>
  );
}

/**
 * One submit at a time (a second tap while one is on its way sends nothing). Accepted: the draft goes and the page shows the outcome. A
 * session that ended (401) reloads quietly (the login page, or "another device"); gone (404) or no longer open (409 closed: a second device,
 * Maria) reloads the page, which then shows what is true now. Anything else stays on the form with its line, her answers kept.
 */
function useSubmit(slug: string, reload: Reload, onAccepted: (next: TestAnswer) => void) {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const busy = useRef(false);
  const send = async (path: string, body: object): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setProblem(null);
    const answer = await sendJson(path, body);
    busy.current = false;
    setSending(false);
    const error = answer.data.error;
    if (isDone(answer)) {
      clearDraft(slug);
      onAccepted(answer.data as unknown as TestAnswer);
    } else if (answer.status === 401) void reload({ quiet: true });
    else if (answer.status === 404 || (answer.status === 409 && error === "closed")) void reload();
    else if (answer.status === 409 && error === "changed") setProblem("changed");
    else if (answer.status === 400 && (error === "incomplete" || error === "tooLong")) setProblem(error);
    else setProblem(answer.status === 429 ? "rate" : "failed");
  };
  return { sending, problem, setProblem, send };
}

/** The line under the questions. A changed test's: "laadi leht uuesti" with the reload as the one button (a submit would be refused again). */
function ProblemLine({ problem, t, reload }: { problem: Problem; t: TestTexts; reload: Reload }) {
  const text =
    problem === "changed" ? t.changed : problem === "incomplete" ? t.incomplete : problem === "tooLong" ? fill(t.tooLong, { max: TEST_LIMITS.answer }) : problem === "rate" ? t.rate : t.failed;
  return (
    <div className={styles.problem} role="alert" data-test-error={problem}>
      <p className={styles.problemText}>{text}</p>
      {problem === "changed" && (
        <button type="button" className={ui.btn} onClick={() => void reload()}>
          {t.reload}
        </button>
      )}
    </div>
  );
}

/**
 * A new attempt: the course's current questions, the try's number ("Katse 2/3"), the pass mark when there are choice questions. Every answer
 * goes into the draft as she gives it. "Esita test" checks that every question is answered, then asks once more, inline (a phone's own
 * dialog is neither the site's look nor testable); only "Jah, esita" sends, and sends only the answers that fit the questions.
 */
function AttemptForm({ view, slug, api, t, reload, onAccepted }: { view: TestAnswer; slug: string; api: string; t: TestTexts; reload: Reload; onAccepted: (next: TestAnswer) => void }) {
  const uid = useId();
  const { questions } = view;
  const made = view.last?.number ?? 0;
  const n = made + 1;
  const max = made + view.triesLeft;
  const [answers, setAnswers] = useState<TestAnswers>(() => fitting(questions, readDraft(slug)));
  const [confirming, setConfirming] = useState(false);
  const { sending, problem, setProblem, send } = useSubmit(slug, reload, onAccepted);
  const form = useRef<HTMLFormElement>(null);
  const yes = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) yes.current?.focus();
  }, [confirming]);

  const change = (id: string, value: string[] | string) => {
    const next = { ...answers, [id]: value };
    setAnswers(next);
    writeDraft(slug, next);
    if (problem === "incomplete") setProblem(null);
  };
  const ask = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const missing = questions.find((q) => !answered(q, answers[q.id]));
    if (missing) {
      setConfirming(false);
      setProblem("incomplete");
      form.current?.querySelector<HTMLElement>(`[data-question="${missing.id}"] input, [data-question="${missing.id}"] textarea`)?.focus();
      return;
    }
    setProblem(null);
    setConfirming(true);
  };
  const confirm = async () => {
    await send(api, { answers: fitting(questions, answers) });
    setConfirming(false);
  };
  const hasChoice = questions.some((q) => q.kind === "choice");

  return (
    <form ref={form} className={styles.form} onSubmit={ask} noValidate>
      <p className={styles.lead}>{t.lead}</p>
      <p className={styles.meta}>
        {fill(t.attempt, { n, max })}
        {hasChoice && ` · ${fill(t.need, { pass: view.passPercent })}`}
      </p>
      <div className={styles.questions}>
        {questions.map((q, i) => (
          <QuestionField key={q.id} q={q} number={i + 1} value={answers[q.id]} onChange={(v) => change(q.id, v)} uid={uid} t={t} />
        ))}
      </div>
      {problem && <ProblemLine problem={problem} t={t} reload={reload} />}
      {problem === "changed" ? null : confirming ? (
        <div className={styles.confirm} data-test-confirm="">
          <p className={styles.confirmText}>{fill(t.confirm, { n, max })}</p>
          <div className={styles.actions}>
            <button ref={yes} type="button" className={ui.btn} onClick={() => void confirm()} aria-disabled={sending || undefined} data-confirm="yes">
              {sending ? t.sending : t.confirmYes}
            </button>
            <button type="button" className={ui.btnOutline} onClick={() => setConfirming(false)} data-confirm="no">
              {t.confirmNo}
            </button>
          </div>
        </div>
      ) : (
        <button type="submit" className={ui.btn} data-test-submit="">
          {t.submit}
        </button>
      )}
    </form>
  );
}

/**
 * Maria's "Paranda" (spec §4.2): the attempt's own questions; the answers she marked open for rewriting with her comment under each, the
 * rest read-only. "Saada uuesti" sends the whole attempt back (the accepted answers as they were) and uses no try, so it asks nothing first.
 */
function FixForm({ attempt, slug, api, t, reload, onAccepted }: { attempt: AttemptView; slug: string; api: string; t: TestTexts; reload: Reload; onAccepted: (next: TestAnswer) => void }) {
  const uid = useId();
  const review = attempt.review ?? {};
  const toFix = attempt.questions.filter((q) => review[q.id]?.verdict === "fix").map((q) => q.id);
  const [answers, setAnswers] = useState<TestAnswers>(() => {
    const draft = readDraft(slug);
    const out: TestAnswers = { ...attempt.answers };
    for (const id of toFix) {
      const text = draft[id];
      if (typeof text === "string") out[id] = text;
    }
    return out;
  });
  const { sending, problem, setProblem, send } = useSubmit(slug, reload, onAccepted);

  const change = (id: string, value: string[] | string) => {
    const next = { ...answers, [id]: value };
    setAnswers(next);
    writeDraft(slug, next);
    if (problem === "incomplete") setProblem(null);
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const blank = toFix.find((id) => {
      const a = answers[id];
      return typeof a !== "string" || a.trim() === "";
    });
    if (blank) {
      setProblem("incomplete");
      return;
    }
    void send(`${api}/uuesti`, { attemptId: attempt.id, answers });
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <p className={styles.lead}>{t.fixLead}</p>
      <div className={styles.questions}>
        {attempt.questions.map((q, i) => {
          const open = toFix.includes(q.id);
          return (
            <QuestionField
              key={q.id}
              q={q}
              number={i + 1}
              value={answers[q.id]}
              onChange={open ? (v) => change(q.id, v) : undefined}
              uid={uid}
              t={t}
              locked={!open}
              comment={open ? review[q.id]?.comment : undefined}
            />
          );
        })}
      </div>
      {problem && <ProblemLine problem={problem} t={t} reload={reload} />}
      {problem !== "changed" && (
        <button type="submit" className={ui.btn} aria-disabled={sending || undefined} data-test-submit="">
          {sending ? t.sending : t.resubmit}
        </button>
      )}
    </form>
  );
}

/** Her answers as she sent them, read-only (waiting for Maria, or after the access ended), with Maria's comment where she asked for a fix. */
function AnswerList({ attempt, t }: { attempt: AttemptView; t: TestTexts }) {
  const uid = useId();
  const review = attempt.review ?? {};
  return (
    <section className={styles.answers} aria-labelledby={`${uid}-answers`}>
      <h2 id={`${uid}-answers`} className={styles.answersTitle}>
        {t.answers}
      </h2>
      {attempt.questions.map((q, i) => (
        <QuestionField key={q.id} q={q} number={i + 1} value={attempt.answers[q.id]} uid={uid} t={t} locked comment={review[q.id]?.verdict === "fix" ? review[q.id]?.comment : undefined} />
      ))}
    </section>
  );
}

/**
 * One question, numbered, Maria's text as she wrote it: a choice question is a fieldset of rows, each its radio (one right option) or
 * checkbox ("Vali kõik õiged") with the option's text, the whole row the 44 px target; an open question is a text box with its count.
 * `locked`: shown, not changed (a disabled fieldset, a read-only box). `comment`: Maria's, under the answer.
 */
function QuestionField({
  q,
  number,
  value,
  onChange,
  uid,
  t,
  locked = false,
  comment,
}: {
  q: PublicQuestion;
  number: number;
  value: string[] | string | undefined;
  onChange?: (value: string[] | string) => void;
  uid: string;
  t: TestTexts;
  locked?: boolean;
  comment?: string;
}) {
  const name = `${uid}-${q.id}`;
  if (q.kind === "choice") {
    const picked = Array.isArray(value) ? value : [];
    const toggle = (id: string, on: boolean) => {
      if (!q.multiple) return onChange?.([id]);
      const set = new Set(picked);
      if (on) set.add(id);
      else set.delete(id);
      onChange?.(q.options.filter((o) => set.has(o.id)).map((o) => o.id));
    };
    return (
      <fieldset className={styles.question} data-question={q.id} disabled={locked}>
        <legend className={styles.label}>
          {number}. {q.text}
        </legend>
        {q.multiple && <p className={styles.hint}>{t.multiple}</p>}
        <div className={styles.options}>
          {q.options.map((o) => (
            <label key={o.id} className={styles.option}>
              <input type={q.multiple ? "checkbox" : "radio"} name={name} value={o.id} checked={picked.includes(o.id)} onChange={(e) => toggle(o.id, e.target.checked)} data-answer-option={o.id} />
              <span>{o.text}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  const text = typeof value === "string" ? value : "";
  return (
    <div className={styles.question} data-question={q.id}>
      <label htmlFor={name} className={styles.label}>
        {number}. {q.text}
      </label>
      <textarea
        id={name}
        className={styles.text}
        rows={4}
        maxLength={TEST_LIMITS.answer}
        value={text}
        readOnly={locked}
        onChange={(e) => onChange?.(e.target.value)}
        aria-describedby={locked ? undefined : `${name}-count`}
        data-answer-open=""
      />
      {!locked && (
        <p id={`${name}-count`} className={styles.count}>
          {fill(t.count, { n: text.length, max: TEST_LIMITS.answer })}
        </p>
      )}
      {comment && (
        <p className={styles.comment} data-test-review-comment={q.id}>
          <span className={styles.commentLabel}>{t.comment}</span>
          {comment}
        </p>
      )}
    </div>
  );
}
