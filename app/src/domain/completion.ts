// The e-course completion's pure rules (spec §3, §4, D2–D5): the limits, the test's questions and settings and their checks, what the
// student is shown of a question, the answers' check, the grading and the pass mark, Maria's review of the open answers, the tries, the
// test's state, the practical work's status, each step's state and the completion rule. No database, no React: the server, the admin's
// screens and the student's pages share them. It runs in the browser too (the test and practical pages, the course editor), on iOS Safari
// before 16.4 as well: no lookbehind here nor in what it imports (tests/unit/old-safari.test.ts), and never lib/storable.

import type { AttemptStatus, OpenReview, SentProtocol, TestAnswers, TestQuestion, Verdict } from "@/db/schema";
import { toStorable } from "@/lib/to-storable";

/** A question's text, an option's text, an open answer and Maria's comment at most these characters; at most 50 questions, 2–6 options (spec §3.1). */
export const TEST_LIMITS = { questions: 50, text: 500, minOptions: 2, maxOptions: 6, option: 200, answer: 2000, comment: 2000 } as const;
/** A course with no `course_tests` row: the pass mark and the tries it would have. */
export const TEST_DEFAULTS = { passPercent: 80, tries: 3 } as const;
export const PASS_RANGE = { min: 1, max: 100 } as const;
export const TRIES_RANGE = { min: 1, max: 10 } as const;
/** Photos per practical point in one round (spec D4). */
export const PHOTOS_PER_POINT = 3;
/**
 * A practical photo (spec §4.3, D7): the full JPEG at most 2 MB and 2048 px on its long side, the thumbnail at most 200 KB and 480 px; the
 * browser refuses a source file over 60 MB before decoding it. One upload (full + thumbnail + the envelope) stays under Vercel's 4.5 MB.
 */
export const PHOTO_LIMITS = { fullBytes: 2 * 1024 * 1024, thumbBytes: 200 * 1024, maxEdge: 2048, thumbEdge: 480, sourceBytes: 60 * 1024 * 1024 } as const;

const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
/** A question's or an option's id: 1–32 characters [0-9a-z] (newItemId makes 8). Nothing else is ever a key of the answers (no "__proto__"). */
const ITEM_ID = /^[0-9a-z]{1,32}$/;

/** 8 random characters [0-9a-z] (crypto.getRandomValues): a new question's or option's id, made when it is added and never reused. */
export function newItemId(): string {
  let id = "";
  while (id.length < 8) {
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(8))) {
      // 252 = 7 × 36: the bytes above it are skipped, so every character is equally likely
      if (byte < 252 && id.length < 8) id += ID_CHARS[byte % 36];
    }
  }
  return id;
}

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === "string" && ITEM_ID.test(v);

/**
 * The questions as stored or as the course editor sent them (jsonb, or JSON from the browser: anything): the well-formed ones in their order,
 * as they are (no text is trimmed or cut here: checkQuestions refuses what is wrong, nothing is cut silently). A question or an option with
 * another shape, or an id that is not 1–32 characters [0-9a-z], is dropped. Never throws.
 */
export function readQuestions(value: unknown): TestQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): TestQuestion[] => {
    if (!isObject(v) || !validId(v.id) || typeof v.text !== "string") return [];
    if (v.kind === "open") return [{ id: v.id, kind: "open", text: v.text }];
    if (v.kind !== "choice" || !Array.isArray(v.options)) return [];
    const options = v.options.flatMap((o) =>
      isObject(o) && validId(o.id) && typeof o.text === "string" && typeof o.correct === "boolean" ? [{ id: o.id, text: o.text, correct: o.correct }] : [],
    );
    return [{ id: v.id, kind: "choice", text: v.text, options }];
  });
}

/**
 * What is wrong with the questions: the question at `index` (0-based; with `option`, that option of it) is empty, too long, has fewer than 2
 * or more than 6 options, or no correct one; or the whole list (index -1) has more than 50 questions or an id twice.
 */
export type QuestionProblem =
  | { index: number; option?: number; error: "empty" | "tooLong" | "options" | "noCorrect" }
  | { index: -1; error: "tooMany" | "duplicateId" };

/** Text Postgres can store (Maria pastes), trimmed. */
const clean = (s: string): string => toStorable(s).trim();

/**
 * The course editor's "Teadmiste test" as sent (readQuestions' output): every text cleaned (toStorable) and trimmed; refused: more than 50
 * questions, an id used twice (among the questions, or among one question's options), an empty question or option, a question over 500 or an
 * option over 200 characters, a choice question without 2–6 options or without a correct one. The first problem in the list's order is the
 * answer, so the editor can show it in place.
 */
