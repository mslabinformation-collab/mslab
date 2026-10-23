// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// „Tühista registreerimine“ at the bottom of the registration drawer (admin UX pass, piece 2, Task 6; README A2 drawer 6, B10; piece2-texts S3-g) in a
// browser-like document (happy-dom), with the server action answered here: the danger button asks with a ConfirmPanel in its place — the question
// with the student's name, the lines each only when true (the seat that is freed at once, the money and the invoices that stay in its three forms,
// and always that no mail goes) — and „Jah, tühista“ / „Katkesta“; nothing is cancelled before the yes; after it, today's „Registreerimine on
// tühistatud.“ takes the focus.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({ addManualPaymentAction: vi.fn(), saveRegistrationStatus: vi.fn(), cancelRegistration: vi.fn(), toggleRequestHandled: vi.fn() }));
vi.mock("@/server/actions/admin", () => actions);

import { RegistrationCancel } from "@/components/admin/RegistrationForms";

type Props = Parameters<typeof RegistrationCancel>[0];
const base: Props = { id: 7, name: "Kati Tamm", status: "confirmed", seat: "12.12 Tallinn", paidCents: 17500, hasInvoices: true };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => within.querySelector<E>(selector);
const all = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => [...within.querySelectorAll<E>(selector)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = async (over: Partial<Props> = {}) => {
  await act(async () => root.render(createElement(RegistrationCancel, { ...base, ...over })));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const trigger = () => all<HTMLButtonElement>("button").find((b) => text(b) === "Tühista registreerimine") ?? null;
const panel = () => $("[data-confirm-panel]");
const buttonOf = (label: string) => all<HTMLButtonElement>("button", panel()!).find((b) => text(b) === label) ?? null;
const linesOf = () => all("li", panel()!).map((li) => text(li));
/** Draws the drawer's bottom and presses the button (unless the question is open already: the page brought other facts while it was). */
const ask = async (over: Partial<Props> = {}) => {
  await show(over);
  if (trigger()) await click(trigger());
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

describe("the danger button asks with a ConfirmPanel in its place", () => {
  test("the button is there to begin with and does nothing by itself; pressed, the panel takes its place and the focus", async () => {
    await show();
    expect(trigger()).not.toBeNull();
    expect(panel()).toBeNull();
    await click(trigger());
    expect(actions.cancelRegistration).not.toHaveBeenCalled();
    expect(trigger()).toBeNull(); // (the panel stands where the button stood)
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(panel());
  });

  test("the question names the student: „Kas tühistan registreerimise: {name}?“ — a surname's case is not guessed — and the buttons are „Jah, tühista“ and „Katkesta“", async () => {
    await ask();
    expect(text($("[data-confirm-panel] > p"))).toBe("Kas tühistan registreerimise: Kati Tamm?");
    expect(all("button", panel()!).map(text)).toEqual(["Jah, tühista", "Katkesta"]);
    await ask({ name: "Мария Кузнецова" });
    expect(text($("[data-confirm-panel] > p"))).toBe("Kas tühistan registreerimise: Мария Кузнецова?");
  });
});

describe("the lines, each only when true (S3-g)", () => {
  test("a session whose seat is taken: the seat line first; the money and the invoices that stay; and that no mail goes", async () => {
    await ask();
    expect(linesOf()).toEqual(["Koht 12.12 Tallinn koolitusel vabaneb kohe avalikus kalendris.", "Laekunud 175 € ja arved jäävad alles.", "Õpilasele kirja ei saadeta."]);
  });

  test("no seat line without a session (or when the registration holds no seat now): the page passes none", async () => {
    await ask({ seat: null });
    expect(linesOf()).toEqual(["Laekunud 175 € ja arved jäävad alles.", "Õpilasele kirja ei saadeta."]);
  });

  test("the money line in its three forms: money and invoices; money only; invoices only — and none of them when there is neither", async () => {
    await ask({ paidCents: 17500, hasInvoices: true });
    expect(linesOf()[1]).toBe("Laekunud 175 € ja arved jäävad alles.");
    await show({ paidCents: 17500, hasInvoices: false }); // (the question stays open while the page brings other facts)
    expect(linesOf()).toContain("Laekunud 175 € jääb alles.");
    expect(linesOf()).not.toContain("Laekunud 175 € ja arved jäävad alles.");
    await ask({ paidCents: 0, hasInvoices: true });
    expect(linesOf()).toContain("Arved jäävad alles.");
    await ask({ paidCents: 0, hasInvoices: false });
    expect(linesOf()).toEqual(["Koht 12.12 Tallinn koolitusel vabaneb kohe avalikus kalendris.", "Õpilasele kirja ei saadeta."]);
  });

  test("the amount is written as the Raha card does: no euro sign inside, cents only when there are some", async () => {
    await ask({ paidCents: 5050 });
    expect(linesOf()[1]).toBe("Laekunud 50,50 € ja arved jäävad alles.");
    await ask({ paidCents: 123400 });
    expect(linesOf()[1]).toBe("Laekunud 1 234 € ja arved jäävad alles.");
  });

  test("„Õpilasele kirja ei saadeta.“ is always there, and is the last line", async () => {
    for (const over of [{}, { seat: null }, { paidCents: 0, hasInvoices: false }, { seat: null, paidCents: 0, hasInvoices: false }]) {
      await ask(over);
      expect(linesOf().at(-1), JSON.stringify(over)).toBe("Õpilasele kirja ei saadeta.");
    }
  });
});

describe("the answer", () => {
  test("„Katkesta“ and Esc close the question without cancelling anything; the focus goes back to the button; Esc goes no further", async () => {
    await ask();
    await click(buttonOf("Katkesta"));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await click(trigger());
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    await act(async () => void panel()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    document.removeEventListener("keydown", outside);
    expect(panel()).toBeNull();
    expect(outside).not.toHaveBeenCalled(); // (the drawer round it stays open)
    expect(document.activeElement).toBe(trigger());
    expect(actions.cancelRegistration).not.toHaveBeenCalled();
  });

  test("„Jah, tühista“ cancels this registration (its id, nothing else); the page then brings the cancelled state, and „Registreerimine on tühistatud.“ takes the focus", async () => {
    actions.cancelRegistration.mockResolvedValue({ ok: true });
    await ask();
    await click(buttonOf("Jah, tühista"));
    expect(actions.cancelRegistration).toHaveBeenCalledTimes(1);
    const sent = actions.cancelRegistration.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(sent.entries())).toEqual({ id: "7" });
    // (the action refreshes the page: the registration then arrives as cancelled)
    await show({ status: "cancelled", seat: null });
    expect(panel()).toBeNull();
    expect(trigger()).toBeNull();
    expect(text($("[data-cancelled]"))).toBe("Registreerimine on tühistatud.");
    expect(document.activeElement).toBe($("[data-cancelled]"));
  });

  test("a press while the first is on its way sends nothing more", async () => {
    let finish: (r: unknown) => void = () => {};
    actions.cancelRegistration.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await ask();
    const yes = buttonOf("Jah, tühista");
    await click(yes);
    await click(yes);
    expect(actions.cancelRegistration).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    await settle();
  });

  test("a failure is told in words, with the question still open to try again", async () => {
    actions.cancelRegistration.mockResolvedValue({ ok: false, error: "notFound" });
    await ask();
    await click(buttonOf("Jah, tühista"));
    expect(text($('[role="alert"]'))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(panel()).not.toBeNull();
    actions.cancelRegistration.mockResolvedValue({ ok: true });
    await click(buttonOf("Jah, tühista"));
    expect(actions.cancelRegistration).toHaveBeenCalledTimes(2);
  });

  test("a cancelled registration has no button and no question: only the line that says so", async () => {
    await show({ status: "cancelled" });
    expect(trigger()).toBeNull();
    expect(panel()).toBeNull();
    expect(text($("[data-cancelled]"))).toBe("Registreerimine on tühistatud.");
  });
});
