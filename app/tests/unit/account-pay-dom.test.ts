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

describe("a start the server refuses because the card is out of date (fix round 1)", () => {
  // The cards as the signed-in client's own page loads them (GET /api/konto): a refusal that says the card is out of date loads them again,
  // quietly (the page stays, no skeleton), as the change request's dialog does; the refusals that say nothing about the card keep it.
  const stale = dashboard([contact(7, { status: "cancelled" })]);
  const setup = (refusal: Response, second: Response) => {
    const gets = [json(200, dashboard([contact(7)])), second];
    fetchMock.mockImplementation(async (input) => (String(input) === "/api/konto" ? (gets.shift() ?? json(200, stale)) : refusal));
  };
  const open = async () => {
    await act(async () => root.render(createElement(CoursesTab, { locale: "et", t, now: NOW })));
    await settle();
  };
  const gets = () => fetchMock.mock.calls.filter(([input]) => String(input) === "/api/konto").length;

  test.each([
    ["401 (signed out, or another device signed in)", json(401, { ok: false, reason: "none" })],
    ["404 (the registration is gone, or no longer hers)", json(404, { ok: false, error: "registration" })],
    ["409 nothing (paid meanwhile, or called off)", json(409, { ok: false, error: "nothing" })],
  ])("%s: the cards are loaded again quietly, and the card shows what is true now", async (_name, refusal) => {
    setup(refusal, json(200, stale));
    await open();
    expect(gets()).toBe(1);
    await click($("[data-card-action='pay-online']"));
    expect(gets()).toBe(2); // the quiet reload
    expect($("[data-card-skeleton]")).toBeNull(); // quiet: the page stays
    expect($("[data-card='registration-7'] [data-next-step]")?.textContent).toBe("Registreering on tühistatud.");
    expect($("[data-card-action='pay-online']")).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
    // the focus is on the card the student was dealing with
    expect(document.activeElement).toBe($("[data-card='registration-7'] h2"));
  });

  test("a 401 or 404 leaves no line behind; 'nothing' keeps its own true sentence under the reloaded card", async () => {
    setup(json(404, { ok: false, error: "registration" }), json(200, stale));
    await open();
    await click($("[data-card-action='pay-online']"));
    expect($("[data-card-pay-error]")).toBeNull();
    fetchMock.mockReset();
    setup(json(409, { ok: false, error: "nothing" }), json(200, stale));
    await act(async () => root.unmount());
    root = createRoot(container);
    await open();
    await click($("[data-card-action='pay-online']"));
    expect($("[data-card-pay-error]")?.textContent).toBe("Selle registreeringu eest pole praegu midagi tasuda.");
  });

  test("when the reload gets no answer, the page is left as it was and the card says 'Midagi läks valesti', its button ready", async () => {
    setup(json(404, { ok: false, error: "registration" }), json(500, { ok: false }));
    await open();
    await click($("[data-card-action='pay-online']"));
    expect(gets()).toBe(2);
    expect($("[data-card='registration-7'] [data-card-action='pay-online']")?.textContent).toBe("Maksa 175 €");
    expect($("[data-card-pay-error]")?.textContent).toBe("Midagi läks valesti. Proovi uuesti.");
  });

  test.each([
    ["503 (Montonio does not answer)", json(503, { ok: false, error: "unavailable" }), "Midagi läks valesti. Proovi uuesti."],
    ["429 (too many starts)", json(429, { ok: false, error: "rate" }), "Liiga palju katseid. Proovi mõne minuti pärast."],
    ["409 full (the session has filled)", json(409, { ok: false, error: "full" }), "See koolitus on täis. Võta ühendust Mariaga."],
    ["500", json(500, { ok: false, error: "server" }), "Midagi läks valesti. Proovi uuesti."],
  ])("%s: the card is not loaded again; its button stays, with the line", async (_name, refusal, line) => {
    setup(refusal, json(200, stale));
    await open();
    await click($("[data-card-action='pay-online']"));
    expect(gets()).toBe(1);
    expect($("[data-card-action='pay-online']")?.textContent).toBe("Maksa 175 €");
    expect($("[data-card-pay-error]")?.textContent).toBe(line);
  });
});

test("without online payments the cards are today's: 'Vaata juhiseid' is the one button; no 'Maksa'", async () => {
  await render(dashboard([contact(7), contact(8, { status: "confirmed", paidCents: 17500 })], { payOnline: undefined }));
  expect($$("[data-card-action]").map((b) => [b.getAttribute("data-card-action"), b.textContent])).toEqual([["pay", "Vaata juhiseid"], ["change", "Tühista või muuda aega"]]);
  expect(container.textContent).not.toContain("Maksa");
});
