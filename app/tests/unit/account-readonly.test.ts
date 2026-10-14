// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountShell } from "@/components/account/AccountShell";
import { CoursesTab } from "@/components/account/CoursesTab";
import { coursesTexts, shellTexts } from "@/components/account/texts";
import type { ContactCard } from "@/domain/account-cards";
import { getDict } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";

// The admin's read-only "view as client" (Task 9) in a browser-like document (happy-dom): every button and link is
// clicked, and nothing happens — no request, no dialog, no prepayment panel, no menu, no navigation. The same clicks on
// the student's own view do act, so the clicks themselves are known to reach React.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-10-03T10:00:00.000Z";
const course = { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine" } };
const contact = (registrationId: number, over: Partial<ContactCard> = {}): ContactCard => ({
  kind: "contact", registrationId, course, session: { startsAt: "2026-11-14T08:00:00.000Z", city: "Pärnu", venue: "", cancelled: false },
  status: "confirmed", paymentChoice: "full", priceCents: 35000, paidCents: 35000, createdAt: NOW, ...over,
});

const dashboard: Dashboard = {
  client: { email: "kati@example.test", name: "Kati", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
  cards: [
    contact(7, { status: "awaiting_prepayment", paymentChoice: "half", paidCents: 0 }),
    contact(8),
    { kind: "ecourse", course: { slug: "kulmumeistri-e-koolitus", title: { et: "Kulmumeistri e-koolitus" } }, grantedAt: NOW, expiresAt: "2027-04-03T10:00:00.000Z", revoked: false, completedAt: "2026-10-01T10:00:00.000Z" },
  ],
  favourites: [],
  prepayment: { receiver: "MS LAB OÜ", iban: "EE00 0000 0000 0000 0000", bank: "", referencePrefix: "MS" },
  resume: null,
};

const d = getDict("et");
const Shell = AccountShell as (props: Omit<ComponentProps<typeof AccountShell>, "children">) => ReturnType<typeof AccountShell>;

let container: HTMLDivElement;
let root: Root;
const fetchSpy = vi.fn(() => Promise.reject(new Error("no request may be made")));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const click = (el: Element) => act(async () => (el as HTMLElement).click());

describe("read-only: a click does nothing", () => {
  test("every button and link of the frame and the cards: no request, no dialog, no panel, no menu, no navigation", async () => {
    await act(async () =>
      root.render(
        createElement(
          Shell,
          { tab: "courses", locale: "et", t: shellTexts(d), readOnly: true, banner: "Vaatad kliendi Kati vaadet — muuta ei saa" },
          createElement(CoursesTab, { locale: "et", t: coursesTexts(d), data: dashboard, readOnly: true, now: NOW }),
        ),
      ),
    );
    const targets = [...container.querySelectorAll("button:not([data-filter]), a")];
    // the tabs twice, the menu, pay, change request, Ava koolitus
    expect(targets.length).toBe(10);
    const before = location.href;
    for (const el of targets) await click(el);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")).toBeNull();
    expect(container.querySelector("[data-prepayment]")).toBeNull();
    expect(container.querySelector("[data-account-logout]")).toBeNull();
    expect(container.querySelector("[aria-expanded='true']")).toBeNull();
    expect(location.href).toBe(before);
    // the cards are all still there, unchanged
    expect(container.querySelectorAll("[data-card]")).toHaveLength(3);
    // a completed e-course's line is a line, not a target (e-course completion): the count of targets above is unchanged
    expect(container.querySelector("[data-card-completed]")?.textContent).toBe("Lõpetatud 01.10.2026");
  });

  test("the same clicks on the student's own view do act: the instructions open, the dialog opens", async () => {
    await act(async () => root.render(createElement(CoursesTab, { locale: "et", t: coursesTexts(d), data: { ...dashboard, cards: dashboard.cards.slice(0, 2) }, now: NOW })));
    await click(container.querySelector("[data-card-action='pay']")!);
    expect(container.querySelector("[data-prepayment]")).not.toBeNull();
    await click(container.querySelector("[data-card-action='change']")!);
    expect(document.querySelector("dialog[data-change-dialog]")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled(); // opening sends nothing yet
  });
});
