import { describe, expect, test } from "vitest";
import { stepLine, stepLineShort } from "@/components/admin/step-line";
import type { CourseSteps } from "@/domain/completion";
import { adminEt } from "@/i18n/dict/admin";

// The Õpilased drawer's line about one e-course access (README A5, piece 2 texts P-7): her lessons, the test with her newest score and the practical
// work in Maria's words — no colons —, a step the course does not have left out, and the phone's shorter line. A completed course has no line: the
// card's pill says „Läbitud {date}“.

const t = adminEt.clients.steps;
const steps = (over: Partial<CourseSteps> = {}): CourseSteps => ({
  lessons: { done: 8, total: 8, state: "done" },
  test: { state: "done", triesLeft: null },
  practical: { state: "review", round: 1 },
  completedAt: null,
  ...over,
});

describe("stepLine", () => {
  test("the prototype's line: the lessons, the test with her score, the practical work, no colons", () => {
    expect(stepLine(steps(), t, 85)).toBe("Õppetunnid 8/8 · Test läbitud (85 %) · Praktiline töö ootab hindamist");
  });

  test("every state in words; no score before her first attempt", () => {
    expect(stepLine(steps({ lessons: { done: 3, total: 8, state: "open" }, test: { state: "locked", triesLeft: 3 }, practical: { state: "locked", round: 0 } }), t)).toBe(
      "Õppetunnid 3/8 · Test lukus · Praktiline töö lukus",
    );
    expect(stepLine(steps({ test: { state: "open", triesLeft: 2 }, practical: { state: "locked", round: 0 } }), t, 60)).toBe("Õppetunnid 8/8 · Test avatud (60 %) · Praktiline töö lukus");
    for (const [state, word] of [
      ["review", "ootab hindamist"],
      ["fix", "parandamisel"],
      ["used", "katsed otsas"],
    ] as const)
      expect(stepLine(steps({ test: { state, triesLeft: 0 } }), t, 70)).toContain(`Test ${word} (70 %)`);
    for (const [state, word] of [
      ["open", "avatud"],
      ["fix", "parandamisel"],
      ["done", "kinnitatud"],
    ] as const)
      expect(stepLine(steps({ practical: { state, round: 2 } }), t)).toContain(`Praktiline töö ${word}`);
  });

  test("a step the course does not have is left out; a course without lessons names none; nothing at all is an empty line", () => {
    expect(stepLine(steps({ test: null }), t)).toBe("Õppetunnid 8/8 · Praktiline töö ootab hindamist");
    expect(stepLine(steps({ practical: null }), t, 85)).toBe("Õppetunnid 8/8 · Test läbitud (85 %)");
    expect(stepLine(steps({ lessons: { done: 0, total: 0, state: "done" } }), t, 85)).toBe("Test läbitud (85 %) · Praktiline töö ootab hindamist");
    expect(stepLine(steps({ lessons: { done: 0, total: 0, state: "done" }, test: null, practical: null }), t)).toBe("");
  });

  test("completed: no line (the card's pill is „Läbitud {date}“)", () => {
    expect(stepLine(steps({ completedAt: "2026-11-13T22:30:00.000Z" }), t, 85)).toBe("");
    expect(stepLineShort(steps({ completedAt: "2026-11-13T22:30:00.000Z" }), t)).toBe("");
  });
});

describe("stepLineShort: the phone frame's line", () => {
  test("„3/3 · test läbitud · praktiline ootab“: no word for the lessons, lower case, no score, ' hindamist' dropped (P-7)", () => {
    expect(stepLineShort(steps({ lessons: { done: 3, total: 3, state: "done" }, test: { state: "done", triesLeft: null } }), t)).toBe("3/3 · test läbitud · praktiline ootab");
  });

  test("every state keeps its word, 'ootab hindamist' is 'ootab'; a step the course does not have is left out", () => {
    expect(stepLineShort(steps({ lessons: { done: 3, total: 8, state: "open" }, test: { state: "review", triesLeft: null }, practical: { state: "locked", round: 0 } }), t)).toBe(
      "3/8 · test ootab · praktiline lukus",
    );
    expect(stepLineShort(steps({ test: { state: "used", triesLeft: 0 }, practical: { state: "fix", round: 2 } }), t)).toBe("8/8 · test katsed otsas · praktiline parandamisel");
    expect(stepLineShort(steps({ test: null, practical: { state: "done", round: 1 } }), t)).toBe("8/8 · praktiline kinnitatud");
    expect(stepLineShort(steps({ lessons: { done: 0, total: 0, state: "done" }, test: null, practical: null }), t)).toBe("");
  });
});
