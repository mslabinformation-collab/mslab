import { describe, expect, test } from "vitest";
import type { AttemptStatus, SentProtocol, TestQuestion } from "@/db/schema";
import {
  checkAnswers, checkQuestions, checkReview, checkSettings, choicePassed, courseSteps, fixAnswers, grade, hasOpen, isComplete, newItemId, PASS_RANGE,
  percentOf, PHOTO_LIMITS, PHOTOS_PER_POINT, practicalStatus, publicQuestions, readQuestions, reviewStatus, sentFixPoints, submitStatus, TEST_DEFAULTS,
  TEST_LIMITS, testState, triesAllowed, TRIES_RANGE, type StepInputs, type TestState,
} from "@/domain/completion";

// The e-course completion's pure rules (spec §3, §4, §9 unit): the limits, the questions' and the settings' checks, what the student sees of a
// question, the answers' check, the grading at the pass mark's edges, Maria's review, the tries, the test's state, the practical status
// table, the step states (a passed step stays passed) and the completion rule.

/** A choice question; `correct` names its correct options by id. */
const choice = (id: string, options: string[], correct: string[], text = `Küsimus ${id}`): TestQuestion => ({
  id,
  kind: "choice",
  text,
  options: options.map((o) => ({ id: o, text: `Vastus ${o}`, correct: correct.includes(o) })),
});
const open = (id: string, text = `Avatud küsimus ${id}`): TestQuestion => ({ id, kind: "open", text });

