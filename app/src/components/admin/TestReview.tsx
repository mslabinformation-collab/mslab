"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import type { AttemptStatus, OpenReview, TestAnswers, TestQuestion, Verdict } from "@/db/schema";
import { grade, TEST_LIMITS } from "@/domain/completion";
import type { AdminDict } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { reviewAttemptAction } from "@/server/actions/admin-assessment";
import ui from "./ui.module.css";
import styles from "./TestReview.module.css";

// Maria's review of one test attempt (e-course completion, spec §5.4): every question of the attempt's own copy in order, numbered as the
// student saw them. The choice part is read-only: each option she picked is marked right (✓) or wrong (✗) against the key, and a correct one she
// left out is named. Each open answer takes "Kinnitatud" or "Paranda" and a comment (required for "Paranda"); "Saada" sends them all
// (reviewAttemptAction). A plain form: what Maria marks and writes is kept in this browser (localStorage `mslab-review:<attemptId>`) until it is
// sent, so a reload or a closed tab loses nothing. An attempt not waiting for her ("fix", "passed", "failed") shows her last review, read-only.

export type ReviewTexts = AdminDict["assessment"]["review"];
/**
 * What the review shows of an attempt (db/queries/assessment.ts ReviewAttempt): its copy of the questions, with the key. `submittedAt` (ISO) goes
 * back with the review: answers the student rewrote after this page was read make the server answer `stale` (server/test-attempts.ts).
 */
export type ReviewedAttempt = { id: number; status: AttemptStatus; questions: TestQuestion[]; answers: TestAnswers; review: OpenReview | null; submittedAt: string };

type Mark = { verdict: Verdict | null; comment: string };
type Marks = Record<string, Mark>;
type Problem = "verdict" | "comment" | "tooLong";

const draftKey = (attemptId: number) => `mslab-review:${attemptId}`;

/** Where the form starts: an answer Maria accepted before (a rewrite brings the attempt back) stays accepted; every other one is unmarked. */
function startMarks(a: ReviewedAttempt): Marks {
  const marks: Marks = {};
  for (const q of a.questions) {
    if (q.kind !== "open") continue;
    const last = a.review?.[q.id];
    marks[q.id] = last?.verdict === "ok" ? { verdict: "ok", comment: last.comment } : { verdict: null, comment: "" };
  }
  return marks;
}

/** The draft this browser kept, read defensively (the storage may hold anything, or be blocked): this attempt's open answers only. */
function readDraft(a: ReviewedAttempt): Marks | null {
  try {
    const raw = localStorage.getItem(draftKey(a.id));
    if (!raw) return null;
    const kept = (JSON.parse(raw) as { marks?: Record<string, { verdict?: unknown; comment?: unknown } | undefined> }).marks ?? {};
    const marks = startMarks(a);
    for (const id of Object.keys(marks)) {
      const m = kept[id];
      if (m) marks[id] = { verdict: m.verdict === "ok" || m.verdict === "fix" ? m.verdict : null, comment: typeof m.comment === "string" ? m.comment : "" };
    }
    return marks;
  } catch {
    return null; // blocked storage, or not JSON: the form starts afresh
  }
}

function writeDraft(attemptId: number, marks: Marks): void {
  try {
    localStorage.setItem(draftKey(attemptId), JSON.stringify({ marks, at: Date.now() }));
  } catch {
    // the storage is full or blocked: the form still works, its text is just not kept
  }
}

function dropDraft(attemptId: number): void {
  try {
    localStorage.removeItem(draftKey(attemptId));
  } catch {
    // blocked storage kept nothing
  }
}

/** What stops the send, per open answer: no verdict; "Paranda" without a comment; a comment over its limit (nothing is cut silently). */
function problemsOf(questions: readonly TestQuestion[], marks: Marks): Record<string, Problem> {
  const out: Record<string, Problem> = {};
  for (const q of questions) {
    if (q.kind !== "open") continue;
    const m = marks[q.id];
    if (!m?.verdict) out[q.id] = "verdict";
    else if (m.verdict === "fix" && !m.comment.trim()) out[q.id] = "comment";
    else if (m.comment.length > TEST_LIMITS.comment) out[q.id] = "tooLong";
  }
  return out;
}