export function checkQuestions(list: readonly TestQuestion[]): { ok: true; questions: TestQuestion[] } | { ok: false; problem: QuestionProblem } {
  if (list.length > TEST_LIMITS.questions) return { ok: false, problem: { index: -1, error: "tooMany" } };
  const twice = (ids: string[]) => new Set(ids).size !== ids.length;
  if (twice(list.map((q) => q.id)) || list.some((q) => q.kind === "choice" && twice(q.options.map((o) => o.id))))
    return { ok: false, problem: { index: -1, error: "duplicateId" } };
  const questions: TestQuestion[] = [];
  for (const [index, q] of list.entries()) {
    const text = clean(q.text);
    if (!text) return { ok: false, problem: { index, error: "empty" } };
    if (text.length > TEST_LIMITS.text) return { ok: false, problem: { index, error: "tooLong" } };
    if (q.kind === "open") {
      questions.push({ id: q.id, kind: "open", text });
      continue;
    }
    if (q.options.length < TEST_LIMITS.minOptions || q.options.length > TEST_LIMITS.maxOptions) return { ok: false, problem: { index, error: "options" } };
    const options = [];
    for (const [option, o] of q.options.entries()) {
      const optionText = clean(o.text);
      if (!optionText) return { ok: false, problem: { index, option, error: "empty" } };
      if (optionText.length > TEST_LIMITS.option) return { ok: false, problem: { index, option, error: "tooLong" } };
      options.push({ id: o.id, text: optionText, correct: o.correct });
    }
    if (!options.some((o) => o.correct)) return { ok: false, problem: { index, error: "noCorrect" } };
    questions.push({ id: q.id, kind: "choice", text, options });
  }
  return { ok: true, questions };
}

/** The pass mark (whole percent 1–100) and the tries (whole number 1–10); the pass mark is checked first. */
export function checkSettings(passPercent: number, tries: number): { ok: true } | { ok: false; error: "pass" | "tries" } {
  const within = (n: number, r: { min: number; max: number }) => Number.isInteger(n) && n >= r.min && n <= r.max;
  if (!within(passPercent, PASS_RANGE)) return { ok: false, error: "pass" };
  if (!within(tries, TRIES_RANGE)) return { ok: false, error: "tries" };
  return { ok: true };
}

/** A question as the student sees it: no answer key; `multiple`: more than one correct option (checkboxes, "Vali kõik õiged"). */
export type PublicQuestion =
  | { id: string; kind: "choice"; text: string; options: { id: string; text: string }[]; multiple: boolean }
  | { id: string; kind: "open"; text: string };

/** The questions without their answer key (spec §4.2): the only shape of a question that is sent to the student. */
export function publicQuestions(questions: readonly TestQuestion[]): PublicQuestion[] {
  return questions.map((q) =>
    q.kind === "open"
      ? { id: q.id, kind: "open", text: q.text }
      : { id: q.id, kind: "choice", text: q.text, options: q.options.map((o) => ({ id: o.id, text: o.text })), multiple: q.options.filter((o) => o.correct).length > 1 },
  );
}

/** Does `raw` (an object) hold `key` as its own (never an inherited "constructor")? */
const own = (raw: Loose, key: string): boolean => Object.prototype.hasOwnProperty.call(raw, key);

/**
 * The submitted answers against the questions: `changed` when the ids are not exactly the questions' ids (or an option id is unknown, or
 * a single-answer question has more than one), `incomplete` when a choice has no option or an open answer is blank, `tooLong` over 2000.
 * Open answers are trimmed and cleaned with toStorable.
 *
 * `changed` (the test was edited under her, spec §4.2) is looked for over every question first, also when the answers are not an object or
 * an answer has the other kind's shape; then the first `incomplete` or `tooLong` in the questions' order. The answers come back in the
 * questions' order, a choice's options in the question's order (twice picked: once).
 */
export function checkAnswers(
  questions: readonly TestQuestion[],
  raw: unknown,
): { ok: true; answers: TestAnswers } | { ok: false; error: "changed" | "incomplete" | "tooLong" } {
  if (!isObject(raw)) return { ok: false, error: "changed" };
  const keys = Object.keys(raw);
  if (keys.length !== questions.length || questions.some((q) => !own(raw, q.id))) return { ok: false, error: "changed" };
  for (const q of questions) {
    const value = raw[q.id];
    if (q.kind === "open") {
      if (typeof value !== "string") return { ok: false, error: "changed" };
      continue;
    }
    if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && q.options.some((o) => o.id === id))) return { ok: false, error: "changed" };
    const single = q.options.filter((o) => o.correct).length <= 1;
    if (single && new Set(value).size > 1) return { ok: false, error: "changed" };
  }
  const answers: TestAnswers = {};
  for (const q of questions) {
    const value = raw[q.id];
    if (q.kind === "open") {
      const text = clean(value as string);
      if (!text) return { ok: false, error: "incomplete" };
      if (text.length > TEST_LIMITS.answer) return { ok: false, error: "tooLong" };
      answers[q.id] = text;
    } else {
      const picked = new Set(value as string[]);
      if (picked.size === 0) return { ok: false, error: "incomplete" };
      answers[q.id] = q.options.filter((o) => picked.has(o.id)).map((o) => o.id);
    }
  }
  return { ok: true, answers };
}

