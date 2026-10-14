import type { CourseSteps, StepState } from "@/domain/completion";
import { fill, formatDate } from "@/i18n/format";

// The Õpilased drawer's line about one e-course access (e-course completion, spec §5.5): "Õppetunnid 8/8 · Test: läbitud (85 %) · Praktiline
// töö: ootab hindamist", or "Lõpetatud 14.11.2026" once the course is completed. Built from the steps her own page shows (server/completion.ts
// loadSteps), so the two never disagree. Pure: the words come in (adminEt.clients.steps).

export type StepLineTexts = {
  /** "Õppetunnid {done}/{total}" */
  lessons: string;
  /** "Test: {state}", before her first attempt */
  test: string;
  /** "Test: {state} ({percent} %)" */
  testScore: string;
  /** "Praktiline töö: {state}" */
  practical: string;
  /** "Lõpetatud {date}" */
  completed: string;
  testStates: Record<StepState, string>;
  /** (the practical work is never "used": that is the test's tries) */
  practicalStates: Record<Exclude<StepState, "used">, string>;
};

/**
 * The line: "Lõpetatud <day in Tallinn>" for a completed course; else the lessons (when the course has any), the test (when it has questions)
 * with `percent` — her newest attempt's score, null before her first or when it had no choice questions — and the practical work (when it has
 * points), joined by " · ".
 */
export function stepLine(steps: CourseSteps, t: StepLineTexts, percent: number | null = null): string {
  if (steps.completedAt) return fill(t.completed, { date: formatDate(new Date(steps.completedAt), "et") });
  const parts: string[] = [];
  if (steps.lessons.total > 0) parts.push(fill(t.lessons, { done: steps.lessons.done, total: steps.lessons.total }));
  if (steps.test) {
    const state = t.testStates[steps.test.state];
    parts.push(percent === null ? fill(t.test, { state }) : fill(t.testScore, { state, percent }));
  }
  if (steps.practical) parts.push(fill(t.practical, { state: t.practicalStates[steps.practical.state === "used" ? "locked" : steps.practical.state] }));
  return parts.join(" · ");
}
