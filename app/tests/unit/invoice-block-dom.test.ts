// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { coveringInvoices, openAmounts, type OpenAmount, type OpenAmounts } from "@/domain/invoice";

// The registration drawer's „Arved“ (invoices Task 5, spec §5, D5, D6, rulings R10 and R1; admin UX pass, piece 2, Task 6) in a browser-like document
// (happy-dom), with the server actions answered here: the actions each state has in view (the rest, and the two ConfirmPanels of „Võta tasumine
// tagasi“ and „Tühista arve“, are tests/unit/invoice-row-dom.test.ts), „Koosta arve“ — one button, never two — offering exactly the open amounts
// and the two kinds with the day and the way for „Juba tasutud“, the link to Seaded when there is no seller, „Saada õpilasele“ with its second
// address, „Märgi tasutuks“ and „Muuda saajat“ chosen under „Veel ▾“ with its refused fields, and the block's folded row on a phone.

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

import { InvoiceBlock } from "@/components/admin/InvoiceBlock";
import type { InvoiceView } from "@/components/admin/invoice-view";

const NBSP = " ";
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
// (a request she marked paid keeps its due date; only a receipt is born paid with none)
const MARKED = view({ id: 12, number: "MSL2026-002", status: "paid", paidAt: "2026-10-15T09:00:00.000Z", paidMethod: "bank", paidAdds: true });
const RECEIPT = view({ id: 13, number: "MSL2026-003", status: "paid", dueAt: null, paidAt: "2026-10-12T09:00:00.000Z", paidMethod: "cash", paidAdds: false });
const ONLINE = view({ id: 14, number: "MSL2026-004", status: "paid", dueAt: null, paidAt: "2026-10-14T09:00:00.000Z", paidMethod: "montonio", online: true });
const CANCELLED = view({ id: 15, number: "MSL2026-005", status: "cancelled" });
const AMOUNTS: OpenAmount[] = [
  { kind: "prepayment", cents: 17500, part: "Ettemaks 50%" },
  { kind: "full", cents: 35000, part: "Kogu summa (100%)" },
];
/** Nothing typed by hand: „Maksmiseks“ and „Juba tasutud“ are offered the same amounts. */
const both = (amounts: OpenAmount[]): OpenAmounts => ({ request: amounts, receipt: amounts });
const OPEN = both(AMOUNTS);
const NONE = both([]);

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => within.querySelector<E>(selector);
const all = <E extends Element = HTMLElement>(selector: string, within: ParentNode = container) => [...within.querySelectorAll<E>(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
type Props = Partial<Parameters<typeof InvoiceBlock>[0]>;
const show = async (props: Props = {}) => {
  await act(async () => root.render(createElement(InvoiceBlock, { registrationId: 7, invoices: [UNPAID], uninvoiced: [], open: OPEN, sellerReady: true, canCreate: true, today: TODAY, ...props })));
  await settle();
};
const rowOf = (number: string) => $(`[data-invoice="${number}"]`)!;
/** The names of the buttons and links in a row's action group, in order. */
const actionsOf = (number: string) => all("button, a", $('[role="group"]', rowOf(number))!).map((el) => el.textContent);
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const button = (text: string, within: ParentNode = container) => all<HTMLButtonElement>("button", within).find((b) => b.textContent === text) ?? null;
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submitForm = async (form: Element | null) => {
  await act(async () => (form as HTMLFormElement).requestSubmit());
  await settle();
};
const line = (within: ParentNode) => $('[role="status"]', within)!.textContent;
/** An action under a row's „Veel ▾“: opens the menu and chooses the item by its words. */
const viaMenu = async (number: string, label: string) => {
  await click($("[data-more-menu] > button", rowOf(number)));
  await click(all('[role="menuitem"]', rowOf(number)).find((el) => el.textContent === label) ?? null);
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

describe("the list: each state shows the actions it allows, and no others", () => {
  test("Tasumata: Saada õpilasele, Muuda saajat, Märgi tasutuks, Tühista arve and the PDF", async () => {
    await show();
    expect(actionsOf("MSL2026-001")).toEqual(["Saada õpilasele", "Laadi alla (PDF)", "Veel ▾"]);
    expect($("[data-invoice-state]", rowOf("MSL2026-001"))!.textContent).toBe("Tasumata");
  });

  test("Tasutud by Maria's mark or receipt: send, undo and the PDF — not mark, cancel or edit; an online payment's invoice: send and the PDF only", async () => {
    await show({ invoices: [MARKED, RECEIPT, ONLINE] });
    expect(actionsOf("MSL2026-002")).toEqual(["Saada õpilasele", "Laadi alla (PDF)", "Veel ▾"]);
    expect(actionsOf("MSL2026-003")).toEqual(["Saada õpilasele", "Laadi alla (PDF)", "Veel ▾"]);
    expect(actionsOf("MSL2026-004")).toEqual(["Saada õpilasele", "Laadi alla (PDF)"]);
    for (const n of ["MSL2026-002", "MSL2026-003", "MSL2026-004"]) expect($("[data-invoice-state]", rowOf(n))!.textContent).toBe("Tasutud");
  });

  test("Tühistatud: the PDF only (nothing to send, nothing to undo)", async () => {
    await show({ invoices: [CANCELLED] });
    expect(actionsOf("MSL2026-005")).toEqual(["Laadi alla (PDF)"]);
    expect($("[data-invoice-state]", rowOf("MSL2026-005"))!.textContent).toBe("Tühistatud");
  });

  test("the row: number, the amount in euros with a no-break space, what it is for, when it was made and is due, or paid and how; the download is Maria's route", async () => {
    await show({ invoices: [UNPAID, MARKED, ONLINE] });
    expect($("[data-invoice-amount]", rowOf("MSL2026-001"))!.textContent).toBe(`175,00${NBSP}€`);
    expect($("[data-invoice-facts]", rowOf("MSL2026-001"))!.textContent).toBe("Ettemaks 50% · Koostatud 16.10.2026 · Maksta kuni 23.10.2026");
    expect($("[data-invoice-facts]", rowOf("MSL2026-002"))!.textContent).toBe("Ettemaks 50% · Koostatud 16.10.2026 · Tasutud 15.10.2026 · Pangaülekanne");
    expect($("[data-invoice-facts]", rowOf("MSL2026-004"))!.textContent).toContain("Tasutud 14.10.2026 · Montonio");
    const link = $<HTMLAnchorElement>("[data-invoice-download]", rowOf("MSL2026-001"))!;
    expect(link.getAttribute("href")).toBe("/api/admin/arve/11");
    expect(link.getAttribute("aria-label")).toBe("Laadi alla (PDF): arve MSL2026-001");
  });

  test("the last send: when, and the second address if there was one; none yet shows nothing", async () => {
    await show({ invoices: [view({ sentAt: "2026-10-17T07:00:00.000Z" }), view({ id: 12, number: "MSL2026-002", sentAt: "2026-10-17T07:00:00.000Z", sentNote: "raamatupidaja@firma.example" }), view({ id: 13, number: "MSL2026-003" })] });
    expect($("[data-invoice-sent]", rowOf("MSL2026-001"))!.textContent).toBe("Saadetud 17.10.2026");
    expect($("[data-invoice-sent]", rowOf("MSL2026-002"))!.textContent).toBe("Saadetud 17.10.2026 · ka aadressile raamatupidaja@firma.example");
    expect($("[data-invoice-sent]", rowOf("MSL2026-003"))).toBeNull();
  });

  test("no invoice yet: a line says so", async () => {
    await show({ invoices: [] });
    expect($("[data-invoices-none]")!.textContent).toBe("Sellele registreeringule pole arveid koostatud.");
    expect($("[data-invoice-list]")).toBeNull();
  });
});

describe("„Koosta arve“", () => {
  const open = async () => click($("[data-invoice-create]"));

  test("offers exactly the open amounts as choices, the first chosen, and the two kinds; nothing else", async () => {
    await show({ invoices: [] });
    expect($("[data-invoice-create]")!.textContent).toBe("Koosta arve");
    expect($("[data-invoice-create-form]")).toBeNull();
    await open();
    expect($("[data-invoice-create]")).toBeNull(); // (one „Koosta arve“ at a time: the form's own submit)
    const kinds = all("[data-invoice-kind]");
    expect(kinds.map((k) => k.getAttribute("data-invoice-kind"))).toEqual(["prepayment", "full"]);
    expect(kinds.map((k) => k.closest("label")!.textContent)).toEqual([`Ettemaks 50% · 175,00${NBSP}€`, `Kogu summa (100%) · 350,00${NBSP}€`]);
    expect(kinds.map((k) => (k as HTMLInputElement).checked)).toEqual([true, false]);
    expect(all("[data-invoice-mode]").map((m) => m.closest("label")!.textContent)).toEqual(["Maksmiseks", "Juba tasutud"]);
    expect($<HTMLInputElement>('[data-invoice-mode="request"]')!.checked).toBe(true);
    expect($("[data-paid-date]")).toBeNull(); // (a request asks no day)
    expect($("[data-invoice-create-confirm]")!.textContent).toBe("Koosta arve");
  });

  test("when only the rest is open, only the rest is offered", async () => {
    await show({ open: both([{ kind: "balance", cents: 17500, part: "Jääk 50%" }]) });
    await open();
    expect(all("[data-invoice-kind]").map((k) => k.getAttribute("data-invoice-kind"))).toEqual(["balance"]);
  });

  test("„Maksmiseks“ sends the registration, the kind chosen and the mode; made: the number, the form closed", async () => {
    actions.createInvoiceAction.mockResolvedValue({ ok: true, number: "MSL2026-006" });
    await show({ invoices: [] });
    await open();
    await click($('[data-invoice-kind="full"]'));
    await submitForm($("[data-invoice-create-form]"));
    expect(actions.createInvoiceAction).toHaveBeenCalledTimes(1);
    expect(actions.createInvoiceAction.mock.calls[0][0]).toEqual({ registrationId: 7, kind: "full", mode: "request" });
    expect(line(container)).toBe("Arve MSL2026-006 on koostatud.");
    expect($("[data-invoice-create-form]")).toBeNull();
    expect($("[data-invoice-create]")).not.toBeNull();
  });

  test("„Juba tasutud“ asks the day (today, never after) and the way (Pangaülekanne, Sularaha, Kaardimakse kohapeal) and sends both", async () => {
    actions.createInvoiceAction.mockResolvedValue({ ok: true, number: "MSL2026-006" });
    await show({ invoices: [] });
    await open();
    await click($('[data-invoice-mode="receipt"]'));
    const date = $<HTMLInputElement>("[data-paid-date]")!;
    expect([date.type, date.value, date.max]).toEqual(["date", TODAY, TODAY]);
    expect(all("[data-paid-method]").map((m) => m.closest("label")!.textContent)).toEqual(["Pangaülekanne", "Sularaha", "Kaardimakse kohapeal"]);
    expect($<HTMLInputElement>('[data-paid-method="bank"]')!.checked).toBe(true);
    expect($("[data-invoice-mode-hint]")!.textContent).toBe("Raha on juba kätte saadud. „Laekunud summa“ ei muutu.");
    await type(date, "2026-10-12");
    await click($('[data-paid-method="cash"]'));
    await submitForm($("[data-invoice-create-form]"));
    expect(actions.createInvoiceAction.mock.calls[0][0]).toEqual({ registrationId: 7, kind: "prepayment", mode: "receipt", paidAt: "2026-10-12", method: "cash" });
  });

  test("a refusal is shown in its words and the form stays open (here the bank details are missing)", async () => {
    actions.createInvoiceAction.mockResolvedValue({ ok: false, error: "bankMissing", text: "Täida enne Seaded → „Ettemaksu juhised“ (saaja ja IBAN)." });
    await show({ invoices: [] });
    await open();
    await submitForm($("[data-invoice-create-form]"));
    expect(line(container)).toBe("Täida enne Seaded → „Ettemaksu juhised“ (saaja ja IBAN).");
    expect($("[data-invoice-create-form]")).not.toBeNull();
  });

  test("„Katkesta“ closes the form without a call", async () => {
    await show();
    await open();
    await click(button("Katkesta"));
    expect($("[data-invoice-create-form]")).toBeNull();
    expect(actions.createInvoiceAction).not.toHaveBeenCalled();
  });

  test("without a seller there is no „Koosta arve“, but a link „Täida Seaded → Arve andmed“ to the card", async () => {
    await show({ sellerReady: false });
    expect($("[data-invoice-create]")).toBeNull();
    const link = $<HTMLAnchorElement>("[data-invoice-need-seller] a")!;
    expect([link.textContent, link.getAttribute("href")]).toEqual(["Täida Seaded → Arve andmed", "/admin/seaded#arve"]);
  });

  test("everything already invoiced: a line says so; a registration without a price offers nothing", async () => {
    await show({ open: NONE });
    expect($("[data-invoice-all-covered]")!.textContent).toBe("Kõik summad on juba arvega kaetud.");
    expect($("[data-invoice-create]")).toBeNull();
    await show({ open: NONE, canCreate: false });
    expect($("[data-invoice-all-covered]")).toBeNull();
    expect($("[data-invoice-need-seller]")).toBeNull();
    expect($("[data-invoice-create]")).toBeNull();
  });
});

describe("the final review's wave on the block: paid online payments without an invoice (I1), money typed by hand (m4)", () => {
  /** The prepayment paid online on 15.10, no invoice yet (it is in „Arveta maksed“): the page's uninvoicedOf, coveringInvoices and openAmounts. */
  const PAID = { paymentId: 21, amountCents: 17500, paidAt: "2026-10-15T09:00:00.000Z", pays: null };
  const afterPaid = openAmounts({ priceCents: 35000, paymentChoice: "half", paidCents: 17500 }, coveringInvoices({ paymentChoice: "half" }, [], [{ id: 21, kind: "prepayment", invoiceId: null, amountCents: 17500 }]));

  test("I1: the paid payment is listed with its own „Koosta arve“ (the catch-up), which is the only one in view; the generic one waits", async () => {
    actions.catchUpInvoiceAction.mockResolvedValue({ ok: true, number: "MSL2026-002" });
    await show({ invoices: [], uninvoiced: [PAID], open: afterPaid });
    const row = $("[data-uninvoiced-payment='21']")!;
    expect($("[data-uninvoiced-line]", row)!.textContent).toBe(`Veebimakse 175,00${NBSP}€ (15.10.2026) on veel arveta.`);
    expect($("[data-uninvoiced-pays]", row)!.textContent).toBe("Koostab uue arve");
    expect($("[data-invoice-create]")).toBeNull();
    // the row's own button is the catch-up: it makes the payment's invoice
    await click($("[data-uninvoiced-create='21']", row));
    expect(actions.catchUpInvoiceAction).toHaveBeenCalledWith({ paymentId: 21 });
    expect(line(row)).toBe("Arve MSL2026-002 on valmis.");
  });

  test("I1: with the payment invoiced, „Koosta arve“ offers only the rest, as a request or a receipt", async () => {
    await show({ invoices: [], uninvoiced: [], open: afterPaid });
    await click($("[data-invoice-create]"));
    expect(all("[data-invoice-kind]").map((k) => k.getAttribute("data-invoice-kind"))).toEqual(["balance"]);
    await click($('[data-invoice-mode="receipt"]'));
    expect(all("[data-invoice-kind]").map((k) => [k.getAttribute("data-invoice-kind"), k.closest("label")!.textContent])).toEqual([["balance", `Jääk 50% · 175,00${NBSP}€`]]);
  });

  test("I1: one started for an unpaid invoice names the invoice its catch-up will pay; without a seller the row has no button", async () => {
    await show({ invoices: [view({ paidOnline: true })], uninvoiced: [{ ...PAID, pays: "MSL2026-001" }], open: both([{ kind: "balance", cents: 17500, part: "Jääk 50%" }]) });
    expect($("[data-uninvoiced-payment='21'] [data-uninvoiced-pays]")!.textContent).toBe("Tasub arve MSL2026-001");
    await show({ invoices: [], uninvoiced: [PAID], open: afterPaid, sellerReady: false });
    expect($("[data-uninvoiced-payment='21']")).not.toBeNull();
    expect($("[data-uninvoiced-create]")).toBeNull();
    expect($("[data-invoice-need-seller]")).not.toBeNull();
  });

  test("no such payment: no list", async () => {
    await show();
    expect($("[data-invoice-uninvoiced]")).toBeNull();
  });

  test("m4: money typed by hand — „Maksmiseks“ asks for the rest only, „Juba tasutud“ offers exactly the typed sum; with nothing to request, the request kind cannot be chosen", async () => {
    actions.createInvoiceAction.mockResolvedValue({ ok: true, number: "MSL2026-006" });
    await show({ invoices: [], open: openAmounts({ priceCents: 35000, paymentChoice: "half", paidCents: 10000 }, []) });
    await click($("[data-invoice-create]"));
    expect(all("[data-invoice-kind]").map((k) => k.closest("label")!.textContent)).toEqual([`Osamakse · 250,00${NBSP}€`]);
    await click($('[data-invoice-mode="receipt"]'));
    expect(all("[data-invoice-kind]").map((k) => [k.getAttribute("data-invoice-kind"), k.closest("label")!.textContent])).toEqual([["prepayment", `Osamakse · 100,00${NBSP}€`]]);
    await submitForm($("[data-invoice-create-form]"));
    expect(actions.createInvoiceAction.mock.calls[0][0]).toMatchObject({ registrationId: 7, kind: "prepayment", mode: "receipt" });
    // all of the price typed: only a receipt; „Maksmiseks“ is there but cannot be chosen
    await show({ invoices: [], open: openAmounts({ priceCents: 35000, paymentChoice: "half", paidCents: 35000 }, []) });
    await click($("[data-invoice-create]"));
    expect($<HTMLInputElement>('[data-invoice-mode="request"]')!.disabled).toBe(true);
    expect($<HTMLInputElement>('[data-invoice-mode="receipt"]')!.checked).toBe(true);
    expect(all("[data-invoice-kind]").map((k) => k.closest("label")!.textContent)).toEqual([`Kogu summa (100%) · 350,00${NBSP}€`]);
    expect($("[data-paid-date]")).not.toBeNull();
  });
});

describe("the final review's wave on a row: paid online, waiting for its catch-up (m2); „Tagastatud“ (I3)", () => {
  test("m2: an invoice paid online that waits for „Arveta maksed“ says so, and offers no „Saada õpilasele“ and no „Märgi tasutuks“", async () => {
    await show({ invoices: [view({ paidOnline: true })] });
    expect($("[data-invoice-paid-online]", rowOf("MSL2026-001"))!.textContent).toBe("Veebis tasutud — ootab „Arveta maksed“ alt arvet.");
    expect(actionsOf("MSL2026-001")).toEqual(["Laadi alla (PDF)", "Veel ▾"]);
    await show({ invoices: [UNPAID] });
    expect($("[data-invoice-paid-online]")).toBeNull();
  });

  test("I3: a paid invoice whose payment was refunded or voided reads „Tagastatud“ (stored paid); it is not sent again (README A2 drawer 4): the PDF only", async () => {
    await show({ invoices: [view({ ...ONLINE, refunded: true })] });
    expect($("[data-invoice-state]", rowOf("MSL2026-004"))!.textContent).toBe("Tagastatud");
    expect(rowOf("MSL2026-004").getAttribute("data-invoice-status")).toBe("paid");
    expect(rowOf("MSL2026-004").getAttribute("data-invoice-refunded")).toBe("true");
    expect(actionsOf("MSL2026-004")).toEqual(["Laadi alla (PDF)"]);
    await show({ invoices: [ONLINE] });
    expect($("[data-invoice-state]", rowOf("MSL2026-004"))!.textContent).toBe("Tasutud");
  });
});

describe("„Saada õpilasele“", () => {
  const open = async () => click($("[data-invoice-send]"));

  test("names the student's address and offers „Saada ka aadressile“; sends the invoice and the second address as typed", async () => {
    actions.sendInvoiceAction.mockResolvedValue({ ok: true });
    await show();
    await open();
    const panel = $('[data-invoice-panel="send"]')!;
    expect(panel.textContent).toContain("Kiri läheb aadressile kati@school.example.");
    expect($("label", panel)!.textContent).toBe("Saada ka aadressile");
    await type($<HTMLInputElement>("[data-invoice-also]")!, "raamatupidaja@firma.example");
    await submitForm(panel);
    expect(actions.sendInvoiceAction).toHaveBeenCalledWith({ id: 11, also: "raamatupidaja@firma.example" });
    expect(line(rowOf("MSL2026-001"))).toBe("Arve on saadetud.");
    expect($('[data-invoice-panel="send"]')).toBeNull();
  });

  test("without a second address it sends an empty one", async () => {
    actions.sendInvoiceAction.mockResolvedValue({ ok: true });
    await show();
    await open();
    await submitForm($('[data-invoice-panel="send"]'));
    expect(actions.sendInvoiceAction).toHaveBeenCalledWith({ id: 11, also: "" });
  });

  test("the second address refused after the first went: told; a bad address: marked on its field", async () => {
    actions.sendInvoiceAction.mockResolvedValueOnce({ ok: true, secondFailed: true });
    await show();
    await open();
    await submitForm($('[data-invoice-panel="send"]'));
    expect(line(rowOf("MSL2026-001"))).toBe("Õpilasele saadetud, teisele aadressile mitte.");
    actions.sendInvoiceAction.mockResolvedValueOnce({ ok: false, error: "email", text: "Sisesta korrektne e-posti aadress." });
    await open();
    await type($<HTMLInputElement>("[data-invoice-also]")!, "ei ole aadress");
    await submitForm($('[data-invoice-panel="send"]'));
    expect(line(rowOf("MSL2026-001"))).toBe("Sisesta korrektne e-posti aadress.");
    expect($("[data-invoice-also]")!.getAttribute("aria-invalid")).toBe("true");
    expect($('[data-invoice-panel="send"]')).not.toBeNull();
  });

  test("a paid invoice can be sent too", async () => {
    actions.sendInvoiceAction.mockResolvedValue({ ok: true });
    await show({ invoices: [RECEIPT] });
    await click($("[data-invoice-send]"));
    await submitForm($('[data-invoice-panel="send"]'));
    expect(actions.sendInvoiceAction).toHaveBeenCalledWith({ id: 13, also: "" });
  });
});

describe("„Märgi tasutuks“", () => {
  const open = async () => viaMenu("MSL2026-001", "Märgi tasutuks");

  test("asks the day (today) and the way (Pangaülekanne), says what it does to „Laekunud summa“, and sends both", async () => {
    actions.markInvoicePaidAction.mockResolvedValue({ ok: true, full: false });
    await show();
    await open();
    const panel = $('[data-invoice-panel="paid"]')!;
    expect(panel.textContent).toContain("Summa lisatakse registreeringu „Laekunud summa“ juurde ja koht kinnitub, kui laekunud on vähemalt 50%.");
    expect($<HTMLInputElement>("[data-paid-date]", panel)!.value).toBe(TODAY);
    await type($<HTMLInputElement>("[data-paid-date]", panel)!, "2026-10-14");
    await click($('[data-paid-method="card"]', panel));
    await submitForm(panel);
    expect(actions.markInvoicePaidAction).toHaveBeenCalledWith({ id: 11, paidAt: "2026-10-14", method: "card" });
    expect(line(rowOf("MSL2026-001"))).toBe("Arve on märgitud tasutuks.");
  });

  test("the session being full is told after it", async () => {
    actions.markInvoicePaidAction.mockResolvedValue({ ok: true, full: true });
    await show();
    await open();
    await submitForm($('[data-invoice-panel="paid"]'));
    expect(line(rowOf("MSL2026-001"))).toBe("Arve on märgitud tasutuks. Koolitus on vahepeal täis, nii et koht jäi kinnitamata.");
  });

  test("an invoice already paid online is refused in the controller's words, the panel stays", async () => {
    actions.markInvoicePaidAction.mockResolvedValue({ ok: false, error: "paidOnline", text: "See arve on juba veebis tasutud — koosta arve „Arveta maksed“ alt." });
    await show();
    await open();
    await submitForm($('[data-invoice-panel="paid"]'));
    expect(line(rowOf("MSL2026-001"))).toBe("See arve on juba veebis tasutud — koosta arve „Arveta maksed“ alt.");
    expect($('[data-invoice-panel="paid"]')).not.toBeNull();
  });
});

describe("„Muuda saajat“", () => {
  const open = async () => viaMenu("MSL2026-001", "Muuda saajat");
  const field = (name: string) => $<HTMLInputElement>(`[data-buyer-field="${name}"]`)!;

  test("the buyer's fields as they are; saved as typed (the company's too)", async () => {
    actions.updateInvoiceBuyerAction.mockResolvedValue({ ok: true });
    await show();
    await open();
    expect(["name", "address", "company", "companyCode", "companyAddress"].map((n) => field(n).value)).toEqual(["Kati Tamm", "", "", "", ""]);
    expect(all("label", $('[data-invoice-panel="buyer"]')!).map((l) => l.textContent)).toEqual(["Nimi", "Aadress", "Ettevõtte nimi", "Ettevõtte registrikood", "Ettevõtte aadress"]);
    await type(field("company"), "Tamm OÜ");
    await type(field("companyCode"), "12345678");
    await submitForm($('[data-invoice-panel="buyer"]'));
    expect(actions.updateInvoiceBuyerAction).toHaveBeenCalledWith({ id: 11, name: "Kati Tamm", address: "", company: "Tamm OÜ", companyCode: "12345678", companyAddress: "" });
    expect(line(rowOf("MSL2026-001"))).toBe("Saaja on salvestatud.");
  });

  test("a refused field is marked in words and takes the focus", async () => {
    actions.updateInvoiceBuyerAction.mockResolvedValue({ ok: false, error: "invalid", text: "x", fields: { name: "required", companyCode: "tooLong" } });
    await show();
    await open();
    await type(field("name"), "");
    await submitForm($('[data-invoice-panel="buyer"]'));
    expect(field("name").getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(`${field("name").id}-error`)!.textContent).toBe("Täida see väli.");
    expect(document.getElementById(`${field("companyCode").id}-error`)!.textContent).toBe("Tekst on liiga pikk.");
    expect(document.activeElement).toBe(field("name"));
    expect(field("company").getAttribute("aria-invalid")).toBeNull();
    expect(line(rowOf("MSL2026-001"))).toBe("Kontrolli märgitud välju.");
  });
});

describe("only one „Koosta arve“ (README A2 drawer 4)", () => {
  const PAID = { paymentId: 21, amountCents: 17500, paidAt: "2026-10-15T09:00:00.000Z", pays: null };
  const rest = both([{ kind: "balance", cents: 17500, part: "Jääk 50%" }]);

  test("with an unbilled online payment, its row's button is the only one: the generic button is not there", async () => {
    await show({ invoices: [], uninvoiced: [PAID], open: rest });
    expect(all("button").filter((b) => b.textContent === "Koosta arve")).toHaveLength(1);
    expect($("[data-uninvoiced-create='21']")!.textContent).toBe("Koosta arve");
    expect($("[data-invoice-create]")).toBeNull();
  });

  test("two unbilled payments: each has its own button and still no generic one", async () => {
    await show({ invoices: [], uninvoiced: [PAID, { ...PAID, paymentId: 22 }], open: rest });
    expect(all("[data-uninvoiced-create]").map((b) => b.getAttribute("data-uninvoiced-create"))).toEqual(["21", "22"]);
    expect($("[data-invoice-create]")).toBeNull();
  });

  test("with none, the generic button is the only one; once the payment has its invoice, it comes back", async () => {
    await show({ invoices: [], uninvoiced: [], open: rest });
    expect(all("button").filter((b) => b.textContent === "Koosta arve")).toHaveLength(1);
    expect($("[data-invoice-create]")).not.toBeNull();
    await show({ invoices: [], uninvoiced: [PAID], open: rest });
    expect($("[data-invoice-create]")).toBeNull();
    await show({ invoices: [], uninvoiced: [], open: rest });
    expect($("[data-invoice-create]")).not.toBeNull();
  });

  test("without a seller there is no button at all: the payment's row has none and the link to Seaded stands in", async () => {
    await show({ invoices: [], uninvoiced: [PAID], open: rest, sellerReady: false });
    expect(all("button").filter((b) => b.textContent === "Koosta arve")).toHaveLength(0);
    expect($("[data-invoice-need-seller]")).not.toBeNull();
  });
});

describe("the block on a phone: a folded row (README A2 phone drawer)", () => {
  const fold = () => $("[data-phone-fold]")!;
  const summary = () => $("[data-phone-fold-toggle] [data-fold-summary]")!.textContent;

  test("it is the PhoneFold: „Arved“ as the heading and as the row, closed to begin with, the invoices in the body", async () => {
    await show({ invoices: [UNPAID] });
    expect(fold().hasAttribute("data-registration-invoices")).toBe(true);
    expect($("h3", fold())!.textContent).toBe("Arved");
    expect($("[data-phone-fold-toggle]")!.getAttribute("aria-expanded")).toBe("false");
    expect(fold().contains(rowOf("MSL2026-001"))).toBe(true);
    await click($("[data-phone-fold-toggle]"));
    expect($("[data-phone-fold-toggle]")!.getAttribute("aria-expanded")).toBe("true");
  });

  test("the row's summary (P-3): „{n} tasumata“, „kõik tasutud“, „arveid pole“", async () => {
    await show({ invoices: [UNPAID, view({ id: 16, number: "MSL2026-006" }), RECEIPT] });
    expect(summary()).toBe("2 tasumata");
    await show({ invoices: [view({ ...UNPAID, status: "paid", paidAt: "2026-10-15T09:00:00.000Z", paidMethod: "bank" }), CANCELLED] });
    expect(summary()).toBe("kõik tasutud");
    await show({ invoices: [] });
    expect(summary()).toBe("arveid pole");
    // (a cancelled invoice is no invoice to speak of)
    await show({ invoices: [CANCELLED] });
    expect(summary()).toBe("arveid pole");
  });

  test("an invoice made or paid while the row is open leaves it open", async () => {
    actions.createInvoiceAction.mockResolvedValue({ ok: true, number: "MSL2026-006" });
    await show({ invoices: [] });
    await click($("[data-phone-fold-toggle]"));
    await click($("[data-invoice-create]"));
    await submitForm($("[data-invoice-create-form]"));
    expect($("[data-phone-fold-toggle]")!.getAttribute("aria-expanded")).toBe("true");
    expect(line(container)).toBe("Arve MSL2026-006 on koostatud.");
  });
});
