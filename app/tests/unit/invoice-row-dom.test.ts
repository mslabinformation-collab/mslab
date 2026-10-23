// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// One invoice's row (admin UX pass, piece 2, Task 6; README A2 drawer 4, the Part 2 prototype's Arved row): „Saada õpilasele“ and „Laadi alla (PDF)“
// in view, the rest under „Veel ▾“ (Muuda saajat, Märgi tasutuks, Tühista arve, Võta tasumine tagasi) as the state allows, and the two questions as
// ConfirmPanels: P-11 for „Tühista arve“ and S3-f for the undo of a receipt (chosen by its missing due date, not by what the mark added), with the
// sum the server will really take back. The server actions are answered here.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actions = vi.hoisted(() => ({
  createInvoiceAction: vi.fn(),
  sendInvoiceAction: vi.fn(),
  markInvoicePaidAction: vi.fn(),
  undoInvoicePaidAction: vi.fn(),
  cancelInvoiceAction: vi.fn(),
  updateInvoiceBuyerAction: vi.fn(),
  catchUpInvoiceAction: vi.fn(),
}));
vi.mock("@/server/actions/admin-invoices", () => actions);

import { InvoiceRow } from "@/components/admin/InvoiceRow";
import type { InvoiceView } from "@/components/admin/invoice-view";

