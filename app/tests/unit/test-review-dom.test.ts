// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ReopenTest } from "@/components/admin/ReopenTest";
import { TestReview, type ReviewedAttempt } from "@/components/admin/TestReview";
import type { TestQuestion } from "@/db/schema";
import { startMarks, type Marks } from "@/domain/test-review-marks";
import { adminEt } from "@/i18n/dict/admin";
import { stubFetch } from "../fakes";

// Maria's test review (e-course completion, spec §5.4; admin UX pass B15) and "Ava test uuesti" (§5.2), in a browser-like document (happy-dom)
// with the server actions and the marks' route answered here: the choice part read-only with every pick against the key; the open answers' verdicts
// and comments, saved to the server as she marks them (the editors' autosave: the chip, the browser's own copy until the server has them, the
// conflict, the attempt gone), a pressed verdict cleared by a second tap, the send button that counts them, the send refused in place when a
// mark is missing; a rewrite back for review; the read-only review; the reopen's ConfirmPanel.

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
const SUBMITTED = "2026-10-19T07:00:00.000Z";
const ROUTE = "/api/admin/testi-hinnang/41";
const NONE = { verdict: null, comment: "" };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);

/**
 * The marks' route (api/admin/testi-hinnang/<attempt>, tests/db/test-review-route.test.ts is the real one) as the screen needs it: the draft's version
 * and marks; a save from another version is a 409 with the stored marks; the flags say it is unreachable, the attempt reviewed elsewhere (409, no
 * marks), or gone (404). `log` is the order of what reached the server.
 */
const remote = { version: 0, marks: {} as Marks, down: false, reviewed: false, gone: false, log: [] as string[] };
const resetRemote = () => Object.assign(remote, { version: 0, marks: startMarks(QUESTIONS, null), down: false, reviewed: false, gone: false, log: [] });
const route = (init: RequestInit | undefined): Response => {
  if (remote.down) throw new TypeError("Failed to fetch");
  if (remote.gone) return Response.json({ ok: false, error: "notFound" }, { status: 404 });
  const body = JSON.parse(String(init?.body)) as { version: string; patch: Marks };
  if (remote.reviewed) return Response.json({ ok: false, error: "conflict", version: "0", value: null }, { status: 409 });
  if (String(remote.version) !== body.version) return Response.json({ ok: false, error: "conflict", version: String(remote.version), value: remote.marks }, { status: 409 });
  remote.marks = { ...remote.marks, ...body.patch };
  remote.version += 1;
  remote.log.push("save");
  return Response.json({ ok: true, version: String(remote.version), savedAt: "2026-10-19T08:00:00.000Z" });
};
let fetched: ReturnType<typeof stubFetch>;
/** The saves that reached the route, as the engine sent them. */
const saves = () => fetched.calls.filter((c) => c.url === ROUTE).map((c) => c.body as { version: string; patch: Marks });

