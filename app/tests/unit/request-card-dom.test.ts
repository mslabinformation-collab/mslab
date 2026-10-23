// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RequestCard } from "@/components/admin/RequestCard";
import { RequestFold } from "@/components/admin/RequestFold";
import { requestView, type RequestLookup } from "@/components/admin/request-view";
import { RequestTarget } from "@/components/admin/RequestTarget";
import { UndoProvider } from "@/components/admin/UndoBar";
import type { RegistrationRow } from "@/db/queries/admin";
import type { CourseSession, Request as RequestRow } from "@/db/schema";

// A card of Päringud (admin UX pass, README A7, piece 2 Task 15): the name, the line „{date} · {lang} · {email}“, the type tag, the message, the muted
// facts line (S3-j), „Märgi tehtuks“ with its UndoBar, „Vasta e-kirjaga ↗“ (S3-k: the subject is filled) and, for a waitlist entry or a change request,
// the link to the session or the registration. The server action is answered here; its rules are tests/db/admin-requests.test.ts.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { ok: true; version: string } | { ok: false; error: string };
const action = vi.hoisted(() => vi.fn<(input: Record<string, unknown>) => Promise<Answer>>());
vi.mock("@/server/actions/admin", () => ({
  addManualPaymentAction: vi.fn(),
  saveRegistrationStatus: vi.fn(),
  cancelRegistration: vi.fn(),
  toggleRequestHandled: action,
}));

// (the clock the deep link's 2 s run on is faked below; the browser's own events are not)
const realTimeout = globalThis.setTimeout;

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string, from: ParentNode = document) => from.querySelector<E>(selector);
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};

const request = (over: Partial<RequestRow>): RequestRow => ({ id: 5, kind: "contact", payload: {}, handled: false, clientId: null, createdAt: new Date("2026-10-19T04:24:00Z"), ...over });
const session = { id: 7, startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu" } as CourseSession;
const registration = {
  id: 12,
  name: "Kati Kask",
  email: "kati@example.test",
  locale: "ru",
  course: { slug: "kulm", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } },
  courseSession: { startsAt: new Date("2026-11-14T08:00:00Z"), city: "Pärnu" },
} as unknown as RegistrationRow;
const lookup = (over: Partial<RequestLookup> = {}): RequestLookup => ({
  courses: new Map([["kulm", { et: "Kulmumeistri baaskoolitus", ru: "Базовый курс" }]]),
  sessions: new Map([[7, session]]),
  registrations: new Map([[12, registration]]),
  ...over,
});

const draw = async (row: RequestRow, over: Partial<RequestLookup> = {}) => {
  await act(async () => root.render(createElement(UndoProvider, null, createElement(RequestCard, { view: requestView(row, lookup(over)) }))));
  await settle();
};
const card = () => $("article[data-request]")!;
const bar = () => $("[data-undo-bar]");
const barText = () => text(bar()?.querySelector("p"));
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === name) ?? null;

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

