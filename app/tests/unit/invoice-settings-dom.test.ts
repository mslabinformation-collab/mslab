// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Seaded → „Arve andmed“ (invoices Task 5, spec D2, D7, D8; ruling R3) in a browser-like document (happy-dom), with the server action answered
// here: the stored values in their fields, the hint under the prefix (a new prefix starts at 001), the save as typed, a refused field marked
// in words with the focus on the first, the bank details of „Ettemaksu juhised“ read-only with a link to that card, and „Näidisarve (PDF)“ as a
// link whose address holds the card's values as they stand on the screen, saved or not.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const action = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/admin-invoices", () => ({ saveInvoiceSettingsAction: action }));

import { InvoiceSettings, type InvoiceBank, type InvoiceSettingsInitial } from "@/components/admin/InvoiceSettings";

const INITIAL: InvoiceSettingsInitial = {
  company: "MS LAB OÜ",
  registryCode: "16346048",
  address: "Rüütli 1, 80010 Pärnu",
  vatNumber: "",
  vatOn: false,
  vatRate: 24,
  prefix: "MSL",
  nextYear: 2026,
  nextSeq: 15,
  termDays: 7,
  footer: "",
  last: "MSL2026-014",
};
const BANK: InvoiceBank = { receiver: "MS LAB Koolituskeskus OÜ", iban: "EE382200221020145685", bank: "Swedbank" };

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
/** The card as the page renders it (a new key: a new card, as a new page load gives). */
const show = async (initial: InvoiceSettingsInitial = INITIAL, bank: InvoiceBank = BANK, opts: { now?: Date } = {}) => {
  await act(async () => root.render(createElement(InvoiceSettings, { key: JSON.stringify([initial, bank, opts.now ?? null]), initial, bank, now: opts.now })));
  await settle();
};
const input = (field: string) => $<HTMLInputElement>(`[data-invoice-field="${field}"]`)!;
const errorOf = (field: string) => document.getElementById(`${input(field).id}-error`)?.textContent ?? null;
const hintOf = (field: string) => document.getElementById(`${input(field).id}-hint`)?.textContent ?? null;
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const check = async (el: HTMLInputElement) => act(async () => el.click());
const submit = async () => {
  await act(async () => $<HTMLFormElement>("[data-invoice-form]")!.requestSubmit());
  await settle();
};

