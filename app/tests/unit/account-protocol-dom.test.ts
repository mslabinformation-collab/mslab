// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, Profiler, useInsertionEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoursesTab } from "@/components/account/CoursesTab";
import { ProtocolPage } from "@/components/account/ProtocolPage";
import { coursesTexts, protocolTexts } from "@/components/account/texts";
import type { ContactCard, IndividualCard } from "@/domain/account-cards";
import { getDict, type Locale } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";

// The student's protocol (spec §5): the page reads its registration from the fragment and loads the sent copy; the frame is in her language,
// Maria's text as written; a stage without a note is not shown; a protocol that is not hers is "not found". And the card's "Vaata protokolli".

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
const page = async (locale: Locale, hash: string) => {
  window.history.replaceState(null, "", `${locale === "ru" ? "/ru" : ""}/konto/protokoll${hash}`);
  await act(async () => root.render(createElement(ProtocolPage, { locale, t: protocolTexts(getDict(locale)) })));
  await settle();
};
const ANSWER = {
  ok: true,
  course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } },
  session: { startsAt: "2026-10-12T07:00:00.000Z", city: "Pärnu", venue: "MS LAB stuudio" },
  sentAt: "2026-10-12T15:00:00.000Z",
  stages: [
    { title: "Ettevalmistus", note: "Kulmud said ühtlased" },
    { title: "Kulmude analüüs", note: "" },
    { title: "Värvimine", note: "Värv sobis" },
  ],
  generalNote: "Tubli töö!\nJätka harjutamist.",
};

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
});

