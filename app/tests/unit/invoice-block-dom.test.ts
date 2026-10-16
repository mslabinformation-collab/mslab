// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenAmount } from "@/domain/invoice";

// The registration drawer's „Arved“ (invoices Task 5, spec §5, D5, D6, rulings R10 and R1) in a browser-like document (happy-dom), with the
// server actions answered here: the actions each state allows (and none other), „Koosta arve“ offering exactly the open amounts and the two
// kinds with the day and the way for „Juba tasutud“, the link to Seaded when there is no seller, „Saada õpilasele“ with its second address,
// „Märgi tasutuks“, the confirmation of „Võta tasumine tagasi“ saying what will happen (a receipt is cancelled, a marked request is unpaid
// again) and of „Tühista arve“, and „Muuda saajat“ with its refused fields.

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
  paidAdds: false,
  sentAt: null,
  sentNote: "",
  buyer: BUYER,
  registrationId: 7,
  ...over,
});
const UNPAID = view();
const MARKED = view({ id: 12, number: "MSL2026-002", status: "paid", dueAt: null, paidAt: "2026-10-15T09:00:00.000Z", paidMethod: "bank", paidAdds: true });
const RECEIPT = view({ id: 13, number: "MSL2026-003", status: "paid", dueAt: null, paidAt: "2026-10-12T09:00:00.000Z", paidMethod: "cash", paidAdds: false });
const ONLINE = view({ id: 14, number: "MSL2026-004", status: "paid", dueAt: null, paidAt: "2026-10-14T09:00:00.000Z", paidMethod: "montonio", online: true });
const CANCELLED = view({ id: 15, number: "MSL2026-005", status: "cancelled" });
const OPEN: OpenAmount[] = [
  { kind: "prepayment", cents: 17500, part: "Ettemaks 50%" },
  { kind: "full", cents: 35000, part: "Kogu summa (100%)" },
];

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
  await act(async () => root.render(createElement(InvoiceBlock, { registrationId: 7, invoices: [UNPAID], open: OPEN, sellerReady: true, canCreate: true, today: TODAY, ...props })));
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
    expect(actionsOf("MSL2026-001")).toEqual(["Saada õpilasele", "Muuda saajat", "Märgi tasutuks", "Tühista arve", "Laadi alla (PDF)"]);
    expect($("[data-invoice-state]", rowOf("MSL2026-001"))!.textContent).toBe("Tasumata");
  });

  test("Tasutud by Maria's mark or receipt: send, undo and the PDF — not mark, cancel or edit; an online payment's invoice: send and the PDF only", async () => {
    await show({ invoices: [MARKED, RECEIPT, ONLINE] });
    expect(actionsOf("MSL2026-002")).toEqual(["Saada õpilasele", "Võta tasumine tagasi", "Laadi alla (PDF)"]);
    expect(actionsOf("MSL2026-003")).toEqual(["Saada õpilasele", "Võta tasumine tagasi", "Laadi alla (PDF)"]);
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
    await show({ open: [{ kind: "balance", cents: 17500, part: "Jääk 50%" }] });
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
    await show({ open: [] });
    expect($("[data-invoice-all-covered]")!.textContent).toBe("Kõik summad on juba arvega kaetud.");
    expect($("[data-invoice-create]")).toBeNull();
    await show({ open: [], canCreate: false });
    expect($("[data-invoice-all-covered]")).toBeNull();
    expect($("[data-invoice-need-seller]")).toBeNull();
    expect($("[data-invoice-create]")).toBeNull();
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
  const open = async () => click($("[data-invoice-mark-paid]"));

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

describe("„Võta tasumine tagasi“ (ruling R10)", () => {
  const open = async (number: string) => click($("[data-invoice-undo]", rowOf(number)));

  test("a marked request: the words say it is unpaid again and the amount comes off „Laekunud summa“; nothing is done before the confirmation", async () => {
    await show({ invoices: [MARKED] });
    await open("MSL2026-002");
    expect($("[data-invoice-undo-text]")!.textContent).toBe("Arve muutub uuesti tasumata ja summa võetakse „Laekunud summa“ alt maha.");
    expect(actions.undoInvoicePaidAction).not.toHaveBeenCalled();
  });

  test("a receipt: the words say it is cancelled and keeps its number", async () => {
    await show({ invoices: [RECEIPT] });
    await open("MSL2026-003");
    expect($("[data-invoice-undo-text]")!.textContent).toBe("Kviitung tühistatakse (number jääb alles).");
  });

  test("the confirmation takes the focus on „Katkesta“, never on the button that does it", async () => {
    await show({ invoices: [MARKED] });
    await open("MSL2026-002");
    expect(document.activeElement).toBe($("[data-invoice-close]", rowOf("MSL2026-002")));
    expect(document.activeElement).not.toBe($("[data-invoice-undo-confirm]"));
  });

  test("confirmed: the action runs, and the screen says which of the two it was, by the status that came back", async () => {
    actions.undoInvoicePaidAction.mockResolvedValueOnce({ ok: true, status: "unpaid" }).mockResolvedValueOnce({ ok: true, status: "cancelled" });
    await show({ invoices: [MARKED, RECEIPT] });
    await open("MSL2026-002");
    await click($("[data-invoice-undo-confirm]"));
    expect(actions.undoInvoicePaidAction).toHaveBeenLastCalledWith({ id: 12 });
    expect(line(rowOf("MSL2026-002"))).toBe("Arve on jälle tasumata.");
    await open("MSL2026-003");
    await click($("[data-invoice-undo-confirm]"));
    expect(actions.undoInvoicePaidAction).toHaveBeenLastCalledWith({ id: 13 });
    expect(line(rowOf("MSL2026-003"))).toBe("Kviitung on tühistatud.");
  });

  test("„Katkesta“ leaves everything as it was; a refusal is shown", async () => {
    await show({ invoices: [MARKED] });
    await open("MSL2026-002");
    await click(button("Katkesta"));
    expect($('[data-invoice-panel="undo"]')).toBeNull();
    expect(actions.undoInvoicePaidAction).not.toHaveBeenCalled();
    actions.undoInvoicePaidAction.mockResolvedValue({ ok: false, error: "notManual", text: "Veebis tasutud arvet ei saa tagasi võtta." });
    await open("MSL2026-002");
    await click($("[data-invoice-undo-confirm]"));
    expect(line(rowOf("MSL2026-002"))).toBe("Veebis tasutud arvet ei saa tagasi võtta.");
  });
});

describe("„Tühista arve“", () => {
  test("asks to be confirmed, saying the number stays; then cancels", async () => {
    actions.cancelInvoiceAction.mockResolvedValue({ ok: true });
    await show();
    await click($("[data-invoice-cancel]"));
    expect($('[data-invoice-panel="cancel"]')!.textContent).toContain("Arve tühistatakse. Number jääb alles");
    expect(actions.cancelInvoiceAction).not.toHaveBeenCalled();
    await click($("[data-invoice-cancel-confirm]"));
    expect(actions.cancelInvoiceAction).toHaveBeenCalledWith({ id: 11 });
    expect(line(rowOf("MSL2026-001"))).toBe("Arve on tühistatud.");
  });

  test("„Katkesta“ keeps the invoice; the focus starts on it", async () => {
    await show();
    await click($("[data-invoice-cancel]"));
    expect(document.activeElement).toBe($("[data-invoice-close]", rowOf("MSL2026-001")));
    await click(button("Katkesta"));
    expect($('[data-invoice-panel="cancel"]')).toBeNull();
    expect(actions.cancelInvoiceAction).not.toHaveBeenCalled();
  });
});

describe("„Muuda saajat“", () => {
  const open = async () => click($("[data-invoice-buyer]"));
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

describe("one action at a time", () => {
  test("a second tap on a submit while the first is on its way sends nothing more", async () => {
    let finish: (r: unknown) => void = () => {};
    actions.cancelInvoiceAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await show();
    await click($("[data-invoice-cancel]"));
    await click($("[data-invoice-cancel-confirm]"));
    await click($("[data-invoice-cancel-confirm]"));
    expect(actions.cancelInvoiceAction).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    await settle();
    expect(line(rowOf("MSL2026-001"))).toBe("Arve on tühistatud.");
  });
});