beforeEach(() => {
  action.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("InvoiceSettings", () => {
  test("the stored values in their fields; the card is called „Arve andmed“, with the anchor the drawer's link goes to", async () => {
    await show();
    expect($("h2")!.textContent).toBe("Arve andmed");
    expect($("section")!.id).toBe("arve");
    expect(["company", "registryCode", "address", "vatNumber", "vatRate", "prefix", "nextSeq", "termDays", "footer"].map((f) => input(f).value)).toEqual([
      "MS LAB OÜ", "16346048", "Rüütli 1, 80010 Pärnu", "", "24", "MSL", "15", "7", "",
    ]);
    expect(input("vatOn").checked).toBe(false);
    expect($("[data-invoice-save]")!.textContent).toBe("Salvesta arve andmed");
    expect($("[data-invoice-last]")!.textContent).toBe("Viimati väljastatud: MSL2026-014");
    await show({ ...INITIAL, last: null });
    expect($("[data-invoice-last]")!.textContent).toBe("2026. aastal pole veel arveid väljastatud.");
  });

  test("B21: no „Aasta“ field; from 1 December (Tallinn) the line „1. jaanuarist: MSL2027-001“ shows", async () => {
    await show({ ...INITIAL, prefix: "MSL", nextYear: 2026 }, BANK, { now: new Date("2026-11-30T23:30:00Z") }); // 1.12 01:30 in Tallinn
    expect(document.querySelector('[data-invoice-field="nextYear"]')).toBeNull();
    expect(document.querySelector("[data-invoice-january]")?.textContent).toBe("1. jaanuarist: MSL2027-001");
    // the legend and the number stay; the line follows the prefix as it is typed (the server stores it in capitals)
    expect($("legend")!.textContent).toBe("Järgmine number");
    expect(input("nextSeq").value).toBe("15");
    await type(input("prefix"), "abc");
    expect($("[data-invoice-january]")!.textContent).toBe("1. jaanuarist: ABC2027-001");
    await type(input("prefix"), "");
    expect($("[data-invoice-january]")!.textContent).toBe("1. jaanuarist: MSL2027-001");
  });

  test("B21: before December there is no January line", async () => {
    await show({ ...INITIAL, prefix: "MSL", nextYear: 2026 }, BANK, { now: new Date("2026-11-30T21:30:00Z") }); // 23:30 in Tallinn, still 30.11
    expect(document.querySelector("[data-invoice-january]")).toBeNull();
    expect(document.querySelector('[data-invoice-field="nextYear"]')).toBeNull();
  });

  test("B21: the January line counts to the end of December and is the Tallinn year's next, also on 31.12 and in the new year's first minutes", async () => {
    await show(INITIAL, BANK, { now: new Date("2026-12-31T21:30:00Z") }); // 31.12 23:30 in Tallinn
    expect($("[data-invoice-january]")!.textContent).toBe("1. jaanuarist: MSL2027-001");
    await show({ ...INITIAL, nextYear: 2027 }, BANK, { now: new Date("2026-12-31T22:30:00Z") }); // 1.1.2027 00:30 in Tallinn: January itself
    expect($("[data-invoice-january]")).toBeNull();
  });

  test("ruling R3: the prefix says a new one starts its own numbering at 001, as a hint the field is described by", async () => {
    await show();
    expect(hintOf("prefix")).toBe("Uus eesliide alustab oma numbrit 001-st.");
    expect(input("prefix").getAttribute("aria-describedby")).toContain(`${input("prefix").id}-hint`);
  });

  test("the bank details of Ettemaksu juhised are read-only, with the IBAN in groups and a link to that card; they are not fields", async () => {
    await show();
    const bank = $("[data-invoice-bank]")!;
    expect(bank.textContent).toContain("MS LAB Koolituskeskus OÜ");
    expect(bank.textContent).toContain("EE38 2200 2210 2014 5685");
    expect(bank.textContent).toContain("Swedbank");
    expect(bank.querySelector("input, textarea")).toBeNull();
    const link = bank.querySelector<HTMLAnchorElement>("a")!;
    expect([link.textContent, link.getAttribute("href")]).toEqual(["Muuda: Ettemaksu juhised", "/admin/seaded#ettemaks"]);
    expect($("[data-invoice-bank-missing]")).toBeNull();
  });

  test("without the receiver or the IBAN the card says a request to pay cannot be made", async () => {
    await show(INITIAL, { receiver: "MS LAB OÜ", iban: "  ", bank: "" });
    expect($("[data-invoice-bank-missing]")!.textContent).toBe("Ettemaksu juhised on täitmata (saaja ja IBAN): pangaülekande arvet ei saa koostada.");
    expect($("[data-invoice-bank] dl")).toBeNull();
    expect($("[data-invoice-bank] a")).not.toBeNull();
  });

  test("„Salvesta arve andmed“ sends the fields as typed; saved, the fields take the card as the next issue will have it and the last number of the saved year", async () => {
    action.mockResolvedValue({ ok: true, card: { ...INITIAL, company: "Uus OÜ", vatNumber: "EE100200300", vatOn: true, vatRate: 22, prefix: "ABC", nextYear: 2026, nextSeq: 1, last: null } });
    await show();
    await type(input("company"), "  Uus OÜ ");
    await type(input("vatNumber"), "EE100200300");
    await check(input("vatOn"));
    await type(input("vatRate"), "22");
    await type(input("prefix"), "abc");
    await type(input("nextSeq"), "40");
    await submit();
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0][0]).toEqual({
      company: "  Uus OÜ ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "EE100200300", vatOn: true, vatRate: "22", prefix: "abc", nextSeq: "40", termDays: "7", footer: "",
    });
    expect([input("company").value, input("prefix").value, input("nextSeq").value]).toEqual(["Uus OÜ", "ABC", "1"]);
    expect($("[data-invoice-status]")!.textContent).toBe("Arve andmed on salvestatud.");
    expect($("[data-invoice-last]")!.textContent).toBe("2026. aastal pole veel arveid väljastatud.");
  });

  test("a refused field is marked in words, takes the focus, and what she typed stays; the codes have their own words by field", async () => {
    action.mockResolvedValue({ ok: false, fields: { nextSeq: "taken" } });
    await show();
    await type(input("nextSeq"), "14");
    await submit();
    expect(input("nextSeq").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input("nextSeq"));
    expect(errorOf("nextSeq")).toBe("See number on juba väljastatud. Vali suurem number kui viimati väljastatud.");
    expect(input("nextSeq").getAttribute("aria-describedby")).toContain(`${input("nextSeq").id}-error`);
    expect($("[data-invoice-last]")!.textContent).toBe("Viimati väljastatud: MSL2026-014");
    expect($("[data-invoice-status]")!.textContent).toBe("Kontrolli märgitud välju.");
    expect(input("company").getAttribute("aria-invalid")).toBeNull();
    expect(input("nextSeq").value).toBe("14");

    action.mockResolvedValue({
      ok: false,
      fields: { company: "required", registryCode: "tooLong", vatNumber: "required", prefix: "invalid", vatRate: "invalid", termDays: "invalid", nextSeq: "invalid", footer: "somethingNew" },
    });
    await submit();
    expect(["company", "registryCode", "vatNumber", "prefix", "vatRate", "termDays", "nextSeq", "footer", "address"].map(errorOf)).toEqual([
      "Täida see väli.",
      "Tekst on liiga pikk.",
      "Käibemaksuga arve vajab KMKR numbrit.",
      "Kasuta ainult tähti (A–Z) ja numbreid, kuni 10 märki.",
      "Käibemaksumäär peab olema 1–50.",
      "Päevi peab olema 0–90.",
      "Kontrolli numbrit (1–2 147 483 647).",
      "Kontrolli seda välja.",
      null,
    ]);
    expect(document.activeElement).toBe(input("company"));
    action.mockResolvedValue({ ok: false, error: "server" });
    await submit();
    expect($("[data-invoice-status]")!.textContent).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
  });

  test("„Näidisarve (PDF)“ is a link to the sample route in a new tab, with the card's values as they stand — typed, not saved — and the checkbox as 1 or 0", async () => {
    await show();
    const link = $<HTMLAnchorElement>("[data-invoice-sample]")!;
    expect(link.textContent).toBe("Näidisarve (PDF)");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    const query = (href: string) => Object.fromEntries(new URL(href, "https://mslab.example").searchParams);
    expect(new URL(link.getAttribute("href")!, "https://mslab.example").pathname).toBe("/api/admin/naidisarve");
    expect(query(link.getAttribute("href")!)).toEqual({
      company: "MS LAB OÜ", registryCode: "16346048", address: "Rüütli 1, 80010 Pärnu", vatNumber: "", vatOn: "0", vatRate: "24", prefix: "MSL", nextSeq: "15", termDays: "7", footer: "",
    });
    await type(input("company"), "Muu OÜ & Pojad");
    await type(input("footer"), "Täname!");
    await check(input("vatOn"));
    expect(query($<HTMLAnchorElement>("[data-invoice-sample]")!.getAttribute("href")!)).toMatchObject({ company: "Muu OÜ & Pojad", footer: "Täname!", vatOn: "1" });
    expect(action).not.toHaveBeenCalled(); // (nothing was saved to draw it)
  });

  test("a second tap on the save while the first is on its way saves once", async () => {
    let finish: (r: unknown) => void = () => {};
    action.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await show();
    await submit();
    await submit();
    expect(action).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, card: INITIAL }));
    await settle();
    expect($("[data-invoice-status]")!.textContent).toBe("Arve andmed on salvestatud.");
  });
});