describe("the protocol page", () => {
  test("loads her registration's protocol from the fragment's id; the stages with a note, the general notes as written, when it was sent", async () => {
    fetchMock.mockResolvedValue(json(200, ANSWER));
    await page("et", "#id=42");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/konto/protokoll?id=42");
    expect($("h1")!.textContent).toBe("Kulmude lamineerimine");
    expect($("[data-protocol-when]")!.textContent).toBe("12.10.2026 · 10:00 · Pärnu, MS LAB stuudio");
    expect($$("[data-protocol-stage] h3").map((h) => h.textContent)).toEqual(["Ettevalmistus", "Värvimine"]);
    expect($("[data-protocol-general]")!.textContent).toBe("Tubli töö!\nJätka harjutamist.");
    expect(container.textContent).toContain("Praktiline osa");
    expect(container.textContent).toContain("Üldised märkused");
    expect(container.textContent).toContain("Saadetud 12.10.2026");
    expect($("[data-protocol-back]")!.getAttribute("href")).toBe("/konto");
  });

  test("opened by the mail's login (#sisse&id=42): the mark leaves the address, the id stays and is read", async () => {
    fetchMock.mockResolvedValue(json(200, ANSWER));
    await page("et", "#sisse&id=42");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/konto/protokoll?id=42");
    expect(window.location.hash).toBe("#id=42"); // useAccount's takeLoginMark (Task 3): the mark taken, the rest kept
  });

  test("not hers, or none sent: 'Seda protokolli ei leitud.' with the way back; an address without an id asks nothing", async () => {
    fetchMock.mockResolvedValue(json(404, { ok: false }));
    await page("et", "#id=42");
    expect($("[data-account-state='noProtocol']")!.textContent).toContain("Seda protokolli ei leitud.");
    fetchMock.mockReset();
    await page("et", "");
    expect(fetchMock).not.toHaveBeenCalled();
    expect($("[data-account-state='noProtocol']")).not.toBeNull();
  });

  test("in Russian: the frame and the course in Russian, Maria's text as she wrote it", async () => {
    fetchMock.mockResolvedValue(json(200, ANSWER));
    await page("ru", "#id=42");
    expect($("h1")!.textContent).toBe("Ламинирование бровей");
    for (const text of ["Практическая часть", "Общие замечания", "Отправлен 12.10.2026", "Kulmud said ühtlased", "Ettevalmistus"]) expect(container.textContent).toContain(text);
    expect($("[data-protocol-back]")!.getAttribute("href")).toBe("/ru/konto");
  });

  test("an individual course has no session: no date line, the rest as usual", async () => {
    fetchMock.mockResolvedValue(json(200, { ...ANSWER, session: null }));
    await page("et", "#id=42");
    expect($("h1")!.textContent).toBe("Kulmude lamineerimine");
    expect($("[data-protocol-when]")).toBeNull();
    expect($$("[data-protocol-stage]")).toHaveLength(2);
    expect($("[data-protocol-general]")).not.toBeNull();
  });

  test("Maria's text is text: markup in a heading, a note or the general notes is shown as typed, and the note keeps its line breaks (pre-wrap)", async () => {
    const markup = { title: "<i>Ettevalmistus</i>", note: "<b>x</b> & <script>window.__ran = 1</script>\nteine rida" };
    fetchMock.mockResolvedValue(json(200, { ...ANSWER, stages: [markup], generalNote: "<img src=x onerror=alert(1)>" }));
    await page("et", "#id=42");
    expect($("[data-protocol-stage] h3")!.textContent).toBe(markup.title);
    expect($("[data-protocol-stage] p")!.textContent).toBe(markup.note);
    expect($("[data-protocol-general]")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(container.querySelector("b, i, script, img")).toBeNull();
    expect((window as unknown as { __ran?: number }).__ran).toBeUndefined();
    // the line break is the CSS's to keep: the note's class is pre-wrap
    const css = readFileSync(join(process.cwd(), "src/components/account/ProtocolPage.module.css"), "utf8");
    expect(css).toMatch(/\.note\s*\{[^}]*white-space:\s*pre-wrap/);
  });

  test("opened from the card (Next pushes the address in an insertion effect, after the page's first render): never 'not found' on the way, then the protocol", async () => {
    // What the app router does with a <Link>: the new page renders while the address still has no id, and HistoryUpdater's insertion effect
    // puts #id=42 in at the same commit. The log is what each commit leaves in the DOM (a Profiler reports every commit of its subtree after
    // the DOM is written and before the browser can paint): a commit that shows "noProtocol" is the flash.
    window.history.replaceState(null, "", "/konto/protokoll");
    fetchMock.mockResolvedValue(json(200, ANSWER));
    const log: string[] = [];
    const Updater = () => {
      useInsertionEffect(() => window.history.replaceState(null, "", "/konto/protokoll#id=42"), []);
      return null;
    };
    const onCommit = () => log.push($("[data-account-state]")?.getAttribute("data-account-state") ?? ($("[data-protocol-page]") ? "protocol" : "empty"));
    await act(async () =>
      root.render(createElement(Profiler, { id: "protocol", onRender: onCommit }, createElement(Updater), createElement(ProtocolPage, { locale: "et", t: protocolTexts(getDict("et")) }))),
    );
    await settle();
    expect(log[0]).toBe("empty");
    expect(log).not.toContain("noProtocol");
    expect(log.at(-1)).toBe("protocol");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/konto/protokoll?id=42"]);
  });

  test("another registration's address while the page is open (hashchange): that protocol is loaded; the hook lets go of the event when the page goes", async () => {
    fetchMock.mockResolvedValue(json(200, ANSWER));
    await page("et", "#id=42");
    window.history.replaceState(null, "", "/konto/protokoll#id=43");
    await act(async () => window.dispatchEvent(new Event("hashchange")));
    await settle();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/konto/protokoll?id=42", "/api/konto/protokoll?id=43"]);
    const off = vi.spyOn(window, "removeEventListener");
    await act(async () => root.render(createElement("div")));
    expect(off.mock.calls.map((c) => c[0])).toContain("hashchange");
  });
});

describe("the card's 'Vaata protokolli'", () => {
  const NOW = "2026-10-13T10:00:00.000Z";
  const contact = (registrationId: number, over: Partial<ContactCard> = {}): ContactCard => ({
    kind: "contact",
    registrationId,
    course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine" } },
    session: { startsAt: "2026-10-12T07:00:00.000Z", city: "Pärnu", venue: "", cancelled: false },
    status: "confirmed",
    paymentChoice: "full",
    priceCents: 35000,
    paidCents: 35000,
    createdAt: "2026-09-01T10:00:00.000Z",
    ...over,
  });
  const dashboard = (cards: Dashboard["cards"]): Dashboard => ({
    client: { email: "kati@example.test", name: "Kati", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
    cards,
    favourites: [],
    prepayment: null,
    resume: null,
  });
  const render = async (data: Dashboard, readOnly = false) =>
    act(async () => root.render(createElement(CoursesTab, { locale: "et", t: coursesTexts(getDict("et")), data, readOnly, now: NOW })));

  test("a course that has been, its protocol sent: 'Vaata protokolli' is its one button; none before it is sent", async () => {
    await render(dashboard([contact(7, { protocolSent: true }), contact(8)]));
    const link = $("[data-card='registration-7'] [data-card-protocol]")!;
    expect([link.textContent, link.getAttribute("href")]).toEqual(["Vaata protokolli", "/konto/protokoll#id=7"]);
    expect(link.className).toMatch(/btnOutline/);
    expect($("[data-card='registration-8'] [data-card-protocol]")).toBeNull();
  });

  test("a card with a button of its own gets the link under it; an individual course's card too; read-only it does nothing", async () => {
    const ahead = contact(9, { session: { startsAt: "2026-11-14T08:00:00.000Z", city: "Pärnu", venue: "", cancelled: false }, protocolSent: true });
    const individual: IndividualCard = { kind: "individual", registrationId: 10, course: { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine" } }, status: "confirmed", preferredPeriod: "", createdAt: "2026-09-01T10:00:00.000Z", protocolSent: true };
    await render(dashboard([ahead, individual]));
    expect($("[data-card='registration-9'] [data-card-action]")!.textContent).toBe("Tühista või muuda aega");
    expect($("[data-card='registration-9'] [data-card-protocol]")!.className).not.toMatch(/btnOutline/);
    expect($("[data-card='registration-10'] [data-card-protocol]")!.getAttribute("href")).toBe("/konto/protokoll#id=10");
    await render(dashboard([contact(7, { protocolSent: true })]), true);
    expect($("[data-card-protocol]")!.getAttribute("aria-disabled")).toBe("true");
    expect($("[data-card-protocol]")!.getAttribute("href")).toBeNull();
  });
});