describe("the card", () => {
  const russian = request({
    id: 41,
    payload: { name: "Юлия Соколова", email: "julia@example.test", message: "Здравствуйте! Есть ли курсы на русском языке в Таллинне?", locale: "ru" },
  });

  test("the name is its heading; under it „{date} · {lang} · {email}“; the type tag; the message; the facts line; the id of a deep link", async () => {
    await draw(russian);
    expect(card().id).toBe("p-41");
    expect(card().getAttribute("data-handled")).toBe("0");
    expect(card().getAttribute("aria-labelledby")).toBe("req-41");
    expect(text($("h3#req-41"))).toBe("Юлия Соколова");
    expect(text($("[data-request-meta]"))).toBe("19.10.2026 07:24 · RU · julia@example.test");
    expect(text($("[data-request-tag]"))).toBe("Kontakt");
    expect(text($("[data-request-message]"))).toBe("Здравствуйте! Есть ли курсы на русском языке в Таллинне?");
    expect(text($("[data-request-facts]"))).toBe("Vastus vene keeles");
  });

  test("a phone shows the short line „{dd.mm} · {lang}“ in its place (the stylesheet swaps them); the page holds the long one", async () => {
    await draw(russian);
    expect($("[data-request-meta] [data-swap]")!.getAttribute("data-short")).toBe("19.10 · RU");
  });

  test("a plain Estonian message has no facts line at all", async () => {
    await draw(request({ payload: { name: "Mari", email: "mari@example.test", message: "Tere!", locale: "et" } }));
    expect($("[data-request-facts]")).toBeNull();
    expect(text($("[data-request-meta]"))).toBe("19.10.2026 07:24 · ET · mari@example.test");
  });

  test("the e-learning interest: tagged „E-õppe huvi“, named by its address (not repeated under it), the course as the message, and the cart in the facts", async () => {
    await draw(request({ payload: { course: "kulm", intent: "purchase", email: "reet@example.test", locale: "et" } }));
    expect(text($("h3"))).toBe("reet@example.test");
    expect(text($("[data-request-meta]"))).toBe("19.10.2026 07:24 · ET");
    expect(text($("[data-request-tag]"))).toBe("E-õppe huvi");
    expect($("[data-request-tag]")!.hasAttribute("data-interest")).toBe(true);
    expect(text($("[data-request-message]"))).toBe("Huvi: Kulmumeistri baaskoolitus");
    expect(text($("[data-request-facts]"))).toBe("Ostu ei lõpetanud · ostukorvist");
  });

  test("the other tabs carry their own tag; only the interest is dark", async () => {
    const tags: [RequestRow["kind"], string][] = [["individual", "Individuaal"], ["practice", "Praktika"], ["waitlist", "Ootenimekiri"], ["change_request", "Muutmine"]];
    for (const [kind, tag] of tags) {
      await draw(request({ kind, payload: { name: "N", email: "n@example.test", locale: "et", session: 7, registrationId: 12, kind: "cancel" } }));
      expect(text($("[data-request-tag]")), kind).toBe(tag);
      expect($("[data-request-tag]")!.hasAttribute("data-interest"), kind).toBe(false);
    }
  });

  test("Individuaal: the phone first in the facts, and no message line when she wrote none", async () => {
    await draw(
      request({
        kind: "individual",
        payload: { course: "kulm", name: "Jaan Tamm", email: "jaan@example.test", phone: "+372 5555 0102", preferredPeriod: "Jaanuari teine pool", message: "", wantsModelHelp: false, wantsAccount: true, locale: "et" },
      }),
    );
    expect($("[data-request-message]")).toBeNull();
    expect(text($("[data-request-facts]"))).toBe("+372 5555 0102 · Kulmumeistri baaskoolitus · Soovitud periood: Jaanuari teine pool · Soovib kontot");
  });

  test("the phone in the facts line is a tel: link, in the same muted line: the text of the line is as it was (S3-j), the link only wraps the number", async () => {
    await draw(
      request({
        kind: "individual",
        payload: { course: "kulm", name: "Jaan", email: "jaan@example.test", phone: "+372 5555 0102", preferredPeriod: "Jaanuari teine pool", wantsAccount: true, locale: "et" },
      }),
    );
    const links = document.querySelectorAll<HTMLAnchorElement>("[data-request-facts] a");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("tel:+37255550102");
    expect(text(links[0])).toBe("+372 5555 0102");
    expect(text($("[data-request-facts]"))).toBe("+372 5555 0102 · Kulmumeistri baaskoolitus · Soovitud periood: Jaanuari teine pool · Soovib kontot");
    expect(text($("[data-request-meta]"))).not.toContain("5555"); // (the header line has no number)
  });

  test("a Praktika request's phone is a link too; a card with no number, or one with no digits, has none", async () => {
    await draw(request({ kind: "practice", payload: { package: "MINI", name: "Liis", email: "liis@example.test", phone: "5555-0103", locale: "et" } }));
    expect($("[data-request-facts] a")!.getAttribute("href")).toBe("tel:55550103");
    expect(text($("[data-request-facts]"))).toBe("5555-0103 · Pakett: MINI");
    await draw(request({ kind: "practice", payload: { package: "MINI", name: "Liis", email: "liis@example.test", phone: "ei ole", locale: "et" } }));
    expect($("[data-request-facts] a")).toBeNull();
    await draw(request({ kind: "waitlist", payload: { session: 7, course: "kulm", name: "Ott", email: "ott@example.test", locale: "et" } }));
    expect($("[data-request-facts] a")).toBeNull();
  });

  test("„Vasta e-kirjaga ↗“ opens a mail to her address with the subject filled in her language (S3-k), URL-encoded", async () => {
    await draw(request({ kind: "individual", payload: { course: "kulm", name: "Jaan", email: "jaan@example.test", locale: "et" } }));
    const reply = $<HTMLAnchorElement>("a[data-request-reply]")!;
    expect(text(reply)).toBe("Vasta e-kirjaga ↗");
    expect(reply.getAttribute("href")).toBe(`mailto:jaan@example.test?subject=${encodeURIComponent("Vastus sinu päringule — Kulmumeistri baaskoolitus")}`);
    expect(reply.getAttribute("href")).toContain("p%C3%A4ringule%20%E2%80%94%20Kulmumeistri");
    expect($("[data-request-reply] [data-swap]")!.getAttribute("data-short")).toBe("Vasta ↗");
  });

  test("a Russian request is answered with a Russian subject and the Russian title of the course", async () => {
    await draw(request({ kind: "individual", payload: { course: "kulm", name: "Юлия", email: "julia@example.test", locale: "ru" } }));
    expect($("a[data-request-reply]")!.getAttribute("href")).toBe(`mailto:julia@example.test?subject=${encodeURIComponent("Ответ на ваш запрос — Базовый курс")}`);
  });

  test("a plain message names no course: the subject says „MS LAB“", async () => {
    await draw(russian);
    expect($("a[data-request-reply]")!.getAttribute("href")).toBe(`mailto:julia@example.test?subject=${encodeURIComponent("Ответ на ваш запрос — MS LAB")}`);
  });

  test("a practice request is answered under its package", async () => {
    await draw(request({ kind: "practice", payload: { package: "MINI", name: "Liis", email: "liis@example.test", locale: "et" } }));
    expect($("a[data-request-reply]")!.getAttribute("href")).toBe(`mailto:liis@example.test?subject=${encodeURIComponent("Vastus sinu päringule — MINI")}`);
  });

  test("an address with characters a mailto link cannot carry as they are is encoded; one that is plain stays readable", async () => {
    await draw(request({ payload: { name: "N", email: "o'brien+x@example.test", locale: "et" } }));
    expect($("a[data-request-reply]")!.getAttribute("href")!.startsWith("mailto:o'brien%2Bx@example.test?subject=")).toBe(true);
  });

  test("no address, no reply link", async () => {
    await draw(request({ payload: { name: "Mari", message: "Tere", locale: "et" } }));
    expect($("a[data-request-reply]")).toBeNull();
  });

  test("a waitlist entry links to its session in Kalender, with the day in the facts", async () => {
    await draw(request({ kind: "waitlist", payload: { session: 7, course: "kulm", name: "Ott", email: "ott@example.test", locale: "et" } }));
    const go = $<HTMLAnchorElement>("a[data-request-go]")!;
    expect(text(go)).toBe("Ava toimumine →");
    expect(go.getAttribute("href")).toBe("/admin/kalender?id=7");
    expect(text($("[data-request-facts]"))).toBe("Kulmumeistri baaskoolitus · Toimumine: 14.11.2026 10:00, Pärnu");
  });

  test("a waitlist entry whose session is gone links nowhere and says so by its number", async () => {
    await draw(request({ kind: "waitlist", payload: { session: 99, course: "kulm", name: "Ott", email: "ott@example.test", locale: "et" } }));
    expect($("a[data-request-go]")).toBeNull();
    expect(text($("[data-request-facts]"))).toBe("Kulmumeistri baaskoolitus · Toimumine: toimumine #99");
  });

  test("a change request is named by its registration's name, in the registration's language, and links to the registration", async () => {
    await draw(request({ kind: "change_request", payload: { registrationId: 12, kind: "cancel", message: "Jään haigeks.", email: "kati.konto@example.test" } }));
    expect(text($("h3"))).toBe("Kati Kask");
    expect(text($("[data-request-meta]"))).toBe("19.10.2026 07:24 · RU · kati.konto@example.test");
    expect(text($("[data-request-tag]"))).toBe("Muutmine");
    expect(text($("[data-request-message]"))).toBe("Jään haigeks.");
    expect(text($("[data-request-facts]"))).toBe("Vastus vene keeles · Soovib tühistada · Kulmude lamineerimine, 14.11.2026 Pärnu");
    const go = $<HTMLAnchorElement>("a[data-request-go]")!;
    expect(text(go)).toBe("Ava registreering →");
    expect(go.getAttribute("href")).toBe("/admin/registreerimised?id=12");
    expect($("a[data-request-reply]")!.getAttribute("href")).toBe(`mailto:kati.konto@example.test?subject=${encodeURIComponent("Ответ на ваш запрос — Ламинирование бровей")}`);
  });

  test("a change request whose registration is gone: named by its address, the number in the facts, no link", async () => {
    await draw(request({ kind: "change_request", payload: { registrationId: 12, kind: "change", email: "kati.konto@example.test" } }), { registrations: new Map() });
    expect(text($("h3"))).toBe("kati.konto@example.test");
    expect(text($("[data-request-facts]"))).toBe("Soovib muuta aega · Registreerimine #12 (ei leitud)");
    expect($("a[data-request-go]")).toBeNull();
    // (no language: it is the registration's, and there is none; the address is the name, so it is not said twice)
    expect(text($("[data-request-meta]"))).toBe("19.10.2026 07:24");
  });

  test("a done card says so for the stylesheet and offers „Märgi tegemata“", async () => {
    await draw(request({ handled: true, payload: { name: "Mari", email: "mari@example.test", message: "Tere", locale: "et" } }));
    expect(card().getAttribute("data-handled")).toBe("1");
    expect(text($("[data-request-toggle] button"))).toBe("Märgi tegemata");
  });
});

