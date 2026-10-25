// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEBOUNCE_MS } from "@/components/admin/autosave/constants";
import type { AutosaveStatus } from "@/domain/autosave";
import { stubFetch } from "../fakes";

// Seaded → „Maksmine“ (admin UX pass piece 3b, Task 4; README B4, B21; ruling R-f; piece3-texts P-9, P-10 and §4) in a browser-like document
// (happy-dom), with the route answered here: one card for „Ettemaksu juhised“ and the invoice settings (one set of bank fields for both), the lead as
// drawn, no save button (every field autosaves: the bank fields on api/admin/seaded/prepayment, the rest on api/admin/seaded/invoice), „Arve järgmine
// number“ with the preview „Järgmine arve: {prefix}{year}-{nnn}“ (001 while the typed prefix is not the stored one, R3) and „Viimati väljastatud …“,
// and from 1 December the new year's first number on the same line. The number and the prefix commit on blur (behaviours conflict 13), and a number
// already issued is refused in the field (`taken`).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/admin/seaded", useSearchParams: () => new URLSearchParams() }));

import { InvoiceSettings, type InvoiceBank, type InvoiceSettingsInitial } from "@/components/admin/InvoiceSettings";
import { LeaveGuardProvider } from "@/components/admin/LeaveGuard";

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
  version: "i:t1.c1",
};
const BANK: InvoiceBank = { version: "p1", value: { receiver: "MS LAB Koolituskeskus OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" } };
/** 25.10.2026 in Tallinn. */
const OCTOBER = new Date("2026-10-25T09:00:00Z");

let container: HTMLDivElement;
let root: Root;
let fetched: ReturnType<typeof stubFetch>;
/** The route's versions by part; a save from another is a conflict. `refuse`: the 400 of the part's next save. */
let versions: Record<string, string>;
let refuse: Record<string, Record<string, string>>;
let statuses: [string, AutosaveStatus][];
const route = async (url: string, init: RequestInit | undefined): Promise<Response> => {
  const part = /^\/api\/admin\/seaded\/(\w+)$/.exec(url)?.[1];
  if (!part) return Response.json({ ok: false }, { status: 404 });
  const body = JSON.parse(String(init?.body)) as { version: string; patch: Record<string, unknown> };
  const refused = refuse[part];
  if (refused) {
    delete refuse[part];
    return Response.json({ ok: false, error: "invalid", fields: refused }, { status: 400 });
  }
  if (body.version !== versions[part]) return Response.json({ ok: false, error: "conflict", version: versions[part], value: {} }, { status: 409 });
  versions[part] = `${versions[part]}+`;
  return Response.json({ ok: true, version: versions[part], savedAt: "2026-10-25T11:20:00.000Z" });
};
const sent = (part: string) => fetched.calls.filter((c) => c.url === `/api/admin/seaded/${part}`).map((c) => c.body as { version: string; patch: Record<string, unknown> });