/** n single-answer questions q1…qn, each with options a, b, c and "a" correct. */
const singles = (n: number): TestQuestion[] => Array.from({ length: n }, (_, i) => choice(`q${i + 1}`, ["a", "b", "c"], ["a"]));
/** The answers of `singles(n)` with the first `right` answered right ("a") and the rest wrong ("b"). */
const answersOf = (n: number, right: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i + 1}`, [i < right ? "a" : "b"]]));

describe("the limits (spec §3.1, §4.3)", () => {
  test("as the spec and the plan name them", () => {
    expect(TEST_LIMITS).toEqual({ questions: 50, text: 500, minOptions: 2, maxOptions: 6, option: 200, answer: 2000, comment: 2000 });
    expect(TEST_DEFAULTS).toEqual({ passPercent: 80, tries: 3 });
    expect([PASS_RANGE, TRIES_RANGE]).toEqual([{ min: 1, max: 100 }, { min: 1, max: 10 }]);
    expect(PHOTOS_PER_POINT).toBe(3);
    expect(PHOTO_LIMITS).toEqual({ fullBytes: 2_097_152, thumbBytes: 204_800, maxEdge: 2048, thumbEdge: 480, sourceBytes: 62_914_560 });
  });
});

describe("ids", () => {
  test("newItemId: 8 characters [0-9a-z], a new one each time", () => {
    const ids = Array.from({ length: 200 }, newItemId);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{8}$/);
    expect(new Set(ids).size).toBe(200);
  });
});

describe("readQuestions: the stored list read defensively", () => {
  test("well-formed questions in their order, as they are (nothing trimmed or cut here)", () => {
    const list = [choice("q1", ["a", "b"], ["b"]), open("q2", "  Kirjelda  "), { id: "q3", kind: "open", text: "x".repeat(900) }];
    expect(readQuestions(list)).toEqual(list);
  });

  test("anything malformed is dropped, and it never throws", () => {
    for (const value of [null, undefined, "x", 5, { id: "q1" }]) expect(readQuestions(value)).toEqual([]);
    expect(
      readQuestions([
        null,
        "q",
        { id: "q1", kind: "open" }, // no text
        { id: "Q1", kind: "open", text: "upper-case id" },
        { id: "__proto__", kind: "open", text: "x" },
        { id: "", kind: "open", text: "x" },
        { id: "x".repeat(33), kind: "open", text: "x" },
        { id: "q2", kind: "other", text: "x" },
        { id: "q3", kind: "choice", text: "x" }, // no options
        { id: "q4", kind: "open", text: "jah", extra: true },
      ]),
    ).toEqual([{ id: "q4", kind: "open", text: "jah" }]);
  });

  test("a choice question keeps its well-formed options only (checkQuestions then counts them)", () => {
    expect(
      readQuestions([
        {
          id: "q1",
          kind: "choice",
          text: "Mis?",
          options: [{ id: "a", text: "A", correct: true }, { id: "b", text: "B" }, { id: "c", text: 3, correct: false }, null, { id: "d", text: "D", correct: false, x: 1 }],
        },
      ]),
    ).toEqual([{ id: "q1", kind: "choice", text: "Mis?", options: [{ id: "a", text: "A", correct: true }, { id: "d", text: "D", correct: false }] }]);
  });
});

describe("checkQuestions: the course editor's list (spec §3.1)", () => {
  test("every text cleaned and trimmed; open and choice questions kept in order", () => {
    const r = checkQuestions([
      { id: "q1", kind: "choice", text: "  Mis on\u0000 õige?  ", options: [{ id: "a", text: " Üks ", correct: true }, { id: "b", text: "Kaks\u000b", correct: false }] },
      { id: "q2", kind: "open", text: "\tKirjelda\n" },
    ]);
    expect(r).toEqual({
      ok: true,
      questions: [
        { id: "q1", kind: "choice", text: "Mis on õige?", options: [{ id: "a", text: "Üks", correct: true }, { id: "b", text: "Kaks", correct: false }] },
        { id: "q2", kind: "open", text: "Kirjelda" },
      ],
    });
    expect(checkQuestions([])).toEqual({ ok: true, questions: [] });
  });

  test("at most 50 questions; an id twice (questions, or one question's options) — the whole list (index -1)", () => {
    expect(checkQuestions(singles(50))).toMatchObject({ ok: true });
    expect(checkQuestions(singles(51))).toEqual({ ok: false, problem: { index: -1, error: "tooMany" } });
    expect(checkQuestions([open("q1"), open("q1")])).toEqual({ ok: false, problem: { index: -1, error: "duplicateId" } });
    expect(checkQuestions([choice("q1", ["a", "a"], ["a"])])).toEqual({ ok: false, problem: { index: -1, error: "duplicateId" } });
    expect(checkQuestions([choice("q1", ["a", "b"], ["a"]), choice("q2", ["a", "b"], ["a"])])).toMatchObject({ ok: true }); // options are per question
  });

  test("a question's text: empty (blank) or over 500 characters, at its index", () => {
    expect(checkQuestions([open("q1"), open("q2", "   ")])).toEqual({ ok: false, problem: { index: 1, error: "empty" } });
    expect(checkQuestions([open("q1", "x".repeat(500))])).toMatchObject({ ok: true });
    expect(checkQuestions([open("q1", `  ${"x".repeat(500)}  `)])).toMatchObject({ ok: true }); // trimmed before it is measured
    expect(checkQuestions([open("q1"), open("q2", "x".repeat(501))])).toEqual({ ok: false, problem: { index: 1, error: "tooLong" } });
    expect(checkQuestions([choice("q1", ["a", "b"], ["a"], "")])).toEqual({ ok: false, problem: { index: 0, error: "empty" } });
  });

  test("a choice question: 2–6 options, each non-empty and at most 200 characters (at its option), at least one correct", () => {
    expect(checkQuestions([choice("q1", ["a"], ["a"])])).toEqual({ ok: false, problem: { index: 0, error: "options" } });
    expect(checkQuestions([choice("q1", ["a", "b"], ["a"])])).toMatchObject({ ok: true });
    expect(checkQuestions([choice("q1", ["a", "b", "c", "d", "e", "f"], ["f"])])).toMatchObject({ ok: true });
    expect(checkQuestions([open("q0"), choice("q1", ["a", "b", "c", "d", "e", "f", "g"], ["a"])])).toEqual({ ok: false, problem: { index: 1, error: "options" } });
    const withOption = (text: string): TestQuestion => ({ id: "q1", kind: "choice", text: "Mis?", options: [{ id: "a", text: "A", correct: true }, { id: "b", text, correct: false }] });
    expect(checkQuestions([withOption(" ")])).toEqual({ ok: false, problem: { index: 0, option: 1, error: "empty" } });
    expect(checkQuestions([withOption("y".repeat(200))])).toMatchObject({ ok: true });
    expect(checkQuestions([withOption("y".repeat(201))])).toEqual({ ok: false, problem: { index: 0, option: 1, error: "tooLong" } });
    expect(checkQuestions([choice("q1", ["a", "b"], [])])).toEqual({ ok: false, problem: { index: 0, error: "noCorrect" } });
  });

  test("the first problem in the list's order wins", () => {
    expect(checkQuestions([choice("q1", ["a", "b"], []), open("q2", "")])).toEqual({ ok: false, problem: { index: 0, error: "noCorrect" } });
  });
});

describe("checkSettings", () => {
  test("the pass mark a whole 1–100, the tries a whole 1–10; the pass mark first", () => {
    for (const [p, t] of [[1, 1], [80, 3], [100, 10]]) expect(checkSettings(p, t)).toEqual({ ok: true });
    for (const p of [0, 101, 79.5, Number.NaN]) expect(checkSettings(p, 3)).toEqual({ ok: false, error: "pass" });
    for (const t of [0, 11, 2.5, Number.POSITIVE_INFINITY]) expect(checkSettings(80, t)).toEqual({ ok: false, error: "tries" });
    expect(checkSettings(0, 0)).toEqual({ ok: false, error: "pass" });
  });
});

describe("publicQuestions: what the student is sent (never the answer key)", () => {
  test("no `correct` anywhere; `multiple` when more than one option is correct", () => {
    const shown = publicQuestions([choice("q1", ["a", "b"], ["a"]), choice("q2", ["a", "b", "c"], ["a", "c"]), open("q3")]);
    expect(shown).toEqual([
      { id: "q1", kind: "choice", text: "Küsimus q1", options: [{ id: "a", text: "Vastus a" }, { id: "b", text: "Vastus b" }], multiple: false },
      { id: "q2", kind: "choice", text: "Küsimus q2", options: [{ id: "a", text: "Vastus a" }, { id: "b", text: "Vastus b" }, { id: "c", text: "Vastus c" }], multiple: true },
      { id: "q3", kind: "open", text: "Avatud küsimus q3" },
    ]);
    expect(JSON.stringify(shown)).not.toContain("correct");
  });
});

describe("checkAnswers: the submitted answers against the questions", () => {
  const questions = [choice("q1", ["a", "b", "c"], ["a"]), choice("q2", ["a", "b", "c"], ["a", "c"]), open("q3")];
  const good = { q1: ["a"], q2: ["c", "a"], q3: "  Minu vastus\u0000  " };

  test("accepted: in the questions' order, a choice's options in the question's order, an open answer cleaned and trimmed", () => {
    const r = checkAnswers(questions, good);
    expect(r).toEqual({ ok: true, answers: { q1: ["a"], q2: ["a", "c"], q3: "Minu vastus" } });
    expect(r.ok && Object.keys(r.answers)).toEqual(["q1", "q2", "q3"]);
    expect(checkAnswers(questions, { ...good, q1: ["b", "b"] })).toEqual({ ok: true, answers: { q1: ["b"], q2: ["a", "c"], q3: "Minu vastus" } }); // twice picked: once
    expect(checkAnswers(questions, { ...good, q2: ["b"] })).toMatchObject({ ok: true }); // a wrong answer is still an answer
  });

  test("changed: the ids are not exactly the questions' (one missing, one more, another one)", () => {
    expect(checkAnswers(questions, { q1: ["a"], q2: ["a"] })).toEqual({ ok: false, error: "changed" });
    expect(checkAnswers(questions, { ...good, q4: "x" })).toEqual({ ok: false, error: "changed" });
    expect(checkAnswers(questions, { q1: ["a"], q2: ["a"], q9: "x" })).toEqual({ ok: false, error: "changed" });
    expect(checkAnswers([], {})).toEqual({ ok: true, answers: {} });
  });

  test("changed: an unknown option, the other kind's shape, a single-answer question with two; not an object at all", () => {
    expect(checkAnswers(questions, { ...good, q1: ["z"] })).toEqual({ ok: false, error: "changed" });
    expect(checkAnswers(questions, { ...good, q1: "a" })).toEqual({ ok: false, error: "changed" });
    expect(checkAnswers(questions, { ...good, q3: ["a"] })).toEqual({ ok: false, error: "changed" });
    expect(checkAnswers(questions, { ...good, q1: [1] })).toEqual({ ok: false, error: "changed" });
    expect(checkAnswers(questions, { ...good, q1: ["a", "b"] })).toEqual({ ok: false, error: "changed" }); // one correct option: radio buttons
    expect(checkAnswers(questions, { ...good, q2: ["a", "b", "c"] })).toMatchObject({ ok: true }); // several correct: checkboxes, any number
    for (const raw of [null, undefined, "x", [], [["a"]]]) expect(checkAnswers(questions, raw)).toEqual({ ok: false, error: "changed" });
  });

  test("changed wins over incomplete: it is looked for over every question first", () => {
    expect(checkAnswers(questions, { q1: [], q2: ["a"], q3: ["x"] })).toEqual({ ok: false, error: "changed" });
  });

  test("incomplete: a choice without an option, a blank open answer (spaces or what toStorable drops)", () => {
    expect(checkAnswers(questions, { ...good, q1: [] })).toEqual({ ok: false, error: "incomplete" });
    expect(checkAnswers(questions, { ...good, q3: "   " })).toEqual({ ok: false, error: "incomplete" });
    expect(checkAnswers(questions, { ...good, q3: "\u0000\u0001" })).toEqual({ ok: false, error: "incomplete" });
  });

  test("tooLong: an open answer over 2000 characters after trimming", () => {
    expect(checkAnswers(questions, { ...good, q3: "x".repeat(2000) })).toMatchObject({ ok: true });
    expect(checkAnswers(questions, { ...good, q3: ` ${"x".repeat(2000)} ` })).toMatchObject({ ok: true });
    expect(checkAnswers(questions, { ...good, q3: "x".repeat(2001) })).toEqual({ ok: false, error: "tooLong" });
  });

  test("the first of incomplete and tooLong in the questions' order", () => {
    const two = [open("q1"), open("q2")];
    expect(checkAnswers(two, { q1: "x".repeat(2001), q2: "" })).toEqual({ ok: false, error: "tooLong" });
    expect(checkAnswers(two, { q1: "", q2: "x".repeat(2001) })).toEqual({ ok: false, error: "incomplete" });
  });

  test("an id like 'constructor' is never taken from the object's prototype", () => {
    expect(checkAnswers([open("constructor")], {})).toEqual({ ok: false, error: "changed" });
  });
});

describe("grade (spec §3.3)", () => {
  test("one correct option: right only with exactly it", () => {
    const qs = [choice("q1", ["a", "b", "c"], ["b"])];
    expect(grade(qs, { q1: ["b"] })).toEqual({ correct: 1, total: 1, wrong: [] });
    expect(grade(qs, { q1: ["a"] })).toEqual({ correct: 0, total: 1, wrong: [1] });
  });

  test("several correct options: the exact set, in any order; one missing or one more is wrong", () => {
    const qs = [choice("q1", ["a", "b", "c", "d"], ["a", "c"])];
    expect(grade(qs, { q1: ["c", "a"] }).correct).toBe(1);
    expect(grade(qs, { q1: ["a"] }).correct).toBe(0);
    expect(grade(qs, { q1: ["a", "c", "d"] }).correct).toBe(0);
    expect(grade(qs, { q1: ["b", "d"] }).correct).toBe(0);
  });

  test("open questions are not counted; `wrong` holds positions in the whole list, 1-based", () => {
    const qs = [open("q1"), choice("q2", ["a", "b"], ["a"]), open("q3"), choice("q4", ["a", "b"], ["a"]), choice("q5", ["a", "b"], ["b"])];
    expect(grade(qs, { q1: "x", q2: ["b"], q3: "y", q4: ["a"], q5: ["a"] })).toEqual({ correct: 1, total: 3, wrong: [2, 5] });
  });

  test("zero choice questions: 0 of 0; a missing or malformed answer is wrong", () => {
    expect(grade([open("q1")], { q1: "x" })).toEqual({ correct: 0, total: 0, wrong: [] });
    expect(grade([], {})).toEqual({ correct: 0, total: 0, wrong: [] });
    expect(grade([choice("q1", ["a", "b"], ["a"])], {})).toEqual({ correct: 0, total: 1, wrong: [1] });
    expect(grade([choice("q1", ["a", "b"], ["a"])], { q1: "a" })).toEqual({ correct: 0, total: 1, wrong: [1] });
  });
});

describe("the pass mark (spec §3.3): correct × 100 ≥ passPercent × total, no rounding; the percentage shown rounded down", () => {
  test("5 questions at 80 %: 4 pass, 3 do not; at 81 % even 4 do not (80 % < 81 %); at 79 % 4 do", () => {
    expect(choicePassed(4, 5, 80)).toBe(true);
    expect(choicePassed(3, 5, 80)).toBe(false);
    expect(choicePassed(4, 5, 81)).toBe(false);
    expect(choicePassed(4, 5, 79)).toBe(true);
    expect(choicePassed(5, 5, 100)).toBe(true);
    expect(choicePassed(4, 5, 100)).toBe(false);
  });

  test("10 questions: 8 at 80 % passes, 7 does not; 8 at 81 % does not; 7 at 70 % passes", () => {
    expect(choicePassed(8, 10, 80)).toBe(true);
    expect(choicePassed(7, 10, 80)).toBe(false);
    expect(choicePassed(8, 10, 81)).toBe(false);
    expect(choicePassed(8, 10, 79)).toBe(true);
    expect(choicePassed(7, 10, 70)).toBe(true);
  });

  test("3 questions at 67 %: 2 of 3 is 66.7 % and does not pass (no rounding up); at 66 % it does", () => {
    expect(choicePassed(2, 3, 67)).toBe(false);
    expect(choicePassed(2, 3, 66)).toBe(true);
    expect(choicePassed(1, 1, 1)).toBe(true);
    expect(choicePassed(0, 1, 1)).toBe(false);
  });

  test("no choice questions passes at any mark", () => {
    expect(choicePassed(0, 0, 100)).toBe(true);
    expect(choicePassed(0, 0, 1)).toBe(true);
  });

  test("the same through grade on real lists", () => {
    const five = singles(5);
    expect(choicePassed(grade(five, answersOf(5, 4)).correct, 5, 80)).toBe(true);
    expect(choicePassed(grade(five, answersOf(5, 3)).correct, 5, 80)).toBe(false);
    const ten = singles(10);
    expect(choicePassed(grade(ten, answersOf(10, 8)).correct, 10, 80)).toBe(true);
    expect(choicePassed(grade(ten, answersOf(10, 7)).correct, 10, 80)).toBe(false);
  });

  test("percentOf: rounded down; 100 with no choice questions", () => {
    expect(percentOf(7, 10)).toBe(70);
    expect(percentOf(2, 3)).toBe(66);
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(29, 30)).toBe(96); // 96.67
    expect(percentOf(4, 5)).toBe(80);
    expect(percentOf(0, 7)).toBe(0);
    expect(percentOf(10, 10)).toBe(100);
    expect(percentOf(0, 0)).toBe(100);
  });
});

describe("the attempt's status at the submit", () => {
  test("failed under the mark; passed with no open questions; review with open ones", () => {
    const withOpen = [choice("q1", ["a", "b"], ["a"]), open("q2")];
    const choiceOnly = [choice("q1", ["a", "b"], ["a"])];
    expect(hasOpen(withOpen)).toBe(true);
    expect(hasOpen(choiceOnly)).toBe(false);
    expect(submitStatus(withOpen, 0, 1, 80)).toBe("failed"); // failed even with open answers: Maria never sees them
    expect(submitStatus(choiceOnly, 1, 1, 80)).toBe("passed");
    expect(submitStatus(withOpen, 1, 1, 80)).toBe("review");
    expect(submitStatus([open("q1")], 0, 0, 100)).toBe("review"); // only open questions: always to Maria
  });
});

describe("Maria's review of the open answers (spec §5.4)", () => {
  const questions = [choice("q1", ["a", "b"], ["a"]), open("q2"), open("q3")];

  test("every open question with a verdict; comments cleaned and trimmed, '' when none; choice questions and anything else left out", () => {
    const r = checkReview(questions, { q1: { verdict: "fix", comment: "x" }, q2: { verdict: "ok" }, q3: { verdict: "fix", comment: "  Kirjuta pikemalt\u0000 " }, q9: { verdict: "ok" } });
    expect(r).toEqual({ ok: true, review: { q2: { verdict: "ok", comment: "" }, q3: { verdict: "fix", comment: "Kirjuta pikemalt" } } });
    expect(checkReview(questions, { q2: { verdict: "ok", comment: " Hea " }, q3: { verdict: "ok", comment: "" } })).toEqual({
      ok: true,
      review: { q2: { verdict: "ok", comment: "Hea" }, q3: { verdict: "ok", comment: "" } },
    });
  });

  test("incomplete: an open question without 'ok' or 'fix', or no object at all", () => {
    expect(checkReview(questions, { q2: { verdict: "ok" } })).toEqual({ ok: false, error: "incomplete" });
    expect(checkReview(questions, { q2: { verdict: "ok" }, q3: { verdict: "maybe" } })).toEqual({ ok: false, error: "incomplete" });
    expect(checkReview(questions, { q2: { verdict: "ok" }, q3: "ok" })).toEqual({ ok: false, error: "incomplete" });
    for (const raw of [null, "x", []]) expect(checkReview(questions, raw)).toEqual({ ok: false, error: "incomplete" });
  });

  test("comment: a 'fix' needs a non-blank comment; tooLong: a comment over 2000 characters (before the comment rule)", () => {
    expect(checkReview(questions, { q2: { verdict: "ok" }, q3: { verdict: "fix", comment: "   " } })).toEqual({ ok: false, error: "comment" });
    expect(checkReview(questions, { q2: { verdict: "ok", comment: "x".repeat(2000) }, q3: { verdict: "fix", comment: "y" } })).toMatchObject({ ok: true });
    expect(checkReview(questions, { q2: { verdict: "ok", comment: "x".repeat(2001) }, q3: { verdict: "fix", comment: "" } })).toEqual({ ok: false, error: "tooLong" });
    expect(checkReview(questions, { q2: { verdict: "ok" }, q3: { verdict: "fix", comment: "z".repeat(2001) } })).toEqual({ ok: false, error: "tooLong" });
  });

  test("no open questions: an empty review", () => {
    expect(checkReview([choice("q1", ["a", "b"], ["a"])], {})).toEqual({ ok: true, review: {} });
  });

  test("reviewStatus: passed when every open answer is ok, else fix; fixAnswers names the fix ones", () => {
    expect(reviewStatus({ q2: { verdict: "ok", comment: "" }, q3: { verdict: "ok", comment: "Hea" } })).toBe("passed");
    expect(reviewStatus({ q2: { verdict: "ok", comment: "" }, q3: { verdict: "fix", comment: "Paranda" } })).toBe("fix");
    expect(reviewStatus({})).toBe("passed");
    expect(fixAnswers({ q2: { verdict: "fix", comment: "a" }, q3: { verdict: "ok", comment: "" }, q4: { verdict: "fix", comment: "b" } })).toEqual(["q2", "q4"]);
    expect(fixAnswers({ q2: { verdict: "ok", comment: "" } })).toEqual([]);
    expect(fixAnswers(null)).toEqual([]);
  });
});

describe("tries and the test's state (spec §3.3)", () => {
  const tries = (...statuses: AttemptStatus[]) => statuses.map((status, i) => ({ number: i + 1, status }));

  test("triesAllowed: the course's tries plus each reopen's", () => {
    expect(triesAllowed(3, 0)).toBe(3);
    expect(triesAllowed(3, 3)).toBe(6);
    expect(triesAllowed(1, 2)).toBe(3);
  });

  test("none before the first attempt, with every try left", () => {
    expect(testState([], 3)).toEqual({ kind: "none", triesLeft: 3 });
    expect(testState([], triesAllowed(3, 3))).toEqual({ kind: "none", triesLeft: 6 });
  });

  test("open after a failed attempt while tries are left; used once every allowed try failed", () => {
    expect(testState(tries("failed"), 3)).toEqual({ kind: "open", triesLeft: 2 });
    expect(testState(tries("failed", "failed"), 3)).toEqual({ kind: "open", triesLeft: 1 });
    expect(testState(tries("failed", "failed", "failed"), 3)).toEqual({ kind: "used" });
    expect(testState(tries("failed"), 1)).toEqual({ kind: "used" });
  });

  test("extraTries: a reopen after the tries were used opens it again with the new tries", () => {
    const used = tries("failed", "failed", "failed");
    expect(testState(used, triesAllowed(3, 0))).toEqual({ kind: "used" });
    expect(testState(used, triesAllowed(3, 3))).toEqual({ kind: "open", triesLeft: 3 });
    expect(testState(tries("failed", "failed", "failed", "failed", "failed", "failed"), triesAllowed(3, 3))).toEqual({ kind: "used" });
  });

  test("review and fix wait for Maria and for the student; passed stays passed whatever came before; any order", () => {
    expect(testState(tries("failed", "review"), 3)).toEqual({ kind: "review" });
    expect(testState(tries("failed", "fix"), 3)).toEqual({ kind: "fix" });
    expect(testState(tries("review"), 1)).toEqual({ kind: "review" }); // the last try waits: not "used"
    expect(testState(tries("failed", "failed", "passed"), 3)).toEqual({ kind: "passed" });
    expect(testState([{ number: 2, status: "passed" }, { number: 1, status: "failed" }], 1)).toEqual({ kind: "passed" });
  });
});

describe("the practical status (spec §3.4's table)", () => {
  const sent = (verdicts: ("ok" | "fix" | null)[]): SentProtocol => ({ stages: verdicts.map((_, i) => ({ title: `P${i}`, note: "" })), generalNote: "", verdicts });

  test("open: no row, or round 0 (also with notes Maria sent before the submission)", () => {
    expect(practicalStatus(null)).toBe("open");
    expect(practicalStatus({ round: 0, sentRound: null, sent: null })).toBe("open");
    expect(practicalStatus({ round: 0, sentRound: 0, sent: sent([]) })).toBe("open");
  });

  test("review: submitted and not assessed in this round (none yet, or only an earlier one)", () => {
    expect(practicalStatus({ round: 1, sentRound: null, sent: null })).toBe("review");
    expect(practicalStatus({ round: 2, sentRound: 1, sent: sent(["ok", "fix"]) })).toBe("review");
  });

  test("fix: this round's send marked a point 'fix'; passed: it marked none", () => {
    expect(practicalStatus({ round: 1, sentRound: 1, sent: sent(["ok", "fix"]) })).toBe("fix");
    expect(practicalStatus({ round: 2, sentRound: 2, sent: sent(["ok", "ok"]) })).toBe("passed");
    expect(practicalStatus({ round: 1, sentRound: 1, sent: { stages: [], generalNote: "" } })).toBe("passed"); // no verdicts in the copy
  });

  test("sentFixPoints: the 0-based points the last send marked 'fix'", () => {
    expect(sentFixPoints(sent(["ok", "fix", null, "fix"]))).toEqual([1, 3]);
    expect(sentFixPoints(sent(["ok"]))).toEqual([]);
    expect(sentFixPoints({ stages: [], generalNote: "" })).toEqual([]);
    expect(sentFixPoints(null)).toEqual([]);
  });
});

describe("the steps (spec §4.1, §4.4) and the completion rule", () => {
  const NONE: TestState = { kind: "none", triesLeft: 3 };
  /** A course with lessons, questions and points, 8 lessons of 8 done, no attempt, nothing submitted. */
  const inputs = (over: Partial<StepInputs> = {}): StepInputs => ({
    lessonsDone: 8, lessonsTotal: 8, hasQuestions: true, test: NONE, hasPoints: true, practical: "open", practicalRound: 0, completedAt: null, ...over,
  });

  test("the lessons: open until done >= total; a course without lessons is done", () => {
    expect(courseSteps(inputs({ lessonsDone: 7 })).lessons).toEqual({ done: 7, total: 8, state: "open" });
    expect(courseSteps(inputs()).lessons).toEqual({ done: 8, total: 8, state: "done" });
    expect(courseSteps(inputs({ lessonsDone: 0, lessonsTotal: 0 })).lessons.state).toBe("done");
  });

  test("the test: locked until the lessons are done; open then, with the tries left", () => {
    expect(courseSteps(inputs({ lessonsDone: 7 })).test).toEqual({ state: "locked", triesLeft: 3 });
    expect(courseSteps(inputs()).test).toEqual({ state: "open", triesLeft: 3 });
  });

  test("the test: an attempt made opens it whatever the lessons (a lesson Maria added later locks nothing again)", () => {
    expect(courseSteps(inputs({ lessonsDone: 8, lessonsTotal: 9, test: { kind: "open", triesLeft: 2 } })).test).toEqual({ state: "open", triesLeft: 2 });
    expect(courseSteps(inputs({ lessonsDone: 8, lessonsTotal: 9, test: { kind: "review" } })).test).toEqual({ state: "review", triesLeft: null });
    expect(courseSteps(inputs({ lessonsDone: 8, lessonsTotal: 9, test: { kind: "passed" } })).test).toEqual({ state: "done", triesLeft: null });
  });

  test("the test: review, fix, passed and used", () => {
    expect(courseSteps(inputs({ test: { kind: "review" } })).test).toEqual({ state: "review", triesLeft: null });
    expect(courseSteps(inputs({ test: { kind: "fix" } })).test).toEqual({ state: "fix", triesLeft: null });
    expect(courseSteps(inputs({ test: { kind: "passed" } })).test).toEqual({ state: "done", triesLeft: null });
    expect(courseSteps(inputs({ test: { kind: "used" } })).test).toEqual({ state: "used", triesLeft: 0 });
  });

  test("the practical work: locked until the test is passed, whatever the test's state", () => {
    for (const test of [NONE, { kind: "open", triesLeft: 1 }, { kind: "review" }, { kind: "fix" }, { kind: "used" }] as TestState[])
      expect(courseSteps(inputs({ test })).practical, test.kind).toEqual({ state: "locked", round: 0 });
    expect(courseSteps(inputs({ test: { kind: "passed" } })).practical).toEqual({ state: "open", round: 0 });
  });

  test("the practical work: open, review, fix and passed → open, review, fix, done, with the round", () => {
    const passed: TestState = { kind: "passed" };
    expect(courseSteps(inputs({ test: passed, practical: "review", practicalRound: 1 })).practical).toEqual({ state: "review", round: 1 });
    expect(courseSteps(inputs({ test: passed, practical: "fix", practicalRound: 1 })).practical).toEqual({ state: "fix", round: 1 });
    expect(courseSteps(inputs({ test: passed, practical: "open", practicalRound: 1 })).practical).toEqual({ state: "open", round: 1 }); // a fix round being prepared
    expect(courseSteps(inputs({ test: passed, practical: "passed", practicalRound: 2 })).practical).toEqual({ state: "done", round: 2 });
  });

  test("the practical work stays open once submitted (round > 0), even when the test is not passed now (Maria added questions later)", () => {
    expect(courseSteps(inputs({ test: NONE, practical: "review", practicalRound: 1 })).practical).toEqual({ state: "review", round: 1 });
    expect(courseSteps(inputs({ test: NONE, practical: "fix", practicalRound: 1 })).practical).toEqual({ state: "fix", round: 1 });
  });

  test("no questions: no test step, and the practical work opens with the lessons done", () => {
    const noTest = inputs({ hasQuestions: false });
    expect(courseSteps(noTest).test).toBeNull();
    expect(courseSteps(noTest).practical).toEqual({ state: "open", round: 0 });
    expect(courseSteps({ ...noTest, lessonsDone: 7 }).practical).toEqual({ state: "locked", round: 0 });
    expect(courseSteps({ ...noTest, lessonsDone: 7, practical: "review", practicalRound: 1 }).practical).toEqual({ state: "review", round: 1 });
  });

  test("no points: no practical step; neither: lessons only", () => {
    expect(courseSteps(inputs({ hasPoints: false })).practical).toBeNull();
    const lessonsOnly = courseSteps(inputs({ hasQuestions: false, hasPoints: false }));
    expect([lessonsOnly.test, lessonsOnly.practical]).toEqual([null, null]);
  });

  test("a set completedAt makes every present step done, with its ISO date (also after a lesson or a question added later)", () => {
    const at = new Date("2026-11-14T10:00:00Z");
    expect(courseSteps(inputs({ lessonsDone: 8, lessonsTotal: 9, test: NONE, practical: "open", completedAt: at }))).toEqual({
      lessons: { done: 8, total: 9, state: "done" },
      test: { state: "done", triesLeft: null },
      practical: { state: "done", round: 0 },
      completedAt: "2026-11-14T10:00:00.000Z",
    });
    expect(courseSteps(inputs({ hasQuestions: false, hasPoints: false, completedAt: at }))).toEqual({
      lessons: { done: 8, total: 8, state: "done" },
      test: null,
      practical: null,
      completedAt: "2026-11-14T10:00:00.000Z",
    });
    expect(courseSteps(inputs()).completedAt).toBeNull();
  });

  test("isComplete: every present step done; completedAt is not consulted", () => {
    const passed: TestState = { kind: "passed" };
    expect(isComplete(inputs({ test: passed, practical: "passed", practicalRound: 1 }))).toBe(true);
    expect(isComplete(inputs({ test: passed, practical: "fix", practicalRound: 1 }))).toBe(false);
    expect(isComplete(inputs({ test: passed, practical: "review", practicalRound: 1 }))).toBe(false);
    expect(isComplete(inputs({ test: { kind: "review" } }))).toBe(false);
    expect(isComplete(inputs({ test: passed, practical: "open", completedAt: new Date() }))).toBe(false); // the date alone completes nothing
    // a course without points completes with the test, one without a test with the practical work, one with neither with the lessons
    expect(isComplete(inputs({ hasPoints: false, test: passed }))).toBe(true);
    expect(isComplete(inputs({ hasPoints: false, test: passed, lessonsDone: 7 }))).toBe(false);
    expect(isComplete(inputs({ hasQuestions: false, practical: "passed", practicalRound: 1 }))).toBe(true);
    expect(isComplete(inputs({ hasQuestions: false, hasPoints: false }))).toBe(true);
    expect(isComplete(inputs({ hasQuestions: false, hasPoints: false, lessonsDone: 7 }))).toBe(false);
  });
});
