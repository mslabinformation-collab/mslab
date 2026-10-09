// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoursesTab } from "@/components/account/CoursesTab";
import { coursesTexts } from "@/components/account/texts";
import type { AccountCard, ContactCard, PrepaymentInfo } from "@/domain/account-cards";
import { getDict } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";

// The cards' "Maksa" (phase 2b, spec 6.3): with online payments an unpaid card's one main button is "Maksa {summa}" (the transfer's "Vaata
// juhiseid" under it as a text button), a confirmed card with a rest has "Maksa ülejäänud {summa}" (the change request under it). The button
// posts /api/konto/maksa and the page goes to Montonio; a refusal says why under the button. Without online payments the cards are today's.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ navigate: vi.fn<(url: string) => void>() }));
vi.mock("@/lib/navigate", () => ({ navigate: mocks.navigate }));

const NOW = "2026-10-09T10:00:00.000Z";
const FUTURE = "2026-11-14T08:00:00.000Z";
const PAY: PrepaymentInfo = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "Swedbank", referencePrefix: "MSLAB-" };
const course = { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine" } };
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

const t = coursesTexts(getDict("et"));
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const render = async (data: Dashboard, readOnly = false) => {
  await act(async () => root.render(createElement(CoursesTab, { locale: "et", t, data, readOnly, now: NOW })));
};
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};

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

describe("with online payments", () => {
  test("an unpaid card: 'Maksa 175 €' is its one main button; 'või tasu pangaülekandega' and 'Vaata juhiseid' under it; pressing it goes to Montonio", async () => {
    await render(dashboard([contact(7)]));
    expect($$("[data-card-action]").map((b) => [b.getAttribute("data-card-action"), b.textContent])).toEqual([["pay-online", "Maksa 175 €"]]);
    expect($("[data-card='registration-7']")!.textContent).toContain("või tasu pangaülekandega");
    await click($("[data-card-transfer]"));
    expect($("[data-prepayment]")).not.toBeNull();
    fetchMock.mockResolvedValue(json(200, { ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-1" }));
    await click($("[data-card-action='pay-online']"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect([url, init?.method, JSON.parse(String(init?.body))]).toEqual(["/api/konto/maksa", "POST", { registrationId: 7 }]);
    expect(mocks.navigate).toHaveBeenCalledWith("https://sandbox-stargate.montonio.com/pay-1");
  });

  test("a refusal says why under the button: full, nothing to pay, too many, anything else", async () => {
    await render(dashboard([contact(7)]));
    for (const [answer, line] of [
      [json(409, { ok: false, error: "full" }), "See koolitus on täis. Võta ühendust Mariaga."],
      [json(409, { ok: false, error: "nothing" }), "Selle registreeringu eest pole praegu midagi tasuda."],
      [json(429, { ok: false, error: "rate" }), "Liiga palju katseid. Proovi mõne minuti pärast."],
      [json(503, { ok: false, error: "unavailable" }), "Midagi läks valesti. Proovi uuesti."],
    ] as const) {
      fetchMock.mockResolvedValueOnce(answer);
      await click($("[data-card-action='pay-online']"));
      expect($("[data-card-pay-error]")?.textContent).toBe(line);
    }
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  test("a confirmed card with a rest: 'Maksa ülejäänud 175 €', the change request under it; without the transfer instructions 'Maksa' alone", async () => {
    await render(dashboard([contact(8, { status: "confirmed", paidCents: 17500 })]));
    expect($$("[data-card-action]").map((b) => b.textContent)).toEqual(["Maksa ülejäänud 175 €"]);
    expect($("[data-card-change]")?.textContent).toBe("Tühista või muuda aega");
    await render(dashboard([contact(9)], { prepayment: null }));
    expect($("[data-next-step]")?.textContent).toBe("Koha kinnitamiseks tasu ettemaks 175 €.");
    expect($$("[data-card='registration-9'] button").map((b) => b.textContent)).toEqual(["Maksa 175 €"]);
  });

  test("the browser goes only to a web address: anything else in an answer's paymentUrl is a failed start, not a navigation", async () => {
    await render(dashboard([contact(7)]));
    for (const paymentUrl of ["javascript:alert(1)", "data:text/html,x", "//elsewhere.example/x", 7, null]) {
      fetchMock.mockResolvedValueOnce(json(200, { ok: true, paymentUrl }));
      await click($("[data-card-action='pay-online']"));
      expect($("[data-card-pay-error]")?.textContent, String(paymentUrl)).toBe("Midagi läks valesti. Proovi uuesti.");
    }
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  test("while the browser leaves for Montonio the button says so and takes no second press; back from the browser's cache it is ready again", async () => {
    await render(dashboard([contact(7)]));
    fetchMock.mockResolvedValue(json(200, { ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-1" }));
    await click($("[data-card-action='pay-online']"));
    expect($("[data-card-action='pay-online']")?.textContent).toBe("Avan makse…");
    await click($("[data-card-action='pay-online']"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // (a page shown again from the back-forward cache: `persisted`; a plain load is not)
    await act(async () => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false })));
    expect($("[data-card-action='pay-online']")?.textContent).toBe("Avan makse…");
    await act(async () => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })));
    expect($("[data-card-action='pay-online']")?.textContent).toBe("Maksa 175 €");
  });

  test("read-only (the admin's view): the button is there and does nothing", async () => {
    await render(dashboard([contact(7)]), true);
    await click($("[data-card-action='pay-online']"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

test("without online payments the cards are today's: 'Vaata juhiseid' is the one button; no 'Maksa'", async () => {
  await render(dashboard([contact(7), contact(8, { status: "confirmed", paidCents: 17500 })], { payOnline: undefined }));
  expect($$("[data-card-action]").map((b) => [b.getAttribute("data-card-action"), b.textContent])).toEqual([["pay", "Vaata juhiseid"], ["change", "Tühista või muuda aega"]]);
  expect(container.textContent).not.toContain("Maksa");
});
