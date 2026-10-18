// @vitest-environment happy-dom
import { act, createElement, Profiler, useInsertionEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoursesTab } from "@/components/account/CoursesTab";
import { FeedbackForm } from "@/components/account/FeedbackForm";
import { coursesTexts, feedbackTexts } from "@/components/account/texts";
import { checkFeedback } from "@/domain/protocols";
import { getDict, type Locale } from "@/i18n/locales";
import type { Dashboard } from "@/server/client-data";

// The feedback form (spec §7): Maria's ten questions in the paper form's order, nothing required but one answer needed, the free texts with
// their count, the closing line; and the dashboard's card with "Ei soovi".

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
const click = async (el: Element | null) => {
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const COURSE = { slug: "kulmude-lami", title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } };
const form = async (locale: Locale = "et") => {
  window.history.replaceState(null, "", `${locale === "ru" ? "/ru" : ""}/konto/tagasiside#id=42`);
  await act(async () => root.render(createElement(FeedbackForm, { locale, t: feedbackTexts(getDict(locale)) })));
  await settle();
};
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => [url, JSON.parse(String(init?.body))]);

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

describe("the form", () => {
  test("the questions in the paper form's order; one answer at least; the answers as keys; the closing line", async () => {
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(200, { ok: true }) : json(200, { ok: true, course: COURSE, sent: false, shownName: "Kati K." })));
    await form();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/konto/tagasiside?id=42");
    expect($("h1")!.textContent).toBe("Sinu kogemus MS LAB koolitusel");
    expect($$("[data-question]").map((q) => q.getAttribute("data-question"))).toEqual(["score", "expectations", "clarity", "balance", "ready", "trainer", "safe", "materials", "recommend", "message"]);
    expect($$("[data-question='score'] input")).toHaveLength(10);
    await click($("[data-feedback-submit]"));
    expect($("[data-feedback-error]")!.textContent).toBe("Vasta vähemalt ühele küsimusele.");
    expect(posts()).toEqual([]);
    await click($("[data-question='score'] input[value='9']"));
    expect($("[data-feedback-error]")).toBeNull(); // an answer given takes the line away
    await click($("[data-question='expectations'] input[value='met']"));
    await act(async () => {
      const box = $("[data-question='message'] textarea") as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Aitäh!");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect($("[data-question='message']")!.textContent).toContain("6 / 2000");
    await click($("[data-feedback-submit]"));
    expect(posts()).toEqual([["/api/konto/tagasiside", { id: 42, locale: "et", answers: { score: 9, expectations: "met", message: "Aitäh!" }, consent: null }]]);
    expect($("[data-feedback-done='done']")!.textContent).toContain("Aitäh, et oled osa MS LAB koolituskeskuse algusest ja kasvust. Sinu tagasiside aitab meil saada veel paremaks!");
    // the button she pressed is gone: the closing line, a status, has the focus
    expect(document.activeElement).toBe($("[data-feedback-done='done'] [role='status']"));
  });

  test("answered already (on load, or a second tab's submit): it says so; not open: it says so with the way back", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, course: COURSE, sent: true, shownName: "Kati K." }));
    await form();
    expect($("[data-feedback-done='sent']")!.textContent).toContain("Tagasiside on juba saadetud. Aitäh!");
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(409, { ok: false, error: "sent" }) : json(200, { ok: true, course: COURSE, sent: false, shownName: "Kati K." })));
    await act(async () => root.unmount());
    root = createRoot(container);
    await form();
    await click($("[data-question='score'] input[value='7']"));
    await click($("[data-feedback-submit]"));
    expect($("[data-feedback-done='sent']")).not.toBeNull();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json(404, { ok: false }));
    await act(async () => root.unmount());
    root = createRoot(container);
    await form();
    expect($("[data-account-state='feedbackClosed']")!.textContent).toContain("Sellele koolitusele ei saa praegu tagasisidet anda.");
  });

  test("Review Focus 5: Russian: the questions, the options and the closing line in Russian", async () => {
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(200, { ok: true }) : json(200, { ok: true, course: COURSE, sent: false, shownName: "Kati K." })));
    await form("ru");
    expect($("h1")!.textContent).toBe("Ваш опыт обучения в MS LAB");
    expect($("[data-question='ready']")!.textContent).toContain("Скорее да, нужно немного практики");
    await click($("[data-question='safe'] input[value='very']"));
    await click($("[data-feedback-submit]"));
    expect(posts()[0][1]).toEqual({ id: 42, locale: "ru", answers: { safe: "very" }, consent: null });
    expect($("[data-feedback-done='done']")!.textContent).toContain("Спасибо, что вы часть начала и роста учебного центра MS LAB.");
  });

  test("a refused send keeps her answers and says why, then a second try goes through; a closed form (404 on send) says so", async () => {
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(429, { ok: false, error: "rate" }) : json(200, { ok: true, course: COURSE, sent: false, shownName: "Kati K." })));
    await form();
    await click($("[data-question='trainer'] input[value='good']"));
    await click($("[data-feedback-submit]"));
    expect($("[data-feedback-error]")!.textContent).toBe("Liiga palju katseid. Proovi mõne minuti pärast.");
    expect(($("[data-question='trainer'] input[value='good']") as HTMLInputElement).checked).toBe(true);
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(500, { ok: false }) : json(200, { ok: true, course: COURSE, sent: false, shownName: "Kati K." })));
    await click($("[data-feedback-submit]"));
    expect($("[data-feedback-error]")!.textContent).toBe("Midagi läks valesti. Proovi uuesti.");
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(404, { ok: false, error: "registration" }) : json(200, { ok: true, course: COURSE, sent: false, shownName: "Kati K." })));
    await click($("[data-feedback-submit]"));
    expect($("[data-feedback-done='closed']")!.textContent).toContain("Sellele koolitusele ei saa praegu tagasisidet anda.");
    expect($("[data-feedback-form]")).toBeNull();
  });

  test("pasted control characters (a NUL) are left out of what is sent and Word's line and page breaks become line breaks, as the server's check wants: the words go through, never a 'failed' line for good", async () => {
    // the route's own check (domain/protocols.ts checkFeedback): a free text Postgres cannot store is refused
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === "POST" ? (checkFeedback(JSON.parse(String(init.body)).answers).ok ? json(200, { ok: true }) : json(400, { ok: false, error: "answers" })) : json(200, { ok: true, course: COURSE, sent: false, shownName: "Kati K." }),
    );
    await form();
    const type = async (key: string, text: string) =>
      act(async () => {
        const box = $(`[data-question='${key}'] textarea`) as HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const VT = String.fromCharCode(0x0b);
    const FF = String.fromCharCode(0x0c);
    const NUL = String.fromCharCode(0);
    await type("message", `Väga${VT}hea koolitus${NUL}, aitäh${FF}Mari`);
    await type("recommend", `${VT}${NUL}${FF}`); // nothing but control characters and line breaks: not an answer
    await click($("[data-feedback-submit]"));
    expect(posts()).toEqual([["/api/konto/tagasiside", { id: 42, locale: "et", answers: { message: "Väga\nhea koolitus, aitäh\nMari" }, consent: null }]]);
    expect($("[data-feedback-error]")).toBeNull();
    expect($("[data-feedback-done='done']")).not.toBeNull();
  });

  test("a choice changed before sending: the last one is sent, and nothing else", async () => {
    fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(200, { ok: true }) : json(200, { ok: true, course: COURSE, sent: false, shownName: "Kati K." })));
    await form();
    await click($("[data-question='score'] input[value='9']"));
    await click($("[data-question='score'] input[value='7']"));
    expect(($("[data-question='score'] input[value='9']") as HTMLInputElement).checked).toBe(false);
    expect(($("[data-question='score'] input[value='7']") as HTMLInputElement).checked).toBe(true);
    await click($("[data-feedback-submit]"));
    expect(posts()).toEqual([["/api/konto/tagasiside", { id: 42, locale: "et", answers: { score: 7 }, consent: null }]]);
  });

  test("an address without an id asks nothing and says the form is not open", async () => {
    window.history.replaceState(null, "", "/konto/tagasiside");
    await act(async () => root.render(createElement(FeedbackForm, { locale: "et", t: feedbackTexts(getDict("et")) })));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect($("[data-account-state='feedbackClosed']")!.textContent).toContain("Sellele koolitusele ei saa praegu tagasisidet anda.");
  });

  test("opened from the card (Next pushes the address in an insertion effect, after the page's first render): never 'closed' on the way, then the form", async () => {
    // What the app router does with a <Link>: the new page renders while the address still has no id, and HistoryUpdater's insertion effect
    // puts #id=42 in at the same commit. The log is what each commit leaves in the DOM (a Profiler reports every commit of its subtree after
    // the DOM is written and before the browser can paint): a commit that shows "feedbackClosed" is the flash.
    window.history.replaceState(null, "", "/konto/tagasiside");
    fetchMock.mockResolvedValue(json(200, { ok: true, course: COURSE, sent: false, shownName: "Kati K." }));
    const log: string[] = [];
    const Updater = () => {
      useInsertionEffect(() => window.history.replaceState(null, "", "/konto/tagasiside#id=42"), []);
      return null;
    };
    const onCommit = () => log.push($("[data-account-state]")?.getAttribute("data-account-state") ?? ($("[data-feedback-form]") ? "form" : "empty"));
    await act(async () =>
      root.render(createElement(Profiler, { id: "feedback", onRender: onCommit }, createElement(Updater), createElement(FeedbackForm, { locale: "et", t: feedbackTexts(getDict("et")) }))),
    );
    await settle();
    expect(log[0]).toBe("empty");
    expect(log).not.toContain("feedbackClosed");
    expect(log.at(-1)).toBe("form");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/konto/tagasiside?id=42"]);
  });
});