const TODAY = "2026-10-16";
const BUYER = { name: "Kati Tamm", email: "kati@school.example", address: "", company: "", companyCode: "", companyAddress: "" };
const view = (over: Partial<InvoiceView> = {}): InvoiceView => ({
  id: 11,
  number: "MSL2026-001",
  kind: "prepayment",
  part: "Ettemaks 50%",
  course: "Kulmude baaskoolitus",
  session: "14.11.2026 Pärnu",
  amountCents: 17500,
  status: "unpaid",
  issuedAt: "2026-10-16T09:00:00.000Z",
  dueAt: "2026-10-23T09:00:00.000Z",
  paidAt: null,
  paidMethod: null,
  online: false,
  paidOnline: false,
  refunded: false,
  paidAdds: false,
  takeBack: null,
  sentAt: null,
  sentNote: "",
  buyer: BUYER,
  registrationId: 7,
  ...over,
});
const UNPAID = view();
/** A request Maria marked paid: it has a due date, and its mark added the money. */
const MARKED = view({ id: 12, number: "MSL2026-002", status: "paid", paidAt: "2026-10-15T09:00:00.000Z", paidMethod: "bank", paidAdds: true });
/** A receipt („Juba tasutud“, „Lisa laekumine“'s): born paid, so no due date. */
const RECEIPT = view({ id: 13, number: "MSL2026-003", status: "paid", dueAt: null, paidAt: "2026-10-12T09:00:00.000Z", paidMethod: "cash", paidAdds: true });
const ONLINE = view({ id: 14, number: "MSL2026-004", status: "paid", dueAt: null, paidAt: "2026-10-14T09:00:00.000Z", paidMethod: "montonio", online: true });
const CANCELLED = view({ id: 15, number: "MSL2026-005", status: "cancelled" });

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => within.querySelector<E>(selector);
const all = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => [...within.querySelectorAll<E>(selector)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
let shown = 0;
/** Draws the row afresh each time (a new key): what an earlier row left open does not carry over. */
const show = async (invoice: InvoiceView) => {
  await act(async () => root.render(createElement("ul", null, createElement(InvoiceRow, { key: ++shown, invoice, today: TODAY }))));
  await settle();
};
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
/** What is in view in the row's action group, in order. */
const inView = () => all("button, a", $('[role="group"]')!).map((el) => text(el));
const moreButton = () => $<HTMLButtonElement>("[data-more-menu] > button");
const menuItems = () => all('[role="menuitem"]').map((el) => text(el));
const openMenu = () => click(moreButton());
const choose = async (label: string) => {
  await openMenu();
  await click(all('[role="menuitem"]').find((el) => text(el) === label) ?? null);
};
const panel = () => $("[data-confirm-panel]");
const buttonsOf = (within: Element) => all("button", within).map((el) => text(el));
const linesOf = (within: Element) => all("li", within).map((el) => text(el));
const status = () => text($('[role="status"]'));
const press = (el: Element, key: string) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

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

describe("what is in view, and what is under „Veel ▾“ (README A2 drawer 4)", () => {
  test("Tasumata: „Saada õpilasele“ and „Laadi alla (PDF)“ in view; Muuda saajat, Märgi tasutuks and Tühista arve under „Veel ▾“", async () => {
    await show(UNPAID);
    expect(inView()).toEqual(["Saada õpilasele", "Laadi alla (PDF)", "Veel ▾"]);
    expect(menuItems()).toEqual([]); // (closed)
    await openMenu();
    expect(menuItems()).toEqual(["Muuda saajat", "Märgi tasutuks", "Tühista arve"]);
    expect(all('[role="menuitem"]').map((el) => el.getAttribute("data-tone"))).toEqual([null, null, "danger"]);
  });

  test("Tasutud by Maria's mark, and a receipt: „Võta tasumine tagasi“ is the one thing under „Veel ▾“", async () => {
    for (const paid of [MARKED, RECEIPT]) {
      await show(paid);
      expect(inView(), paid.number).toEqual(["Saada õpilasele", "Laadi alla (PDF)", "Veel ▾"]);
      await openMenu();
      expect(menuItems(), paid.number).toEqual(["Võta tasumine tagasi"]);
    }
  });

  test("Tasutud online: „Saada õpilasele“ and the PDF, and no „Veel ▾“ (an online payment's invoice is never changed by Maria)", async () => {
    await show(ONLINE);
    expect(inView()).toEqual(["Saada õpilasele", "Laadi alla (PDF)"]);
    expect(moreButton()).toBeNull();
  });

  test("Tühistatud: the PDF only", async () => {
    await show(CANCELLED);
    expect(inView()).toEqual(["Laadi alla (PDF)"]);
    expect(moreButton()).toBeNull();
  });

  test("„Tagastatud“ (the online payment was refunded): no „Saada õpilasele“ — the PDF only, no menu", async () => {
    await show(view({ ...ONLINE, refunded: true }));
    expect($("[data-invoice-state]")!.textContent).toBe("Tagastatud");
    expect(inView()).toEqual(["Laadi alla (PDF)"]);
    expect(moreButton()).toBeNull();
  });

  test("paid online and waiting for its catch-up (R14): no „Saada õpilasele“ and no „Märgi tasutuks“; the rest is under „Veel ▾“", async () => {
    await show(view({ paidOnline: true }));
    expect(inView()).toEqual(["Laadi alla (PDF)", "Veel ▾"]);
    await openMenu();
    expect(menuItems()).toEqual(["Muuda saajat", "Tühista arve"]);
  });

  test("each row's menu is named from words on screen: „Veel: {number}“ (a list has one on every row), and it is a menu", async () => {
    await show(UNPAID);
    expect(moreButton()!.getAttribute("aria-label")).toBe("Veel: MSL2026-001");
    expect(moreButton()!.getAttribute("aria-haspopup")).toBe("menu");
    await openMenu();
    expect($('[role="menu"]')).not.toBeNull();
  });

  test("a menu item opens the same panels as before: the buyer's fields, the day and the way, with „Katkesta“ giving the focus back to „Veel ▾“", async () => {
    await show(UNPAID);
    await choose("Muuda saajat");
    expect($('[data-invoice-panel="buyer"]')).not.toBeNull();
    expect(document.activeElement).toBe($('[data-buyer-field="name"]'));
    await click(all("button", $('[data-invoice-panel="buyer"]')!).find((b) => text(b) === "Katkesta") ?? null);
    expect($('[data-invoice-panel="buyer"]')).toBeNull();
    expect(document.activeElement).toBe(moreButton());
    await choose("Märgi tasutuks");
    expect($('[data-invoice-panel="paid"]')).not.toBeNull();
    expect($<HTMLInputElement>("[data-paid-date]")!.value).toBe(TODAY);
  });

  test("„Saada õpilasele“ stays a button in view: its panel opens, and „Katkesta“ gives the focus back to it", async () => {
    await show(UNPAID);
    await click($("[data-invoice-send]"));
    expect($('[data-invoice-panel="send"]')).not.toBeNull();
    await click(all("button", $('[data-invoice-panel="send"]')!).find((b) => text(b) === "Katkesta") ?? null);
    expect($('[data-invoice-panel="send"]')).toBeNull();
    expect(document.activeElement).toBe($("[data-invoice-send]"));
  });
});

describe("„Tühista arve“ asks with a ConfirmPanel (P-11)", () => {
  test("„Kas tühistan arve {number}?“, the one line, „Jah, tühista arve“ and „Katkesta“; nothing is done before the answer; the panel takes the focus", async () => {
    await show(UNPAID);
    await choose("Tühista arve");
    expect(text($("[data-confirm-panel] p"))).toBe("Kas tühistan arve MSL2026-001?");
    expect(linesOf(panel()!)).toEqual(["Number jääb alles ja summa on uue arve jaoks jälle vaba."]);
    expect(buttonsOf(panel()!)).toEqual(["Jah, tühista arve", "Katkesta"]);
    expect(document.activeElement).toBe(panel());
    expect(actions.cancelInvoiceAction).not.toHaveBeenCalled();
  });

  test("„Katkesta“ keeps the invoice and the focus goes back to „Veel ▾“; so does Esc, which closes only the panel", async () => {
    await show(UNPAID);
    await choose("Tühista arve");
    await click(all("button", panel()!).find((b) => text(b) === "Katkesta") ?? null);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(moreButton());
    await choose("Tühista arve");
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    await press(panel()!, "Escape");
    document.removeEventListener("keydown", outside);
    expect(panel()).toBeNull();
    expect(outside).not.toHaveBeenCalled(); // (the drawer round it stays open)
    expect(document.activeElement).toBe(moreButton());
    expect(actions.cancelInvoiceAction).not.toHaveBeenCalled();
  });

  test("„Jah, tühista arve“ cancels it, and the screen says so", async () => {
    actions.cancelInvoiceAction.mockResolvedValue({ ok: true });
    await show(UNPAID);
    await choose("Tühista arve");
    await click(all("button", panel()!).find((b) => text(b) === "Jah, tühista arve") ?? null);
    expect(actions.cancelInvoiceAction).toHaveBeenCalledWith({ id: 11 });
    expect(status()).toBe("Arve on tühistatud.");
    expect(panel()).toBeNull();
  });

  test("a refusal is shown in its words and the question stays", async () => {
    actions.cancelInvoiceAction.mockResolvedValue({ ok: false, error: "notUnpaid", text: "See arve pole enam tasumata. Laadi leht uuesti." });
    await show(UNPAID);
    await choose("Tühista arve");
    await click(all("button", panel()!).find((b) => text(b) === "Jah, tühista arve") ?? null);
    expect(status()).toBe("See arve pole enam tasumata. Laadi leht uuesti.");
    expect(panel()).not.toBeNull();
  });

  test("a second press while the first is on its way sends nothing more", async () => {
    let finish: (r: unknown) => void = () => {};
    actions.cancelInvoiceAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await show(UNPAID);
    await choose("Tühista arve");
    const yes = all("button", panel()!).find((b) => text(b) === "Jah, tühista arve") ?? null;
    await click(yes);
    await click(yes);
    expect(actions.cancelInvoiceAction).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    await settle();
    expect(status()).toBe("Arve on tühistatud.");
  });
});

describe("„Võta tasumine tagasi“ of a receipt asks with a ConfirmPanel (S3-f)", () => {
  const yes = () => all("button", panel()!).find((b) => text(b) === "Jah, võta tasumine tagasi") ?? null;

  test("the question, the three lines when the registration then falls under 50 %, and the two buttons", async () => {
    await show(view({ ...RECEIPT, takeBack: { cents: 17500, backToAwaiting: true } }));
    await choose("Võta tasumine tagasi");
    expect(text($("[data-confirm-panel] p"))).toBe("Kas võtan kviitungi MSL2026-003 tasumise tagasi?");
    expect(linesOf(panel()!)).toEqual(["Kviitung tühistatakse (number jääb alles).", "Laekunud summa väheneb 175 €.", "Registreering läheb tagasi olekusse „Ootab ettemaksu“."]);
    expect(buttonsOf(panel()!)).toEqual(["Jah, võta tasumine tagasi", "Katkesta"]);
    expect(document.activeElement).toBe(panel());
    expect(actions.undoInvoicePaidAction).not.toHaveBeenCalled();
  });

  test("the third line only when the sum then drops under 50 % (the place stays otherwise)", async () => {
    await show(view({ ...RECEIPT, takeBack: { cents: 17500, backToAwaiting: false } }));
    await choose("Võta tasumine tagasi");
    expect(linesOf(panel()!)).toEqual(["Kviitung tühistatakse (number jääb alles).", "Laekunud summa väheneb 175 €."]);
  });

  test("{x} is what the server will really take back: a cap below the receipt's amount shows the capped sum, with cents when there are some", async () => {
    await show(view({ ...RECEIPT, amountCents: 17500, takeBack: { cents: 5050, backToAwaiting: false } }));
    await choose("Võta tasumine tagasi");
    expect(linesOf(panel()!)[1]).toBe("Laekunud summa väheneb 50,50 €.");
    await show(view({ ...RECEIPT, amountCents: 17500, takeBack: { cents: 0, backToAwaiting: false } }));
    await choose("Võta tasumine tagasi");
    expect(linesOf(panel()!)[1]).toBe("Laekunud summa väheneb 0 €.");
  });

  test("where the page does not know the registration (the Arved list) the receipt's own amount is shown and the third line is left out", async () => {
    await show(view({ ...RECEIPT, takeBack: null }));
    await choose("Võta tasumine tagasi");
    expect(linesOf(panel()!)).toEqual(["Kviitung tühistatakse (number jääb alles).", "Laekunud summa väheneb 175 €."]);
  });

  test("a receipt is told by its missing due date, not by whether the mark added money: both kinds of receipt get S3-f", async () => {
    for (const paidAdds of [true, false]) {
      await show(view({ ...RECEIPT, paidAdds, takeBack: { cents: 17500, backToAwaiting: false } }));
      await choose("Võta tasumine tagasi");
      expect(text($("[data-confirm-panel] p")), String(paidAdds)).toBe("Kas võtan kviitungi MSL2026-003 tasumise tagasi?");
    }
  });

  test("a request Maria marked paid keeps today's words: it is unpaid again and the amount comes off „Laekunud summa“", async () => {
    await show(MARKED);
    await choose("Võta tasumine tagasi");
    expect(text($("[data-confirm-panel] p"))).toBe("Arve muutub uuesti tasumata ja summa võetakse „Laekunud summa“ alt maha.");
    expect(linesOf(panel()!)).toEqual([]);
    expect(buttonsOf(panel()!)).toEqual(["Jah, võta tasumine tagasi", "Katkesta"]);
  });

  test("„Katkesta“ and Esc leave everything as it was, with the focus back on „Veel ▾“", async () => {
    await show(view({ ...RECEIPT, takeBack: { cents: 17500, backToAwaiting: false } }));
    await choose("Võta tasumine tagasi");
    await click(all("button", panel()!).find((b) => text(b) === "Katkesta") ?? null);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(moreButton());
    await choose("Võta tasumine tagasi");
    await press(panel()!, "Escape");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(moreButton());
    expect(actions.undoInvoicePaidAction).not.toHaveBeenCalled();
  });

  test("confirmed: the action runs, and the screen says which of the two it was, by the status that came back", async () => {
    actions.undoInvoicePaidAction.mockResolvedValueOnce({ ok: true, status: "cancelled" }).mockResolvedValueOnce({ ok: true, status: "unpaid" });
    await show(view({ ...RECEIPT, takeBack: { cents: 17500, backToAwaiting: false } }));
    await choose("Võta tasumine tagasi");
    await click(yes());
    expect(actions.undoInvoicePaidAction).toHaveBeenLastCalledWith({ id: 13 });
    expect(status()).toBe("Kviitung on tühistatud.");
    await show(MARKED);
    await choose("Võta tasumine tagasi");
    await click(yes());
    expect(actions.undoInvoicePaidAction).toHaveBeenLastCalledWith({ id: 12 });
    expect(status()).toBe("Arve on jälle tasumata.");
  });

  test("a refusal is shown in its words and the question stays", async () => {
    actions.undoInvoicePaidAction.mockResolvedValue({ ok: false, error: "notManual", text: "Veebis tasutud arvet ei saa tagasi võtta." });
    await show(MARKED);
    await choose("Võta tasumine tagasi");
    await click(yes());
    expect(status()).toBe("Veebis tasutud arvet ei saa tagasi võtta.");
    expect(panel()).not.toBeNull();
  });
});
