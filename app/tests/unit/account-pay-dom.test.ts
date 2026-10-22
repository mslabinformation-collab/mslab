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

// ---------- Järelmaks (Inbank) on the card (instalments §4 „Maksa“ for a järelmaks registration, Task 7) ----------
// An unpaid card booked with „Järelmaks (Inbank)“ has two buttons while a loan may go to Inbank (Dashboard.financing: Maria's toggle; payments on; the
// price 100–5000 €; nothing paid; the whole price due): „Maksa järelmaksuga (Inbank)“ and „Maksa pangalingiga“, each posting its `method`. In every other
// case it is the one „Maksa {summa}“ of before, posting no `method`.

describe("Järelmaks (Inbank) on the card", () => {
  const loan = (id: number, over: Partial<ContactCard> = {}) => contact(id, { paymentChoice: "financing", ...over });
  const actions = () => $$("[data-card-action]").map((b) => [b.getAttribute("data-card-action"), b.textContent]);
  const TWO = [["pay-financing", "Maksa järelmaksuga (Inbank)"], ["pay-online", "Maksa pangalingiga"]];
  const bodyOf = (call: number) => JSON.parse(String(fetchMock.mock.calls[call][1]?.body));

  test("allowed: two buttons — järelmaks first — and 'või tasu pangaülekandega' with 'Vaata juhiseid' under them; the sentence says the whole price", async () => {
    await render(dashboard([loan(7)], { financing: true }));
    expect(actions()).toEqual(TWO);
    expect($("[data-next-step]")?.textContent).toBe("Koha kinnitamiseks tasu ettemaks 350 €.");
    expect($("[data-card='registration-7']")!.textContent).toContain("või tasu pangaülekandega");
    expect($("[data-card-transfer]")).not.toBeNull();
    expect($$("[data-card='registration-7'] button").map((b) => b.textContent)).toEqual(["Maksa järelmaksuga (Inbank)", "Maksa pangalingiga", "Vaata juhiseid"]);
  });

  test("the järelmaks button posts method hirePurchase and the browser goes to the page the start gave; the bank's posts paymentInitiation", async () => {
    await render(dashboard([loan(7)], { financing: true }));
    fetchMock.mockResolvedValue(json(200, { ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/loan-1" }));
    await click($("[data-card-action='pay-financing']"));
    expect([fetchMock.mock.calls[0][0], fetchMock.mock.calls[0][1]?.method, bodyOf(0)]).toEqual(["/api/konto/maksa", "POST", { registrationId: 7, method: "hirePurchase" }]);
    expect(mocks.navigate).toHaveBeenLastCalledWith("https://sandbox-stargate.montonio.com/loan-1");
    // back from the browser's cache, the other way
    await act(async () => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })));
    fetchMock.mockResolvedValue(json(200, { ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/bank-1" }));
    await click($("[data-card-action='pay-online']"));
    expect(bodyOf(1)).toEqual({ registrationId: 7, method: "paymentInitiation" });
    expect(mocks.navigate).toHaveBeenLastCalledWith("https://sandbox-stargate.montonio.com/bank-1");
  });

  test("while the browser leaves for Montonio the pressed button says so and both take no second press; back from the cache both are ready again", async () => {
    await render(dashboard([loan(7)], { financing: true }));
    fetchMock.mockResolvedValue(json(200, { ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/loan-1" }));
    await click($("[data-card-action='pay-financing']"));
    expect(actions()).toEqual([["pay-financing", "Avan makse…"], ["pay-online", "Maksa pangalingiga"]]);
    expect($$("[data-card-action]").map((b) => b.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
    await click($("[data-card-action='pay-online']"));
    await click($("[data-card-action='pay-financing']"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })));
    expect(actions()).toEqual(TWO);
    expect($$("[data-card-action]").map((b) => b.getAttribute("aria-disabled"))).toEqual([null, null]);
  });

  test("the one 'Maksa' as today, posting no method: the toggle off, a part paid, the price outside 100–5000 €, an invoice for a part, payments off, booked with 100% or 50%", async () => {
    const one = async (label: string, data: Dashboard, button: string) => {
      await render(data);
      expect(actions(), label).toEqual([["pay-online", button]]);
    };
    await one("off", dashboard([loan(7)]), "Maksa 350 €");
    await one("false", dashboard([loan(7)], { financing: false }), "Maksa 350 €");
    await one("part paid", dashboard([loan(7, { paidCents: 5000 })], { financing: true }), "Maksa 300 €");
    await one("below", dashboard([loan(7, { priceCents: 9999 })], { financing: true }), "Maksa 99,99 €");
    await one("above", dashboard([loan(7, { priceCents: 500001 })], { financing: true }), "Maksa 5 000,01 €");
    await one("invoice for a part", dashboard([loan(7, { openInvoice: { id: 3, kind: "full", amountCents: 10000 } })], { financing: true }), "Maksa 100 €");
    await one("100%", dashboard([contact(7, { paymentChoice: "full" })], { financing: true }), "Maksa 350 €");
    await one("50%", dashboard([contact(7)], { financing: true }), "Maksa 175 €");
    await render(dashboard([loan(7)], { financing: true, payOnline: undefined }));
    expect(actions()).toEqual([["pay", "Vaata juhiseid"]]);
    // the range's edges are in: 100 € and 5000 €
    for (const priceCents of [10000, 500000]) {
      await render(dashboard([loan(7, { priceCents })], { financing: true }));
      expect(actions(), String(priceCents)).toEqual(TWO);
    }
    // (and the single button posts the body of before)
    await render(dashboard([loan(7)]));
    fetchMock.mockResolvedValue(json(200, { ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/pay-1" }));
    await click($("[data-card-action='pay-online']"));
    expect(bodyOf(0)).toEqual({ registrationId: 7 });
  });

  test("a confirmed card whose whole price is still due keeps the two buttons, the change request a text button under them", async () => {
    await render(dashboard([loan(7, { status: "confirmed" })], { financing: true }));
    expect(actions()).toEqual(TWO);
    expect($("[data-card-change]")?.textContent).toBe("Tühista või muuda aega");
  });

  test("read-only (the admin's view): both buttons are there, aria-disabled, and do nothing", async () => {
    await render(dashboard([loan(7)], { financing: true }), true);
    expect(actions()).toEqual(TWO);
    await click($("[data-card-action='pay-financing']"));
    await click($("[data-card-action='pay-online']"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("Russian", async () => {
    const ru = coursesTexts(getDict("ru"));
    await act(async () => root.render(createElement(CoursesTab, { locale: "ru", t: ru, data: dashboard([loan(7)], { financing: true }), readOnly: false, now: NOW })));
    expect(actions()).toEqual([["pay-financing", "Оплатить в рассрочку (Inbank)"], ["pay-online", "Оплатить через банк"]]);
  });

  describe("a loan the server refuses: 409 financing (the toggle went off, or the price moved, since the page was loaded)", () => {
    const RANGE = "Järelmaks on võimalik 100–5000 € hinnaga koolitusele.";
    const open = async () => {
      await act(async () => root.render(createElement(CoursesTab, { locale: "et", t, now: NOW })));
      await settle();
    };

    test("the range sentence under the buttons, the cards loaded again quietly: the card then has the one bank button, and the sentence stays", async () => {
      const gets = [json(200, dashboard([loan(7)], { financing: true })), json(200, dashboard([loan(7)]))];
      fetchMock.mockImplementation(async (input) => (String(input) === "/api/konto" ? (gets.shift() ?? json(200, dashboard([loan(7)]))) : json(409, { ok: false, error: "financing" })));
      await open();
      expect(actions()).toEqual(TWO);
      await click($("[data-card-action='pay-financing']"));
      const post = fetchMock.mock.calls.find(([input]) => String(input) === "/api/konto/maksa")!;
      expect(JSON.parse(String(post[1]?.body))).toEqual({ registrationId: 7, method: "hirePurchase" });
      expect($("[data-card-pay-error]")?.textContent).toBe(RANGE);
      expect(actions()).toEqual([["pay-online", "Maksa 350 €"]]);
      expect(mocks.navigate).not.toHaveBeenCalled();
    });

    test("when the reload gets no answer the card keeps both buttons, with the sentence, ready", async () => {
      const gets = [json(200, dashboard([loan(7)], { financing: true })), json(500, { ok: false })];
      fetchMock.mockImplementation(async (input) => (String(input) === "/api/konto" ? (gets.shift() ?? json(500, { ok: false })) : json(409, { ok: false, error: "financing" })));
      await open();
      await click($("[data-card-action='pay-financing']"));
      expect($("[data-card-pay-error]")?.textContent).toBe(RANGE);
      expect(actions()).toEqual(TWO);
    });

    test("the bank's press on that card still goes to the bank", async () => {
      fetchMock.mockImplementation(async (input) =>
        String(input) === "/api/konto" ? json(200, dashboard([loan(7)], { financing: true })) : json(200, { ok: true, paymentUrl: "https://sandbox-stargate.montonio.com/bank-2" }),
      );
      await open();
      await click($("[data-card-action='pay-online']"));
      expect(mocks.navigate).toHaveBeenCalledWith("https://sandbox-stargate.montonio.com/bank-2");
    });
  });
});
