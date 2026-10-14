import { describe, expect, test } from "vitest";
import { stepLine } from "@/components/admin/step-line";
import type { CourseSteps } from "@/domain/completion";
import { adminEt } from "@/i18n/dict/admin";

// The Õpilased drawer's line about one e-course access (e-course completion, spec §5.5): her lessons, the test with her newest score and the
// practical work in Maria's words, a step the course does not have left out, and "Lõpetatud" with its day once the course is completed.

const t = adminEt.clients.steps;
const steps = (over: Partial<CourseSteps> = {}): CourseSteps => ({
  lessons: { done: 8, total: 8, state: "done" },
  test: { state: "done", triesLeft: null },
  practical: { state: "review", round: 1 },
  completedAt: null,
  ...over,
});

describe("stepLine", () => {
  test("the spec's line: the lessons, the test with her score, the practical work", () => {
    expect(stepLine(steps(), t, 85)).toBe("Õppetunnid 8/8 · Test: läbitud (85 %) · Praktiline töö: ootab hindamist");
  });

  test("every state in words; no score before her first attempt", () => {
    expect(stepLine(steps({ lessons: { done: 3, total: 8, state: "open" }, test: { state: "locked", triesLeft: 3 }, practical: { state: "locked", round: 0 } }), t)).toBe(
      "Õppetunnid 3/8 · Test: lukus · Praktiline töö: lukus",
    );
    expect(stepLine(steps({ test: { state: "open", triesLeft: 2 }, practical: { state: "locked", round: 0 } }), t, 60)).toBe("Õppetunnid 8/8 · Test: avatud (60 %) · Praktiline töö: lukus");
    for (const [state, word] of [
      ["review", "ootab hindamist"],
      ["fix", "parandamisel"],
      ["used", "katsed otsas"],
    ] as const)
      expect(stepLine(steps({ test: { state, triesLeft: 0 } }), t, 70)).toContain(`Test: ${word} (70 %)`);
    for (const [state, word] of [
      ["open", "avatud"],
      ["fix", "parandamisel"],
      ["done", "kinnitatud"],
    ] as const)
      expect(stepLine(steps({ practical: { state, round: 2 } }), t)).toContain(`Praktiline töö: ${word}`);
  });

  test("a step the course does not have is left out; a course without lessons names none; nothing at all is an empty line", () => {
    expect(stepLine(steps({ test: null }), t)).toBe("Õppetunnid 8/8 · Praktiline töö: ootab hindamist");
    expect(stepLine(steps({ practical: null }), t, 85)).toBe("Õppetunnid 8/8 · Test: läbitud (85 %)");
    expect(stepLine(steps({ lessons: { done: 0, total: 0, state: "done" } }), t, 85)).toBe("Test: läbitud (85 %) · Praktiline töö: ootab hindamist");
    expect(stepLine(steps({ lessons: { done: 0, total: 0, state: "done" }, test: null, practical: null }), t)).toBe("");
  });

  test("completed: only 'Lõpetatud' with its day in Tallinn", () => {
    expect(stepLine(steps({ completedAt: "2026-11-13T22:30:00.000Z" }), t, 85)).toBe("Lõpetatud 14.11.2026"); // 00:30 in Tallinn
  });
});
