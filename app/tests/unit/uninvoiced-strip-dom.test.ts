// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The strip „Arveta maksed: {n}“ on the Arved page (admin UX pass, piece 2, Task 14; README A6, B11, piece2-texts S3-l and P-8, the Part 2 prototype's
// Arved frame): the title with the count, the summary line, „Näita ▸“ / „Peida ▾“ for the per-row list (open at once on a deep link to #arveta), and
// „Koosta {n} arvet“ → a ConfirmPanel with the numbers → the result in words. The n = 1 forms are S3-l's. The server action is answered here.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ createInvoicesForUnbilledAction: vi.fn(), catchUpInvoiceAction: vi.fn() }));
vi.mock("@/server/actions/admin-invoices", () => actions);

import { UninvoicedStrip, resultLines } from "@/components/admin/UninvoicedStrip";

const SUMMARY = "Tasutud, aga arve puudub · 525,00 € · Kati Tamm, Mari Kask, Liis Mets";
const ROWS = createElement("ul", { "data-rows": "" }, createElement("li", null, "Kati Tamm · 175,00 €"), createElement("li", null, "Mari Kask · 175,00 €"));

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => within.querySelector<E>(selector);
const all = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => [...within.querySelectorAll<E>(selector)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
type Props = { ids: number[]; first: string; last: string; linked: number; summary: string; ready: boolean };
const THREE: Props = { ids: [4, 5, 6], first: "MSL2026-004", last: "MSL2026-006", linked: 0, summary: SUMMARY, ready: true };
let shown = 0;
const show = async (over: Partial<Props> = {}, fresh = true) => {
  await act(async () => root.render(createElement(UninvoicedStrip, { key: fresh ? ++shown : shown, ...THREE, ...over }, ROWS)));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const bulk = () => $<HTMLButtonElement>("[data-uninvoiced-bulk]");
const toggle = () => $<HTMLButtonElement>("[data-uninvoiced-toggle]");
const panel = () => $("[data-confirm-panel]");
const yes = () => all("button", panel()!)[0]; // (the first of the two: it says what is happening while the press is on its way)
const cancelButton = () => all("button", panel()!).find((b) => text(b) === "Katkesta")!;
const status = () => text($("[data-uninvoiced-result]"));
const press = (el: Element, key: string) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
const listBox = () => $<HTMLElement>("[data-uninvoiced-list]")!;

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  window.location.hash = "";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the strip, closed", () => {
  test("it is the anchor #arveta; the title counts the payments, the summary says what they are; the list is folded away", async () => {
    await show();
    const strip = $("section#arveta")!;
    expect(strip).not.toBeNull();
    expect(strip.getAttribute("data-uninvoiced")).toBe("");
    expect(text($("h2", strip))).toBe("Arveta maksed: 3");
    expect(strip.getAttribute("aria-labelledby")).toBe($("h2", strip)!.id);
    expect(text($("[data-uninvoiced-summary]"))).toBe(SUMMARY);
    expect(listBox().hidden).toBe(true);
    expect(text(toggle())).toBe("Näita ▸");
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
    expect(toggle()!.getAttribute("aria-controls")).toBe(listBox().id);
    expect(text(bulk())).toBe("Koosta 3 arvet");
    expect(panel()).toBeNull();
  });

  test("„Näita ▸“ opens the per-row list and says „Peida ▾“; pressed again it folds it away", async () => {
    await show();
    await click(toggle());
    expect(listBox().hidden).toBe(false);
    expect(text(toggle())).toBe("Peida ▾");
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
    expect(text(listBox())).toContain("Kati Tamm · 175,00 €");
    await click(toggle());
    expect(listBox().hidden).toBe(true);
    expect(text(toggle())).toBe("Näita ▸");
  });

  test("a deep link to #arveta (the overview's „Arveta makset“ row) opens the list, on arrival and when the address changes to it later", async () => {
    window.location.hash = "#arveta";
    await show();
    expect(listBox().hidden).toBe(false);
    expect(text(toggle())).toBe("Peida ▾");
    await act(async () => root.unmount());
    root = createRoot(container);
    window.location.hash = "";
    await show();
    expect(listBox().hidden).toBe(true);
    await act(async () => {
      window.location.hash = "#arveta";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(listBox().hidden).toBe(false);
  });

  test("with a single payment the button and the title say so: „Koosta 1 arve“", async () => {
    await show({ ids: [4], first: "MSL2026-004", last: "MSL2026-004" });
    expect(text($("h2"))).toBe("Arveta maksed: 1");
    expect(text(bulk())).toBe("Koosta 1 arve");
  });

  test("Seaded's seller card empty: the link stands in place of the button, and there is nothing to press", async () => {
    await show({ ready: false });
    expect(bulk()).toBeNull();
    const link = $<HTMLAnchorElement>("[data-uninvoiced-need-seller]")!;
    expect(text(link)).toBe("Täida Seaded → Maksmine");
    expect(link.getAttribute("href")).toBe("/admin/seaded#maksmine");
  });
});

describe("„Koosta {n} arvet“ asks with a ConfirmPanel (B11)", () => {
  test("the question, the one line with the numbers, „Jah, koosta {n} arvet“ and „Katkesta“; the button gives its place to the panel; nothing is sent yet", async () => {
    await show();
    await click(bulk());
    expect(text($("p", panel()!))).toBe("Kas koostan 3 arvet?");
    expect(all("li", panel()!).map(text)).toEqual(["Iga arve saab oma numbri (MSL2026-004–MSL2026-006). Õpilastele neid ei saadeta."]);
    expect(all("button", panel()!).map(text)).toEqual(["Jah, koosta 3 arvet", "Katkesta"]);
    expect(bulk()).toBeNull();
    expect(document.activeElement).toBe(panel());
    expect(actions.createInvoicesForUnbilledAction).not.toHaveBeenCalled();
  });

  test("n = 1 (S3-l): „Kas koostan 1 arve?“, „Arve saab numbri {first}. Õpilasele seda ei saadeta.“, „Jah, koosta 1 arve“", async () => {
    await show({ ids: [4], first: "MSL2026-004", last: "MSL2026-004" });
    await click(bulk());
    expect(text($("p", panel()!))).toBe("Kas koostan 1 arve?");
    expect(all("li", panel()!).map(text)).toEqual(["Arve saab numbri MSL2026-004. Õpilasele seda ei saadeta."]);
    expect(all("button", panel()!).map(text)).toEqual(["Jah, koosta 1 arve", "Katkesta"]);
  });

  test("when a payment pays an invoice already made the line names no range (it would not be one): „Iga arve saab oma numbri. Õpilastele neid ei saadeta.“; n = 1 keeps its number, whoever's it is", async () => {
    await show({ linked: 1, first: "MSL2026-042", last: "MSL2026-043" });
    await click(bulk());
    expect(text($("p", panel()!))).toBe("Kas koostan 3 arvet?");
    expect(all("li", panel()!).map(text)).toEqual(["Iga arve saab oma numbri. Õpilastele neid ei saadeta."]);
    await click(cancelButton());
    await show({ ids: [4], first: "MSL2026-007", last: "MSL2026-007", linked: 1 });
    await click(bulk());
    expect(all("li", panel()!).map(text)).toEqual(["Arve saab numbri MSL2026-007. Õpilasele seda ei saadeta."]);
  });

  test("while the batch is on its way „Katkesta“ and Esc do nothing: the panel stays, the focus does not move, and when the answer comes the result is shown", async () => {
    let finish: (v: unknown) => void = () => {};
    actions.createInvoicesForUnbilledAction.mockReturnValue(new Promise((r) => (finish = r)));
    await show();
    await click(bulk());
    await click(yes());
    const before = document.activeElement;
    await click(cancelButton());
    await press(panel()!, "Escape");
    expect(panel(), "the panel is still there").not.toBeNull();
    expect(text(yes())).toBe("Koostan…");
    expect(document.activeElement).toBe(before);
    expect(actions.createInvoicesForUnbilledAction).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, made: ["MSL2026-004", "MSL2026-005", "MSL2026-006"], already: 0, failed: [], sellerMissing: false, linked: 0 }));
    await settle();
    expect(panel()).toBeNull();
    expect(status()).toBe("Koostatud 3 arvet: MSL2026-004–MSL2026-006.");
  });

  test("„Katkesta“ and Esc close the panel, send nothing, and the focus goes back to the button", async () => {
    await show();
    await click(bulk());
    await click(cancelButton());
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(bulk());
    await click(bulk());
    await press(panel()!, "Escape");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(bulk());
    expect(actions.createInvoicesForUnbilledAction).not.toHaveBeenCalled();
  });

  test("„Jah“ sends the list the panel showed, once; the panel says what is happening; on the answer it closes and the screen says what was made, with the focus on that line", async () => {
    let finish: (v: unknown) => void = () => {};
    actions.createInvoicesForUnbilledAction.mockReturnValue(new Promise((r) => (finish = r)));
    await show();
    await click(bulk());
    await click(yes());
    expect(actions.createInvoicesForUnbilledAction).toHaveBeenCalledWith({ ids: [4, 5, 6] });
    expect(text(yes())).toBe("Koostan…");
    await click(yes()); // (a second press while it is on its way)
    expect(actions.createInvoicesForUnbilledAction).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, made: ["MSL2026-004", "MSL2026-005", "MSL2026-006"], already: 0, failed: [], sellerMissing: false, linked: 0 }));
    await settle();
    expect(panel()).toBeNull();
    expect(status()).toBe("Koostatud 3 arvet: MSL2026-004–MSL2026-006.");
    expect($("[data-uninvoiced-result]")!.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe($("[data-uninvoiced-result]"));
  });

  test("one made: the existing „Arve {number} on valmis.“", async () => {
    actions.createInvoicesForUnbilledAction.mockResolvedValue({ ok: true, made: ["MSL2026-004"], already: 0, failed: [], sellerMissing: false, linked: 0 });
    await show({ ids: [4], first: "MSL2026-004", last: "MSL2026-004" });
    await click(bulk());
    await click(yes());
    expect(status()).toBe("Arve MSL2026-004 on valmis.");
  });

  test("a refusal is shown in its words and the question stays", async () => {
    actions.createInvoicesForUnbilledAction.mockResolvedValue({ ok: false, error: "server", text: "Midagi läks valesti. Proovi uuesti." });
    await show();
    await click(bulk());
    await click(yes());
    expect(status()).toBe("Midagi läks valesti. Proovi uuesti.");
    expect($("[data-uninvoiced-result]")!.className).toMatch(/error/);
    expect(panel()).not.toBeNull();
  });

  test("when the payments are all billed the page refreshes to none: the strip is gone but for the line that says what was done", async () => {
    actions.createInvoicesForUnbilledAction.mockResolvedValue({ ok: true, made: ["MSL2026-004", "MSL2026-005", "MSL2026-006"], already: 0, failed: [], sellerMissing: false, linked: 0 });
    await show();
    await click(bulk());
    await click(yes());
    await show({ ids: [], first: "", last: "", summary: "" }, false); // (the same strip, drawn again by the refreshed page: its state is kept)
    expect(status()).toBe("Koostatud 3 arvet: MSL2026-004–MSL2026-006.");
    expect(document.activeElement, "the line the press gave the focus is the same element after the refresh").toBe($("[data-uninvoiced-result]"));
    expect($("h2")).toBeNull();
    expect(bulk()).toBeNull();
    expect(toggle()).toBeNull();
  });

  test("with nothing to bill and nothing to say the strip draws nothing", async () => {
    await show({ ids: [], first: "", last: "", summary: "" });
    expect(container.innerHTML).toBe("");
  });
});

