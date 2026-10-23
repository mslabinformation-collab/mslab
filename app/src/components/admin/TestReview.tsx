"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode, type RefObject } from "react";
import type { AttemptStatus, OpenReview, TestAnswers, TestQuestion, Verdict } from "@/db/schema";
import { grade, TEST_LIMITS } from "@/domain/completion";
import { markCounts, NO_MARK, startMarks, type Mark, type Marks } from "@/domain/test-review-marks";
import { adminEt, type AdminDict } from "@/i18n/dict/admin";
import { fill } from "@/i18n/format";
import { toStorable } from "@/lib/to-storable";
import { reviewAttemptAction } from "@/server/actions/admin-assessment";
import { patchSender } from "./autosave/engine";
import { useAutosave } from "./autosave/useAutosave";
import { SaveStatus } from "./SaveStatus";
import ui from "./ui.module.css";
import styles from "./TestReview.module.css";

// Maria's review of one test attempt (e-course completion, spec §5.4; admin UX pass A4, B15): every question of the attempt's own copy in order,
// numbered as the student saw them. The choice part is read-only: each option she picked is marked right (✓) or wrong (✗) against the key, and a
// correct one she left out is named. Each open answer takes "Kinnitatud" or "Paranda" (a pressed one tapped again is cleared) and a comment
// (required for "Paranda"); "Saada · {õ} õige, {v} vale" sends them all (reviewAttemptAction).
// What Maria marks and writes is saved to the server as she works (the editors' autosave, autosave/useAutosave.ts → POST
// /api/admin/testi-hinnang/<attempt>, server/test-review-marks.ts), so a reload, the phone or another browser has the marks: a tap at once, a
// comment when she leaves its box. The marks are a draft of the review, apart from `review` (what the student is shown); the send deletes the
// draft. The engine keeps its own copy in this browser until the server has the marks, for the answers they were typed on (their `submittedAt` is
// in its key, and the server ignores a draft of other answers): after the student rewrote the answers, an earlier mark is never put onto answers
// Maria has not seen. The SaveStatus chip is at the right end of the heading row (`head` is the page's heading text), and the conflict's
// „Taasta minu tekst“ saves this screen's marks over another device's. An attempt not waiting for her ("fix", "passed", "failed") shows her last
// review, read-only, with no saving.

export type ReviewTexts = AdminDict["assessment"]["review"];
/**
 * What the review shows of an attempt (db/queries/assessment.ts ReviewAttempt): its copy of the questions, with the key. `submittedAt` (ISO) goes
 * back with the review: answers the student rewrote after this page was read make the server answer `stale` (server/test-attempts.ts).
 */
export type ReviewedAttempt = { id: number; status: AttemptStatus; questions: TestQuestion[]; answers: TestAnswers; review: OpenReview | null; submittedAt: string };
/** The marks as the server holds them (server/test-review-marks.ts readMarks): their version for the autosave and every open answer's mark. */
export type MarksDraft = { version: string; value: Marks };

type Problem = "verdict" | "comment" | "tooLong";

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

/** The marks whose comment is over its limit: the autosave holds them back (the others still save), and the screen says so at their box. */
function tooLongMarks(marks: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, m] of Object.entries(marks)) {
    const comment = (m as Mark | undefined)?.comment;
    if (typeof comment === "string" && comment.length > TEST_LIMITS.comment) out[id] = "tooLong";
  }
  return out;
}

/** What the questions' list needs to be a form: the marks, what is wrong with them, and what a tap or a typed word does. */
type Edit = {
  marks: Marks;
  problems: Record<string, Problem>;
  /** Sent: the marks are shown as they were sent, read-only. */
  locked: boolean;
  onVerdict: (id: string, verdict: Verdict) => void;
  onComment: (id: string, text: string) => void;
  onLeaveBox: () => void;
};

export function TestReview({ attempt, t, draft, head }: { attempt: ReviewedAttempt; t: ReviewTexts; draft?: MarksDraft; head?: ReactNode }) {
  const editable = attempt.status === "review";
  const [sent, setSent] = useState("");
  const sentLine = useRef<HTMLParagraphElement>(null);

  // and again when the page's refresh swaps the form for the read-only review: the line is a new element there
  useEffect(() => {
    if (sent) sentLine.current?.focus();
  }, [sent, editable]);

  if (!editable)
    return (
      <>
        <Heading head={head} />
        <div className={styles.review} data-review-readonly={attempt.id}>
          <Questions attempt={attempt} t={t} edit={null} />
          {/* the refresh after Maria's send lands here (this component's state survives it): her confirmation stays */}
          {sent && (
            <p ref={sentLine} tabIndex={-1} role="status" className={`${ui.success} ${styles.line}`} data-review-sent="">
              {sent}
            </p>
          )}
        </div>
      </>
    );
  // (keyed by the answers it is for: the autosave reads its options once, so answers rewritten meanwhile start a form of their own)
  return <ReviewForm key={`${attempt.id}-${attempt.submittedAt}`} attempt={attempt} t={t} draft={draft} head={head} sent={sent} onSent={setSent} sentLine={sentLine} />;
}

