// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ReopenTest } from "@/components/admin/ReopenTest";
import { TestReview, type ReviewedAttempt } from "@/components/admin/TestReview";
import type { TestQuestion } from "@/db/schema";
import { adminEt } from "@/i18n/dict/admin";

// Maria's test review (e-course completion, spec §5.4) and "Ava test uuesti" (§5.2), in a browser-like document (happy-dom) with the server
// actions answered here: the choice part read-only with every pick against the key; the open answers' verdicts and comments, refused in place
// when one is missing; the draft kept in this browser until it is sent; a rewrite back for review; the read-only review; the reopen's step.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ review: vi.fn(), reopen: vi.fn() }));
vi.mock("@/server/actions/admin-assessment", () => ({ sendAssessmentAction: vi.fn(), reviewAttemptAction: actions.review, reopenTestAction: actions.reopen }));

const QUESTIONS: TestQuestion[] = [
  { id: "qvalik01", kind: "choice", text: "Mitu korda pesta pintslit?", options: [{ id: "o1oige01", text: "Pärast igat kasutust", correct: true }, { id: "o1vale01", text: "Kord nädalas", correct: false }] },
  {
    id: "qvalik02",
    kind: "choice",
    text: "Mis kuulub ettevalmistusse?",
    options: [
      { id: "o2oige01", text: "Naha puhastus", correct: true },
      { id: "o2oige02", text: "Kuju mõõtmine", correct: true },
      { id: "o2vale01", text: "Värvi segamine silma järgi", correct: false },
    ],
  },
  { id: "qavatud1", kind: "open", text: "Kirjelda oma tööde järjekorda." },
  { id: "qavatud2", kind: "open", text: "Mida teed allergia korral?" },
];
const ANSWERS = { qvalik01: ["o1oige01"], qvalik02: ["o2oige01", "o2vale01"], qavatud1: "Puhastan, siis mõõdan.", qavatud2: "Jätkan tööd." };
const t = adminEt.assessment.review;
const reopenTexts = { ...adminEt.assessment.reopen, saving: adminEt.common.saving, error: adminEt.common.saveError };
const KEY = "mslab-review:41";
const SUBMITTED = "2026-10-19T07:00:00.000Z";

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = async (over: Partial<ReviewedAttempt> = {}) => {
  await act(async () => root.render(createElement(TestReview, { attempt: { id: 41, status: "review", questions: QUESTIONS, answers: ANSWERS, review: null, submittedAt: SUBMITTED, ...over }, t })));
  await settle();
};
/** The page loaded again: a new mount, the same browser storage. */
const reload = async (over: Partial<ReviewedAttempt> = {}) => {
  await act(async () => root.unmount());
  root = createRoot(container);
  await show(over);
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const type = async (el: HTMLTextAreaElement | null, value: string) => {
  expect(el, "the box to type in").not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};
const answer = (id: string) => $(`[data-review-answer="${id}"]`)!;
const verdict = (id: string, v: "ok" | "fix") => $(`[data-review-answer="${id}"] [data-review-verdict="${v}"]`);
const comment = (id: string) => $<HTMLTextAreaElement>(`[data-review-answer="${id}"] [data-review-comment]`);
const problem = (id: string) => answer(id).querySelector("[data-review-problem]");
const send = async () => {
  await act(async () => $<HTMLFormElement>("[data-review-form]")!.requestSubmit());
  await settle();
};

beforeEach(() => {
  actions.review.mockReset();
  actions.reopen.mockReset();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("TestReview", () => {
  test("the choice part is read-only: every pick marked against the key; a question is right only with exactly its correct options", async () => {
    await show();
    const one = $('[data-review-question="qvalik01"]')!;
    const two = $('[data-review-question="qvalik02"]')!;
    expect([one.dataset.reviewRight, two.dataset.reviewRight]).toEqual(["true", "false"]);
    expect(one.textContent).toContain("1.");
    expect(one.textContent).toContain(t.right);
    expect(two.textContent).toContain(t.wrong);
    const option = (id: string) => $(`[data-review-option="${id}"]`)!;
    expect(option("o1oige01").textContent).toContain("✓");
    expect(option("o2vale01").textContent).toContain("✗");
    expect(option("o2vale01").textContent).toContain(t.pickedWrong);
    expect(option("o2oige02").textContent).toContain(t.missed); // a correct one she left out
    expect(option("o1vale01").dataset.picked).toBeUndefined();
    expect(option("o2oige02").dataset.correct).toBe("true");
    expect(two.querySelectorAll("button, input, textarea")).toHaveLength(0);
    // the open answers, numbered on in the same list: her text, the two verdicts and a comment box each
    expect(answer("qavatud1").textContent).toContain("3.");
    expect(answer("qavatud1").textContent).toContain("Puhastan, siis mõõdan.");
    expect(verdict("qavatud1", "ok")!.getAttribute("aria-pressed")).toBe("false");
    expect(verdict("qavatud1", "fix")!.textContent).toBe("Paranda");
    expect(comment("qavatud2")!.value).toBe("");
  });

  test("'Saada' with an answer unmarked, or 'Paranda' without a comment, or one too long: said at that answer, nothing sent", async () => {
    await show();
    await click(verdict("qavatud2", "fix"));
    await send();
    expect(actions.review).not.toHaveBeenCalled();
    expect($("[data-review-error]")!.textContent).toBe(t.errors.incomplete);
    expect(document.activeElement).toBe($("[data-review-error]"));
    expect(problem("qavatud1")!.textContent).toBe(t.problems.verdict);
    expect(problem("qavatud2")!.textContent).toBe(t.problems.comment);
    await click(verdict("qavatud1", "ok")); // marking it takes its problem away
    expect(problem("qavatud1")).toBeNull();
    await type(comment("qavatud2"), "x".repeat(2001));
    await send();
    expect(problem("qavatud2")!.textContent).toBe("Liiga pikk: 2001 / 2000 märki.");
    expect(actions.review).not.toHaveBeenCalled();
  });

  test("sent: every open answer's verdict and comment go to the server with the answers' time the page showed; the form says so, read-only, the draft is gone, and the line stays after the page's refresh", async () => {
    actions.review.mockResolvedValue({ kind: "reviewed", status: "fix", completed: false });
    await show();
    await click(verdict("qavatud1", "ok"));
    await click(verdict("qavatud2", "fix"));
    await type(comment("qavatud2"), "Kirjuta, millal pöördud arsti poole.");
    expect(localStorage.getItem(KEY)).not.toBeNull();
    await send();
    expect(actions.review).toHaveBeenCalledTimes(1);
    expect(actions.review.mock.calls[0][0]).toEqual({
      attemptId: 41,
      review: { qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "fix", comment: "Kirjuta, millal pöördud arsti poole." } },
      submittedAt: SUBMITTED,
    });
    expect($("[data-review-sent]")!.textContent).toBe(t.sent.fix);
    expect(document.activeElement).toBe($("[data-review-sent]"));
    expect($("[data-review-send]")).toBeNull();
    expect(comment("qavatud2")).toBeNull();
    expect(answer("qavatud2").querySelector('[data-review-shown="fix"]')).not.toBeNull();
    expect(answer("qavatud2").textContent).toContain("Kirjuta, millal pöördud arsti poole.");
    expect(localStorage.getItem(KEY)).toBeNull();
    // the action's refresh: the page hands over the attempt as the server holds it now, no longer in review
    await show({ status: "fix", review: { qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "fix", comment: "Kirjuta, millal pöördud arsti poole." } } });
    expect($('[data-review-readonly="41"]')).not.toBeNull();
    expect($("[data-review-sent]")!.textContent).toBe(t.sent.fix);
    expect(document.activeElement).toBe($("[data-review-sent]"));
  });

  test("the server's refusals are said, and nothing is lost: the marks stay on the form and in this browser", async () => {
    await show();
    await click(verdict("qavatud1", "ok"));
    await click(verdict("qavatud2", "ok"));
    for (const [answerOf, text] of [
      [{ kind: "stale" }, t.errors.stale],
      [{ kind: "notFound" }, t.errors.notFound],
      [{ kind: "failed" }, t.errors.failed],
      [{ kind: "invalid", error: "comment" }, t.errors.comment],
    ] as const) {
      actions.review.mockResolvedValueOnce(answerOf);
      await send();
      expect($("[data-review-error]")!.textContent).toBe(text);
      expect($("[data-review-sent]")!.textContent).toBe("");
    }
    expect(verdict("qavatud1", "ok")!.getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem(KEY)!).marks).toEqual({ qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "ok", comment: "" } });
  });

  test("the draft: kept in this browser while she works and back after a reload; a broken one is left aside", async () => {
    await show();
    await click(verdict("qavatud2", "fix"));
    await type(comment("qavatud2"), "Lisa allergiatest.");
    await reload();
    expect(verdict("qavatud2", "fix")!.getAttribute("aria-pressed")).toBe("true");
    expect(comment("qavatud2")!.value).toBe("Lisa allergiatest.");
    localStorage.setItem(KEY, "{not json");
    await reload();
    expect(verdict("qavatud2", "fix")!.getAttribute("aria-pressed")).toBe("false");
    expect(comment("qavatud2")!.value).toBe("");
  });

  test("a draft belongs to the answers it was written for: after the student rewrote them (a stale refusal, a reload) it is not restored, and it is removed", async () => {
    await show();
    await click(verdict("qavatud2", "fix"));
    await type(comment("qavatud2"), "Lisa allergiatest.");
    expect(JSON.parse(localStorage.getItem(KEY)!).submittedAt).toBe(SUBMITTED);
    // she sends, the server says stale (the student rewrote meanwhile); the reload brings the new answers with their new time
    const REWRITTEN = "2026-10-19T09:30:00.000Z";
    await reload({ submittedAt: REWRITTEN, answers: { ...ANSWERS, qavatud2: "Jätkan tööd, aga küsin enne arsti käest." } });
    expect(verdict("qavatud2", "fix")!.getAttribute("aria-pressed")).toBe("false");
    expect(comment("qavatud2")!.value).toBe("");
    expect(answer("qavatud2").textContent).toContain("küsin enne arsti käest");
    expect(localStorage.getItem(KEY)).toBeNull();
    // what she marks on the new answers is kept for those
    await click(verdict("qavatud1", "ok"));
    expect(JSON.parse(localStorage.getItem(KEY)!).submittedAt).toBe(REWRITTEN);
    await reload({ submittedAt: REWRITTEN });
    expect(verdict("qavatud1", "ok")!.getAttribute("aria-pressed")).toBe("true");
    // a draft that names no answers' time at all (not one of this form's) is left aside too
    localStorage.setItem(KEY, JSON.stringify({ marks: { qavatud1: { verdict: "fix", comment: "Vana." } }, at: 1 }));
    await reload({ submittedAt: REWRITTEN });
    expect(verdict("qavatud1", "fix")!.getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("a rewrite back for review: an accepted answer stays accepted; a 'Paranda' one opens again, her last comment shown", async () => {
    await show({ review: { qavatud1: { verdict: "ok", comment: "Hea." }, qavatud2: { verdict: "fix", comment: "Lisa allergiatest." } } });
    expect(verdict("qavatud1", "ok")!.getAttribute("aria-pressed")).toBe("true");
    expect(comment("qavatud1")!.value).toBe("Hea.");
    expect(verdict("qavatud2", "fix")!.getAttribute("aria-pressed")).toBe("false");
    expect(comment("qavatud2")!.value).toBe("");
    expect(answer("qavatud2").textContent).toContain("Eelmine kommentaar: Lisa allergiatest.");
  });

  test("read-only once reviewed: Maria's verdicts and comments, no form; an attempt that failed its choice part has its open answers unreviewed", async () => {
    await show({ status: "fix", review: { qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "fix", comment: "Lisa allergiatest." } } });
    expect($("[data-review-form]")).toBeNull();
    expect($('[data-review-readonly="41"]')).not.toBeNull();
    expect(answer("qavatud1").querySelector('[data-review-shown="ok"]')!.textContent).toBe("Kinnitatud");
    expect(answer("qavatud2").textContent).toContain("Lisa allergiatest.");
    expect(document.querySelectorAll("button, textarea")).toHaveLength(0);
    await show({ status: "failed", review: null });
    expect(answer("qavatud1").textContent).toContain(t.notReviewed);
  });
});

describe("ReopenTest", () => {
  const showReopen = async (used: boolean) => {
    await act(async () => root.render(createElement(ReopenTest, { accessId: 9, course: "Kulmumeistri e-koolitus", used, t: reopenTexts })));
    await settle();
  };
  const panel = () => $("[data-confirm-panel]");
  const trigger = () => $("[data-reopen]");
  const panelButton = (name: string) => [...panel()!.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;

  test("one button; pressed, a ConfirmPanel takes its place (P-13: the old question split at the „?“) and the focus; „Katkesta“ and Esc go back to the button, with the focus on it", async () => {
    await showReopen(true);
    expect($("[data-reopen-done]")!.getAttribute("role")).toBe("status");
    expect(trigger()!.textContent).toBe("Ava test uuesti");
    expect(panel()).toBeNull();
    await click(trigger());
    expect(trigger()).toBeNull(); // (the panel stands where the button stood)
    expect($("[data-confirm-panel] > p")!.textContent).toBe("Kas avan testi „Kulmumeistri e-koolitus“ uuesti?");
    expect([...panel()!.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Õpilane saab sama palju katseid juurde ja kirja."]);
    expect([...panel()!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Jah, ava", "Katkesta"]);
    expect(document.activeElement).toBe(panel());
    await click(panelButton("Katkesta"));
    expect(panel()).toBeNull();
    expect(actions.reopen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
    await click(trigger());
    await act(async () => void panel()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(actions.reopen).not.toHaveBeenCalled();
  });

  test("'Jah, ava' sends the access, and the line says her tries and takes the focus (the student's drawer); the page's refresh keeps the line", async () => {
    actions.reopen.mockResolvedValue({ kind: "reopened", triesLeft: 3 });
    await showReopen(true);
    await click(trigger());
    await click(panelButton("Jah, ava"));
    expect(actions.reopen).toHaveBeenCalledWith({ accessId: 9 });
    expect($("[data-reopen-done]")!.textContent).toBe("Test on uuesti avatud: katseid jäänud 3.");
    expect(document.activeElement).toBe($("[data-reopen-done]"));
    await showReopen(false); // the page's refresh: the test is open now
    expect(trigger()).toBeNull();
    expect(panel()).toBeNull();
    expect($("[data-reopen-done]")!.textContent).toBe("Test on uuesti avatud: katseid jäänud 3.");
  });

  test("the page is not refreshed by the action, so the test still reads as used up: the line stays, the button does not come back; reopened elsewhere meanwhile is said the same way", async () => {
    actions.reopen.mockResolvedValue({ kind: "reopened", triesLeft: 3 });
    await showReopen(true);
    await click(trigger());
    await click(panelButton("Jah, ava"));
    expect($("[data-reopen-done]")!.textContent).toBe("Test on uuesti avatud: katseid jäänud 3.");
    expect(trigger()).toBeNull(); // (`used` is still true here: nothing re-read the page)
    expect(panel()).toBeNull();
    expect(actions.reopen).toHaveBeenCalledTimes(1);
    actions.reopen.mockResolvedValue({ kind: "notNeeded" });
    await act(async () => root.unmount());
    root = createRoot(container);
    await showReopen(true);
    await click(trigger());
    await click(panelButton("Jah, ava"));
    expect($("[data-reopen-done]")!.textContent).toBe("Test on juba avatud.");
    expect(trigger()).toBeNull();
  });

  test("a press while the first is on its way sends nothing more; the yes says that it is saving", async () => {
    let finish: (r: unknown) => void = () => {};
    actions.reopen.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await showReopen(true);
    await click(trigger());
    const yes = panelButton("Jah, ava");
    await click(yes);
    expect(panel()!.querySelector("button")!.textContent).toBe(adminEt.common.saving);
    await click(panel()!.querySelector("button"));
    expect(actions.reopen).toHaveBeenCalledTimes(1);
    await act(async () => finish({ kind: "reopened", triesLeft: 2 }));
    await settle();
  });

  test("a failed answer stays under the panel as an alert, the question still open to try again; not used up: no button and no panel", async () => {
    actions.reopen.mockResolvedValue({ kind: "failed" });
    await showReopen(true);
    await click(trigger());
    await click(panelButton("Jah, ava"));
    expect($("[role='alert']")!.textContent).toBe(adminEt.common.saveError);
    expect(panel()).not.toBeNull();
    actions.reopen.mockResolvedValue({ kind: "reopened", triesLeft: 3 });
    await click(panelButton("Jah, ava"));
    expect(actions.reopen).toHaveBeenCalledTimes(2);
    expect($("[role='alert']")).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await showReopen(false);
    expect(trigger()).toBeNull();
    expect(panel()).toBeNull();
  });

  test("the page came back with the test open while the question was asked: the question ends with it", async () => {
    await showReopen(true);
    await click(trigger());
    expect(panel()).not.toBeNull();
    await showReopen(false);
    expect(panel()).toBeNull();
    expect(trigger()).toBeNull();
  });
});