const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
/** What the page hands over: the marks as the server holds them (its draft, or the form's start with version "0"). */
const draftOf = () => ({ version: String(remote.version), value: remote.marks });
const show = async (over: Partial<ReviewedAttempt> = {}, head?: unknown) => {
  await act(async () =>
    root.render(createElement(TestReview, { attempt: { id: 41, status: "review", questions: QUESTIONS, answers: ANSWERS, review: null, submittedAt: SUBMITTED, ...over }, t, draft: draftOf(), head: head as never })),
  );
  await settle();
};
/** The page loaded again: a new mount, the same browser storage, the server's marks read afresh. */
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
/** Leaving the box (React's onBlur listens to focusout). */
const leave = async (el: Element | null) => {
  await act(async () => void el!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await settle();
};
const answer = (id: string) => $(`[data-review-answer="${id}"]`)!;
const verdict = (id: string, v: "ok" | "fix") => $(`[data-review-answer="${id}"] [data-review-verdict="${v}"]`);
const pressed = (id: string, v: "ok" | "fix") => verdict(id, v)!.getAttribute("aria-pressed");
const comment = (id: string) => $<HTMLTextAreaElement>(`[data-review-answer="${id}"] [data-review-comment]`);
const problem = (id: string) => answer(id).querySelector("[data-review-problem]");
const sendButton = () => $("[data-review-send]")!.textContent;
const chip = () => $("[data-save-status]")?.getAttribute("data-save-kind");
const restore = () => $("[data-review-restore]");
/** The keys the editors' autosave keeps its browser copy under (autosave/engine.ts draftKey). */
const copies = () => Object.keys(localStorage).filter((k) => k.startsWith("mslab-draft:"));
const send = async () => {
  await act(async () => $<HTMLFormElement>("[data-review-form]")!.requestSubmit());
  await settle();
};

beforeEach(() => {
  actions.review.mockReset();
  actions.reopen.mockReset();
  localStorage.clear();
  resetRemote();
  fetched = stubFetch((_url, init) => route(init));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
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
    expect(pressed("qavatud1", "ok")).toBe("false");
    expect(verdict("qavatud1", "fix")!.textContent).toBe("Paranda");
    expect(comment("qavatud2")!.value).toBe("");
  });

  test("B15: the send button says how many answers are right and how many wrong (README A4); „, 0 vale“ goes when none is wrong, „0 õige“ stays; a pressed verdict tapped again is cleared", async () => {
    await show();
    expect(sendButton()).toBe("Saada · 0 õige");
    await click(verdict("qavatud1", "ok"));
    expect(sendButton()).toBe("Saada · 1 õige");
    await click(verdict("qavatud2", "fix"));
    expect(sendButton()).toBe("Saada · 1 õige, 1 vale");
    await click(verdict("qavatud1", "fix"));
    expect(sendButton()).toBe("Saada · 0 õige, 2 vale");
    // the pressed „Paranda“ tapped again: no verdict, as on the practical work's cards
    await click(verdict("qavatud1", "fix"));
    expect([pressed("qavatud1", "ok"), pressed("qavatud1", "fix")]).toEqual(["false", "false"]);
    expect(sendButton()).toBe("Saada · 0 õige, 1 vale");
    await click(verdict("qavatud2", "ok"));
    await click(verdict("qavatud2", "ok"));
    expect([pressed("qavatud2", "ok"), pressed("qavatud2", "fix")]).toEqual(["false", "false"]);
    await click(verdict("qavatud1", "ok"));
    await click(verdict("qavatud2", "ok"));
    expect(sendButton()).toBe("Saada · 2 õige");
    // and what a tap came to is on the server: the last save is the cleared mark, with the comment it had
    expect(remote.marks).toEqual({ qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "ok", comment: "" } });
  });

  test("B15: a tap is saved at once and a comment when she leaves its box (the chip says so); the screen restores the marks from the server on reload, and keeps nothing in the old local key", async () => {
    await show();
    expect(chip()).toBe("saved");
    await click(verdict("qavatud2", "fix"));
    expect(saves()).toEqual([{ version: "0", patch: { qavatud2: { verdict: "fix", comment: "" } } }]);
    expect(chip()).toBe("saved");
    await type(comment("qavatud2"), "Lisa allergiatest.");
    expect(saves()).toHaveLength(1); // (typing waits out its 1.5 s)
    expect(chip()).toBe("dirty");
    await leave(comment("qavatud2"));
    expect(saves()[1]).toEqual({ version: "1", patch: { qavatud2: { verdict: "fix", comment: "Lisa allergiatest." } } });
    expect(chip()).toBe("saved");
    expect(remote.marks.qavatud2).toEqual({ verdict: "fix", comment: "Lisa allergiatest." });
    expect(copies()).toEqual([]); // the server has it: the browser's own copy is gone
    expect(localStorage.getItem("mslab-review:41")).toBeNull(); // the old local-only draft is not written any more
    // another browser, or the phone: the page reads the marks from the server
    await reload();
    expect(pressed("qavatud2", "fix")).toBe("true");
    expect(comment("qavatud2")!.value).toBe("Lisa allergiatest.");
    expect(pressed("qavatud1", "ok")).toBe("false");
    expect(sendButton()).toBe("Saada · 0 õige, 1 vale");
    expect(chip()).toBe("saved");
    expect(saves()).toHaveLength(2); // (nothing is saved again just for opening it)
    // and the next save goes on from the version the page was given
    await click(verdict("qavatud1", "ok"));
    expect(saves()[2]).toEqual({ version: "2", patch: { qavatud1: { verdict: "ok", comment: "" } } });
  });

  test("B15: the status chip sits at the right end of the page's heading row; a review that is read-only has none", async () => {
    await show({}, createElement("div", { "data-head-left": "" }, "Eliis Tamm"));
    const row = $("[data-review-head]")!;
    expect(row.querySelector("[data-head-left]")!.textContent).toBe("Eliis Tamm");
    expect(row.querySelector("[data-save-status]")).not.toBeNull();
    expect($("[data-review-form] [data-save-status]")).toBeNull();
    await show({ status: "fix", review: null }, createElement("div", { "data-head-left": "" }, "Eliis Tamm"));
    expect($("[data-review-head] [data-head-left]")!.textContent).toBe("Eliis Tamm");
    expect($("[data-save-status]")).toBeNull();
  });

  test("B15: while the server cannot be reached the marks stay on the screen and in this browser; a reload resumes them, and they are saved when it is back", async () => {
    remote.down = true;
    await show();
    await click(verdict("qavatud1", "fix"));
    await type(comment("qavatud1"), "Kirjuta täpsemalt.");
    await leave(comment("qavatud1"));
    expect(chip()).toBe("retry");
    expect(copies()).toHaveLength(1);
    expect(pressed("qavatud1", "fix")).toBe("true");
    // the page is opened again (nothing is on the server): the browser's copy comes back, and goes up as soon as the server answers
    remote.down = false;
    await reload();
    expect(pressed("qavatud1", "fix")).toBe("true");
    expect(comment("qavatud1")!.value).toBe("Kirjuta täpsemalt.");
    expect(sendButton()).toBe("Saada · 0 õige, 1 vale");
    expect(remote.marks.qavatud1).toEqual({ verdict: "fix", comment: "Kirjuta täpsemalt." });
    expect(chip()).toBe("saved");
    expect(copies()).toEqual([]);
  });

  test("B15: the browser's copy belongs to the answers it was typed on: after the student rewrote them it is not put onto the new ones", async () => {
    remote.down = true;
    await show();
    await click(verdict("qavatud2", "fix"));
    expect(copies()).toHaveLength(1);
    const REWRITTEN = "2026-10-19T09:30:00.000Z";
    const tried = saves().length; // (the one that did not get through)
    remote.down = false;
    await reload({ submittedAt: REWRITTEN, answers: { ...ANSWERS, qavatud2: "Jätkan tööd, aga küsin enne arsti käest." } });
    expect(pressed("qavatud2", "fix")).toBe("false");
    expect(answer("qavatud2").textContent).toContain("küsin enne arsti käest");
    expect(saves()).toHaveLength(tried); // (the old copy was not sent over the new answers)
    expect(remote.version).toBe(0);
    // a broken copy under the right key is left aside too
    localStorage.setItem(`mslab-draft:testi-hinnang:41-${Date.parse(REWRITTEN)}:t9`, "{not json");
    await reload({ submittedAt: REWRITTEN });
    expect(pressed("qavatud2", "fix")).toBe("false");
  });

  test("B15: marks changed on another device meanwhile: the chip says so and „Taasta minu tekst“ saves this screen's marks over them; the form keeps what she sees", async () => {
    await show();
    await click(verdict("qavatud1", "ok"));
    remote.version = 5;
    remote.marks = { qavatud1: { verdict: "fix", comment: "Teisest seadmest." }, qavatud2: NONE };
    await click(verdict("qavatud2", "fix"));
    expect(chip()).toBe("conflict");
    expect(pressed("qavatud1", "ok")).toBe("true");
    expect(pressed("qavatud2", "fix")).toBe("true");
    expect(restore()!.textContent).toBe("Taasta minu tekst");
    expect(saves().at(-1)).toMatchObject({ version: "1" }); // (its first save was made on version 0 and answered 1)
    await click(restore());
    expect(chip()).toBe("saved");
    expect(restore()).toBeNull();
    expect(remote.marks).toEqual({ qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "fix", comment: "" } });
    expect(pressed("qavatud1", "ok")).toBe("true");
  });

  test("I2: „Saada“ is held while a conflict with other marks is open (as the protocol and the practical work hold theirs): the conflict's sentence at the button, nothing sent; „Taasta minu tekst“ takes it away", async () => {
    actions.review.mockResolvedValue({ kind: "reviewed", status: "passed", completed: false });
    await show();
    await click(verdict("qavatud1", "ok"));
    remote.version = 5;
    remote.marks = { qavatud1: { verdict: "fix", comment: "Teisest seadmest." }, qavatud2: NONE };
    await click(verdict("qavatud2", "ok"));
    expect(chip()).toBe("conflict");
    // (the form is complete: only the conflict stops the send; and it is said first, before a missing mark would be)
    await send();
    expect(actions.review).not.toHaveBeenCalled();
    expect($("[data-review-error]")!.textContent).toBe(adminEt.autosave.conflict);
    expect(document.activeElement).toBe($("[data-review-error]"));
    expect(pressed("qavatud1", "ok")).toBe("true"); // (what she sees is what she keeps)
    await click(restore());
    expect(chip()).toBe("saved");
    expect($("[data-review-error]")!.textContent).toBe(""); // „Taasta minu tekst“ clears it
    await send();
    expect(actions.review).toHaveBeenCalledTimes(1);
    expect(actions.review.mock.calls[0][0].review).toEqual({ qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "ok", comment: "" } });
  });

  test("M1: what Postgres cannot store (a control character from a paste; a lone surrogate goes the same way, see the route test) is taken out of a comment as it is typed, so no save is refused for it; an emoji stays", async () => {
    await show();
    await click(verdict("qavatud2", "fix"));
    await type(comment("qavatud2"), "a\u0007b\u000cc \u{1F600}");
    // (Word's page break becomes a line break, the bell goes)
    expect(comment("qavatud2")!.value).toBe("ab\nc \u{1F600}");
    await leave(comment("qavatud2"));
    expect(chip()).toBe("saved");
    expect(remote.marks.qavatud2).toEqual({ verdict: "fix", comment: "ab\nc \u{1F600}" });
  });

  test("M4: the old local-only copy of the marks (mslab-review:<attempt>) is removed when the form opens, so it does not linger; another attempt's stays", async () => {
    localStorage.setItem("mslab-review:41", JSON.stringify({ marks: { qavatud1: { verdict: "ok", comment: "" } }, at: 1, submittedAt: SUBMITTED }));
    localStorage.setItem("mslab-review:42", "{}");
    await show();
    expect(localStorage.getItem("mslab-review:41")).toBeNull();
    expect(localStorage.getItem("mslab-review:42")).toBe("{}");
    expect(pressed("qavatud1", "ok")).toBe("false"); // (it is not put onto the form: the server's marks are the form's)
  });

  test("B15: the attempt was sent from her other device meanwhile: the chip says it changed, there is nothing to restore over; „Saada“ then says it is stale", async () => {
    actions.review.mockResolvedValue({ kind: "stale" });
    await show();
    remote.reviewed = true;
    await click(verdict("qavatud1", "ok"));
    expect(chip()).toBe("conflict");
    expect(restore()).toBeNull();
    expect(pressed("qavatud1", "ok")).toBe("true");
    await click(verdict("qavatud2", "ok"));
    await send();
    expect($("[data-review-error]")!.textContent).toBe(t.errors.stale);
  });

  test("B15: the attempt is gone (404): „Seda katset enam ei ole. Tekst on selles seadmes alles.“", async () => {
    await show();
    remote.gone = true;
    await click(verdict("qavatud1", "ok"));
    expect(chip()).toBe("gone");
    expect($("[data-save-status]")!.textContent).toContain("Seda katset enam ei ole. Tekst on selles seadmes alles.");
    expect(pressed("qavatud1", "ok")).toBe("true");
  });

  test("B15: a comment over its limit is held back and said at its box (the others still save); the chip leads to it", async () => {
    await show();
    await click(verdict("qavatud1", "ok"));
    await click(verdict("qavatud2", "fix"));
    await type(comment("qavatud2"), "x".repeat(2001));
    await leave(comment("qavatud2"));
    expect(chip()).toBe("invalid");
    expect(problem("qavatud2")!.textContent).toBe("Liiga pikk: 2001 / 2000 märki.");
    expect(comment("qavatud2")!.getAttribute("aria-invalid")).toBe("true");
    expect(remote.marks.qavatud2).toEqual({ verdict: "fix", comment: "" }); // (the long text was not sent)
    await click($("[data-save-status] button"));
    expect(document.activeElement).toBe(comment("qavatud2"));
    await type(comment("qavatud2"), "Lühike.");
    await leave(comment("qavatud2"));
    expect(chip()).toBe("saved");
    expect(problem("qavatud2")).toBeNull();
    expect(remote.marks.qavatud2).toEqual({ verdict: "fix", comment: "Lühike." });
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

  test("sent: what she typed last is saved first, then every open answer's verdict and comment go with the answers' time the page showed; the form says so, read-only, the browser's copy is gone, and the line stays after the page's refresh", async () => {
    actions.review.mockImplementation(async () => {
      remote.log.push("review");
      return { kind: "reviewed", status: "fix", completed: false };
    });
    await show();
    await click(verdict("qavatud1", "ok"));
    await click(verdict("qavatud2", "fix"));
    await type(comment("qavatud2"), "Kirjuta, millal pöördud arsti poole."); // (not left yet: still waiting out its 1.5 s)
    expect(remote.log).toEqual(["save", "save"]);
    await send();
    expect(remote.log).toEqual(["save", "save", "save", "review"]);
    expect(remote.marks.qavatud2.comment).toBe("Kirjuta, millal pöördud arsti poole.");
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
    expect(copies()).toEqual([]);
    // the action's refresh: the page hands over the attempt as the server holds it now, no longer in review (and the draft gone)
    await show({ status: "fix", review: { qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "fix", comment: "Kirjuta, millal pöördud arsti poole." } } });
    expect($('[data-review-readonly="41"]')).not.toBeNull();
    expect($("[data-review-sent]")!.textContent).toBe(t.sent.fix);
    expect(document.activeElement).toBe($("[data-review-sent]"));
    expect($("[data-save-status]")).toBeNull();
    expect(saves()).toHaveLength(3); // (a read-only review saves nothing)
  });

  test("the server's refusals are said, and nothing is lost: the marks stay on the form, on the server and, until it has them, in this browser", async () => {
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
    expect(pressed("qavatud1", "ok")).toBe("true");
    expect(remote.marks).toEqual({ qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "ok", comment: "" } });
  });

  test("a rewrite back for review: an accepted answer stays accepted; a 'Paranda' one opens again, her last comment shown; the server's marks win over that start", async () => {
    const review = { qavatud1: { verdict: "ok" as const, comment: "Hea." }, qavatud2: { verdict: "fix" as const, comment: "Lisa allergiatest." } };
    remote.marks = startMarks(QUESTIONS, review); // (the page reads the form's start through the same rule)
    await show({ review });
    expect(pressed("qavatud1", "ok")).toBe("true");
    expect(comment("qavatud1")!.value).toBe("Hea.");
    expect(pressed("qavatud2", "fix")).toBe("false");
    expect(comment("qavatud2")!.value).toBe("");
    expect(answer("qavatud2").textContent).toContain("Eelmine kommentaar: Lisa allergiatest.");
    expect(sendButton()).toBe("Saada · 1 õige");
    // she changed her mind about the accepted one and the server has that
    remote.version = 3;
    remote.marks = { qavatud1: NONE, qavatud2: { verdict: "ok", comment: "" } };
    await reload({ review });
    expect(pressed("qavatud1", "ok")).toBe("false");
    expect(pressed("qavatud2", "ok")).toBe("true");
  });

  test("read-only once reviewed: Maria's verdicts and comments, no form and no saving; an attempt that failed its choice part has its open answers unreviewed", async () => {
    await show({ status: "fix", review: { qavatud1: { verdict: "ok", comment: "" }, qavatud2: { verdict: "fix", comment: "Lisa allergiatest." } } });
    expect($("[data-review-form]")).toBeNull();
    expect($('[data-review-readonly="41"]')).not.toBeNull();
    expect(answer("qavatud1").querySelector('[data-review-shown="ok"]')!.textContent).toBe("Kinnitatud");
    expect(answer("qavatud2").textContent).toContain("Lisa allergiatest.");
    expect(document.querySelectorAll("button, textarea")).toHaveLength(0);
    await show({ status: "failed", review: null });
    expect(answer("qavatud1").textContent).toContain(t.notReviewed);
    expect(fetched.calls).toEqual([]);
  });
});

describe("ReopenTest", () => {
  const showReopen = async (used: boolean) => {
    await act(async () => root.render(createElement(ReopenTest, { accessId: 9, course: "Kulmumeistri e-koolitus", student: "Kati Kask", used, t: reopenTexts })));
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
    expect($("[data-reopen-done]")!.textContent).toBe("Test uuesti avatud: Kati Kask, katseid jäänud 3.");
    expect(document.activeElement).toBe($("[data-reopen-done]"));
    await showReopen(false); // the page's refresh: the test is open now
    expect(trigger()).toBeNull();
    expect(panel()).toBeNull();
    expect($("[data-reopen-done]")!.textContent).toBe("Test uuesti avatud: Kati Kask, katseid jäänud 3.");
  });

  test("the page is not refreshed by the action, so the test still reads as used up: the line stays, the button does not come back; reopened elsewhere meanwhile is said the same way", async () => {
    actions.reopen.mockResolvedValue({ kind: "reopened", triesLeft: 3 });
    await showReopen(true);
    await click(trigger());
    await click(panelButton("Jah, ava"));
    expect($("[data-reopen-done]")!.textContent).toBe("Test uuesti avatud: Kati Kask, katseid jäänud 3.");
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