/**
 * The choice part's result (spec §3.3): a choice question is right when the picked set equals the set of correct options exactly; `total`
 * counts the choice questions only. `wrong`: the 1-based positions (in the whole list) of the choice questions answered wrong.
 */
export function grade(questions: readonly TestQuestion[], answers: TestAnswers): { correct: number; total: number; wrong: number[] } {
  let correct = 0;
  let total = 0;
  const wrong: number[] = [];
  for (const [i, q] of questions.entries()) {
    if (q.kind !== "choice") continue;
    total++;
    const value = own(answers, q.id) ? answers[q.id] : [];
    const picked = new Set(Array.isArray(value) ? value : []);
    const right = q.options.filter((o) => o.correct).map((o) => o.id);
    if (picked.size === right.length && right.every((id) => picked.has(id))) correct++;
    else wrong.push(i + 1);
  }
  return { correct, total, wrong };
}

/** total 0 passes; else correct × 100 ≥ passPercent × total (no rounding). */
export function choicePassed(correct: number, total: number, passPercent: number): boolean {
  return total === 0 || correct * 100 >= passPercent * total;
}

/** Rounded down; 100 when total is 0. */
export function percentOf(correct: number, total: number): number {
  return total === 0 ? 100 : Math.floor((correct * 100) / total);
}

/** Has the test open questions (answers Maria reads)? */
export const hasOpen = (questions: readonly TestQuestion[]): boolean => questions.some((q) => q.kind === "open");

/** failed (choice part under the mark) | passed (no open questions) | review. */
export function submitStatus(questions: readonly TestQuestion[], correct: number, total: number, passPercent: number): AttemptStatus {
  if (!choicePassed(correct, total, passPercent)) return "failed";
  return hasOpen(questions) ? "review" : "passed";
}

/**
 * Every open question needs a verdict; "fix" needs a non-blank comment; comments ≤ 2000 (toStorable).
 *
 * Maria's review form as sent (spec §5.4), against the attempt's own copy of the questions: `incomplete` when an open question has no
 * "ok"/"fix" (looked for over all of them first), then `tooLong` for a comment over 2000 characters, then `comment` for a "fix" without one.
 * The review holds the open questions only, each comment cleaned and trimmed ("" when none); anything else sent is left out.
 */
export function checkReview(questions: readonly TestQuestion[], raw: unknown): { ok: true; review: OpenReview } | { ok: false; error: "incomplete" | "comment" | "tooLong" } {
  const open = questions.filter((q) => q.kind === "open");
  const given = isObject(raw) ? raw : {};
  const entries = open.map((q): { id: string; verdict: Verdict | null; comment: string } => {
    const entry = own(given, q.id) ? given[q.id] : undefined;
    const v = isObject(entry) ? entry.verdict : undefined;
    const verdict = v === "ok" || v === "fix" ? v : null;
    const comment = isObject(entry) && typeof entry.comment === "string" ? clean(entry.comment) : "";
    return { id: q.id, verdict, comment };
  });
  if (entries.some((e) => e.verdict === null)) return { ok: false, error: "incomplete" };
  if (entries.some((e) => e.comment.length > TEST_LIMITS.comment)) return { ok: false, error: "tooLong" };
  if (entries.some((e) => e.verdict === "fix" && !e.comment)) return { ok: false, error: "comment" };
  const review: OpenReview = {};
  for (const e of entries) review[e.id] = { verdict: e.verdict!, comment: e.comment };
  return { ok: true, review };
}

/** passed when every open answer is ok, else fix. */
export function reviewStatus(review: OpenReview): "passed" | "fix" {
  return Object.values(review).every((r) => r.verdict === "ok") ? "passed" : "fix";
}

/** The open answers a "fix" review reopens (question ids). */
export function fixAnswers(review: OpenReview | null): string[] {
  return review ? Object.entries(review).flatMap(([id, r]) => (r.verdict === "fix" ? [id] : [])) : [];
}

/** The tries a student has (spec §3.3): the course's, plus what each "Ava test uuesti" added. */
export const triesAllowed = (tries: number, extraTries: number): number => tries + extraTries;

export type TestState =
  | { kind: "none"; triesLeft: number } // no attempt yet
  | { kind: "open"; triesLeft: number } // the last one failed, tries left
  | { kind: "review" }
  | { kind: "fix" }
  | { kind: "passed" }
  | { kind: "used" }; // every allowed try failed