const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  });
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
let mounts = 0;
/** The card as the page renders it: a new card (a page load) unless `read` says it is the page's new read of the same card (router.refresh). */
const show = async (initial: InvoiceSettingsInitial = INITIAL, bank: InvoiceBank = BANK, now = OCTOBER, read = false) => {
  if (!read) mounts++;
  await act(async () => root.render(createElement(InvoiceSettings, { key: mounts, initial, bank, now, onStatus: (key: string, s: AutosaveStatus) => void statuses.push([key, s]) })));
  await settle();
};
const input = (field: string) => $<HTMLInputElement>(`[data-invoice-field="${field}"]`)!;
const bankInput = (field: string) => $<HTMLInputElement>(`[data-bank-field="${field}"]`)!;
const labelOf = (el: Element) => text(container.querySelector(`label[for="${el.id}"]`));
const described = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => text(document.getElementById(id)));
const errorOf = (el: HTMLInputElement) => text(document.getElementById(`${el.id}-error`)) || null;
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const leave = (el: Element) => act(async () => void el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const click = (el: Element) => act(async () => void (el as HTMLElement).click());
const preview = () => text($("[data-invoice-preview]"));

beforeEach(() => {
  for (const fn of Object.values(router)) fn.mockReset();
  versions = { invoice: "i:t1.c1", prepayment: "p1" };
  refuse = {};
  statuses = [];
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  fetched = stubFetch(route);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetched.restore();
  vi.useRealTimers();
});

describe("the card (README B4, ruling R-f; P-9, P-10)", () => {
  test("„Maksmine“: the drawn lead and the frozen-invoice sentence; the bank fields first, the hint under Saaja and IBAN; the seller's fields; no save button and no link to another card", async () => {
    await show();
    expect(text($("h2"))).toBe("Maksmine");
    expect(text($("[data-invoice-lead]"))).toBe("Ühed pangaandmed ettemaksu juhistes ja arvetel. Väljastatud arve jääb selliseks, nagu see väljastati: hilisem muudatus puudutab ainult uusi arveid.");
    expect(["receiver", "iban", "bank", "referencePrefix"].map((f) => [labelOf(bankInput(f)), bankInput(f).value])).toEqual([
      ["Saaja", "MS LAB Koolituskeskus OÜ"],
      ["IBAN", "EE382200221020145685"],
      ["Pank", "Swedbank"],
      ["Selgituse algus", "MSLAB-"],
    ]);
    expect(text($("[data-bank-hint]"))).toBe("Juhised on õpilasele näha ainult siis, kui saaja ja IBAN on täidetud. Muidu ütleb kaart: „Maria saadab sulle arve“.");
    // the bank fields come before the seller's, the hint between IBAN and Pank
    const order = Array.from(container.querySelectorAll("[data-bank-field], [data-bank-hint], [data-invoice-field]")).map((el) => el.getAttribute("data-bank-field") ?? el.getAttribute("data-invoice-field") ?? "hint");
    expect(order.slice(0, 5)).toEqual(["receiver", "iban", "hint", "bank", "referencePrefix"]);
    expect(["company", "registryCode", "address", "vatNumber", "vatRate", "prefix", "nextSeq", "termDays", "footer"].map((f) => input(f).value)).toEqual([
      "MS LAB OÜ", "16346048", "Rüütli 1, 80010 Pärnu", "", "24", "MSL", "15", "7", "",
    ]);
    expect(container.querySelector("button[type=submit], [data-invoice-save]")).toBeNull();
    expect(container.textContent).not.toContain("Salvesta");
    expect(container.querySelector("a[href^='/admin/seaded']")).toBeNull();
    expect(container.textContent).not.toContain("Arve andmed");
    expect(container.textContent).not.toContain("Ettemaksu juhised");
    expect($("[data-invoice-bank-missing]")).toBeNull();
  });

  test("„Arve järgmine number“: one field, under it „Järgmine arve: MSL2026-015“ and „Viimati väljastatud: …“; no year to type, no long hint", async () => {
    await show();
    expect(labelOf(input("nextSeq"))).toBe("Arve järgmine number");
    expect(preview()).toBe("Järgmine arve: MSL2026-015");
    expect(described(input("nextSeq"))).toEqual(["Järgmine arve: MSL2026-015", "Viimati väljastatud: MSL2026-014"]);
    expect(container.querySelector('[data-invoice-field="nextYear"]')).toBeNull();
    expect(container.textContent).not.toContain("Arve number on eesliide, aasta ja number");
    expect(container.querySelector("legend")).toBeNull();
    await show({ ...INITIAL, last: null, nextSeq: 1 });
    expect(preview()).toBe("Järgmine arve: MSL2026-001");
    expect(text($("[data-invoice-last]"))).toBe("2026. aastal pole veel arveid väljastatud.");
  });

  test("B21: from 1 December (Tallinn) the preview and the new year's first number are one line; before it, the preview alone", async () => {
    await show(INITIAL, BANK, new Date("2026-11-30T23:30:00Z")); // 1.12 01:30 in Tallinn
    expect(preview()).toBe("Järgmine arve: MSL2026-015 · 1. jaanuarist: MSL2027-001");
    await show(INITIAL, BANK, new Date("2026-11-30T21:30:00Z")); // 23:30 on 30.11
    expect(preview()).toBe("Järgmine arve: MSL2026-015");
    await show({ ...INITIAL, nextYear: 2027, nextSeq: 1, last: null }, BANK, new Date("2026-12-31T22:30:00Z")); // 1.1.2027 00:30 in Tallinn
    expect(preview()).toBe("Järgmine arve: MSL2027-001");
  });

  test("without the receiver or the IBAN as typed, the card says a bank-transfer invoice cannot be made", async () => {
    await show(INITIAL, { version: "p1", value: { receiver: "MS LAB OÜ", iban: "  ", bank: "", referencePrefix: "" } });
    expect(text($("[data-invoice-bank-missing]"))).toBe("Saaja ja IBAN on täitmata: pangaülekande arvet ei saa koostada.");
    await type(bankInput("iban"), "EE382200221020145685");
    expect($("[data-invoice-bank-missing]")).toBeNull();
  });

  test("„Näidisarve (PDF)“: the sample route in a new tab with the card's values as they stand, typed and not saved; its hint names no save", async () => {
    await show();
    const link = $<HTMLAnchorElement>("[data-invoice-sample]")!;
    expect([text(link), link.target]).toEqual(["Näidisarve (PDF)", "_blank"]);
    expect(container.textContent).toContain("Näidis tehakse kaardi praegustest väärtustest. Midagi ei salvestata.");
    await type(input("company"), "Muu OÜ");
    const query = Object.fromEntries(new URL($<HTMLAnchorElement>("[data-invoice-sample]")!.getAttribute("href")!, "https://mslab.example").searchParams);
    expect(query).toMatchObject({ company: "Muu OÜ", prefix: "MSL", nextSeq: "15", vatOn: "0" });
  });
});

describe("autosave under the page's one status", () => {
  test("a seller's field saves 1.5 s after typing, only what changed, from the part's version; a bank field on the prepayment part; each part's status is told", async () => {
    await show();
    await type(input("company"), "Uus OÜ");
    await wait(DEBOUNCE_MS - 100);
    expect(sent("invoice")).toEqual([]);
    expect(statuses.filter(([k]) => k === "invoice").at(-1)![1].kind).toBe("dirty");
    await wait(200);
    await settle();
    expect(sent("invoice")).toEqual([{ version: "i:t1.c1", patch: { company: "Uus OÜ" } }]);
    expect(statuses.filter(([k]) => k === "invoice").at(-1)![1].kind).toBe("saved");
    await type(bankInput("iban"), "EE38 2200 2210 2014 5685");
    await leave(bankInput("iban"));
    await settle();
    expect(sent("prepayment")).toEqual([{ version: "p1", patch: { iban: "EE38 2200 2210 2014 5685" } }]);
    expect(new Set(statuses.map(([k]) => k))).toEqual(new Set(["invoice", "prepayment"]));
  });

  test("„Arvel on käibemaks“ saves at once; without a VAT number it waits, said on the box in words (the server's rule), and goes with the number once it is typed", async () => {
    await show();
    await click(input("vatOn"));
    await settle();
    expect(sent("invoice")).toEqual([]);
    expect(input("vatOn").getAttribute("aria-invalid")).toBe("true");
    expect(errorOf(input("vatOn"))).toBe("Käibemaksuga arve vajab KMKR numbrit.");
    expect(statuses.at(-1)![1].kind).toBe("invalid");
    await type(input("vatNumber"), "EE100200300");
    await leave(input("vatNumber"));
    await settle();
    expect(sent("invoice")).toEqual([{ version: "i:t1.c1", patch: { vatNumber: "EE100200300", vatOn: true } }]);
    expect(errorOf(input("vatOn"))).toBeNull();
    expect(statuses.at(-1)![1].kind).toBe("saved");
    // with a VAT number stored, the box goes at once; the route's own refusal is said on the box too
    refuse.invoice = { vatOn: "required" };
    await show({ ...INITIAL, vatNumber: "EE100200300" });
    await click(input("vatOn"));
    await settle();
    expect(sent("invoice").at(-1)).toEqual({ version: "i:t1.c1", patch: { vatOn: true } });
    expect(errorOf(input("vatOn"))).toBe("Käibemaksuga arve vajab KMKR numbrit.");
  });

  test("a refused text field says why in its own words, and keeps what was typed", async () => {
    refuse.invoice = { prefix: "invalid" };
    await show();
    await type(input("prefix"), "MS-L");
    await leave(input("prefix"));
    await settle();
    expect(errorOf(input("prefix"))).toBe("Kasuta ainult tähti (A–Z) ja numbreid, kuni 10 märki.");
    expect(input("prefix").value).toBe("MS-L");
    refuse.prepayment = { iban: "iban" };
    await type(bankInput("iban"), "EE38 12");
    await leave(bankInput("iban"));
    await settle();
    expect(errorOf(bankInput("iban"))).toBe("Kontrolli IBANi: kaks tähte, kaks numbrit ja konto number, nt EE38 2200 2210 2014 5685.");
  });
});

describe("the number and the prefix commit on blur (behaviours conflict 13)", () => {
  test("„Arve järgmine number“: typing sends nothing, however long it waits, and the preview follows it; left, it is saved", async () => {
    await show();
    await type(input("nextSeq"), "2");
    expect(preview()).toBe("Järgmine arve: MSL2026-002");
    await type(input("nextSeq"), "20");
    await wait(DEBOUNCE_MS * 3);
    await settle();
    expect(sent("invoice")).toEqual([]);
    expect(preview()).toBe("Järgmine arve: MSL2026-020");
    await leave(input("nextSeq"));
    await settle();
    expect(sent("invoice")).toEqual([{ version: "i:t1.c1", patch: { nextSeq: "20" } }]);
    expect(input("nextSeq").value).toBe("20");
  });

  test("a number typed and not left is not lost: the tab hidden commits it (kept in this browser, and saved)", async () => {
    await show();
    await type(input("nextSeq"), "30");
    expect(sent("invoice")).toEqual([]);
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
      await settle();
    } finally {
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else delete (document as unknown as Record<string, unknown>).visibilityState;
    }
    expect(sent("invoice")).toEqual([{ version: "i:t1.c1", patch: { nextSeq: "30" } }]);
  });

  test("`taken`: the route's refusal shows in the field, the typed number stays; typed again, the words go", async () => {
    refuse.invoice = { nextSeq: "taken" };
    await show();
    await type(input("nextSeq"), "14");
    await leave(input("nextSeq"));
    await settle();
    expect(input("nextSeq").getAttribute("aria-invalid")).toBe("true");
    expect(errorOf(input("nextSeq"))).toBe("See number on juba väljastatud. Vali suurem number kui viimati väljastatud.");
    expect(described(input("nextSeq"))).toContain("See number on juba väljastatud. Vali suurem number kui viimati väljastatud.");
    expect(input("nextSeq").value).toBe("14");
    expect(statuses.at(-1)![1].kind).toBe("invalid");
    await type(input("nextSeq"), "16");
    expect(errorOf(input("nextSeq"))).toBeNull();
  });

  test("R3: a typed prefix that is not the stored one previews 001 (in capitals), and is sent only when left; once stored, the page is read again and the number follows the stored one", async () => {
    await show();
    await type(input("prefix"), "abc");
    expect(preview()).toBe("Järgmine arve: ABC2026-001");
    await wait(DEBOUNCE_MS * 2);
    expect(sent("invoice")).toEqual([]);
    await leave(input("prefix"));
    await settle();
    expect(sent("invoice")).toEqual([{ version: "i:t1.c1", patch: { prefix: "abc" } }]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // the page's new read: the stored prefix and the number the next issue takes under it, taken as stored (nothing sent for it)
    await show({ ...INITIAL, prefix: "ABC", nextSeq: 1, last: null, version: "i:t2.c2" }, BANK, OCTOBER, true);
    expect(input("nextSeq").value).toBe("1");
    expect(preview()).toBe("Järgmine arve: ABC2026-001");
    expect(text($("[data-invoice-last]"))).toBe("2026. aastal pole veel arveid väljastatud.");
    await wait(DEBOUNCE_MS * 2);
    await settle();
    expect(sent("invoice")).toHaveLength(1);
    expect(statuses.at(-1)![1].kind).toBe("saved");
    // the typed prefix back to the stored one: the number field's own number again
    await type(input("prefix"), "ABC");
    await type(input("nextSeq"), "5");
    expect(preview()).toBe("Järgmine arve: ABC2026-005");
  });

  test("review I-1: a number she types and leaves while the new prefix's read is on its way stays hers: the late read's number is not taken, nothing saves over it", async () => {
    await show();
    await type(input("prefix"), "abc");
    await leave(input("prefix"));
    await settle();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // before the page's read comes back she types 50 and leaves it: saved
    await type(input("nextSeq"), "50");
    await leave(input("nextSeq"));
    await settle();
    expect(sent("invoice").map((b) => b.patch)).toEqual([{ prefix: "abc" }, { nextSeq: "50" }]);
    // the read, made before her save, comes back late with the reset number
    await show({ ...INITIAL, prefix: "ABC", nextSeq: 1, last: null, version: "i:t2.c2" }, BANK, OCTOBER, true);
    await wait(DEBOUNCE_MS * 2);
    await settle();
    expect(input("nextSeq").value).toBe("50");
    expect(preview()).toBe("Järgmine arve: ABC2026-050");
    expect(sent("invoice").map((b) => b.patch)).toEqual([{ prefix: "abc" }, { nextSeq: "50" }]);
    expect(statuses.at(-1)![1].kind).toBe("saved");
  });

  test("review M-1: a number typed and not left, then a link: the guard commits and saves it, and asks when the route refuses it (taken)", async () => {
    refuse.invoice = { nextSeq: "taken" };
    mounts++;
    await act(async () =>
      root.render(
        createElement(
          LeaveGuardProvider,
          null,
          createElement("a", { href: "/admin/kalender", "data-away": "" }, "Kalender"),
          createElement(InvoiceSettings, { key: mounts, initial: INITIAL, bank: BANK, now: OCTOBER, onStatus: (key: string, st: AutosaveStatus) => void statuses.push([key, st]) }),
        ),
      ),
    );
    await settle();
    await type(input("nextSeq"), "14");
    await click($("[data-away]")!);
    await settle();
    expect(sent("invoice")).toEqual([{ version: "i:t1.c1", patch: { nextSeq: "14" } }]);
    expect(router.push).not.toHaveBeenCalled();
    expect(text(document.querySelector("[data-leave-title]"))).toBe("Muudatust „Arve järgmine number“ ei saanud veel salvestada.");
    expect(text(document.querySelector("[data-leave-reason]"))).toBe("Üks väli vajab parandamist.");
  });
});