/** The page's heading row: its text at the left (the page hands it over), the save status at the right (below the text on a phone: ui.headAside). */
function Heading({ head, chip }: { head?: ReactNode; chip?: ReactNode }) {
  return (
    <div className={ui.heading} data-review-head="">
      {head}
      {chip && <div className={ui.headAside}>{chip}</div>}
    </div>
  );
}

/** The review while it waits for Maria: the autosave of the marks (one field for each open answer: its id → `{ verdict, comment }`) and the send. */
function ReviewForm({
  attempt,
  t,
  draft,
  head,
  sent,
  onSent,
  sentLine,
}: {
  attempt: ReviewedAttempt;
  t: ReviewTexts;
  draft?: MarksDraft;
  head?: ReactNode;
  sent: string;
  onSent: (line: string) => void;
  sentLine: RefObject<HTMLParagraphElement | null>;
}) {
  const [problems, setProblems] = useState<Record<string, Problem>>({});
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const errorLine = useRef<HTMLParagraphElement>(null);
  const [sender] = useState(() => patchSender(`/api/admin/testi-hinnang/${attempt.id}`));
  const first = draft ?? { version: "0", value: startMarks(attempt.questions, attempt.review) };

  // the guard's notice and the status name an answer by its number, as the verdict buttons' group does (piece2-texts P-12 has no label for these)
  const numbers = useMemo(() => new Map(attempt.questions.map((q, i) => [q.id, i + 1])), [attempt.questions]);
  const label = useCallback((id: string) => fill(t.verdictLabel, { n: numbers.get(id) ?? 0 }), [numbers, t.verdictLabel]);
  const auto = useAutosave({
    owner: "testi-hinnang",
    // the browser's copy is for these answers only: the time they were sent is in its key
    key: `${attempt.id}-${Date.parse(attempt.submittedAt)}`,
    version: first.version,
    fields: first.value,
    save: sender,
    validate: tooLongMarks,
    label,
  });
  const marks = auto.fields as Marks;

  useEffect(() => {
    if (error) errorLine.current?.focus();
  }, [error]);

  // the marks used to be kept in this browser alone (`mslab-review:<attempt>`); the server has them now, so an old copy is not read and not left behind
  useEffect(() => {
    try {
      localStorage.removeItem(`mslab-review:${attempt.id}`);
    } catch {
      // blocked storage kept nothing
    }
  }, [attempt.id]);

  const settle = (id: string) => {
    if (problems[id]) setProblems(Object.fromEntries(Object.entries(problems).filter(([key]) => key !== id)));
    setError("");
  };
  const markOf = (id: string): Mark => marks[id] ?? NO_MARK;
  /** A pressed verdict tapped again is cleared (as on the practical work's cards); a tap is saved at once. */
  const onVerdict = (id: string, verdict: Verdict) => {
    const m = markOf(id);
    auto.setField(id, { verdict: m.verdict === verdict ? null : verdict, comment: m.comment });
    void auto.flush();
    settle(id);
  };
  /** What Postgres cannot store (a lone surrogate, a control character from a paste) is taken out as it comes in: the server refuses it, and the save would be held back. */
  const onComment = (id: string, text: string) => {
    auto.setField(id, { verdict: markOf(id).verdict, comment: toStorable(text) });
    settle(id);
  };

  const send = () => {
    if (pending) return;
    // marks changed on another device meanwhile: this screen's marks are not the latest, and a wrong „Kinnitatud“ is mailed to the student. Held, as the
    // protocol's and the practical work's sends are, until „Taasta minu tekst“ (an explicit overwrite). With no marks stored there (`value` null: reviewed
    // elsewhere) the server's `stale` is the better answer.
    if (auto.conflict && auto.conflict.value !== null) {
      setError(adminEt.autosave.conflict);
      return;
    }
    const found = problemsOf(attempt.questions, marks);
    if (Object.keys(found).length > 0) {
      setProblems(found);
      setError(t.errors.incomplete);
      return;
    }
    setError("");
    const review: OpenReview = Object.fromEntries(Object.entries(marks).map(([id, m]) => [id, { verdict: m.verdict as Verdict, comment: m.comment }]));
    start(async () => {
      // what she typed last is saved first: no save of the marks is on its way when the review is stored (the server then deletes the draft)
      await auto.flush();
      const result = await reviewAttemptAction({ attemptId: attempt.id, review, submittedAt: attempt.submittedAt });
      if (result.kind === "reviewed") {
        onSent(result.completed ? t.sent.completed : result.status === "passed" ? t.sent.passed : t.sent.fix);
      } else {
        setError(result.kind === "invalid" ? t.errors[result.error] : t.errors[result.kind]);
      }
    });
  };

  // the chip's „Näita“: the first comment over its limit
  const showInvalid = () => {
    const id = Object.keys(tooLongMarks(marks))[0];
    if (id) document.querySelector<HTMLTextAreaElement>(`[data-review-answer="${id}"] [data-review-comment]`)?.focus();
  };

  // after a send the form shows what was sent (the page's refresh then shows what the server holds, read-only, with the sent line kept)
  const edit: Edit = { marks, problems, locked: sent !== "", onVerdict, onComment, onLeaveBox: () => void auto.flush() };
  const { ok, fix } = markCounts(marks);
  // the summary is on the button: „, 0 vale“ is left out when nothing is to fix (õ = 0 stays)
  const sendLabel = fix === 0 ? fill(t.sendOk, { ok }) : fill(t.send, { ok, fix });
  return (
    <>
      <Heading head={head} chip={<SaveStatus status={auto.status} thing={t.goneThing} onShowInvalid={showInvalid} />} />
      <form
        className={styles.review}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        data-review-form={attempt.id}
      >
        {/* marks changed on another device meanwhile (README §1.3, B13); with no marks stored there (reviewed elsewhere) there is nothing to restore over */}
        {auto.conflict && auto.conflict.value !== null && (
          <div>
            <button type="button" className={`${ui.btn} ${ui.secondary} ${ui.smallBtn}`} onClick={() => {
                // (the sentence that held the send goes with the conflict)
                if (error === adminEt.autosave.conflict) setError("");
                void auto.restore();
              }}
              data-review-restore=""
            >
              {t.restore}
            </button>
          </div>
        )}
        <Questions attempt={attempt} t={t} edit={edit} />
        <div className={styles.send}>
          {!sent && (
            <button type="submit" className={ui.btn} aria-disabled={pending || undefined} data-review-send="">
              {pending ? t.sending : sendLabel}
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
    </>
  );
}

/** The questions in order: the choice part read-only; each open answer with its verdict buttons and comment box (`edit`), or as Maria's review shows it. */
function Questions({ attempt, t, edit }: { attempt: ReviewedAttempt; t: ReviewTexts; edit: Edit | null }) {
  const uid = useId();
  // the wrong choice questions' 1-based positions, by domain/completion.ts grade's own rule (the picked set equals the correct set)
  const wrong = grade(attempt.questions, attempt.answers).wrong;
  return (
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
        const mark = edit ? (edit.marks[q.id] ?? NO_MARK) : null;
        const shown = edit ? mark : (last ?? null);
        const controls = edit !== null && !edit.locked;
        // a comment over its limit is said as soon as it is typed (the autosave holds it back), as well as at the send
        const problem = edit ? (edit.problems[q.id] ?? (mark && mark.comment.length > TEST_LIMITS.comment ? "tooLong" : undefined)) : undefined;
        const box = `${uid}-${q.id}`;
        return (
          <li key={q.id} className={styles.question} data-review-answer={q.id}>
            <p className={styles.text}>
              <span className={styles.num}>{i + 1}.</span>
              {q.text}
            </p>
            <p className={styles.answer}>{answer || t.noAnswer}</p>
            {edit && mark && controls ? (
              <>
                <div className={styles.verdicts} role="group" aria-label={fill(t.verdictLabel, { n: i + 1 })}>
                  {(["ok", "fix"] as const).map((v) => (
                    <button key={v} type="button" className={styles.verdict} aria-pressed={mark.verdict === v} onClick={() => edit.onVerdict(q.id, v)} data-review-verdict={v}>
                      {v === "ok" ? t.ok : t.fix}
                    </button>
                  ))}
                </div>
                <div className={ui.field}>
                  <label htmlFor={box}>{t.comment}</label>
                  <textarea
                    id={box}
                    name={q.id}
                    className={ui.textarea}
                    value={mark.comment}
                    onChange={(e) => edit.onComment(q.id, e.target.value)}
                    onBlur={edit.onLeaveBox}
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
}