describe("what a press made, in words (piece2-texts S3-l)", () => {
  const done = (over: Partial<Parameters<typeof resultLines>[0]> = {}) => ({ made: [], already: 0, failed: [], sellerMissing: false, linked: 0, ...over });

  test("one made: „Arve {number} on valmis.“; two or more: „Koostatud {n} arvet: {first}–{last}.“", () => {
    expect(resultLines(done({ made: ["MSL2026-004"] }))).toEqual(["Arve MSL2026-004 on valmis."]);
    expect(resultLines(done({ made: ["MSL2026-004", "MSL2026-005"] }))).toEqual(["Koostatud 2 arvet: MSL2026-004–MSL2026-005."]);
    expect(resultLines(done({ made: ["MSL2026-004", "MSL2026-005", "MSL2026-006"] }))).toEqual(["Koostatud 3 arvet: MSL2026-004–MSL2026-006."]);
  });

  test("when some paid an invoice already made the numbers are no range, so two or more made say only how many: „Koostatud {n} arvet.“", () => {
    expect(resultLines(done({ made: ["MSL2026-042", "MSL2026-007"], linked: 1 }))).toEqual(["Koostatud 2 arvet."]);
    expect(resultLines(done({ made: ["MSL2026-007", "MSL2026-008", "MSL2026-001"], linked: 1, already: 1 }))).toEqual(["Koostatud 3 arvet.", "Juba arvega: 1."]);
    // one made keeps its number, linked or not
    expect(resultLines(done({ made: ["MSL2026-001"], linked: 1 }))).toEqual(["Arve MSL2026-001 on valmis."]);
  });

  test("M4: numbers that are no run — an online payment took one during the batch — are no range either: „Koostatud {n} arvet.“", () => {
    // 004 and 006 were made; 005 went to a payment that landed in between
    expect(resultLines(done({ made: ["MSL2026-004", "MSL2026-006"] }))).toEqual(["Koostatud 2 arvet."]);
    expect(resultLines(done({ made: ["MSL2026-004", "MSL2026-005", "MSL2026-007"] }))).toEqual(["Koostatud 3 arvet."]);
    // a series that begins again with the year, or a prefix that changed, is no run
    expect(resultLines(done({ made: ["MSL2026-099", "MSL2027-001"] }))).toEqual(["Koostatud 2 arvet."]);
    // a run across the width of the padding is still one (999 → 1000)
    expect(resultLines(done({ made: ["MSL2026-999", "MSL2026-1000"] }))).toEqual(["Koostatud 2 arvet: MSL2026-999–MSL2026-1000."]);
    // the other lines are as they were
    expect(resultLines(done({ made: ["MSL2026-004", "MSL2026-006"], already: 1, failed: ["Mari Kask"] }))).toEqual(["Koostatud 2 arvet.", "Juba arvega: 1.", "Ei õnnestunud: Mari Kask. Proovi uuesti."]);
  });

  test("billed meanwhile: „Juba arvega: {n}.“; failures: „Ei õnnestunud: {names}. Proovi uuesti.“; all of them, in that order", () => {
    expect(resultLines(done({ already: 2 }))).toEqual(["Juba arvega: 2."]);
    expect(resultLines(done({ failed: ["Mari Kask", "Liis Mets"] }))).toEqual(["Ei õnnestunud: Mari Kask, Liis Mets. Proovi uuesti."]);
    expect(resultLines(done({ made: ["MSL2026-004", "MSL2026-005"], already: 1, failed: ["Mari Kask"] }))).toEqual([
      "Koostatud 2 arvet: MSL2026-004–MSL2026-005.",
      "Juba arvega: 1.",
      "Ei õnnestunud: Mari Kask. Proovi uuesti.",
    ]);
  });

  test("the seller card empty: the existing line, and what was made before it is still said", () => {
    expect(resultLines(done({ sellerMissing: true }))).toEqual(["Täida Seaded → Maksmine"]);
    expect(resultLines(done({ made: ["MSL2026-004"], sellerMissing: true }))).toEqual(["Arve MSL2026-004 on valmis.", "Täida Seaded → Maksmine"]);
  });

  test("the screen shows each in its tone: a failure or an empty card as an error, the rest as done", async () => {
    actions.createInvoicesForUnbilledAction.mockResolvedValue({ ok: true, made: ["MSL2026-004", "MSL2026-005"], already: 0, failed: ["Liis Mets"], sellerMissing: false, linked: 0 });
    await show();
    await click(bulk());
    await click(yes());
    expect(status()).toBe("Koostatud 2 arvet: MSL2026-004–MSL2026-005. Ei õnnestunud: Liis Mets. Proovi uuesti.");
    expect($("[data-uninvoiced-result]")!.className).toMatch(/error/);
  });
});
