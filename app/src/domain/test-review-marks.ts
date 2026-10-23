import type { OpenReview, TestQuestion, Verdict } from "@/db/schema";

// Maria's marks on one test attempt's open answers (admin UX pass, piece 2, Task 11; README A4 "Test review", B15): the rules the review screen
// (components/admin/TestReview.tsx) and the server's draft of the marks (server/test-review-marks.ts) share. No database, no React; types of the
// schema only. Old iPads run it: no regex lookbehind.

/** The draft layer's key of the marks (server/drafts.ts): the attempt's id is the entity id; the draft's value is `{ submittedAt, marks }`. */
export const MARKS_ENTITY = "test_review";
export const MARKS_PART = "marks";

/** One open answer's mark as the form holds it: no verdict yet, or „Kinnitatud“ / „Paranda“, and the comment. */
export type Mark = { verdict: Verdict | null; comment: string };
/** The marks by question id: one for each OPEN question of the attempt (a choice question has none). */
export type Marks = Record<string, Mark>;

export const NO_MARK: Mark = { verdict: null, comment: "" };

/**
 * Where the marks start: an answer Maria accepted before (a rewrite brings the attempt back to her) stays accepted, with her comment; every other
 * open answer is unmarked.
 */
export function startMarks(questions: readonly TestQuestion[], review: OpenReview | null): Marks {
  const marks: Marks = {};
  for (const q of questions) {
    if (q.kind !== "open") continue;
    const last = review?.[q.id];
    marks[q.id] = last?.verdict === "ok" ? { verdict: "ok", comment: last.comment } : { ...NO_MARK };
  }
  return marks;
}

/** How many open answers are marked „Kinnitatud“ (õige) and „Paranda“ (vale): the numbers on the send button. */
export function markCounts(marks: Marks): { ok: number; fix: number } {
  let ok = 0;
  let fix = 0;
  for (const m of Object.values(marks)) {
    if (m.verdict === "ok") ok++;
    else if (m.verdict === "fix") fix++;
  }
  return { ok, fix };
}