/**
 * From the attempts (any order) and the tries allowed. A passed attempt makes the test passed for good (a passed step stays passed, spec
 * §4.4); then one waiting for Maria (review), then one she asked to fix; otherwise every attempt failed: "open" while fewer than the tries
 * allowed were made, else "used". Each submitted attempt is one try.
 */
export function testState(attempts: readonly { number: number; status: AttemptStatus }[], allowed: number): TestState {
  if (attempts.length === 0) return { kind: "none", triesLeft: Math.max(0, allowed) };
  const has = (status: AttemptStatus) => attempts.some((a) => a.status === status);
  if (has("passed")) return { kind: "passed" };
  if (has("review")) return { kind: "review" };
  if (has("fix")) return { kind: "fix" };
  const left = allowed - attempts.length;
  return left > 0 ? { kind: "open", triesLeft: left } : { kind: "used" };
}

export type PracticalStatus = "open" | "review" | "fix" | "passed";

/**
 * spec §3.4's table; null row = open. open: no row, or round 0; review (Ootab hindamist): submitted, and Maria has not sent an assessment of
 * that round; fix (Paranda): her send of this round marked a point "fix"; passed (Kinnitatud): it marked none.
 */
export function practicalStatus(p: { round: number; sentRound: number | null; sent: SentProtocol | null } | null): PracticalStatus {
  if (p === null || p.round === 0) return "open";
  if (p.sentRound === null || p.sentRound < p.round) return "review";
  return (p.sent?.verdicts ?? []).includes("fix") ? "fix" : "passed";
}

/** The points (0-based) the last sent assessment marked "fix". */
export function sentFixPoints(sent: SentProtocol | null): number[] {
  return (sent?.verdicts ?? []).flatMap((v, i) => (v === "fix" ? [i] : []));
}

export type StepState = "locked" | "open" | "review" | "fix" | "done" | "used";
export type StepInputs = {
  lessonsDone: number;
  lessonsTotal: number;
  hasQuestions: boolean;
  test: TestState;
  hasPoints: boolean;
  practical: PracticalStatus;
  practicalRound: number;
  completedAt: Date | null;
};
export type CourseSteps = {
  lessons: { done: number; total: number; state: "open" | "done" };
  test: { state: StepState; triesLeft: number | null } | null; // null: the course has no questions
  practical: { state: StepState; round: number } | null; // null: the course has no points
  completedAt: string | null; // ISO
};

const TEST_STEP: Record<TestState["kind"], StepState> = { none: "open", open: "open", review: "review", fix: "fix", passed: "done", used: "used" };
const PRACTICAL_STEP: Record<PracticalStatus, StepState> = { open: "open", review: "review", fix: "fix", passed: "done" };

/**
 * The rules: lessons done = done >= total. Test: none/open with lessons done (or any attempt made) → "open", else "locked"; review/fix/
 * passed → review/fix/done; used → "used". Practical: locked until the test is passed (or there are no questions and the lessons are done,
 * or round > 0); then open/review/fix/passed → open/review/fix/done. A set completedAt makes every present step "done".
 *
 * ("open" is a state with an attempt made: it opens whatever the lessons. `triesLeft` is given while a new attempt can be made, 0 when
 * the tries are used, null otherwise.)
 */
export function courseSteps(i: StepInputs): CourseSteps {
  const completed = i.completedAt !== null;
  const lessonsDone = i.lessonsDone >= i.lessonsTotal;
  const lessons = { done: i.lessonsDone, total: i.lessonsTotal, state: completed || lessonsDone ? ("done" as const) : ("open" as const) };
  let test: CourseSteps["test"] = null;
  if (i.hasQuestions) {
    if (completed) test = { state: "done", triesLeft: null };
    else if (i.test.kind === "none") test = { state: lessonsDone ? "open" : "locked", triesLeft: i.test.triesLeft };
    else if (i.test.kind === "open") test = { state: "open", triesLeft: i.test.triesLeft };
    else test = { state: TEST_STEP[i.test.kind], triesLeft: i.test.kind === "used" ? 0 : null };
  }
  let practical: CourseSteps["practical"] = null;
  if (i.hasPoints) {
    const opened = (i.hasQuestions ? i.test.kind === "passed" : lessonsDone) || i.practicalRound > 0;
    const state: StepState = completed ? "done" : opened ? PRACTICAL_STEP[i.practical] : "locked";
    practical = { state, round: i.practicalRound };
  }
  return { lessons, test, practical, completedAt: i.completedAt?.toISOString() ?? null };
}

/** Every present step done (completedAt not consulted). */
export function isComplete(i: StepInputs): boolean {
  const s = courseSteps({ ...i, completedAt: null });
  return s.lessons.state === "done" && (s.test === null || s.test.state === "done") && (s.practical === null || s.practical.state === "done");
}