export function TestReview({ attempt, t }: { attempt: ReviewedAttempt; t: ReviewTexts }) {
  const uid = useId();
  const editable = attempt.status === "review";
  const [marks, setMarks] = useState<Marks>(() => startMarks(attempt));
  const [problems, setProblems] = useState<Record<string, Problem>>({});
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const [pending, start] = useTransition();
  const errorLine = useRef<HTMLParagraphElement>(null);
  const sentLine = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!editable) return;
    const kept = readDraft(attempt);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the draft this browser kept is only known after hydration
    if (kept) setMarks(kept);
  }, [attempt, editable]);

  useEffect(() => {
    if (error) errorLine.current?.focus();
  }, [error]);

  // and again when the page's refresh swaps the form for the read-only review: the line is a new element there
  useEffect(() => {
    if (sent) sentLine.current?.focus();
  }, [sent, editable]);

  const change = (id: string, part: Partial<Mark>) => {
    const next = { ...marks, [id]: { ...marks[id], ...part } };
    setMarks(next);
    writeDraft(attempt.id, next);
    if (problems[id]) setProblems(Object.fromEntries(Object.entries(problems).filter(([key]) => key !== id)));
    setError("");
  };

  const send = () => {
    if (pending) return;
    const found = problemsOf(attempt.questions, marks);
    if (Object.keys(found).length > 0) {
      setProblems(found);
      setError(t.errors.incomplete);
      return;
    }
    setError("");
    const review: OpenReview = Object.fromEntries(Object.entries(marks).map(([id, m]) => [id, { verdict: m.verdict as Verdict, comment: m.comment }]));
    start(async () => {
      const result = await reviewAttemptAction({ attemptId: attempt.id, review, submittedAt: attempt.submittedAt });
      if (result.kind === "reviewed") {
        dropDraft(attempt.id);
        setSent(result.completed ? t.sent.completed : result.status === "passed" ? t.sent.passed : t.sent.fix);
      } else {
        setError(result.kind === "invalid" ? t.errors[result.error] : t.errors[result.kind]);
      }
    });
  };

  // after a send the form shows what was sent (the page's refresh then shows what the server holds, read-only, with the sent line kept)
  const locked = !editable || sent !== "";
  // the wrong choice questions' 1-based positions, by domain/completion.ts grade's own rule (the picked set equals the correct set)
  const wrong = grade(attempt.questions, attempt.answers).wrong;
  const list = (
    <ol className={styles.questions}>
      {attempt.questions.map((q, i) => {
        const raw = attempt.answers[q.id];
        if (q.kind === "choice") {
          const picks = Array.isArray(raw) ? raw : [];
          const right = !wrong.includes(i + 1);
          return (
            <li key={q.id} className={styles.question} data-review-question={q.id} data-review-right={right}>
              <div className={styles.head}>
                <p className={styles.text}>
                  <span className={styles.num}>{i + 1}.</span>
                  {q.text}
                </p>
                <span className={`${ui.tag} ${right ? ui.ok : ui.bad}`}>{right ? t.right : t.wrong}</span>
              </div>
              <ul className={styles.options}>
                {q.options.map((o) => {
                  const picked = picks.includes(o.id);
                  return (
                    <li key={o.id} className={styles.option} data-review-option={o.id} data-picked={picked || undefined} data-correct={o.correct || undefined}>
                      <span className={`${styles.mark} ${picked ? (o.correct ? styles.good : styles.bad) : ""}`} aria-hidden="true">
                        {picked ? (o.correct ? "✓" : "✗") : "·"}
                      </span>
                      <span>{o.text}</span>
                      {(picked || o.correct) && <span className={styles.note}>{picked ? (o.correct ? t.pickedRight : t.pickedWrong) : t.missed}</span>}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        }
        const answer = typeof raw === "string" ? raw : "";
        const last = attempt.review?.[q.id];
        const mark = marks[q.id] ?? { verdict: null, comment: "" };
        const shown = editable ? mark : (last ?? null);
        const problem = problems[q.id];
        const box = `${uid}-${q.id}`;
        return (
          <li key={q.id} className={styles.question} data-review-answer={q.id}>
            <p className={styles.text}>
              <span className={styles.num}>{i + 1}.</span>
              {q.text}
            </p>
            <p className={styles.answer}>{answer || t.noAnswer}</p>
            {!locked ? (
              <>
                <div className={styles.verdicts} role="group" aria-label={fill(t.verdictLabel, { n: i + 1 })}>
                  {(["ok", "fix"] as const).map((v) => (
                    <button key={v} type="button" className={styles.verdict} aria-pressed={mark.verdict === v} onClick={() => change(q.id, { verdict: v })} data-review-verdict={v}>
                      {v === "ok" ? t.ok : t.fix}
                    </button>
                  ))}
                </div>
                <div className={ui.field}>
                  <label htmlFor={box}>{t.comment}</label>
                  <textarea
                    id={box}
                    className={ui.textarea}
                    value={mark.comment}
                    onChange={(e) => change(q.id, { comment: e.target.value })}
                    aria-invalid={problem === "comment" || problem === "tooLong" ? true : undefined}
                    aria-describedby={`${box}-hint`}
                    data-review-comment=""
                  />
                  <p id={`${box}-hint`} className={ui.hint}>
                    {last?.verdict === "fix" ? fill(t.previous, { text: last.comment }) : t.commentHint}
                  </p>
                </div>
                {problem && (
                  <p className={ui.error} data-review-problem={problem}>
                    {problem === "tooLong" ? fill(t.problems.tooLong, { n: mark.comment.length, max: TEST_LIMITS.comment }) : t.problems[problem]}
                  </p>
                )}
              </>
            ) : shown?.verdict ? (
              <div className={styles.shown}>
                <span className={`${ui.tag} ${shown.verdict === "ok" ? ui.ok : ui.warn}`} data-review-shown={shown.verdict}>
                  {shown.verdict === "ok" ? t.ok : t.fix}
                </span>
                {shown.comment && <p className={styles.comment}>{shown.comment}</p>}
              </div>
            ) : (
              <p className={ui.muted}>{t.notReviewed}</p>
            )}
          </li>
        );
      })}
    </ol>
  );

  if (!editable)
    return (
      <div className={styles.review} data-review-readonly={attempt.id}>
        {list}
        {/* the refresh after Maria's send lands here (this component's state survives it): her confirmation stays */}
        {sent && (
          <p ref={sentLine} tabIndex={-1} role="status" className={`${ui.success} ${styles.line}`} data-review-sent="">
            {sent}
          </p>
        )}
      </div>
    );
  return (
    <form
      className={styles.review}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      data-review-form={attempt.id}
    >
      {list}
      <div className={styles.send}>
        {!sent && (
          <button type="submit" className={ui.btn} aria-disabled={pending || undefined} data-review-send="">
            {pending ? t.sending : t.send}
          </button>
        )}
        <p ref={errorLine} tabIndex={-1} role="alert" className={`${ui.error} ${styles.line}`} data-review-error="">
          {error}
        </p>
        <p ref={sentLine} tabIndex={-1} role="status" className={`${ui.success} ${styles.line}`} data-review-sent="">
          {sent}
        </p>
      </div>
    </form>
  );
}