describe("the dashboard's card", () => {
  const dashboard = (over: Partial<Dashboard> = {}): Dashboard => ({
    client: { email: "kati@example.test", name: "Kati", phone: "", locale: "et", newsletter: false, passwordSetAt: null },
    cards: [
      {
        kind: "contact",
        registrationId: 7,
        course: COURSE,
        session: { startsAt: "2026-10-12T07:00:00.000Z", city: "Pärnu", venue: "", cancelled: false },
        status: "confirmed",
        paymentChoice: "full",
        priceCents: 35000,
        paidCents: 35000,
        createdAt: "2026-09-01T10:00:00.000Z",
      },
    ],
    favourites: [],
    prepayment: null,
    resume: null,
    feedback: [{ target: { registrationId: 7 }, course: COURSE }],
    ...over,
  });
  const render = async (data: Dashboard, readOnly = false) =>
    act(async () => root.render(createElement(CoursesTab, { locale: "et", t: coursesTexts(getDict("et")), data, readOnly, now: "2026-10-13T10:00:00.000Z" })));

  test("'Kuidas koolitus läks?' with 'Jäta tagasiside' to the form; 'Ei soovi' takes it away for good; a failure says so", async () => {
    await render(dashboard());
    const card = $("[data-feedback-card='registration-7']")!;
    expect(card.textContent).toContain("Kuidas koolitus läks?");
    expect($("[data-feedback-open]")!.getAttribute("href")).toBe("/konto/tagasiside#id=7");
    fetchMock.mockResolvedValueOnce(json(500, { ok: false }));
    await click($("[data-feedback-dismiss]"));
    expect($("[data-feedback-card='registration-7'] [role='alert']")!.textContent).toBe("Ei õnnestunud. Proovi uuesti.");
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await click($("[data-feedback-dismiss]"));
    expect(posts().at(-1)).toEqual(["/api/konto/tagasiside/peida", { id: 7 }]);
    expect($("[data-feedback-card='registration-7']")).toBeNull();
    // the card took its focused button with it: the page's heading has the focus now, not the page's top
    expect(document.activeElement).toBe($("h1"));
  });

  test("two prompts, one of them dismissed: only the other is left, and the focus is on the heading", async () => {
    const OTHER = { slug: "varvimine", title: { et: "Värvimine", ru: "Окрашивание" } };
    await render(dashboard({ feedback: [{ target: { registrationId: 7 }, course: COURSE }, { target: { registrationId: 8 }, course: OTHER }] }));
    expect($$("[data-feedback-card]").map((c) => c.getAttribute("data-feedback-card"))).toEqual(["registration-7", "registration-8"]);
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await click($("[data-feedback-card='registration-7'] [data-feedback-dismiss]"));
    expect(posts()).toEqual([["/api/konto/tagasiside/peida", { id: 7 }]]);
    expect($$("[data-feedback-card]").map((c) => c.getAttribute("data-feedback-card"))).toEqual(["registration-8"]);
    expect($("[data-feedback-card='registration-8']")!.textContent).toContain("Värvimine");
    expect(document.activeElement).toBe($("h1"));
  });

  test("none: no card; read-only (the admin's view): the buttons do nothing", async () => {
    await render(dashboard({ feedback: undefined }));
    expect($("[data-feedback-card]")).toBeNull();
    await render(dashboard(), true);
    expect($("[data-feedback-open]")!.getAttribute("aria-disabled")).toBe("true");
    await click($("[data-feedback-dismiss]"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
