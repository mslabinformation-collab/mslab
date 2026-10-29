// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEBOUNCE_MS } from "@/components/admin/autosave/constants";
import type { ManualReviewFields } from "@/domain/review";
import { adminEt } from "@/i18n/dict/admin";
import { stubFetch } from "../fakes";

// Maria's „Arvustused“ (student reviews, Task 4; spec D2, D4, §4, §5; Review Focus 5; admin UX pass piece 4c, Task 2: README C6, the Part 4 frame „C6
// Tagasiside“, S4-35 … S4-39, rulings R-a … R-e) in a browser-like document (happy-dom), with the server actions answered here: each card in each
// status and kind with its stars, its words and the buttons it allows (a student's words have no edit or delete control at all), the presses and
// what they send — „Avalda“ / „Peida“ at once with the UndoBar's „Võta tagasi“, „Kustuta“ with no question and its own „Võta tagasi“, „Avalehel“ a
// switch with no bar —, a review that is gone answered in words, the focus kept on the card (D5), the status pills without „Kõik“, and the two drawers:
// „Lisa arvustus +“ (an explicit create; „Katkesta“; the leave guard) and „Muuda“ (autosaved on api/admin/arvustus/<id>).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({
  decideReviewAction: vi.fn(),
  undoDecisionAction: vi.fn(),
  setFeaturedAction: vi.fn(),
  saveManualReviewAction: vi.fn(),
  removeReviewAction: vi.fn(),
  undoRemoveReviewAction: vi.fn(),
}));
vi.mock("@/server/actions/admin-reviews", () => actions);
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { Drawer } from "@/components/admin/Drawer";
import { LeaveGuardProvider } from "@/components/admin/LeaveGuard";
import { ListToolbar } from "@/components/admin/ListToolbar";
import { EditReviewForm, NewReviewForm } from "@/components/admin/ManualReviewForm";
import { REVIEWS_HREF, reviewPills, type ReviewCourseOption, type ReviewRowView } from "@/components/admin/review-view";
import { ReviewsPanel } from "@/components/admin/ReviewsPanel";
import { UndoProvider } from "@/components/admin/UndoBar";

const COURSES: ReviewCourseOption[] = [
  { id: 3, label: "Kulmude lamineerimine" },
  { id: 5, label: "Ripsmete tõstmine" },
  { id: 8, label: "Kulmude e-kursus (mustand)" },
];
const TODAY = "2026-10-18";
const LIST = "/admin/tagasiside?vaade=arvustused";
const E = adminEt.reviews.errors;
const EXPECTED = { status: "published", updatedAt: "2026-10-27T09:00:00.000Z", previous: { status: "pending", decidedAt: null } } as const;

