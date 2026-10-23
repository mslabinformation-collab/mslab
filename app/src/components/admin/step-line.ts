import type { CourseSteps, StepState } from "@/domain/completion";
import { fill } from "@/i18n/format";

// The Õpilased drawer's line about one e-course access (README A5, piece 2 texts P-7): "Õppetunnid 8/8 · Test läbitud (85 %) · Praktiline töö ootab
// hindamist" — the prototype's, no colons — and the phone frame's "8/8 · test läbitud · praktiline ootab". Built from the steps her own page shows
// (server/completion.ts loadSteps), so the two never disagree. A completed course has no line: the card's pill says "Läbitud {date}". Pure: the
// words come in (adminEt.clients.steps).

export type StepLineTexts = {
  /** "Õppetunnid {done}/{total}" */
  lessons: string;
  /** "Test {state}", before her first attempt */
  test: string;
  /** "Test {state} ({percent} %)" */
  testScore: string;
  /** "Praktiline töö {state}" */
  practical: string;
  /** The phone's: "{done}/{total}", "test {state}", "praktiline {state}" */
  lessonsShort: string;
  testShort: string;
  practicalShort: string;
  testStates: Record<StepState, string>;
  /** (the practical work is never "used": that is the test's tries) */
  practicalStates: Record<Exclude<StepState, "used">, string>;
};

const practicalState = (steps: NonNullable<CourseSteps["practical"]>): Exclude<StepState, "used"> => (steps.state === "used" ? "locked" : steps.state);
/** The phone drops ' hindamist' ("ootab hindamist" → "ootab", P-7). */
const shorter = (state: string) => state.replace(/ hindamist$/, "");

/**
 * The line: the lessons (when the course has any), the test (when it has questions) with `percent` — her newest attempt's score, null before her first
 * or when it had no choice questions — and the practical work (when it has points), joined by " · "; "" for a completed course.
 */
export function stepLine(steps: CourseSteps, t: StepLineTexts, percent: number | null = null): string {
  if (steps.completedAt) return "";
  const parts: string[] = [];
  if (steps.lessons.total > 0) parts.push(fill(t.lessons, { done: steps.lessons.done, total: steps.lessons.total }));
  if (steps.test) {
    const state = t.testStates[steps.test.state];
    parts.push(percent === null ? fill(t.test, { state }) : fill(t.testScore, { state, percent }));
  }
  if (steps.practical) parts.push(fill(t.practical, { state: t.practicalStates[practicalState(steps.practical)] }));
  return parts.join(" · ");
}

/** The phone's line: the same steps in fewer words — no word for the lessons, lower case, no score, 'ootab hindamist' as 'ootab'. */
export function stepLineShort(steps: CourseSteps, t: StepLineTexts): string {
  if (steps.completedAt) return "";
  const parts: string[] = [];
  if (steps.lessons.total > 0) parts.push(fill(t.lessonsShort, { done: steps.lessons.done, total: steps.lessons.total }));
  if (steps.test) parts.push(fill(t.testShort, { state: shorter(t.testStates[steps.test.state]) }));
  if (steps.practical) parts.push(fill(t.practicalShort, { state: shorter(t.practicalStates[practicalState(steps.practical)]) }));
  return parts.join(" · ");
}
