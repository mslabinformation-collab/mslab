// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoursesTab } from "@/components/account/CoursesTab";
import { PrepaymentInfo } from "@/components/account/PrepaymentInfo";
import { coursesTexts } from "@/components/account/texts";
import type { AccountCard, ContactCard } from "@/domain/account-cards";
import { formatEUR } from "@/domain/money";
import { getDict } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";

// "Minu koolitused" in a browser-like document (happy-dom), with fetch answered here: what the student sees after a
// change request when the browser's storage refuses, after a refused request that leaves no card ahead, and Kopeeri's
// short confirmation.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-10-03T10:00:00.000Z";
const FUTURE = "2026-11-14T08:00:00.000Z";
const course = { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine" } };
const contact = (registrationId: number, over: Partial<ContactCard> = {}): ContactCard => ({
  kind: "contact", registrationId, course, session: { startsAt: FUTURE, city: "Pärnu", venue: "", cancelled: false },
  status: "confirmed", paymentChoice: "full", priceCents: 35000, paidCents: 35000, createdAt: NOW, ...over,
});
const dashboard = (cards: AccountCard[]): Dashboard => ({
  client: { email: "kati@example.test", name: "Kati", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
  cards,
  favourites: [],
  prepayment: null,
  resume: null,
});

const d = getDict("et");
const t = coursesTexts(d);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const $ = (selector: string) => document.querySelector(selector);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Opens "Tühista või muuda aega" on the card, picks a choice and presses Saada. */
async function sendChangeRequest(registrationId: number, kind: "cancel" | "change") {
  await click($(`[data-card="registration-${registrationId}"] [data-card-action="change"]`));
  await click($(`[data-change-kind="${kind}"]`));
  await click($("[data-change-send]"));
}

describe("a change request when the browser's storage refuses (private mode, full storage)", () => {
  test("Saada succeeds: the card says Saadetud and the focus is on it, though nothing could be stored", async () => {
    const refuse = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    vi.stubGlobal("sessionStorage", { getItem: refuse, setItem: refuse, removeItem: refuse });
    fetchMock.mockImplementation(async (_input, init) => (init?.method === "POST" ? json(200, { ok: true }) : json(500, {})));
    await act(async () => root.render(createElement(CoursesTab, { locale: "et", t, data: dashboard([contact(8)]), now: NOW })));

    await sendChangeRequest(8, "change");
    expect(fetchMock).toHaveBeenCalledWith("/api/konto/muutmine", expect.objectContaining({ method: "POST", body: JSON.stringify({ registrationId: 8, kind: "change", message: "" }) }));
    expect($("dialog")).toBeNull();
    const sent = $("[data-card='registration-8'] [data-card-sent]");
    expect(sent?.textContent).toBe("Saadetud. Maria võtab sinuga ühendust.");
    expect(document.activeElement).toBe(sent);
    expect($("[data-card='registration-8'] [data-card-action]")).toBeNull(); // the button does not come back
  });
});

describe("a refused request under a chip that then shows nothing", () => {
  test("the last card ahead is cancelled meanwhile: after the reload the chips go and every card shows (Kõik), never an empty list", async () => {
    const before = dashboard([contact(8), contact(9, { status: "cancelled" })]);
    const after = dashboard([contact(8, { status: "cancelled" }), contact(9, { status: "cancelled" })]);
    const gets = [before, after];
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") return json(404, { ok: false, error: "registration" });
      expect(String(input)).toBe("/api/konto");
      return json(200, gets.shift() ?? after);
    });
    await act(async () => root.render(createElement(CoursesTab, { locale: "et", t, now: NOW })));
    await settle();
    expect(document.querySelectorAll("[data-card]")).toHaveLength(2);

    await click($("[data-filter='upcoming']"));
    expect($("[data-filter='upcoming']")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("[data-card]")).toHaveLength(1);

    await sendChangeRequest(8, "cancel");
    expect($("[data-change-notice]")?.textContent).toBe("Seda registreeringut ei saa enam muuta. Võta Mariaga ühendust.");
    await click($("dialog [aria-label='Sulge']"));

    // the quiet reload: no skeleton, the same page, now with both cards over
    expect($("[data-card-skeleton]")).toBeNull();
    expect($("[data-account-filters]")).toBeNull(); // nothing ahead, nothing to choose
    const cards = [...document.querySelectorAll("[data-card]")].map((c) => c.getAttribute("data-card"));
    expect(cards).toEqual(["registration-8", "registration-9"]);
    expect($("[data-card='registration-8'] [data-next-step]")?.textContent).toBe("Registreering on tühistatud.");
    expect(document.activeElement).toBe($("[data-card='registration-8'] h2")); // the card the student was dealing with
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(2);
  });
});

describe("Kopeeri", () => {
  test("says Kopeeritud ✓ in place and in the live region for 2 s, then both are cleared, so a second copy is announced again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    // stored as Seaded stores it (no spaces); read in groups of four, copied without spaces
    const pay = { receiver: "MS LAB OÜ", iban: "EE382200221020145685", bank: "", referencePrefix: "MS" };
    await act(async () => root.render(createElement(PrepaymentInfo, { id: "p", pay, registrationId: 42, amount: "175 €", t: t.payment })));
    expect($("[data-pay-row='iban'] [data-pay-value]")?.textContent).toBe("EE38 2200 2210 2014 5685");

    const button = $("[data-pay-copy='iban']") as HTMLButtonElement;
    const status = () => $("[data-pay-status]")?.textContent;
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith("EE382200221020145685");
    expect(button.hasAttribute("data-copied")).toBe(true);
    expect(status()).toBe("Kopeeritud: IBAN");

    await act(async () => vi.advanceTimersByTime(2000));
    expect(button.hasAttribute("data-copied")).toBe(false);
    expect(status()).toBe("");

    await act(async () => button.click());
    expect(status()).toBe("Kopeeritud: IBAN");
    expect(writeText).toHaveBeenCalledTimes(2);
  });
});

describe("a discounted registration's card (F1)", () => {
  test("says the code and the euros it took off, before the next-step sentence; a card without a code says nothing of it", async () => {
    await act(async () => root.render(createElement(CoursesTab, { locale: "et", t, data: dashboard([contact(8, { priceCents: 31500, discount: { code: "TERE10", cents: 3500 } }), contact(9)]), now: NOW })));
    const line = $("[data-card='registration-8'] [data-card-discount]");
    expect(line?.textContent).toBe(`Sooduskood TERE10: −${formatEUR(3500, "et")}`);
    expect(line?.nextElementSibling?.hasAttribute("data-next-step")).toBe(true);
    expect($("[data-card='registration-9'] [data-card-discount]")).toBeNull();
  });
});
