// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoursesTab } from "@/components/account/CoursesTab";
import { coursesTexts } from "@/components/account/texts";
import type { AccountCard, CardInvoice, ContactCard, EcourseCard, IndividualCard, PrepaymentInfo } from "@/domain/account-cards";
import { et } from "@/i18n/dict/et";
import { ru } from "@/i18n/dict/ru";
import { getDict, type Locale } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";

// The invoices on the account's course cards (invoices Task 6; spec §4) in a browser-like document (happy-dom):
// - one quiet line per invoice, „Arve {number} · {summa} · Tasutud" or „… · Tasumata · tasu {date}", with „Laadi alla (PDF)" (a link to
//   /api/konto/arve/<id>; aria-disabled in the admin's read-only copy, like the certificate's);
// - an unpaid invoice also shows the receiver, IBAN, bank, amount and reference frozen on it (the instructions' own rows, with "Kopeeri");
// - „Maksa" charges what payableDue says on the server too: an unpaid invoice's exact amount, "ülejäänud" for a „Jääk", also on the course day;
// - an invoice waiting for its catch-up (R14) arrives as paid and `awaitingCatchUp`: no bank details, no „Maksa", and no download (its PDF would
//   still read unpaid) while a paid invoice beside it has its;
// - in Russian, with the account's typography.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ navigate: vi.fn<(url: string) => void>() }));
vi.mock("@/lib/navigate", () => ({ navigate: mocks.navigate }));