const student = (over: Partial<ReviewRowView> = {}): ReviewRowView => ({
  id: 1,
  kind: "student",
  status: "pending",
  featured: false,
  text: "Soovitaksin kindlasti.\nÕppisin väga palju.",
  name: "Mari M.",
  locale: "et",
  writtenAt: "2026-10-13T08:00:00.000Z",
  course: { id: 3, title: "Kulmude lamineerimine", published: true },
  note: null,
  proof: { kind: "registration", status: "confirmed", protocolSent: true },
  feedbackId: 11,
  score: 9,
  ...over,
});
const manual = (over: Partial<ReviewRowView> = {}): ReviewRowView =>
  student({ id: 2, kind: "manual", status: "published", name: "Anu A.", text: "Väga hea koolitus.", locale: "ru", writtenAt: "2026-09-19T21:00:00.000Z", note: "Paberil vormil, 20.09.2026", proof: null, feedbackId: null, score: null, ...over });

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
const $ = <E extends Element = HTMLElement>(selector: string, within: ParentNode = document) => within.querySelector<E>(selector);
const all = <E extends Element = HTMLElement>(selector: string, within: ParentNode = document) => [...within.querySelectorAll<E>(selector)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const render = async (node: React.ReactNode) => {
  await act(async () => root.render(node));
  await settle();
};
/** The panel as the page has it: inside the (panel) layout's UndoBar provider. */
const show = (rows: ReviewRowView[], over: { filtered?: boolean; listHref?: string } = {}) =>
  render(createElement(UndoProvider, null, createElement(ReviewsPanel, { rows, filtered: over.filtered ?? false, listHref: over.listHref ?? LIST })));
// (a tap or a key press focuses the button first, as it does in a browser)
const click = async (el: Element | null) => {
  expect(el, "the element to press").not.toBeNull();
  await act(async () => {
    (el as HTMLElement).focus();
    (el as HTMLElement).click();
  });
  await settle();
};
const rowOf = (id: number) => $(`[data-review="${id}"]`)!;
/** The names of a card's controls, in order: its buttons, its „Muuda“ link and its „Avalehel“ switch. */
const controlsOf = (id: number) => all("button, a, input", rowOf(id)).map((el) => (el instanceof HTMLInputElement ? text(el.closest("label")) : text(el)));
const status = () => $("[data-reviews-status]")!.textContent;
const bar = () => $("[data-undo-bar]");
/** The bar's sentence (its button aside). */
const said = () => text($("[data-undo-bar] p"));
const undoButton = () => all<HTMLButtonElement>("[data-undo-bar] button").find((b) => text(b) === "Võta tagasi") ?? null;
const switchOf = (id: number) => $<HTMLInputElement>("[data-review-featured-toggle]", rowOf(id))!;
const type = async (el: HTMLElement, value: string) =>
  act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const choose = async (el: HTMLElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
const leave = (el: Element | null) => act(async () => void el!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
// (an input, a textarea or a select: only what they share is read)
const field = (name: string, within: ParentNode = document) => $<HTMLInputElement>(`[data-review-field="${name}"]`, within)!;
const buttonNamed = (name: string, scope: ParentNode = document) => all<HTMLButtonElement>("button", scope).find((b) => text(b) === name || b.getAttribute("aria-label") === name) ?? null;
const described = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => text(document.getElementById(id)));
const dialog = () => $<HTMLDialogElement>("dialog[data-drawer]")!;

beforeEach(() => {
  for (const fn of [...Object.values(actions), ...Object.values(router)]) fn.mockReset();
  localStorage.clear();
  history.replaceState({ __NA: true }, "", LIST);
  fetched = stubFetch(() => Response.json({ ok: false }, { status: 404 }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  fetched.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("what each card shows (the Part 4 frame; S4-37)", () => {
  test("the words in quotes (the quotes are drawn, not text), „{nimi} · {koolitus} · {dd.mm.yyyy}“, the language and the status", async () => {
    await show([student()]);
    const card = rowOf(1);
    expect($("[data-review-text]", card)!.textContent).toBe("Soovitaksin kindlasti.\nÕppisin väga palju.");
    expect($("[data-review-who]", card)!.textContent).toBe("Mari M. · Kulmude lamineerimine · 13.10.2026");
    expect($("[data-review-facts] span", card)!.textContent).toBe("Keel: ET");
    expect($("[data-review-tag]", card)!.textContent).toBe("Ootab kinnitust");
    await show([student({ status: "published" }), manual({ status: "hidden" })]);
    expect($("[data-review-tag]", rowOf(1))!.textContent).toBe("Avaldatud");
    expect($("[data-review-tag]", rowOf(2))!.textContent).toBe("Peidetud");
    expect($("[data-review-facts]", rowOf(2))!.textContent).toContain("Keel: RU");
    // the day in Estonian time: 19.09. 21:00 UTC is already the 20th
    expect($("[data-review-who]", rowOf(2))!.textContent).toBe("Anu A. · Kulmude lamineerimine · 20.09.2026");
  });

  test("the stars come from the student's „Hinne“: 9–10 five, 7–8 four, 5–6 three, 3–4 two, 0–2 one; none without a score", async () => {
    const scores = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
    await show(scores.map((score, i) => student({ id: i + 1, score })));
    expect(scores.map((_, i) => $("[data-review-stars]", rowOf(i + 1))?.textContent)).toEqual(["★★★★★", "★★★★★", "★★★★", "★★★★", "★★★", "★★★", "★★", "★★", "★", "★", "★"]);
    expect($("[data-review-stars]", rowOf(1))!.getAttribute("aria-hidden")).toBe("true");
    await show([student({ id: 1, score: null })]);
    expect($("[data-review-stars]", rowOf(1))).toBeNull();
  });

  test("a screen reader hears the score (Dim 29.10): a visually hidden „Hinne {n}/10“, the Vastused list's words, beside the aria-hidden stars; none without a score", async () => {
    const scores = [10, 7, 0];
    await show(scores.map((score, i) => student({ id: i + 1, score })));
    expect(scores.map((_, i) => $("[data-review-score]", rowOf(i + 1))?.textContent)).toEqual(["Hinne 10/10", "Hinne 7/10", "Hinne 0/10"]);
    const line = $("[data-review-score]", rowOf(1))!;
    // the column word of the Vastused list, so the two say a score alike
    expect(line.textContent).toBe(`${adminEt.feedback.col.score} 10/10`);
    // heard: not inside the stars' aria-hidden, and drawn visually hidden
    expect(line.closest("[aria-hidden]")).toBeNull();
    expect(line.className).toContain("srOnly");
    // in the card's top row, right after the stars
    expect(line.previousElementSibling).toBe($("[data-review-stars]", rowOf(1)));
    // no score, no line: an answer without a „Hinne“ and a review Maria added
    await show([student({ id: 1, score: null }), manual()]);
    expect($("[data-review-score]", rowOf(1))).toBeNull();
    expect($("[data-review-score]", rowOf(2))).toBeNull();
  });

  test("a review Maria added has no stars (no score), says „Lisatud käsitsi“ and shows her note; it has no proof", async () => {
    await show([manual()]);
    expect($("[data-review-stars]", rowOf(2))).toBeNull();
    expect($("[data-review-manual]", rowOf(2))!.textContent).toBe("Lisatud käsitsi");
    expect($("[data-review-note]", rowOf(2))!.textContent).toBe("Allikas: Paberil vormil, 20.09.2026");
    expect($("[data-review-proof]", rowOf(2))).toBeNull();
    await show([student()]);
    expect($("[data-review-note]", rowOf(1))).toBeNull();
    expect($("[data-review-manual]", rowOf(1))).toBeNull();
  });

  test("a student's review shows the proof: the registration's status with the protocol line, or the day the e-course was completed", async () => {
    await show([
      student({ id: 1 }),
      student({ id: 2, proof: { kind: "registration", status: "awaiting_prepayment", protocolSent: false } }),
      student({ id: 3, proof: { kind: "completed", completedAt: "2026-10-10T09:00:00.000Z" } }),
    ]);
    expect($("[data-review-proof]", rowOf(1))!.textContent).toBe("Registreering: Kinnitatud · Protokoll saadetud");
    expect($("[data-review-proof]", rowOf(2))!.textContent).toBe("Registreering: Ootab ettemaksu · Protokolli pole saadetud");
    expect($("[data-review-proof]", rowOf(3))!.textContent).toBe("Lõpetatud 10.10.2026");
  });

  test("a review of a draft course says „(mustand)“ after the course, as the drawer's list does", async () => {
    await show([student({ id: 1, course: { id: 8, title: "Kulmude e-kursus", published: false } }), student({ id: 2 })]);
    expect($("[data-review-who]", rowOf(1))!.textContent).toBe("Mari M. · Kulmude e-kursus (mustand) · 13.10.2026");
    expect($("[data-review-who]", rowOf(2))!.textContent).toBe("Mari M. · Kulmude lamineerimine · 13.10.2026");
    expect(COURSES[2].label).toBe("Kulmude e-kursus (mustand)");
  });

  test("R-d: each card is the anchor `arvustus-<id>`; the cards in the order given; none: its own words, narrowed by a pill: the list frame's with the way back", async () => {
    await show([student({ id: 4 }), manual({ id: 9 })]);
    expect(all("[data-review]").map((li) => li.id)).toEqual(["arvustus-4", "arvustus-9"]);
    expect(rowOf(4).getAttribute("tabindex")).toBe("-1");
    await show([]);
    expect(text($("[data-reviews-empty]"))).toBe("Arvustusi pole veel.");
    expect($("[data-review-list]")).toBeNull();
    await show([], { filtered: true });
    expect(text($("[data-reviews-empty] p"))).toBe("Selle valikuga arvustusi pole.");
    expect(text($("[data-reviews-empty] a"))).toBe("Tühjenda otsing ja filtrid");
    expect($<HTMLAnchorElement>("[data-reviews-empty] a")!.getAttribute("href")).toBe(REVIEWS_HREF);
  });
});

describe("the controls follow the status and the kind", () => {
  test.each([
    ["a pending student review", student({ status: "pending" }), ["Avalda", "Peida"]],
    ["a published student review", student({ status: "published" }), ["Peida", "Avalehel"]],
    ["a hidden student review", student({ status: "hidden" }), ["Avalda"]],
    ["a published review Maria added", manual({ status: "published" }), ["Peida", "Muuda", "Kustuta", "Avalehel"]],
    ["a hidden review Maria added", manual({ status: "hidden" }), ["Avalda", "Muuda", "Kustuta"]],
  ] as const)("%s: %j", async (_name, review, controls) => {
    await show([review]);
    expect(controlsOf(review.id)).toEqual(controls);
  });

  test("„Muuda“ and „Kustuta“ are absent on a student's review, whatever its status (her words are hers; she takes her permission back herself)", async () => {
    await show(["pending", "published", "hidden"].map((s, i) => student({ id: i + 1, status: s as ReviewRowView["status"], featured: s === "published" })));
    expect(all("[data-review-edit], [data-review-delete]")).toEqual([]);
    expect(all("textarea, select, input:not([role='switch'])")).toEqual([]);
    for (const id of [1, 2, 3]) {
      expect(controlsOf(id)).not.toContain("Muuda");
      expect(controlsOf(id)).not.toContain("Kustuta");
    }
  });

  test("„Avalda“ is the ink button, „Peida“ the outlined one; „Muuda“ opens its drawer on the view's own address (the filter kept); the names say whose review", async () => {
    await show([student({ status: "pending" }), manual({ status: "published" })], { listHref: `${LIST}&olek=avaldatud` });
    expect($("[data-review-publish]", rowOf(1))!.className).not.toContain("secondary");
    expect($("[data-review-hide]", rowOf(1))!.className).toContain("secondary");
    expect($("[data-review-hide]", rowOf(1))!.getAttribute("aria-label")).toBe("Peida: Mari M.");
    const edit = $<HTMLAnchorElement>("[data-review-edit]", rowOf(2))!;
    expect(edit.getAttribute("href")).toBe(`${LIST}&olek=avaldatud&id=2`);
    expect(edit.id).toBe("arvustus-2-muuda");
    expect(edit.getAttribute("aria-label")).toBe("Muuda: Anu A.");
  });

  test("„Avalehel“ is a switch (48 × 28: the shared Switch), on when the review is on the home page, named „Avalehel: {name}“, described by whose it is and the home hint", async () => {
    await show([student({ id: 1, status: "published" }), student({ id: 2, status: "published", featured: true, name: "Kati K." })]);
    expect(switchOf(1).getAttribute("role")).toBe("switch");
    // (Task 2 review M-5: the buttons' own pattern, „{action}: {name}“; the visible label stays „Avalehel“)
    expect(switchOf(1).getAttribute("aria-label")).toBe("Avalehel: Mari M.");
    expect(switchOf(2).getAttribute("aria-label")).toBe("Avalehel: Kati K.");
    expect(text(switchOf(2).closest("label"))).toBe("Avalehel");
    expect(switchOf(1).checked).toBe(false);
    expect(switchOf(2).checked).toBe(true);
    expect(described(switchOf(2))).toEqual(["Kati K. · Kulmude lamineerimine · 13.10.2026", "Avalehel näidatakse kuni 6 uusimat."]);
    await show([student({ id: 3, status: "pending" }), student({ id: 4, status: "hidden" })]);
    expect($("[data-review-home-hint]")).toBeNull();
  });

  test("a hidden review that is still on the home page's list carries an „Avalehel“ tag; the hint stays for it", async () => {
    await show([student({ id: 1, status: "hidden", featured: true }), student({ id: 2, status: "hidden" }), manual({ id: 5, status: "hidden", featured: true })]);
    for (const id of [1, 5]) {
      expect($("[data-review-featured-tag]", rowOf(id))!.textContent).toBe("Avalehel");
      expect($("[data-review-featured-tag]", rowOf(id))!.getAttribute("title")).toBe("Peidetud, aga avalehe valik jääb: „Avalda“ toob selle avalehele tagasi.");
    }
    expect($("[data-review-featured-tag]", rowOf(2))).toBeNull();
    expect(text($("[data-review-home-hint]"))).toBe("Avalehel näidatakse kuni 6 uusimat.");
  });
});

describe("„Avalda“ and „Peida“ act at once, with „Võta tagasi“ (R-a; S4-38)", () => {
  test("„Avalda“ sends the id and the decision; the bar says „Arvustus avaldatud.“; „Võta tagasi“ sends back what the decision answered", async () => {
    actions.decideReviewAction.mockResolvedValue({ ok: true, expected: EXPECTED });
    actions.undoDecisionAction.mockResolvedValue({ ok: true });
    await show([student()]);
    await click($("[data-review-publish]"));
    expect(actions.decideReviewAction).toHaveBeenCalledExactlyOnceWith({ id: 1, decision: "publish" });
    expect(said()).toBe("Arvustus avaldatud.");
    expect(status()).toBe("");
    expect(document.activeElement).toBe(rowOf(1)); // D5: the focus stays on the card
    await click(undoButton());
    expect(actions.undoDecisionAction).toHaveBeenCalledExactlyOnceWith({ id: 1, expected: EXPECTED });
    expect(bar()).toBeNull();
  });

  test("„Peida“: „Arvustus peidetud.“; an undo refused because the review moved meanwhile says S4-38's words in the bar", async () => {
    actions.decideReviewAction.mockResolvedValue({ ok: true, expected: { ...EXPECTED, status: "hidden" } });
    actions.undoDecisionAction.mockResolvedValue({ ok: false, error: "changed", text: E.changed });
    await show([student()]);
    await click($("[data-review-hide]"));
    expect(actions.decideReviewAction).toHaveBeenCalledWith({ id: 1, decision: "hide" });
    expect(said()).toBe("Arvustus peidetud.");
    await click(undoButton());
    expect(said()).toBe("Arvustust muudeti vahepeal. Vaata see üle.");
  });

  test("after „Võta tagasi“ the card takes the focus back, when it fell with the bar", async () => {
    actions.decideReviewAction.mockResolvedValue({ ok: true, expected: EXPECTED });
    actions.undoDecisionAction.mockResolvedValue({ ok: true });
    await show([student({ id: 1 }), student({ id: 2 })]);
    await click($("[data-review-publish]", rowOf(1)));
    await click(undoButton());
    expect(document.activeElement).toBe(rowOf(1));
  });

  test("„Avalehel“ puts a published review on the home page and off it again, with no bar; the switch shows the press at once", async () => {
    let answer: (v: unknown) => void = () => {};
    actions.setFeaturedAction.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await show([student({ id: 1, status: "published" })]);
    await click(switchOf(1));
    expect(actions.setFeaturedAction).toHaveBeenLastCalledWith({ id: 1, featured: true });
    expect(switchOf(1).checked).toBe(true);
    await act(async () => answer({ ok: true }));
    await settle();
    expect(bar()).toBeNull();
    actions.setFeaturedAction.mockResolvedValue({ ok: true });
    await show([student({ id: 1, status: "published", featured: true })]); // (the page's refresh)
    await click(switchOf(1));
    expect(actions.setFeaturedAction).toHaveBeenLastCalledWith({ id: 1, featured: false });
    expect(bar()).toBeNull();
  });

  test("a press is taken once while it is on its way", async () => {
    let finish: (v: unknown) => void = () => {};
    actions.decideReviewAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await show([student()]);
    const publish = $<HTMLButtonElement>("[data-review-publish]")!;
    await act(async () => publish.click());
    await act(async () => publish.click());
    await act(async () => $<HTMLButtonElement>("[data-review-hide]")!.click());
    expect(actions.decideReviewAction).toHaveBeenCalledTimes(1);
    expect(status()).toBe("Salvestan…");
    expect(publish.getAttribute("aria-disabled")).toBe("true");
    await act(async () => finish({ ok: true, expected: EXPECTED }));
    await settle();
    expect(status()).toBe("");
  });

  test("Review Focus 5: a review the student has just withdrawn is answered with the friendly text, its card goes, the text has the focus, no bar", async () => {
    actions.decideReviewAction.mockResolvedValue({ ok: false, error: "gone", text: E.gone });
    await show([student({ id: 1 }), student({ id: 4, name: "Kati K." })]);
    await click($("[data-review-publish]", rowOf(1)));
    expect(status()).toBe("Seda arvustust enam pole — õpilane võttis loa tagasi.");
    expect($('[data-review="1"]')).toBeNull();
    expect($('[data-review="4"]')).not.toBeNull();
    expect(document.activeElement).toBe($("[data-reviews-status]"));
    expect(bar()).toBeNull();
    // the other card still works
    actions.decideReviewAction.mockResolvedValue({ ok: true, expected: EXPECTED });
    await click($("[data-review-publish]", rowOf(4)));
    expect(actions.decideReviewAction).toHaveBeenLastCalledWith({ id: 4, decision: "publish" });
    expect(status()).toBe("");
  });

  test("a lost connection (the call rejects) is a line of words, not an error page; the card stays and the next press works", async () => {
    actions.decideReviewAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await show([student()]);
    await click($("[data-review-publish]"));
    expect(status()).toBe(E.server);
    expect($("[data-review]")).not.toBeNull();
    actions.decideReviewAction.mockResolvedValue({ ok: true, expected: EXPECTED });
    await click($("[data-review-publish]"));
    expect(actions.decideReviewAction).toHaveBeenCalledTimes(2);
    expect(status()).toBe("");
  });

  test("a withdrawn review answered by „Avalehel“ is the same: its words, its card gone; one Maria removed in another tab: her words („manualGone“), the card gone", async () => {
    actions.setFeaturedAction.mockResolvedValue({ ok: false, error: "gone", text: E.gone });
    await show([student({ status: "published" })]);
    await click(switchOf(1));
    expect(status()).toBe(E.gone);
    expect($("[data-review]")).toBeNull();
    expect($("[data-reviews-empty]")).not.toBeNull();
    actions.setFeaturedAction.mockResolvedValue({ ok: false, error: "manualGone", text: E.manualGone });
    await show([manual({ id: 7, status: "published" })]);
    await click(switchOf(7));
    expect(status()).toBe("Seda arvustust enam pole.");
    expect($('[data-review="7"]')).toBeNull();
    expect(bar()).toBeNull();
  });

  test("„Avalehel“ refused (the review was hidden in another tab) is shown in words; the switch shows the stored state again", async () => {
    actions.setFeaturedAction.mockResolvedValue({ ok: false, error: "notPublished", text: E.notPublished });
    await show([student({ status: "published" })]);
    await click(switchOf(1));
    expect(status()).toBe("Avalehel saab olla ainult avaldatud arvustus.");
    expect(switchOf(1).checked).toBe(false);
  });
});

describe("the focus after „Avalda“ or „Peida“ (D5; the final review's M4)", () => {
  const waiting = (id: number) => student({ id, name: `Õpilane ${id}` });
  /** The page's refresh in a status-filtered view (?olek=ootel): the cards that are left. */
  const refreshTo = (rows: ReviewRowView[]) => show(rows, { filtered: true });
  const press = (decision: "publish" | "hide", id: number) => click($(`[data-review-${decision}]`, rowOf(id)));
  beforeEach(() => actions.decideReviewAction.mockResolvedValue({ ok: true, expected: EXPECTED }));

  test.each([["publish"], ["hide"]] as const)("%s in a filtered view, the refresh after the answer: the card leaves and the focus goes to the next card, not to the page", async (decision) => {
    await show([waiting(1), waiting(2), waiting(3)], { filtered: true });
    await press(decision, 2);
    await refreshTo([waiting(1), waiting(3)]);
    expect($('[data-review="2"]')).toBeNull();
    expect(document.activeElement).toBe(rowOf(3));
  });

  test("the last card: the focus goes to the card before it; the only card (the menu badge's path): to the empty list's words, never the empty status line", async () => {
    await show([waiting(1), waiting(2)], { filtered: true });
    await press("hide", 2);
    await refreshTo([waiting(1)]);
    expect(document.activeElement).toBe(rowOf(1));
    await press("publish", 1);
    await refreshTo([]);
    // (Task 2 review I-2: the status line is empty and not drawn, `.status:empty { display: none }`, so it cannot hold the focus; the empty state can)
    const empty = $("[data-reviews-empty]")!;
    expect(document.activeElement).toBe(empty);
    expect(empty.getAttribute("tabindex")).toBe("-1");
    expect(text($("p", empty))).toBe("Selle valikuga arvustusi pole.");
    expect(status()).toBe("");
    expect(document.activeElement).not.toBe($("[data-reviews-status]"));
  });

  test("the refresh arrives before the answer does: the focus goes where the answer finds it (the next card)", async () => {
    let finish: (v: unknown) => void = () => {};
    actions.decideReviewAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await show([waiting(1), waiting(2), waiting(3)], { filtered: true });
    await press("publish", 1);
    await refreshTo([waiting(2), waiting(3)]);
    await act(async () => finish({ ok: true, expected: EXPECTED }));
    await settle();
    expect(document.activeElement).toBe(rowOf(2));
  });

  test("a refusal does not move the focus to a neighbour: the card stays and the words have the focus, also after a refresh", async () => {
    actions.decideReviewAction.mockResolvedValue({ ok: false, error: "server", text: E.server });
    await show([waiting(1), waiting(2)], { filtered: true });
    await press("publish", 1);
    expect(document.activeElement).toBe($("[data-reviews-status]"));
    await refreshTo([waiting(1), waiting(2)]);
    expect(document.activeElement).toBe($("[data-reviews-status]"));
    expect($('[data-review="1"]')).not.toBeNull();
  });

  test("in the view of all, the card stays (its status changes): the focus is on it", async () => {
    await show([waiting(1), waiting(2)]);
    await press("publish", 1);
    await show([student({ id: 1, status: "published", name: "Õpilane 1" }), waiting(2)]);
    expect(document.activeElement).toBe(rowOf(1));
  });

  test("a refresh that comes long after the press (some other change of the page) does not take the focus", async () => {
    const real = Date.now();
    await show([waiting(1), waiting(2), waiting(3)], { filtered: true });
    await press("publish", 2);
    const later = vi.spyOn(Date, "now").mockReturnValue(real + 60_000);
    try {
      await refreshTo([waiting(1), waiting(3)]);
      expect(document.activeElement).not.toBe(rowOf(3));
    } finally {
      later.mockRestore();
    }
  });

  test("an undo in a filtered view: the card comes back with the refresh and takes the focus", async () => {
    actions.undoDecisionAction.mockResolvedValue({ ok: true });
    await show([waiting(1), waiting(2)], { filtered: true });
    await press("publish", 1);
    await refreshTo([waiting(2)]);
    expect(document.activeElement).toBe(rowOf(2));
    await click(undoButton());
    await refreshTo([waiting(1), waiting(2)]);
    expect(document.activeElement).toBe(rowOf(1));
  });
});

describe("„Kustuta“ on a review Maria added: no question, a soft delete with „Võta tagasi“ (R-b; S4-38)", () => {
  test("the card goes at once and the bar says „Arvustus kustutatud.“; the focus goes to the next card; nothing asks „Jah, kustuta“", async () => {
    actions.removeReviewAction.mockResolvedValue({ ok: true });
    await show([manual({ id: 2 }), manual({ id: 6, name: "Liis L." })]);
    await click($("[data-review-delete]", rowOf(2)));
    expect(actions.removeReviewAction).toHaveBeenCalledExactlyOnceWith({ id: 2 });
    expect($('[data-review="2"]')).toBeNull();
    expect(said()).toBe("Arvustus kustutatud.");
    expect(document.activeElement).toBe(rowOf(6));
    expect(document.body.textContent).not.toContain("Jah, kustuta");
    expect(status()).toBe("");
  });

  test("„Kustuta“ on the only card: the focus goes to the empty list's words („Arvustusi pole veel.“), which are drawn", async () => {
    actions.removeReviewAction.mockResolvedValue({ ok: true });
    await show([manual({ id: 2 })]);
    await click($("[data-review-delete]"));
    const empty = $("[data-reviews-empty]")!;
    expect(text(empty)).toBe("Arvustusi pole veel.");
    expect(document.activeElement).toBe(empty);
  });

  test("„Võta tagasi“ brings the card back, with the focus", async () => {
    actions.removeReviewAction.mockResolvedValue({ ok: true });
    actions.undoRemoveReviewAction.mockResolvedValue({ ok: true });
    await show([manual({ id: 2 }), manual({ id: 6, name: "Liis L." })]);
    await click($("[data-review-delete]", rowOf(2)));
    await click(undoButton());
    expect(actions.undoRemoveReviewAction).toHaveBeenCalledExactlyOnceWith({ id: 2 });
    expect($('[data-review="2"]')).not.toBeNull();
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(rowOf(2));
  });

  test("an undo too late (purged) says so in the bar, and the card stays away; one removed already elsewhere: the words, the card gone", async () => {
    actions.removeReviewAction.mockResolvedValue({ ok: true });
    actions.undoRemoveReviewAction.mockResolvedValue({ ok: false, error: "manualGone", text: E.manualGone });
    await show([manual({ id: 2 })]);
    await click($("[data-review-delete]"));
    await click(undoButton());
    expect(said()).toBe("Seda arvustust enam pole.");
    expect($('[data-review="2"]')).toBeNull();
    actions.removeReviewAction.mockResolvedValue({ ok: false, error: "manualGone", text: E.manualGone });
    await show([manual({ id: 7 })]);
    await click($("[data-review-delete]"));
    expect(status()).toBe("Seda arvustust enam pole.");
    expect($('[data-review="7"]')).toBeNull();
  });
});

describe("the status pills (R-e; S4-36)", () => {
  const COUNTS = { pending: 1, published: 5, hidden: 0 };
  const pills = async (olek: "ootel" | "avaldatud" | "peidetud" | null) => {
    await render(createElement(ListToolbar, { pillRows: [{ label: "Olek", pills: reviewPills(olek, COUNTS) }] }));
    return all<HTMLAnchorElement>("nav[aria-label='Olek'] a").map((a) => ({ text: [...a.childNodes].map((n) => n.textContent).join(" "), href: a.getAttribute("href"), current: a.getAttribute("aria-current") }));
  };

  test("no „Kõik“: each status with its count; with none pressed every review is listed and no pill is current", async () => {
    expect(await pills(null)).toEqual([
      { text: "Ootab kinnitust 1", href: `${LIST}&olek=ootel`, current: null },
      { text: "Avaldatud 5", href: `${LIST}&olek=avaldatud`, current: null },
      { text: "Peidetud 0", href: `${LIST}&olek=peidetud`, current: null },
    ]);
  });

  test("a pressed pill toggles off: the menu badge's ?olek=ootel marks „Ootab kinnitust“, which goes back to every review; the others go to theirs", async () => {
    expect(await pills("ootel")).toEqual([
      { text: "Ootab kinnitust 1", href: LIST, current: "true" },
      { text: "Avaldatud 5", href: `${LIST}&olek=avaldatud`, current: null },
      { text: "Peidetud 0", href: `${LIST}&olek=peidetud`, current: null },
    ]);
  });
});

describe("„Lisa arvustus +“: the create drawer (S4-39; R-c)", () => {
  const CLOSE = `${LIST}&olek=ootel`;
  /** The page round it: the guard, the header's „Lisa arvustus +“ the focus goes back to, the drawer. */
  const showNew = () =>
    render(
      createElement(
        LeaveGuardProvider,
        null,
        createElement("a", { id: "review-add", href: `${CLOSE}&id=uus` }, "Lisa arvustus +"),
        createElement(Drawer, { label: "Uus arvustus", closeHref: CLOSE, closeLabel: "Sulge", returnFocus: "review-add" } as Parameters<typeof Drawer>[0], createElement(NewReviewForm, { courses: COURSES, today: TODAY })),
      ),
    );
  const create = async () => {
    await act(async () => $<HTMLFormElement>("[data-review-form='new']")!.requestSubmit());
    await settle();
  };
  const line = () => text($("[data-new-review-line]"));
  const fillIn = async () => {
    await choose(field("courseId"), "5");
    await type(field("name"), "  Anu   A. ");
    await type(field("text"), "Väga hea koolitus, soovitan!");
    await type(field("writtenAt"), "2026-09-20");
    await choose(field("locale"), "ru");
    await type(field("note"), "Paberil vormil");
  };

  test("the title „Uus arvustus“, the header „Täida kohustuslikud väljad“ then „Vajuta „Lisa arvustus“.“, the warning above the fields, „Lisa arvustus“ and „Katkesta“", async () => {
    await showNew();
    const form = $("[data-review-form='new']")!;
    expect(text($("h2", form))).toBe("Uus arvustus");
    expect(line()).toBe("Täida kohustuslikud väljad");
    expect($("[data-new-review-line]")!.getAttribute("role")).toBe("status");
    const warning = $("[data-review-warning]", form)!;
    expect(text(warning)).toBe("Lisa ainult päris õpilase sõnad tema loal.");
    for (const el of all("input, select, textarea", form)) expect(warning.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(all("label", form).map((l) => text(l))).toEqual(["Koolitus", "Nimi, mida näidatakse", "Arvustuse tekst", "Kirjutamise kuupäev", "Arvustuse keel", "Kust see pärit on?"]);
    expect(field("courseId").value).toBe("");
    expect(all("option", field("courseId")).map((o) => text(o))).toEqual(["Vali koolitus", "Kulmude lamineerimine", "Ripsmete tõstmine", "Kulmude e-kursus (mustand)"]);
    expect([field("writtenAt").value, field("locale").value]).toEqual([TODAY, "et"]);
    expect(all("button", form).map((b) => text(b))).toEqual(["Lisa arvustus", "Katkesta"]);
    await fillIn();
    expect(line()).toBe("Vajuta „Lisa arvustus“.");
    expect(actions.saveManualReviewAction).not.toHaveBeenCalled(); // (never autosaved: a new review is published at once)
  });

  test("the limits are the rules' (name 40, text 2000, note 500), each with its counter", async () => {
    await showNew();
    expect([field("name").maxLength, field("text").maxLength, field("note").maxLength]).toEqual([40, 2000, 500]);
    await type(field("name"), "Anu A.");
    await type(field("note"), "Kiri");
    expect([text($('[data-review-count="name"]')), text($('[data-review-count="text"]')), text($('[data-review-count="note"]'))]).toEqual(["6 / 40", "0 / 2000", "4 / 500"]);
    expect(described(field("note"))).toEqual(["Ainult sinule: avalikul lehel seda ei näidata.", "4 / 500"]);
  });

  test("pressed without the source note: not sent, the field marked in words and focused; typing in it takes the mark away", async () => {
    await showNew();
    await choose(field("courseId"), "3");
    await type(field("name"), "Anu A.");
    await type(field("text"), "Väga hea koolitus.");
    await create();
    expect(actions.saveManualReviewAction).not.toHaveBeenCalled();
    expect(field("note").getAttribute("aria-invalid")).toBe("true");
    expect(described(field("note"))).toContain("Täida see väli.");
    expect(document.activeElement).toBe(field("note"));
    expect(field("name").getAttribute("aria-invalid")).toBeNull();
    await type(field("note"), "Kiri");
    expect(field("note").getAttribute("aria-invalid")).toBeNull();
  });

  test("every other wrong field is marked too (no course chosen, no words, no day); the first gets the focus", async () => {
    await showNew();
    await type(field("note"), "Kiri");
    await type(field("writtenAt"), "");
    await create();
    expect(actions.saveManualReviewAction).not.toHaveBeenCalled();
    for (const name of ["courseId", "name", "text", "writtenAt"]) expect(field(name).getAttribute("aria-invalid"), name).toBe("true");
    expect(document.activeElement).toBe(field("courseId"));
  });

  test("R-c: created, the drawer closes with no result line and the focus is back on „Lisa arvustus +“; the fields went as the rules read them", async () => {
    actions.saveManualReviewAction.mockResolvedValue({ ok: true, id: 12 });
    await showNew();
    await fillIn();
    await create();
    expect(actions.saveManualReviewAction).toHaveBeenCalledExactlyOnceWith({ id: null, courseId: 5, name: "Anu A.", text: "Väga hea koolitus, soovitan!", writtenAt: "2026-09-20", locale: "ru", note: "Paberil vormil" });
    expect(dialog().open).toBe(false);
    expect(router.replace).toHaveBeenCalledExactlyOnceWith(CLOSE, { scroll: false });
    expect(document.activeElement).toBe($("#review-add"));
    expect(text($("[data-review-form-status]"))).toBe("");
    expect($("[data-leave-notice]")).toBeNull();
    expect(localStorage.getItem("mslab-draft:arvustus:uus")).toBeNull();
  });

  test("pasted Word text: a vertical tab and a form feed become line breaks, any other control character a space (a name's breaks too)", async () => {
    actions.saveManualReviewAction.mockResolvedValue({ ok: true, id: 12 });
    await showNew();
    await choose(field("courseId"), "3");
    await type(field("name"), "Anu\u000bA.");
    await type(field("text"), "Esimene rida\u000bteine rida\u000ckolmas\u0001neljas\u0007viies\tkuues\u007f\r\nseitsmes");
    await type(field("note"), "Kiri\u000b20.09.\u0000");
    await create();
    const sent = actions.saveManualReviewAction.mock.calls[0][0];
    expect(sent.text).toBe("Esimene rida\nteine rida\nkolmas neljas viies kuues \nseitsmes");
    expect(sent.name).toBe("Anu A.");
    expect(sent.note).toBe("Kiri\n20.09.");
    for (const value of [sent.name, sent.text, sent.note]) expect(value).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  });

  test("a field the server refuses is marked in words under it; a refusal of the whole (or a lost connection) is a line of words, and the drawer stays", async () => {
    await showNew();
    await fillIn();
    actions.saveManualReviewAction.mockResolvedValueOnce({ ok: false, fields: { courseId: "invalid" } });
    await create();
    expect(field("courseId").getAttribute("aria-invalid")).toBe("true");
    expect(described(field("courseId"))).toContain("Kontrolli seda välja.");
    expect(text($("[data-review-form-status]"))).toBe("Kontrolli seda välja.");
    actions.saveManualReviewAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await create();
    expect(text($("[data-review-form-status]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(dialog().open).toBe(true);
    expect(field("text").value).toBe("Väga hea koolitus, soovitan!");
  });

  test("„Katkesta“ closes it and refocuses „Lisa arvustus +“, with typed text too: nothing is sent, nothing asked, nothing kept; opened again it is empty", async () => {
    await showNew();
    await type(field("name"), "Anu");
    await click(buttonNamed("Katkesta"));
    expect(dialog().open).toBe(false);
    expect(router.replace).toHaveBeenCalledExactlyOnceWith(CLOSE, { scroll: false });
    expect(document.activeElement).toBe($("#review-add"));
    expect($("[data-leave-notice]")).toBeNull();
    expect(actions.saveManualReviewAction).not.toHaveBeenCalled();
    expect(localStorage.getItem("mslab-draft:arvustus:uus")).toBeNull();
    await act(async () => root.unmount());
    document.querySelectorAll("dialog").forEach((d) => d.remove());
    root = createRoot(container);
    await showNew();
    expect(field("name").value).toBe("");
  });

  test("leaving with typed text by ✕ asks with „Arvustust pole veel lisatud.“; „Sulge, tekst jääb seadmesse“ keeps it for the next opening", async () => {
    await showNew();
    await type(field("text"), "Väga hea.");
    await click(buttonNamed("Sulge", dialog()));
    expect(dialog().open).toBe(true);
    expect(text($("[data-leave-title]"))).toBe("Muudatust „Arvustuse tekst“ ei saanud veel salvestada.");
    expect(text($("[data-leave-reason]"))).toBe("Arvustust pole veel lisatud.");
    await click(buttonNamed("Sulge, tekst jääb seadmesse"));
    expect(dialog().open).toBe(false);
    expect(JSON.parse(localStorage.getItem("mslab-draft:arvustus:uus")!)).toMatchObject({ text: "Väga hea." });
    await act(async () => root.unmount());
    document.querySelectorAll("dialog").forEach((d) => d.remove());
    root = createRoot(container);
    await showNew();
    expect(field("text").value).toBe("Väga hea.");
  });
});

describe("„Muuda“: the autosave drawer of a review Maria added (R-c; S4-4, S4-39 note)", () => {
  const ID = 2;
  const FIELDS: ManualReviewFields = { courseId: "3", name: "Anu A.", text: "Väga hea koolitus.", writtenAt: "2026-09-20", locale: "ru", note: "Paberil vormil" };
  let current = "r:v1";
  let reply: ((body: { version: string; patch: Record<string, unknown> }) => Response) | null = null;
  const showEdit = () =>
    render(
      createElement(
        LeaveGuardProvider,
        null,
        createElement("a", { id: `arvustus-${ID}-muuda`, href: `${LIST}&id=${ID}` }, "Muuda"),
        createElement(
          Drawer,
          { label: "Muuda arvustust", closeHref: LIST, closeLabel: "Sulge", returnFocus: `arvustus-${ID}-muuda` } as Parameters<typeof Drawer>[0],
          createElement(EditReviewForm, { id: ID, version: "r:v1", fields: FIELDS, courses: COURSES }),
        ),
      ),
    );
  const chip = () => $("[data-review-head] [data-save-status]")!;
  beforeEach(() => {
    current = "r:v1";
    reply = null;
    fetched.restore();
    fetched = stubFetch(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { version: string; patch: Record<string, unknown> };
      if (url !== `/api/admin/arvustus/${ID}`) return Response.json({ ok: false }, { status: 404 });
      if (reply) return reply(body);
      if (body.version !== current) return Response.json({ ok: false, error: "conflict", version: current, value: { ...FIELDS, text: "Teises aknas." } }, { status: 409 });
      current = "r:v2";
      return Response.json({ ok: true, version: current, savedAt: "2026-10-27T11:03:00.000Z" });
    });
  });

  test("the title „Muuda arvustust“, SaveStatus in the header, the warning, the review's own fields; no „Salvesta“, no „Katkesta“", async () => {
    await showEdit();
    expect(text($("[data-review-form='2'] h2"))).toBe("Muuda arvustust");
    expect(chip().getAttribute("data-save-kind")).toBe("saved");
    expect(text($("[data-review-form='2'] [data-review-warning]"))).toBe("Lisa ainult päris õpilase sõnad tema loal.");
    expect(["courseId", "name", "text", "writtenAt", "locale", "note"].map((n) => field(n).value)).toEqual(["3", "Anu A.", "Väga hea koolitus.", "2026-09-20", "ru", "Paberil vormil"]);
    expect(all("button", $("[data-review-form='2']")!).map((b) => text(b))).toEqual([]);
  });

  test("typed text saves on the review's route from the version the page read; the chip says „Salvestatud …“ and the page is read again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await showEdit();
    await type(field("text"), "Parandatud tekst.");
    expect(chip().getAttribute("data-save-kind")).toBe("dirty");
    await act(async () => void (await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50)));
    await settle();
    expect(fetched.calls.map((c) => [c.method, c.url, c.body])).toEqual([["POST", `/api/admin/arvustus/${ID}`, { version: "r:v1", patch: { text: "Parandatud tekst." } }]]);
    expect(text(chip().querySelector("[data-save-text]"))).toBe("✓ Salvestatud 13:03");
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  test("a select or the day chosen saves at once (an instant field); a field left saves at once", async () => {
    await showEdit();
    await choose(field("courseId"), "5");
    await settle();
    expect(fetched.calls.map((c) => c.body)).toEqual([{ version: "r:v1", patch: { courseId: "5" } }]);
    await type(field("note"), "Kiri");
    await leave(field("note"));
    await settle();
    expect(fetched.calls.map((c) => c.body).at(-1)).toEqual({ version: "r:v2", patch: { note: "Kiri" } });
  });

  test("a required field emptied is held back, marked under it, and the chip's „Näita“ goes there; nothing is sent", async () => {
    await showEdit();
    await type(field("name"), "");
    await leave(field("name"));
    await settle();
    expect(fetched.calls).toEqual([]);
    expect(chip().getAttribute("data-save-kind")).toBe("invalid");
    expect(field("name").getAttribute("aria-invalid")).toBe("true");
    expect(described(field("name"))).toContain("Täida see väli.");
    await click(buttonNamed("Näita", chip()));
    expect(document.activeElement).toBe(field("name"));
  });

  test("the server's refusal of a field is shown under it", async () => {
    reply = () => Response.json({ ok: false, error: "invalid", fields: { courseId: "invalid" } }, { status: 400 });
    await showEdit();
    await choose(field("courseId"), "8");
    await settle();
    expect(field("courseId").getAttribute("aria-invalid")).toBe("true");
    expect(described(field("courseId"))).toContain("Kontrolli seda välja.");
  });

  test("another tab saved first: „Muudeti teises aknas — vaata üle“ and „Taasta minu tekst“, which saves this text over it", async () => {
    current = "r:other";
    await showEdit();
    await type(field("text"), "Minu tekst.");
    await leave(field("text"));
    await settle();
    expect(chip().getAttribute("data-save-kind")).toBe("conflict");
    await click($("[data-review-restore]"));
    await settle();
    expect(fetched.calls.map((c) => c.body).at(-1)).toEqual({ version: "r:other", patch: { text: "Minu tekst." } });
    expect(chip().getAttribute("data-save-kind")).toBe("saved");
  });

  test("removed meanwhile (404): S4-4's „Seda arvustust enam ei ole. Tekst on selles seadmes alles.“", async () => {
    reply = () => Response.json({ ok: false, error: "notFound" }, { status: 404 });
    await showEdit();
    await type(field("text"), "Uus.");
    await leave(field("text"));
    await settle();
    expect(chip().getAttribute("data-save-kind")).toBe("gone");
    expect(text(chip().querySelector("[data-save-text]"))).toBe("Seda arvustust enam ei ole. Tekst on selles seadmes alles.");
  });
});