describe("„Märgi tehtuks“ (instant, with an UndoBar)", () => {
  const open = request({ id: 9, payload: { name: "Mari", email: "mari@example.test", message: "Tere", locale: "et" } });
  const done = request({ id: 9, handled: true, payload: open.payload });

  test("one press marks it: the card asks for „done“ against the „open“ it showed; the bar says „Märgitud tehtuks.“", async () => {
    action.mockResolvedValueOnce({ ok: true, version: "812" });
    await draw(open);
    expect(text(button("Märgi tehtuks"))).toBe("Märgi tehtuks");
    await click(button("Märgi tehtuks"));
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenLastCalledWith({ id: 9, handled: true, expected: false });
    expect(barText()).toBe("Märgitud tehtuks.");
    expect(text(bar()!.querySelector("button"))).toBe("Võta tagasi");
  });

  test("„Võta tagasi“ opens it again, asking for the request as the marking left it (done, that version)", async () => {
    action.mockResolvedValueOnce({ ok: true, version: "812" });
    await draw(open);
    await click(button("Märgi tehtuks"));
    action.mockResolvedValueOnce({ ok: true, version: "813" });
    await click(bar()!.querySelector("button"));
    expect(action).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenLastCalledWith({ id: 9, handled: false, expected: true, version: "812" });
    expect(bar()).toBeNull();
  });

  test("an undo the server refuses (changed meanwhile, elsewhere) shows the bar's own error, and the request is left as it is", async () => {
    action.mockResolvedValueOnce({ ok: true, version: "812" });
    await draw(open);
    await click(button("Märgi tehtuks"));
    action.mockResolvedValueOnce({ ok: false, error: "stale" });
    await click(bar()!.querySelector("button"));
    expect(action).toHaveBeenCalledTimes(2);
    expect(barText()).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
  });

  test("„Märgi tegemata“ in the fold is its own reverse: no bar", async () => {
    action.mockResolvedValueOnce({ ok: true, version: "814" });
    await draw(done);
    await click(button("Märgi tegemata"));
    expect(action).toHaveBeenLastCalledWith({ id: 9, handled: false, expected: true });
    expect(bar()).toBeNull();
  });

  test("a press the server refuses says so by the button, and no bar offers an undo of nothing", async () => {
    action.mockResolvedValueOnce({ ok: false, error: "notFound" });
    await draw(open);
    await click(button("Märgi tehtuks"));
    expect(text($("[data-request-toggle] [role=status]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(bar()).toBeNull();
    // and pressing again tries again, clearing the message while it runs
    action.mockResolvedValueOnce({ ok: true, version: "815" });
    await click(button("Märgi tehtuks"));
    expect(text($("[data-request-toggle] [role=status]"))).toBe("");
    expect(barText()).toBe("Märgitud tehtuks.");
  });

  test("an action that throws is the same refusal", async () => {
    action.mockRejectedValueOnce(new Error("network"));
    await draw(open);
    await click(button("Märgi tehtuks"));
    expect(text($("[data-request-toggle] [role=status]"))).toBe("Salvestamine ei õnnestunud. Proovi uuesti.");
    expect(bar()).toBeNull();
  });

  test("while the answer is on its way the button says „Salvestan…“ and a second press does nothing", async () => {
    let answer: (a: Answer) => void = () => {};
    action.mockReturnValueOnce(new Promise<Answer>((resolve) => (answer = resolve)));
    await draw(open);
    await click(button("Märgi tehtuks"));
    expect(text($("[data-request-toggle] button"))).toBe("Salvestan…");
    await click($("[data-request-toggle] button"));
    expect(action).toHaveBeenCalledTimes(1);
    await act(async () => answer({ ok: true, version: "1" }));
    await settle();
    expect(barText()).toBe("Märgitud tehtuks.");
  });
});

describe("focus after a press: the card leaves its list, the focus does not fall to the page", () => {
  const row = (id: number, handled = false) => request({ id, handled, payload: { name: `N${id}`, email: `n${id}@example.test`, message: "Tere", locale: "et" } });
  type Lists = { open: number[]; done: number[] };
  /** The page's own shape (paringud/page.tsx): a heading, the list of the open cards, and the fold with the done ones when there are any. */
  const page = ({ open, done }: Lists) => {
    const cards = (ids: number[], handled: boolean) =>
      createElement("ul", null, ids.map((id) => createElement("li", { key: id }, createElement(RequestCard, { view: requestView(row(id, handled), lookup()) }))));
    return createElement(
      UndoProvider,
      null,
      createElement(
        "main",
        null,
        createElement("h2", { tabIndex: -1, "data-requests-heading": "" }, "Kontakt"),
        open.length ? cards(open, false) : null,
        done.length ? createElement("details", { "data-fold": "", open: true }, createElement("summary", null, "Tehtud"), cards(done, true)) : null,
      ),
    );
  };
  const show = async (lists: Lists) => {
    await act(async () => root.render(page(lists)));
    await settle();
  };
  const toggle = (id: number) => $<HTMLButtonElement>(`article[data-request="${id}"] [data-request-toggle] button`)!;
  /** She presses the button of card `id` (with the focus on it, as a tap or Enter leaves it). */
  const press = async (id: number) => {
    toggle(id).focus();
    await click(toggle(id));
  };
  const active = () => document.activeElement;

  test("„Märgi tehtuks“: the focus goes to the next card's button", async () => {
    action.mockResolvedValueOnce({ ok: true, version: "1" });
    await show({ open: [1, 2, 3], done: [] });
    await press(1);
    await show({ open: [2, 3], done: [1] });
    expect(active()).toBe(toggle(2));
  });

  test("the last card of the list: the one before it", async () => {
    action.mockResolvedValueOnce({ ok: true, version: "1" });
    await show({ open: [1, 2], done: [] });
    await press(2);
    await show({ open: [1], done: [2] });
    expect(active()).toBe(toggle(1));
  });

  test("none left in the list: the fold's row", async () => {
    action.mockResolvedValueOnce({ ok: true, version: "1" });
    await show({ open: [1], done: [] });
    await press(1);
    await show({ open: [], done: [1] });
    expect(active()).toBe($("details[data-fold] > summary"));
  });

  test("none left and no fold either: the heading", async () => {
    action.mockResolvedValueOnce({ ok: true, version: "1" });
    await show({ open: [1], done: [] });
    await press(1);
    await show({ open: [], done: [] });
    expect(active()).toBe($("[data-requests-heading]"));
  });

  test("„Märgi tegemata“ in the fold: the next done card; the last one: the reopened card itself, now in the list", async () => {
    action.mockResolvedValue({ ok: true, version: "1" });
    await show({ open: [], done: [1, 2] });
    await press(1);
    await show({ open: [1], done: [2] });
    expect(active()).toBe(toggle(2));
    await press(2);
    await show({ open: [1, 2], done: [] });
    expect(active()).toBe(toggle(2));
  });

  test("a press the server refuses moves nothing: the focus stays on the button", async () => {
    action.mockResolvedValueOnce({ ok: false, error: "notFound" });
    await show({ open: [1, 2], done: [] });
    await press(1);
    expect(active()).toBe(toggle(1));
  });

  test("she has moved on by the time the card has gone: her focus is left where it is", async () => {
    action.mockResolvedValueOnce({ ok: true, version: "1" });
    await show({ open: [1, 2, 3], done: [] });
    await press(1);
    toggle(3).focus();
    await show({ open: [2, 3], done: [1] });
    expect(active()).toBe(toggle(3));
  });
});

describe("the fold „Tehtud ({n})“ opens by default when it is all there is, and is never shut under her", () => {
  const fold = (over: { defaultOpen: boolean; id?: string }) =>
    act(async () => root.render(createElement(RequestFold, { key: over.id ?? "kontakt", title: "Tehtud", summary: "", count: 2, defaultOpen: over.defaultOpen }, createElement("p", null, "kaardid"))));
  const details = () => $<HTMLDetailsElement>("details[data-fold]")!;

  test("shut when a request is open; open when none is", async () => {
    await fold({ defaultOpen: false });
    expect(details().open).toBe(false);
    await fold({ defaultOpen: false, id: "praktika" });
    expect(details().open).toBe(false);
    await fold({ defaultOpen: true, id: "individuaal" });
    expect(details().open).toBe(true);
    expect(text($("[data-fold-count]"))).toBe("(2)");
  });

  test("once it is open by default it stays open when a request is reopened (the page then has an open one): she is working in it", async () => {
    await fold({ defaultOpen: true });
    expect(details().open).toBe(true);
    await fold({ defaultOpen: false });
    expect(details().open).toBe(true);
  });

  test("what she did with it stays: shut by her under a default of open, it is not opened again by a new render", async () => {
    await fold({ defaultOpen: true });
    details().open = false;
    await fold({ defaultOpen: true });
    expect(details().open).toBe(false);
  });

  test("another list (another tab or search, another key) starts from its own default", async () => {
    await fold({ defaultOpen: true, id: "kontakt" });
    expect(details().open).toBe(true);
    await fold({ defaultOpen: false, id: "praktika" });
    expect(details().open).toBe(false);
  });
});

describe("a deep link to a card (#p-{id})", () => {
  const spy = vi.fn();
  const reduced = (on: boolean) => {
    window.matchMedia = ((query: string) => ({ matches: on && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  };
  let holder: HTMLElement;
  const page = () => {
    // a card in the list, and one inside the fold „Tehtud (1)“, which is closed
    holder = document.createElement("div");
    const make = (n: number) => {
      const el = document.createElement("article");
      el.id = `p-${n}`;
      el.setAttribute("data-request", String(n));
      return el;
    };
    const fold = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Tehtud (1)";
    fold.append(summary, make(8));
    holder.append(make(3), fold);
    document.body.append(holder);
  };
  /** The address changes (happy-dom, unlike a browser, sometimes says „hashchange“ for a replaceState, a moment later: let that pass before anything is counted). */
  const goTo = async (hash: string) => {
    window.history.replaceState(null, "", `/admin/paringud${hash}`);
    await act(async () => void (await new Promise((resolve) => realTimeout(resolve, 20))));
  };
  /** The fragment changed by Back or a link: the browser says so. */
  const hashchange = () => act(async () => void window.dispatchEvent(new Event("hashchange")));
  const show = async (hash: string) => {
    await goTo(hash);
    await act(async () => root.render(createElement(RequestTarget)));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    spy.mockReset();
    Element.prototype.scrollIntoView = spy;
    reduced(false);
    page();
  });
  afterEach(() => {
    vi.useRealTimers();
    holder.remove();
    window.history.replaceState(null, "", "/");
  });

  test("scrolls to the card and highlights it for 2 s", async () => {
    await show("#p-3");
    const el = document.getElementById("p-3")!;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.contexts[0]).toBe(el);
    expect(el.hasAttribute("data-flash")).toBe(true);
    await act(async () => void vi.advanceTimersByTime(1999));
    expect(el.hasAttribute("data-flash")).toBe(true);
    await act(async () => void vi.advanceTimersByTime(2));
    expect(el.hasAttribute("data-flash")).toBe(false);
  });

  test("a card inside the closed fold opens the fold", async () => {
    const fold = $<HTMLDetailsElement>("details")!;
    expect(fold.open).toBe(false);
    await show("#p-8");
    expect(fold.open).toBe(true);
    expect(spy.mock.contexts[0]).toBe(document.getElementById("p-8"));
  });

  test("under reduced motion the card is reached but not highlighted", async () => {
    reduced(true);
    await show("#p-3");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.getElementById("p-3")!.hasAttribute("data-flash")).toBe(false);
  });

  test("an address with no card, another hash, or no hash does nothing; the fold stays shut", async () => {
    for (const hash of ["", "#p-99", "#arveta", "#p-3x", "#p-"]) {
      spy.mockReset();
      await show(hash);
      expect(spy, hash).not.toHaveBeenCalled();
    }
    expect($<HTMLDetailsElement>("details")!.open).toBe(false);
    expect(document.querySelector("[data-flash]")).toBeNull();
  });

  test("another card by Back or a link on the same page (hashchange) is reached too", async () => {
    await show("#p-3");
    await goTo("#p-8");
    spy.mockReset();
    await hashchange();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.contexts[0]).toBe(document.getElementById("p-8"));
    expect($<HTMLDetailsElement>("details")!.open).toBe(true);
  });

  test("leaving the page takes the listener and the timer with it", async () => {
    await show("#p-3");
    await act(async () => root.render(createElement("div")));
    await goTo("#p-8");
    spy.mockReset();
    await hashchange();
    expect(spy).not.toHaveBeenCalled();
  });
});