const NOW = "2026-10-09T10:00:00.000Z";
const FUTURE = "2026-11-14T08:00:00.000Z";
/** The same Tallinn day as NOW, six hours later: the course day, when amountDue offers nothing. */
const TODAY = "2026-10-09T16:00:00.000Z";
const PAY: PrepaymentInfo = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
const course = { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } };
const contact = (registrationId: number, over: Partial<ContactCard> = {}): ContactCard => ({
  kind: "contact", registrationId, course, session: { startsAt: FUTURE, city: "Pärnu", venue: "", cancelled: false },
  status: "awaiting_prepayment", paymentChoice: "half", priceCents: 35000, paidCents: 0, createdAt: NOW, ...over,
});
const dashboard = (cards: AccountCard[], over: Partial<Dashboard> = {}): Dashboard => ({
  client: { email: "kati@example.test", name: "Kati", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
  cards,
  favourites: [],
  prepayment: PAY,
  resume: null,
  payOnline: true,
  ...over,
});

/** The invoice a paid mark or a payment made: MSL2026-001, 175,00 €, paid on 10.10. */
const paidInvoice = (over: Partial<CardInvoice> = {}): CardInvoice => ({ id: 11, number: "MSL2026-001", amountCents: 17500, status: "paid", dueAt: null, paidAt: "2026-10-10T08:00:00.000Z", transfer: null, ...over });
/** Maria's request to pay: MSL2026-002, 175,00 €, due 23.10.2026, the bank details frozen on it. */
const unpaidInvoice = (over: Partial<CardInvoice> = {}): CardInvoice => ({
  id: 12, number: "MSL2026-002", amountCents: 17500, status: "unpaid", dueAt: "2026-10-23T09:00:00.000Z", paidAt: null,
  transfer: { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", reference: "MSLAB-7" }, ...over,
});

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const render = async (data: Dashboard, opts: { locale?: Locale; readOnly?: boolean } = {}) => {
  const locale = opts.locale ?? "et";
  await act(async () => root.render(createElement(CoursesTab, { locale, t: coursesTexts(getDict(locale)), data, readOnly: opts.readOnly ?? false, now: NOW })));
};
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const NBSP = "\u00a0";
const lineOf = (id: number) => $(`[data-card-invoice='${id}'] [data-invoice-line]`)?.textContent;
const actions = () => $$("[data-card-action]").map((b) => [b.getAttribute("data-card-action"), b.textContent]);

beforeEach(() => {
  fetchMock.mockReset();
  mocks.navigate.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the invoice lines", () => {
  test("a paid invoice: „Arve MSL2026-001 · 175,00 € · Tasutud“ and its download; no bank details", async () => {
    await render(dashboard([contact(7, { status: "confirmed", paidCents: 17500, invoices: [paidInvoice()] })]));
    expect(lineOf(11)).toBe(`Arve MSL2026-001 · 175,00${NBSP}€ · Tasutud`);
    const link = $("[data-card-invoice='11'] a[data-card-invoice-download]") as HTMLAnchorElement;
    expect([link.getAttribute("href"), link.hasAttribute("download"), link.textContent]).toEqual(["/api/konto/arve/11", true, "Laadi alla (PDF)"]);
    expect($("[data-card-invoice='11'][data-invoice-status='paid']")).not.toBeNull();
    expect($("[data-invoice-transfer]")).toBeNull();
  });

  test("an unpaid invoice: „… · Tasumata · tasu 23.10.2026“, its download, and the bank details with the amount and the reference", async () => {
    await render(dashboard([contact(7, { invoices: [unpaidInvoice()], openInvoice: { id: 12, kind: "prepayment", amountCents: 17500 } })]));
    expect(lineOf(12)).toBe(`Arve MSL2026-002 · 175,00${NBSP}€ · Tasumata · tasu 23.10.2026`);
    expect($("[data-card-invoice='12'] a[data-card-invoice-download]")?.getAttribute("href")).toBe("/api/konto/arve/12");
    const rows = $$("[data-card-invoice='12'] [data-invoice-transfer] [data-pay-row]").map((row) => [row.getAttribute("data-pay-row"), row.querySelector("[data-pay-value]")?.textContent]);
    expect(rows).toEqual([["receiver", "MS LAB OÜ"], ["iban", "EE38 2200 2210 2014 5685"], ["bank", "Swedbank"], ["amount", `175,00${NBSP}€`], ["reference", "MSLAB-7"]]);
    // "Kopeeri" for the IBAN and the reference, as the instructions have; and not their „Pärast makset kinnitab Maria su koha.“, which is not an invoice's
    expect($$("[data-card-invoice='12'] [data-pay-copy]").map((b) => b.getAttribute("data-pay-copy"))).toEqual(["iban", "reference"]);
    expect($("[data-card-invoice='12']")!.textContent).not.toContain("Maria su koha");
  });

  test("an unpaid invoice with no due date or no bank details still reads: no date, no panel", async () => {
    await render(dashboard([contact(7, { invoices: [unpaidInvoice({ dueAt: null, transfer: null })] })]));
    expect(lineOf(12)).toBe(`Arve MSL2026-002 · 175,00${NBSP}€ · Tasumata`);
    expect($("[data-invoice-transfer]")).toBeNull();
  });

  test("a bank row Maria left empty is left out; the amount is the invoice's own", async () => {
    await render(dashboard([contact(7, { invoices: [unpaidInvoice({ amountCents: 100050, transfer: { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "", reference: "" } })] })]));
    expect($$("[data-invoice-transfer] [data-pay-row]").map((r) => r.getAttribute("data-pay-row"))).toEqual(["receiver", "iban", "amount"]);
    expect($("[data-invoice-transfer] [data-pay-row='amount'] [data-pay-value]")?.textContent).toBe(`1${NBSP}000,50${NBSP}€`);
  });

  test("several invoices: one line each, in the order given, each with its own download; the ids on each card only", async () => {
    await render(dashboard([contact(7, { invoices: [paidInvoice(), unpaidInvoice()] }), contact(8, { invoices: [paidInvoice({ id: 21, number: "MSL2026-007" })] })]));
    expect($$("[data-card='registration-7'] [data-card-invoice]").map((li) => li.getAttribute("data-card-invoice"))).toEqual(["11", "12"]);
    expect($$("[data-card='registration-8'] [data-card-invoice]").map((li) => li.getAttribute("data-card-invoice"))).toEqual(["21"]);
    expect($$("[data-card='registration-7'] a[data-card-invoice-download]").map((a) => a.getAttribute("href"))).toEqual(["/api/konto/arve/11", "/api/konto/arve/12"]);
  });

  test("each download is named by its invoice for a screen reader, the visible words first", async () => {
    await render(dashboard([contact(7, { invoices: [paidInvoice(), unpaidInvoice()] })]));
    expect($$("a[data-card-invoice-download]").map((a) => a.getAttribute("aria-label"))).toEqual(["Laadi alla (PDF): MSL2026-001", "Laadi alla (PDF): MSL2026-002"]);
  });

  test("a card with no invoices has no invoice block", async () => {
    await render(dashboard([contact(7), contact(8, { invoices: [] })]));
    expect($("[data-card-invoices]")).toBeNull();
  });

  test("an individual course's card and an e-course's carry theirs too", async () => {
    const individual: IndividualCard = { kind: "individual", registrationId: 9, course, status: "awaiting_prepayment", preferredPeriod: "märts", createdAt: NOW, invoices: [unpaidInvoice({ id: 31, number: "MSL2026-003" })] };
    const ecourse: EcourseCard = {
      kind: "ecourse", course: { slug: "kulmud-e", title: { et: "Kulmude e-kursus" } }, grantedAt: NOW, expiresAt: "2027-04-09T10:00:00.000Z", revoked: false,
      invoices: [paidInvoice({ id: 41, number: "MSL2026-004", amountCents: 9500 })],
    };
    await render(dashboard([individual, ecourse]));
    expect(lineOf(31)).toContain("Arve MSL2026-003");
    expect(lineOf(41)).toBe(`Arve MSL2026-004 · 95,00${NBSP}€ · Tasutud`);
    // no „Maksa“ on either: an individual registration has no date to pay for, an e-course's invoice is born paid
    expect($$("[data-card-action='pay-online']")).toEqual([]);
  });

  test("read-only (the admin's copy): the download is there but aria-disabled, with no address, like the certificate's link", async () => {
    await render(dashboard([contact(7, { invoices: [paidInvoice()] })]), { readOnly: true });
    const link = $("a[data-card-invoice-download]")!;
    expect([link.getAttribute("aria-disabled"), link.getAttribute("role"), link.hasAttribute("href"), link.hasAttribute("download")]).toEqual(["true", "link", false, false]);
  });

  test("the lines are quiet: no filled button, no extra main action", async () => {
    await render(dashboard([contact(7, { status: "confirmed", paidCents: 35000, invoices: [paidInvoice()] })]));
    expect($$("[data-card-invoices] button")).toEqual([]);
    expect($$("[data-card-invoices] a").every((a) => !/btn/.test(a.className))).toBe(true);
  });
});

describe("„Maksa“ with an unpaid invoice: the server's payableDue", () => {
  test("an invoice for another sum than the prepayment: „Maksa 350 €“ charges the invoice (the whole sum), and the press posts the registration as before", async () => {
    const full = unpaidInvoice({ amountCents: 35000 });
    await render(dashboard([contact(7, { invoices: [full], openInvoice: { id: 12, kind: "full", amountCents: 35000 } })]));
    expect(actions()).toEqual([["pay-online", "Maksa 350 €"]]);
    fetchMock.mockResolvedValue(json(200, { ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-1" }));
    await click($("[data-card-action='pay-online']"));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ registrationId: 7 });
    expect(mocks.navigate).toHaveBeenCalledWith("https://sandbox-stargate.montonio.com/pay-1");
  });

  test("a „Jääk“ invoice of a confirmed card: „Maksa ülejäänud“ with the invoice's sum, not the card's rest", async () => {
    const rest = unpaidInvoice({ amountCents: 10000 });
    await render(dashboard([contact(7, { status: "confirmed", paidCents: 17500, invoices: [rest], openInvoice: { id: 12, kind: "balance", amountCents: 10000 } })]));
    expect(actions()).toEqual([["pay-online", "Maksa ülejäänud 100 €"]]);
  });

  test("without an open invoice the amounts are amountDue's, as before: the prepayment, and the rest", async () => {
    await render(dashboard([contact(7, { invoices: [paidInvoice()] }), contact(8, { status: "confirmed", paidCents: 17500, invoices: [paidInvoice({ id: 13 })] })]));
    expect(actions()).toEqual([["pay-online", "Maksa 175 €"], ["pay-online", "Maksa ülejäänud 175 €"]]);
  });

  test("the course day: amountDue offers nothing, but an unpaid invoice can be paid — the button is there with it, and not without", async () => {
    const day = { session: { startsAt: TODAY, city: "Pärnu", venue: "", cancelled: false }, status: "confirmed" as const, paidCents: 17500 };
    await render(dashboard([contact(7, day)]));
    expect(actions()).toEqual([["change", "Tühista või muuda aega"]]);
    await render(dashboard([contact(7, { ...day, invoices: [unpaidInvoice()], openInvoice: { id: 12, kind: "balance", amountCents: 17500 } })]));
    expect(actions()).toEqual([["pay-online", "Maksa ülejäänud 175 €"]]);
    expect($("[data-card-change]")?.textContent).toBe("Tühista või muuda aega"); // (the change request is the text button under it)
  });

  test("online payments off: no „Maksa“, but the invoice and its bank details are there", async () => {
    await render(dashboard([contact(7, { invoices: [unpaidInvoice()], openInvoice: { id: 12, kind: "prepayment", amountCents: 17500 } })], { payOnline: false }));
    expect($$("[data-card-action='pay-online']")).toEqual([]);
    expect($("[data-invoice-transfer]")).not.toBeNull();
  });

  test("a cancelled registration or a called-off session: no „Maksa“ even with an unpaid invoice", async () => {
    const invoice = { invoices: [unpaidInvoice()], openInvoice: { id: 12, kind: "prepayment" as const, amountCents: 17500 } };
    await render(dashboard([contact(7, { ...invoice, status: "cancelled" }), contact(8, { ...invoice, session: { startsAt: FUTURE, city: "Pärnu", venue: "", cancelled: true } })]));
    expect($$("[data-card-action='pay-online']")).toEqual([]);
  });
});

describe("the final review's wave: „Tagastatud“ (I3), a cancelled registration (m8)", () => {
  test("I3: a paid invoice whose payment was refunded or voided reads „Tagastatud“, its download as it was; the paid one beside it „Tasutud“", async () => {
    await render(dashboard([contact(7, { status: "confirmed", paidCents: 17500, invoices: [paidInvoice({ refunded: true }), paidInvoice({ id: 13, number: "MSL2026-003" })] })]));
    expect(lineOf(11)).toBe(`Arve MSL2026-001 · 175,00${NBSP}€ · Tagastatud`);
    expect(lineOf(13)).toBe(`Arve MSL2026-003 · 175,00${NBSP}€ · Tasutud`);
    expect($("[data-card-invoice='11']")?.getAttribute("data-invoice-refunded")).toBe("true");
    expect($("[data-card-invoice='13']")?.hasAttribute("data-invoice-refunded")).toBe(false);
    expect($("[data-card-invoice='11'] a[data-card-invoice-download]")?.getAttribute("href")).toBe("/api/konto/arve/11");
    await render(dashboard([contact(7, { status: "confirmed", paidCents: 17500, invoices: [paidInvoice({ refunded: true })] })]), { locale: "ru" });
    expect(lineOf(11)).toBe(`Счёт MSL2026-001 · 175,00${NBSP}€ · Возвращён`);
  });

  test("m8: a cancelled registration's unpaid invoice (sent without bank details or `openInvoice`) reads „Tasumata“ with no bank details and no „Maksa“", async () => {
    await render(dashboard([contact(7, { status: "cancelled", invoices: [unpaidInvoice({ transfer: null })] })]));
    expect(lineOf(12)).toBe(`Arve MSL2026-002 · 175,00${NBSP}€ · Tasumata · tasu 23.10.2026`);
    expect($("[data-invoice-transfer]")).toBeNull();
    expect($$("[data-card-action='pay-online'], [data-card-action='pay']")).toEqual([]);
    expect($("[data-card-invoice='12'] a[data-card-invoice-download]")?.getAttribute("href")).toBe("/api/konto/arve/12");
  });
});

describe("R14: an invoice waiting for its catch-up arrives as paid", () => {
  /** The dashboard's data for it (client-data.ts): the money is in (Laekunud summa), the invoice is paid for the student, nothing is open. */
  const waiting = paidInvoice({ id: 12, number: "MSL2026-002", dueAt: "2026-10-23T09:00:00.000Z", paidAt: null, awaitingCatchUp: true });

  test("it reads „Tasutud“, shows no bank details and gives no „Maksa“ of its own", async () => {
    await render(dashboard([contact(7, { status: "confirmed", paidCents: 17500, invoices: [waiting] })]));
    expect(lineOf(12)).toBe(`Arve MSL2026-002 · 175,00${NBSP}€ · Tasutud`);
    expect($("[data-invoice-transfer]")).toBeNull();
    expect($$("[data-card-action='pay-online']").map((b) => b.textContent)).toEqual(["Maksa ülejäänud 175 €"]); // (the registration's own rest, amountDue's: not the invoice's)
  });

  test("it has no download until the catch-up has paid it, while the paid invoice beside it has one (also in the admin's read-only copy)", async () => {
    for (const readOnly of [false, true]) {
      await render(dashboard([contact(7, { status: "confirmed", paidCents: 17500, invoices: [paidInvoice(), waiting] })]), { readOnly });
      expect($$("[data-card-invoice] a[data-card-invoice-download]").map((a) => a.closest("[data-card-invoice]")?.getAttribute("data-card-invoice"))).toEqual(["11"]);
      expect($("[data-card-invoice='12']")).not.toBeNull(); // (its line is there)
      expect($$("[data-card-invoice='12'] a")).toEqual([]);
    }
  });
});

describe("in Russian", () => {
  test("the lines, the download and the bank details read in Russian; the sum keeps its no-break space", async () => {
    await render(dashboard([contact(7, { invoices: [paidInvoice(), unpaidInvoice()], openInvoice: { id: 12, kind: "prepayment", amountCents: 17500 } })]), { locale: "ru" });
    expect(lineOf(11)).toBe(`Счёт MSL2026-001 · 175,00${NBSP}€ · Оплачен`);
    expect(lineOf(12)).toBe(`Счёт MSL2026-002 · 175,00${NBSP}€ · Не оплачен · оплатить до 23.10.2026`);
    expect($$("a[data-card-invoice-download]").map((a) => [a.textContent, a.getAttribute("aria-label")])).toEqual([
      ["Скачать (PDF)", "Скачать (PDF): MSL2026-001"],
      ["Скачать (PDF)", "Скачать (PDF): MSL2026-002"],
    ]);
    expect($$("[data-invoice-transfer] dt").map((dt) => dt.textContent)).toEqual(["Получатель", "IBAN", "Банк", "Сумма", "Назначение платежа"]);
    expect($("[data-card-action='pay-online']")?.textContent).toMatch(/^Оплатить /);
  });
});

describe("the texts", () => {
  const strings = (value: unknown, path: string): [string, string][] =>
    typeof value === "string" ? [[path, value]] : Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => strings(v, `${path}.${k}`));

  test("both dictionaries hold the same keys and the same {placeholders}", () => {
    expect(Object.keys(ru.account.invoices).sort()).toEqual(Object.keys(et.account.invoices).sort());
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(et.account.invoices) as (keyof typeof et.account.invoices)[]) expect(vars(ru.account.invoices[key]), key).toEqual(vars(et.account.invoices[key]));
  });

  test("Russian typography: no one-letter preposition (в, с, к, о, у) is followed by an ordinary space", () => {
    const all = strings(ru.account.invoices, "invoices");
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const [key, text] of all) expect(text, key).not.toMatch(/(^|[\s(«])[вскоуВСКОУ] /u);
  });

  test("the spec's quoted words, as quoted", () => {
    expect([et.account.invoices.paid, et.account.invoices.unpaid, et.account.invoices.download, et.account.invoices.refunded]).toEqual(["Tasutud", "Tasumata", "Laadi alla (PDF)", "Tagastatud"]);
  });
});
