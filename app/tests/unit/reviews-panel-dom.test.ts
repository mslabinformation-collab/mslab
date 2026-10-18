// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { adminEt } from "@/i18n/dict/admin";

// Maria's „Arvustused“ (student reviews, Task 4; spec D2, D4, §4, §5; Review Focus 5) in a browser-like document (happy-dom), with the server actions
// answered here: each row in each status and kind with the buttons it allows (and no other: a student's words have no edit control at all), the
// proof line, the presses and what they send, a review that is gone (the student took her permission back) answered in words with its row gone, the
// delete's confirming step, and „Lisa arvustus“ / „Muuda“: the warning above the fields, the limits and counters, the required source note, the
// pasted Word text made storable before anything is sent, and a refused field marked in words.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ decideReviewAction: vi.fn(), setFeaturedAction: vi.fn(), saveManualReviewAction: vi.fn(), deleteManualReviewAction: vi.fn() }));
vi.mock("@/server/actions/admin-reviews", () => actions);

import { ReviewsPanel } from "@/components/admin/ReviewsPanel";
import type { ReviewCourseOption, ReviewRowView } from "@/components/admin/review-view";

const COURSES: ReviewCourseOption[] = [
  { id: 3, label: "Kulmude lamineerimine" },
  { id: 5, label: "Ripsmete tõstmine" },
  { id: 8, label: "Kulmude e-kursus (mustand)" },
];
const TODAY = "2026-10-18";
const E = adminEt.reviews.errors;

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
  ...over,
});
const manual = (over: Partial<ReviewRowView> = {}): ReviewRowView =>
  student({ id: 2, kind: "manual", status: "published", name: "Anu A.", text: "Väga hea koolitus.", locale: "ru", writtenAt: "2026-09-19T21:00:00.000Z", note: "Paberil vormil, 20.09.2026", proof: null, ...over });

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => within.querySelector<E>(selector);
const all = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => [...within.querySelectorAll<E>(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = async (rows: ReviewRowView[], over: Partial<Parameters<typeof ReviewsPanel>[0]> = {}) => {
  await act(async () => root.render(createElement(ReviewsPanel, { rows, courses: COURSES, today: TODAY, filtered: false, ...over })));
  await settle();
};
// (a tap or a key press focuses the button first, as it does in a browser)
const click = async (el: Element | null) => {
  await act(async () => {
    (el as HTMLElement).focus();
    (el as HTMLElement).click();
  });
  await settle();
};
const rowOf = (id: number) => $(`[data-review="${id}"]`)!;
/** The names of the buttons in a row (or the form), in order. */
const buttonsOf = (id: number) => all("button", rowOf(id)).map((b) => b.textContent);
const status = () => $("[data-reviews-status]")!.textContent;
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
// (an input, a textarea or a select: only what they share is read)
const field = (name: string, within: ParentNode = container) => $<HTMLInputElement>(`[data-review-field="${name}"]`, within)!;
const submitForm = async (within: ParentNode = container) => {
  await act(async () => $<HTMLFormElement>("[data-review-form]", within)!.requestSubmit());
  await settle();
};

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("what each row shows", () => {
  test("the shown name, the words as written, the course, the day and the language, and the status", async () => {
    await show([student()]);
    const row = rowOf(1);
    expect($("[data-review-name]", row)!.textContent).toBe("Mari M.");
    expect($("[data-review-text]", row)!.textContent).toBe("Soovitaksin kindlasti.\nÕppisin väga palju.");
    expect($("[data-review-facts]", row)!.textContent).toBe("Kulmude lamineerimine13.10.2026Keel: ET");
    expect($("[data-review-tag]", row)!.textContent).toBe("Ootab kinnitust");
    await show([student({ status: "published" }), manual({ status: "hidden" })]);
    expect($("[data-review-tag]", rowOf(1))!.textContent).toBe("Avaldatud");
    expect($("[data-review-tag]", rowOf(2))!.textContent).toBe("Peidetud");
    expect($("[data-review-facts]", rowOf(2))!.textContent).toContain("Keel: RU");
    // the day in Estonian time: 19.09. 21:00 UTC is already the 20th
    expect($("[data-review-facts]", rowOf(2))!.textContent).toContain("20.09.2026");
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
    for (const id of [1, 2, 3]) expect($("[data-review-manual]", rowOf(id))).toBeNull();
  });

  test("a review Maria added says „Lisatud käsitsi“ and shows her note; it has no proof", async () => {
    await show([manual()]);
    expect($("[data-review-manual]", rowOf(2))!.textContent).toBe("Lisatud käsitsi");
    expect($("[data-review-note]", rowOf(2))!.textContent).toBe("Allikas: Paberil vormil, 20.09.2026");
    expect($("[data-review-proof]", rowOf(2))).toBeNull();
    await show([student()]);
    expect($("[data-review-note]", rowOf(1))).toBeNull();
  });

  test("a review of a draft course says „(mustand)“ after the course, as the „Lisa arvustus“ list does; one of a published course has no mark (the final review's M2)", async () => {
    await show([student({ id: 1, course: { id: 8, title: "Kulmude e-kursus", published: false } }), student({ id: 2 })]);
    expect($("[data-review-facts]", rowOf(1))!.textContent).toBe("Kulmude e-kursus (mustand)13.10.2026Keel: ET");
    expect($("[data-review-facts]", rowOf(2))!.textContent).toBe("Kulmude lamineerimine13.10.2026Keel: ET");
    expect(COURSES[2].label).toBe("Kulmude e-kursus (mustand)"); // the same mark the course list of the form carries
    // a hidden or pending review of a draft says it too, whatever the status: it is the course that is not shown
    await show([manual({ id: 3, status: "hidden", course: { id: 8, title: "Kulmude e-kursus", published: false } })]);
    expect($("[data-review-facts]", rowOf(3))!.textContent).toContain("Kulmude e-kursus (mustand)");
  });

  test("the list holds the rows in the order it was given; none: its own words, narrowed by a status: the other words", async () => {
    await show([student({ id: 4 }), manual({ id: 9 })]);
    expect(all("[data-review]").map((li) => li.getAttribute("data-review"))).toEqual(["4", "9"]);
    await show([]);
    expect($("[data-reviews-empty]")!.textContent).toBe("Arvustusi pole veel.");
    expect($("[data-review-list]")).toBeNull();
    await show([], { filtered: true });
    expect($("[data-reviews-empty]")!.textContent).toBe("Selles vaates arvustusi pole.");
  });
});

describe("the buttons follow the status and the kind", () => {
  test.each([
    ["a pending student review", student({ status: "pending" }), ["Avalda", "Peida"]],
    ["a published student review", student({ status: "published" }), ["Peida", "Avalehel"]],
    ["a hidden student review", student({ status: "hidden" }), ["Avalda"]],
    ["a published review Maria added", manual({ status: "published" }), ["Peida", "Avalehel", "Muuda", "Kustuta"]],
    ["a hidden review Maria added", manual({ status: "hidden" }), ["Avalda", "Muuda", "Kustuta"]],
  ] as const)("%s: %j", async (_name, review, buttons) => {
    await show([review]);
    expect(buttonsOf(review.id)).toEqual(buttons);
  });

  test("a student's review never gets an edit or a delete control, whatever its status (its words are hers; she takes her permission back herself)", async () => {
    await show(["pending", "published", "hidden"].map((s, i) => student({ id: i + 1, status: s as ReviewRowView["status"], featured: s === "published" })));
    expect(all("[data-review-edit], [data-review-delete], [data-review-delete-yes]")).toEqual([]);
    expect(all("textarea, input, select")).toEqual([]);
    for (const id of [1, 2, 3]) expect(buttonsOf(id)).not.toContain("Muuda");
  });

  test("„Avalehel“ is a toggle: pressed when the review is on the home page", async () => {
    await show([student({ id: 1, status: "published" }), student({ id: 2, status: "published", featured: true })]);
    expect($("[data-review-featured-toggle]", rowOf(1))!.getAttribute("aria-pressed")).toBe("false");
    expect($("[data-review-featured-toggle]", rowOf(2))!.getAttribute("aria-pressed")).toBe("true");
  });

  test("„Avalehel“ has a quiet hint near its toggles: only the newest six are shown (the final review's M3); it is not there when no row has the toggle", async () => {
    await show([student({ id: 1, status: "published" }), student({ id: 2, status: "published", featured: true })]);
    const hint = $("[data-review-home-hint]")!;
    expect(hint.textContent).toBe("Avalehel näidatakse kuni 6 uusimat.");
    for (const id of [1, 2]) expect($("[data-review-featured-toggle]", rowOf(id))!.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.id).not.toBe("");
    await show([student({ id: 3, status: "pending" }), student({ id: 4, status: "hidden" })]);
    expect($("[data-review-home-hint]")).toBeNull();
  });

  test("a hidden review that is still on the home page's list carries an „Avalehel“ tag, so „Avalda“ is seen to put it back; a published, a pending or an unmarked hidden one does not", async () => {
    await show([
      student({ id: 1, status: "hidden", featured: true }),
      student({ id: 2, status: "hidden", featured: false }),
      student({ id: 3, status: "published", featured: true }),
      student({ id: 4, status: "pending" }),
      manual({ id: 5, status: "hidden", featured: true }),
    ]);
    for (const id of [1, 5]) {
      expect($("[data-review-featured-tag]", rowOf(id))!.textContent).toBe("Avalehel");
      expect($("[data-review-featured-tag]", rowOf(id))!.getAttribute("title")).toBe("Peidetud, aga avalehe valik jääb: „Avalda“ toob selle avalehele tagasi.");
    }
    for (const id of [2, 3, 4]) expect($("[data-review-featured-tag]", rowOf(id))).toBeNull();
    // the hint is there for the hidden marked one too, with no published row on the screen
    await show([student({ id: 1, status: "hidden", featured: true })]);
    expect($("[data-review-home-hint]")!.textContent).toBe("Avalehel näidatakse kuni 6 uusimat.");
    await show([student({ id: 2, status: "hidden", featured: false })]);
    expect($("[data-review-home-hint]")).toBeNull();
    // „Avalda“ takes the tag off the row's tags (the page's refresh gives the published row, whose toggle is pressed)
    await show([student({ id: 1, status: "published", featured: true })]);
    expect($("[data-review-featured-tag]")).toBeNull();
    expect($("[data-review-featured-toggle]")!.getAttribute("aria-pressed")).toBe("true");
  });

  test("a button's name for a screen reader starts with its words and ends with whose review it is", async () => {
    await show([student({ status: "published" })]);
    expect($("[data-review-hide]")!.getAttribute("aria-label")).toBe("Peida: Mari M.");
    expect($("[data-review-featured-toggle]")!.getAttribute("aria-label")).toBe("Avalehel: Mari M.");
  });
});

describe("the presses", () => {
  test("„Avalda“ and „Peida“ send the review's id and the decision; done: the status line stays empty and the row has the focus", async () => {
    actions.decideReviewAction.mockResolvedValue({ ok: true });
    await show([student()]);
    await click($("[data-review-publish]"));
    expect(actions.decideReviewAction).toHaveBeenCalledWith({ id: 1, decision: "publish" });
    expect(status()).toBe("");
    expect(document.activeElement).toBe(rowOf(1));
    await click($("[data-review-hide]"));
    expect(actions.decideReviewAction).toHaveBeenLastCalledWith({ id: 1, decision: "hide" });
  });

  test("„Avalehel“ puts a published review on the home page, and taking it off sends the opposite", async () => {
    actions.setFeaturedAction.mockResolvedValue({ ok: true });
    await show([student({ id: 1, status: "published" }), student({ id: 2, status: "published", featured: true })]);
    await click($("[data-review-featured-toggle]", rowOf(1)));
    expect(actions.setFeaturedAction).toHaveBeenLastCalledWith({ id: 1, featured: true });
    await click($("[data-review-featured-toggle]", rowOf(2)));
    expect(actions.setFeaturedAction).toHaveBeenLastCalledWith({ id: 2, featured: false });
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
    await act(async () => finish({ ok: true }));
    await settle();
    expect(status()).toBe("");
  });

  test("Review Focus 5: a review the student has just withdrawn is answered with the friendly text, its row goes, and the text has the focus", async () => {
    actions.decideReviewAction.mockResolvedValue({ ok: false, error: "gone", text: E.gone });
    await show([student({ id: 1 }), student({ id: 4, name: "Kati K." })]);
    await click($("[data-review-publish]", rowOf(1)));
    expect(status()).toBe("Seda arvustust enam pole — õpilane võttis loa tagasi.");
    expect($('[data-review="1"]')).toBeNull();
    expect($('[data-review="4"]')).not.toBeNull();
    expect(document.activeElement).toBe($("[data-reviews-status]"));
    // the other row still works
    actions.decideReviewAction.mockResolvedValue({ ok: true });
    await click($("[data-review-publish]", rowOf(4)));
    expect(actions.decideReviewAction).toHaveBeenLastCalledWith({ id: 4, decision: "publish" });
    expect(status()).toBe("");
  });

  test("a withdrawn review answered by „Avalehel“ is the same: its words, its row gone", async () => {
    actions.setFeaturedAction.mockResolvedValue({ ok: false, error: "gone", text: E.gone });
    await show([student({ status: "published" })]);
    await click($("[data-review-featured-toggle]"));
    expect(status()).toBe(E.gone);
    expect($("[data-review]")).toBeNull();
    expect($("[data-reviews-empty]")).not.toBeNull();
  });

  test("a lost connection (the call rejects) is a line of words, not an error page; the row stays and the next press works", async () => {
    actions.decideReviewAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await show([student()]);
    await click($("[data-review-publish]"));
    expect(status()).toBe(E.server);
    expect($("[data-review]")).not.toBeNull();
    actions.decideReviewAction.mockResolvedValue({ ok: true });
    await click($("[data-review-publish]"));
    expect(actions.decideReviewAction).toHaveBeenCalledTimes(2);
    expect(status()).toBe("");
  });

  test("another refusal (the review was hidden in another tab) is shown in words and the row stays, for the page's refresh to correct", async () => {
    actions.setFeaturedAction.mockResolvedValue({ ok: false, error: "notPublished", text: E.notPublished });
    await show([student({ status: "published" })]);
    await click($("[data-review-featured-toggle]"));
    expect(status()).toBe("Avalehel saab olla ainult avaldatud arvustus.");
    expect($("[data-review]")).not.toBeNull();
    actions.decideReviewAction.mockResolvedValue({ ok: false, error: "server", text: E.server });
    await click($("[data-review-hide]"));
    expect(status()).toBe(E.server);
  });
});

describe("the focus after „Avalda“ or „Peida“ (the final review's M4)", () => {
  const waiting = (id: number) => student({ id, name: `Õpilane ${id}` });
  /** The page's refresh in a status-filtered view (?olek=ootel): the rows that are left. */
  const refreshTo = (rows: ReviewRowView[]) => show(rows, { filtered: true });
  const press = (decision: "publish" | "hide", id: number) => click($(`[data-review-${decision}]`, rowOf(id)));

  test.each([["publish"], ["hide"]] as const)("%s in a filtered view, the refresh after the answer: the row leaves the list and the focus goes to the next row, not to the page", async (decision) => {
    actions.decideReviewAction.mockResolvedValue({ ok: true });
    await show([waiting(1), waiting(2), waiting(3)], { filtered: true });
    await press(decision, 2);
    expect(actions.decideReviewAction).toHaveBeenCalledWith({ id: 2, decision });
    await refreshTo([waiting(1), waiting(3)]);
    expect($('[data-review="2"]')).toBeNull();
    expect(document.activeElement).toBe(rowOf(3));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("the refresh arrives before the answer does: the same row gets the focus", async () => {
    let finish: (v: unknown) => void = () => {};
    actions.decideReviewAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await show([waiting(1), waiting(2), waiting(3)], { filtered: true });
    await press("publish", 1);
    await refreshTo([waiting(2), waiting(3)]);
    await act(async () => finish({ ok: true }));
    await settle();
    expect(document.activeElement).toBe(rowOf(2));
  });

  test("the last row of the list: the focus goes to the row before it", async () => {
    actions.decideReviewAction.mockResolvedValue({ ok: true });
    await show([waiting(1), waiting(2)], { filtered: true });
    await press("hide", 2);
    await refreshTo([waiting(1)]);
    expect(document.activeElement).toBe(rowOf(1));
  });

  test("the only row: none is left, and the focus goes to the status line, whose place the empty list's words follow", async () => {
    actions.decideReviewAction.mockResolvedValue({ ok: true });
    await show([waiting(1)], { filtered: true });
    await press("publish", 1);
    await refreshTo([]);
    expect($("[data-reviews-empty]")!.textContent).toBe("Selles vaates arvustusi pole.");
    expect(document.activeElement).toBe($("[data-reviews-status]"));
  });

  test("in the view of all, the row stays (its status changes): the focus is on it, as before", async () => {
    actions.decideReviewAction.mockResolvedValue({ ok: true });
    await show([waiting(1), waiting(2)]);
    await press("publish", 1);
    await show([student({ id: 1, status: "published", name: "Õpilane 1" }), waiting(2)]); // (the page's refresh: the row is published now)
    expect(document.activeElement).toBe(rowOf(1));
  });

  test("a refusal does not move the focus to a neighbour: the row stays and the words have the focus", async () => {
    actions.decideReviewAction.mockResolvedValue({ ok: false, error: "server", text: E.server });
    await show([waiting(1), waiting(2)], { filtered: true });
    await press("publish", 1);
    expect(document.activeElement).toBe($("[data-reviews-status]"));
    await refreshTo([waiting(1), waiting(2)]);
    expect(document.activeElement).toBe($("[data-reviews-status]"));
  });

  test("a refresh that comes long after the press (some other change of the page) does not take the focus", async () => {
    const real = Date.now();
    actions.decideReviewAction.mockResolvedValue({ ok: true });
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
});

describe("„Kustuta“ has one confirming step", () => {
  test("the question comes first; „Ei“ takes it back and sends nothing", async () => {
    await show([manual()]);
    await click($("[data-review-delete]"));
    expect($("[data-review-confirm]")!.textContent).toContain("Kas kustutan selle arvustuse?");
    expect(all("button", $("[data-review-confirm]")!).map((b) => b.textContent)).toEqual(["Jah, kustuta", "Ei"]);
    await click($("[data-review-delete-no]"));
    expect($("[data-review-confirm]")).toBeNull();
    expect(actions.deleteManualReviewAction).not.toHaveBeenCalled();
    expect(buttonsOf(2)).toContain("Kustuta");
  });

  test("„Jah, kustuta“ sends the id; done: the row goes and the status line says so", async () => {
    actions.deleteManualReviewAction.mockResolvedValue({ ok: true });
    await show([manual(), manual({ id: 6, name: "Liis L." })]);
    await click($("[data-review-delete]", rowOf(2)));
    await click($("[data-review-delete-yes]"));
    expect(actions.deleteManualReviewAction).toHaveBeenCalledWith({ id: 2 });
    expect($('[data-review="2"]')).toBeNull();
    expect($('[data-review="6"]')).not.toBeNull();
    expect(status()).toBe("Arvustus on kustutatud.");
  });

  test("a review that is not there any more: the words, the row gone", async () => {
    actions.deleteManualReviewAction.mockResolvedValue({ ok: false, error: "manualGone", text: E.manualGone });
    await show([manual()]);
    await click($("[data-review-delete]"));
    await click($("[data-review-delete-yes]"));
    expect(status()).toBe("Seda arvustust enam pole.");
    expect($("[data-review]")).toBeNull();
  });
});

describe("„Lisa arvustus“", () => {
  test("the button opens the form: the warning stands above its fields, and the course is an explicit choice", async () => {
    await show([]);
    expect($("[data-review-form]")).toBeNull();
    await click($("[data-review-add]"));
    const form = $("[data-review-form]")!;
    expect($("[data-review-add]")).toBeNull(); // (the form has its own „Tühista“)
    expect($("h3", form)!.textContent).toBe("Lisa arvustus");
    const warning = $("[data-review-warning]", form)!;
    expect(warning.textContent).toBe("Lisa ainult päris õpilase sõnad tema loal.");
    for (const el of all("input, select, textarea", form)) expect(warning.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING, el.getAttribute("data-review-field") ?? "").toBeTruthy();
    expect(field("courseId").value).toBe("");
    expect(all("option", field("courseId")).map((o) => o.textContent)).toEqual(["Vali koolitus", "Kulmude lamineerimine", "Ripsmete tõstmine", "Kulmude e-kursus (mustand)"]);
    expect(field("writtenAt").value).toBe(TODAY);
    expect(field("locale").value).toBe("et");
    expect(document.activeElement).toBe(field("courseId"));
    // the labels
    const labels = all("label", form).map((l) => l.textContent);
    expect(labels).toEqual(["Koolitus", "Nimi, mida näidatakse", "Arvustuse tekst", "Kirjutamise kuupäev", "Arvustuse keel", "Kust see pärit on?"]);
  });

  test("the limits are the rules' (name 40, text 2000, note 500), each with its counter", async () => {
    await show([]);
    await click($("[data-review-add]"));
    expect([field("name").maxLength, field("text").maxLength, field("note").maxLength]).toEqual([40, 2000, 500]);
    expect($('[data-review-count="name"]')!.textContent).toBe("0 / 40");
    await type(field("name"), "Anu A.");
    await type(field("text"), "Väga hea.");
    await type(field("note"), "Kiri");
    expect([$('[data-review-count="name"]')!.textContent, $('[data-review-count="text"]')!.textContent, $('[data-review-count="note"]')!.textContent]).toEqual(["6 / 40", "9 / 2000", "4 / 500"]);
    expect($('[data-review-count="note"]')!.id).toBeTruthy();
    expect(field("note").getAttribute("aria-describedby")).toContain($('[data-review-count="note"]')!.id);
  });

  test("the source note is required: a form without it is not sent, the field is marked in words and takes the focus", async () => {
    await show([]);
    await click($("[data-review-add]"));
    await choose(field("courseId"), "3");
    await type(field("name"), "Anu A.");
    await type(field("text"), "Väga hea koolitus.");
    await submitForm();
    expect(actions.saveManualReviewAction).not.toHaveBeenCalled();
    expect(field("note").getAttribute("aria-invalid")).toBe("true");
    expect(field("note").closest("div")!.textContent).toContain("Täida see väli.");
    expect(document.activeElement).toBe(field("note"));
    expect(field("name").getAttribute("aria-invalid")).toBeNull();
    // typing in it takes the mark away
    await type(field("note"), "Kiri");
    expect(field("note").getAttribute("aria-invalid")).toBeNull();
  });

  test("every other wrong field is marked too (no course chosen, no words, a day that is no day)", async () => {
    await show([]);
    await click($("[data-review-add]"));
    await type(field("note"), "Kiri");
    await type(field("writtenAt"), "");
    await submitForm();
    expect(actions.saveManualReviewAction).not.toHaveBeenCalled();
    for (const name of ["courseId", "name", "text", "writtenAt"]) expect(field(name).getAttribute("aria-invalid"), name).toBe("true");
    expect(document.activeElement).toBe(field("courseId"));
  });

  test("a complete form sends the id null and the fields (the course as a number), and closes; the new review comes with the page's refresh", async () => {
    actions.saveManualReviewAction.mockResolvedValue({ ok: true, id: 12 });
    await show([]);
    await click($("[data-review-add]"));
    await choose(field("courseId"), "5");
    await type(field("name"), "  Anu   A. ");
    await type(field("text"), "Väga hea koolitus, soovitan!");
    await type(field("writtenAt"), "2026-09-20");
    await choose(field("locale"), "ru");
    await type(field("note"), "Paberil vormil");
    await submitForm();
    expect(actions.saveManualReviewAction).toHaveBeenCalledTimes(1);
    expect(actions.saveManualReviewAction).toHaveBeenCalledWith({ id: null, courseId: 5, name: "Anu A.", text: "Väga hea koolitus, soovitan!", writtenAt: "2026-09-20", locale: "ru", note: "Paberil vormil" });
    expect($("[data-review-form]")).toBeNull();
    expect($("[data-review-add]")).not.toBeNull();
    expect(document.activeElement).toBe($("[data-review-add]")); // (focus goes back to where it was opened from)
  });

  test("pasted Word text: a vertical tab and a form feed become line breaks, any other control character a space; what is sent is storable", async () => {
    actions.saveManualReviewAction.mockResolvedValue({ ok: true, id: 12 });
    await show([]);
    await click($("[data-review-add]"));
    await choose(field("courseId"), "3");
    await type(field("name"), "Anu\u000bA.");
    await type(field("text"), "Esimene rida\u000bteine rida\u000ckolmas\u0001neljas\u0007viies\tkuues\u007f\r\nseitsmes");
    await type(field("note"), "Kiri\u000b20.09.\u0000");
    await submitForm();
    expect(actions.saveManualReviewAction).toHaveBeenCalledTimes(1);
    const sent = actions.saveManualReviewAction.mock.calls[0][0];
    expect(sent.text).toBe("Esimene rida\nteine rida\nkolmas neljas viies kuues \nseitsmes");
    expect(sent.name).toBe("Anu A.");
    expect(sent.note).toBe("Kiri\n20.09.");
    // nothing the database refuses is left
    for (const value of [sent.name, sent.text, sent.note]) expect(value).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  });

  test("a field the server refuses is marked in words under it; a refusal of the whole (a throw) is a line of words and the form stays", async () => {
    await show([]);
    await click($("[data-review-add]"));
    await choose(field("courseId"), "3");
    await type(field("name"), "Anu A.");
    await type(field("text"), "Väga hea koolitus.");
    await type(field("note"), "Kiri");
    actions.saveManualReviewAction.mockResolvedValueOnce({ ok: false, fields: { text: "tooLong" } });
    await submitForm();
    expect(field("text").getAttribute("aria-invalid")).toBe("true");
    expect(field("text").closest("div")!.textContent).toContain("Tekst on liiga pikk.");
    expect($("[data-review-form]")).not.toBeNull();
    actions.saveManualReviewAction.mockResolvedValueOnce({ ok: false, error: "server", text: E.server });
    await submitForm();
    expect($("[data-review-form-status]")!.textContent).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect($("[data-review-form]")).not.toBeNull();
  });

  test("a lost connection on the save is a line of words under the form, which keeps what was typed", async () => {
    actions.saveManualReviewAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await show([]);
    await click($("[data-review-add]"));
    await choose(field("courseId"), "3");
    await type(field("name"), "Anu A.");
    await type(field("text"), "Väga hea koolitus.");
    await type(field("note"), "Kiri");
    await submitForm();
    expect($("[data-review-form-status]")!.textContent).toBe(E.server);
    expect(field("text").value).toBe("Väga hea koolitus.");
    actions.saveManualReviewAction.mockResolvedValueOnce({ ok: true, id: 3 });
    await submitForm();
    expect($("[data-review-form]")).toBeNull();
  });

  test("„Tühista“ closes the form and sends nothing", async () => {
    await show([]);
    await click($("[data-review-add]"));
    await type(field("name"), "Anu");
    await click($("[data-review-cancel]"));
    expect($("[data-review-form]")).toBeNull();
    expect(actions.saveManualReviewAction).not.toHaveBeenCalled();
    await click($("[data-review-add]"));
    expect(field("name").value).toBe(""); // (a new form starts empty)
  });
});

describe("„Muuda“", () => {
  test("opens the form in the row, with the review's own fields (the day in Estonian time, its language, its note); a student's row next to it stays as it was", async () => {
    await show([manual(), student({ id: 7 })]);
    await click($("[data-review-edit]"));
    const form = $("[data-review-form]", rowOf(2))!;
    expect(form.getAttribute("data-review-form")).toBe("2");
    expect($("h3", form)!.textContent).toBe("Muuda arvustust");
    expect($("[data-review-warning]", form)!.textContent).toBe("Lisa ainult päris õpilase sõnad tema loal.");
    expect([field("courseId", form).value, field("name", form).value, field("text", form).value, field("writtenAt", form).value, field("locale", form).value, field("note", form).value]).toEqual([
      "3",
      "Anu A.",
      "Väga hea koolitus.",
      "2026-09-20",
      "ru",
      "Paberil vormil, 20.09.2026",
    ]);
    expect($("[data-review-name]", rowOf(2))).toBeNull(); // (the row's words give way to the form)
    expect($('[data-review="7"] [data-review-form]')).toBeNull();
    expect(buttonsOf(7)).toEqual(["Avalda", "Peida"]);
  });

  test("two forms can be open at once, each with what was typed in it", async () => {
    await show([manual(), manual({ id: 6, name: "Liis L." })]);
    await click($("[data-review-edit]", rowOf(2)));
    await type(field("text", rowOf(2)), "Esimene muudatus");
    await click($("[data-review-edit]", rowOf(6)));
    expect(all("[data-review-form]")).toHaveLength(2);
    expect(field("text", rowOf(2)).value).toBe("Esimene muudatus");
  });

  test("a change is sent with the review's id; done: the form closes and the focus goes back to „Muuda“", async () => {
    actions.saveManualReviewAction.mockResolvedValue({ ok: true, id: 2 });
    await show([manual()]);
    await click($("[data-review-edit]"));
    await type(field("text"), "Parandatud tekst.");
    await submitForm();
    expect(actions.saveManualReviewAction).toHaveBeenCalledWith({ id: 2, courseId: 3, name: "Anu A.", text: "Parandatud tekst.", writtenAt: "2026-09-20", locale: "ru", note: "Paberil vormil, 20.09.2026" });
    expect($("[data-review-form]")).toBeNull();
    expect(document.activeElement).toBe($("[data-review-edit]"));
  });

  test("„Tühista“ gives the row back with its words unchanged", async () => {
    await show([manual()]);
    await click($("[data-review-edit]"));
    await type(field("text"), "Midagi muud");
    await click($("[data-review-cancel]"));
    expect($("[data-review-form]")).toBeNull();
    expect($("[data-review-text]", rowOf(2))!.textContent).toBe("Väga hea koolitus.");
    expect(actions.saveManualReviewAction).not.toHaveBeenCalled();
  });

  test("a review that was deleted in another tab: the words, and the row goes with its form", async () => {
    actions.saveManualReviewAction.mockResolvedValue({ ok: false, error: "manualGone", text: E.manualGone });
    await show([manual()]);
    await click($("[data-review-edit]"));
    await submitForm();
    expect($("[data-review-form-status]")!.textContent).toBe("Seda arvustust enam pole.");
  });
});
