// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EcoursePage } from "@/components/account/EcoursePage";
import { EcourseView as CourseView } from "@/components/account/EcourseView";
import { ecourseTexts } from "@/components/account/texts";
import { formatDate } from "@/i18n/format";
import { getDict, type Locale } from "@/i18n/locales";
import type { EcourseView } from "@/server/client-data";

// The e-course page in a browser-like document (happy-dom), with fetch answered here: no access, the terms notice, accepting
// (and what is sent), a 409 when the admin saved new terms meanwhile, the other failures, and the course view itself (phase 3a
// Task 9: the progress line and bar, the one button "Jätka" / "Alusta", the lessons with their states, the lock sentence, the
// modules folded on a phone, and the admin's read-only view).

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const EXPIRES = "2027-03-22T08:00:00.000Z";
const V1 = "2026-10-01T09:00:00.000Z";
const V2 = "2026-10-03T09:30:00.000Z";
/** Two modules: "Sissejuhatus" with lesson 11 (done) and 12 (current), "Praktika" with 21 and 22 (locked); 1 of 4 done, "Jätka" to 12. */
const MODULES: EcourseView["course"]["modules"] = [
  {
    id: 1,
    title: { et: "Sissejuhatus", ru: "Введение" },
    lessons: [
      { id: 11, moduleId: 1, title: { et: "Tere tulemast", ru: "Добро пожаловать" }, state: "done" },
      { id: 12, moduleId: 1, title: { et: "Tööriistad", ru: "Инструменты" }, state: "current" },
    ],
  },
  {
    id: 2,
    title: { et: "Praktika" },
    lessons: [
      { id: 21, moduleId: 2, title: { et: "Esimene harjutus" }, state: "locked" },
      { id: 22, moduleId: 2, title: { et: "Teine harjutus" }, state: "locked" },
    ],
  },
];
const PROGRESS: EcourseView["progress"] = { done: 1, total: 4, next: 12 };

/** A course without a test or points, nothing completed: the "Lõpetamine" block (e-course completion) shows the lessons and the end only, with no link. */
const COMPLETION: EcourseView["completion"] = { lessons: { done: 1, total: 4, state: "open" }, test: null, practical: null, completedAt: null, protocolSent: false, certificate: null, certificateName: "" };

const view = (
  over: {
    accepted?: boolean;
    version?: string;
    text?: EcourseView["terms"]["text"];
    modules?: EcourseView["course"]["modules"];
    progress?: EcourseView["progress"];
    completion?: EcourseView["completion"];
  } = {},
): EcourseView => ({
  course: { slug: "veebikursus", title: { et: "Veebikursus", ru: "Онлайн-курс" }, modules: over.modules ?? MODULES },
  access: { expiresAt: EXPIRES },
  terms: { version: over.version ?? V1, accepted: over.accepted ?? false, text: over.accepted ? null : "text" in over ? (over.text ?? null) : { et: "Esimene lõik.\n\nTeine lõik.", ru: "Первый абзац." } },
  progress: over.progress ?? PROGRESS,
  completion: over.completion ?? COMPLETION,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const $ = (selector: string) => document.querySelector(selector);
const $$ = (selector: string) => [...document.querySelectorAll(selector)];

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const mount = async (locale: Locale = "et") => {
  await act(async () => root.render(createElement(EcoursePage, { slug: "veebikursus", locale, t: ecourseTexts(getDict(locale)) })));
  await settle();
};
const tick = (box = $("input[name='terms']")) => click(box);
const moduleTitles = () => $$("[data-module] [data-module-title]").map((e) => e.textContent);
const button = () => $("[data-terms-gate] button[type='submit']") as HTMLButtonElement;
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

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

describe("the static shell", () => {
  test("renders the skeleton only: no personal text, no notice, no course", () => {
    const html = renderToStaticMarkup(createElement(EcoursePage, { slug: "veebikursus", locale: "et", t: ecourseTexts(getDict("et")) }));
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/Enne alustamist|Ligipääs|ligipääsu|data-terms|data-ecourse/);
  });
});

describe("without access (the API's 404)", () => {
  test("says so in one sentence with one button to the public course page and a link to her account (an ended access's card has its certificate there), and is not the error state", async () => {
    fetchMock.mockResolvedValue(json(404, { ok: false }));
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/konto/kursus/veebikursus");
    const state = $("[data-account-state='noAccess']")!;
    expect(state.querySelector("h1")?.textContent).toBe("Sul ei ole sellele koolitusele ligipääsu.");
    const ways = [...state.querySelectorAll("a, button")];
    expect(ways.map((e) => [e.textContent, e.getAttribute("href")])).toEqual([
      ["Vaata koolitust", "/koolitused/veebikursus"],
      ["Minu konto", "/konto"],
    ]);
    expect(ways.map((e) => /btn/.test(e.className))).toEqual([true, false]); // the account is a text link: the page keeps one button
    expect(state.querySelector("a")?.getAttribute("href")).toBe("/koolitused/veebikursus");
    expect($("[data-account-state='error']")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Proovi uuesti|Ei õnnestunud/);
  });

  test("Russian: the same, linking to /ru/koolitused/<slug> and /ru/konto", async () => {
    fetchMock.mockResolvedValue(json(404, { ok: false }));
    await mount("ru");
    const state = $("[data-account-state='noAccess']")!;
    expect(state.querySelector("h1")?.textContent).toBe("У\u00a0вас нет доступа к\u00a0этому курсу.");
    expect(state.querySelector("a")?.textContent).toBe("Посмотреть курс");
    expect(state.querySelector("a")?.getAttribute("href")).toBe("/ru/koolitused/veebikursus");
    const account = state.querySelectorAll("a")[1];
    expect([account?.textContent, account?.getAttribute("href")]).toEqual(["Мой кабинет", "/ru/konto"]);
  });

  test("a 404 that is not the API's own answer (the platform's HTML page) is the error with its retry button, never the no-access sentence", async () => {
    fetchMock.mockResolvedValue(new Response("<html>404 This page could not be found</html>", { status: 404, headers: { "content-type": "text/html" } }));
    await mount();
    expect($("[data-account-state='error']")).not.toBeNull();
    expect($("[data-account-state='noAccess']")).toBeNull();
    expect(document.body.textContent).not.toContain("ligipääsu");
  });

  test("a server error is still the error with its retry button, never the no-access sentence", async () => {
    fetchMock.mockResolvedValue(json(500, { ok: false }));
    await mount();
    expect($("[data-account-state='error']")).not.toBeNull();
    expect($("[data-account-state='noAccess']")).toBeNull();
    expect(document.body.textContent).toContain("Ei õnnestunud laadida.");
  });
});

describe("the terms notice", () => {
  test("title, the text as paragraphs, one checkbox and one button that stays off until the box is ticked", async () => {
    fetchMock.mockResolvedValue(json(200, view()));
    await mount();
    const gate = $("[data-terms-gate]")!;
    expect(gate.querySelector("h1")?.textContent).toBe("Enne alustamist");
    expect($$("[data-terms-text] [data-legal-body] p").map((p) => p.textContent)).toEqual(["Esimene lõik.", "Teine lõik."]);
    expect(gate.querySelectorAll("input[type='checkbox']")).toHaveLength(1);
    expect(gate.querySelector("label")?.textContent).toBe("Olen tutvunud ja nõustun tingimustega");
    expect(gate.querySelectorAll("button, a")).toHaveLength(1);
    expect(button().textContent).toBe("Alusta koolitust");
    expect(button().disabled).toBe(true);
    expect($("[data-ecourse]")).toBeNull();
    await tick();
    expect(button().disabled).toBe(false);
    await tick();
    expect(button().disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing was sent
  });

  test("Russian shows the Russian text; a missing Russian text shows the Estonian one", async () => {
    fetchMock.mockResolvedValue(json(200, view()));
    await mount("ru");
    expect($("[data-terms-gate] h1")?.textContent).toBe("Перед началом");
    expect($$("[data-legal-body] p").map((p) => p.textContent)).toEqual(["Первый абзац."]);
    expect(button().textContent).toBe("Начать обучение");
    await act(async () => root.unmount());
    root = createRoot(container);
    fetchMock.mockResolvedValue(json(200, view({ text: { et: "Ainult eesti." } })));
    await mount("ru");
    expect($$("[data-legal-body] p").map((p) => p.textContent)).toEqual(["Ainult eesti."]);
  });

  test("no terms text stored: the server says nothing is left to accept, so the course opens at once: no notice, nothing sent", async () => {
    fetchMock.mockResolvedValue(json(200, view({ accepted: true })));
    await mount();
    expect($("[data-terms-gate]")).toBeNull();
    expect($("[data-ecourse]")).not.toBeNull();
    expect(posts()).toHaveLength(0);
  });

  test("a notice that is somehow sent without its text still shows its title, box and button", async () => {
    fetchMock.mockResolvedValue(json(200, view({ text: null })));
    await mount();
    expect($("[data-terms-text]")).toBeNull();
    expect($("[data-terms-gate] h1")?.textContent).toBe("Enne alustamist");
    expect(button().disabled).toBe(true);
  });

  test("an accepted version goes straight to the course: no notice, nothing sent", async () => {
    fetchMock.mockResolvedValue(json(200, view({ accepted: true })));
    await mount();
    expect($("[data-terms-gate]")).toBeNull();
    expect($("[data-ecourse]")).not.toBeNull();
    expect(posts()).toHaveLength(0);
    expect(document.activeElement).toBe(document.body); // nothing steals the focus on a plain visit
  });
});

describe("accepting", () => {
  test("sends { slug, version } of the shown text, then shows the course with the focus on its title; nothing is loaded again", async () => {
    fetchMock.mockImplementation(async (_input, init) => (init?.method === "POST" ? json(200, { ok: true }) : json(200, view())));
    await mount();
    await tick();
    await click(button());
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe("/api/konto/tingimused");
    expect(posts()[0][1]).toMatchObject({ method: "POST", credentials: "same-origin", body: JSON.stringify({ slug: "veebikursus", version: V1 }) });
    expect(fetchMock).toHaveBeenCalledTimes(2); // the page and the acceptance

    expect($("[data-terms-gate]")).toBeNull();
    const h1 = $("[data-ecourse] h1")!;
    expect(h1.textContent).toBe("Veebikursus");
    expect(document.activeElement).toBe(h1);
    expect($("[data-ecourse-access]")?.textContent).toBe(`Ligipääs kuni ${formatDate(new Date(EXPIRES), "et")}`);
    expect($("[data-ecourse-access]")?.textContent).toBe("Ligipääs kuni 22.03.2027");
    expect(moduleTitles()).toEqual(["Sissejuhatus", "Praktika"]);
    expect($("[data-ecourse-progress]")?.textContent).toBe("1 / 4 õppetundi tehtud");
  });

  test("two quick presses send one request", async () => {
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementation((_input, init) => (init?.method === "POST" ? new Promise<Response>((resolve) => (answer = resolve)) : Promise.resolve(json(200, view()))));
    await mount();
    await tick();
    await act(async () => {
      button().click();
      button().click();
    });
    expect(posts()).toHaveLength(1);
    expect(button().getAttribute("aria-disabled")).toBe("true"); // sending
    await act(async () => answer(json(200, { ok: true })));
    await settle();
    expect($("[data-ecourse]")).not.toBeNull();
  });

  test("a 409 (new terms were saved meanwhile): the page is loaded again quietly, the new text shows with the box cleared and no message", async () => {
    let loads = 0;
    let answerReload: (r: Response) => void = () => {};
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method === "POST") return Promise.resolve(json(409, { ok: false, error: "version" }));
      loads++;
      if (loads === 1) return Promise.resolve(json(200, view()));
      return new Promise<Response>((resolve) => (answerReload = resolve));
    });
    await mount();
    await tick();
    await click(button());
    expect(posts()[0][1]).toMatchObject({ body: JSON.stringify({ slug: "veebikursus", version: V1 }) });
    // while the new answer is on its way the notice stays (no skeleton), still sending, no message; the box is cleared by the new notice
    expect($("[data-account-state='loading']")).toBeNull();
    expect($("[data-terms-gate]")).not.toBeNull();
    expect(($("input[name='terms']") as HTMLInputElement).checked).toBe(true);
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect($("[data-terms-failed]")?.textContent).toBe("");
    await act(async () => answerReload(json(200, view({ version: V2, text: { et: "Uus tekst." } }))));
    await settle();

    expect(loads).toBe(2);
    expect($("[data-terms-gate]")?.getAttribute("data-terms-version")).toBe(V2);
    expect($$("[data-legal-body] p").map((p) => p.textContent)).toEqual(["Uus tekst."]);
    expect(($("input[name='terms']") as HTMLInputElement).checked).toBe(false);
    expect(button().disabled).toBe(true);
    expect($("[data-terms-failed]")?.textContent).toBe("");
    expect(document.body.textContent).not.toMatch(/Ei õnnestunud|Proovi uuesti/);
    expect(document.activeElement).toBe($("[data-terms-gate] h1")); // a screen reader hears that the text changed

    // accepting the new text sends the new version
    fetchMock.mockImplementation(async (_input, init) => (init?.method === "POST" ? json(200, { ok: true }) : json(200, view({ version: V2 }))));
    await tick();
    await click(button());
    expect(posts()[1][1]).toMatchObject({ body: JSON.stringify({ slug: "veebikursus", version: V2 }) });
    expect($("[data-ecourse]")).not.toBeNull();
  });

  test.each([
    ["a server error", () => Promise.resolve(json(500, { ok: false }))],
    ["no answer", () => Promise.reject(new TypeError("network"))],
    ["a platform 404 page", () => Promise.resolve(new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } }))],
    ["an empty answer", () => Promise.resolve(json(200, null))],
  ])("a 409 whose reload fails (%s): the plain sentence, the box still ticked, pressing again asks again", async (_name, failure) => {
    let loads = 0;
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method === "POST") return Promise.resolve(json(409, { ok: false, error: "version" }));
      return ++loads === 1 ? Promise.resolve(json(200, view())) : failure();
    });
    await mount();
    await tick();
    await click(button());
    expect(loads).toBe(2);
    expect($("[data-terms-failed]")?.textContent).toBe("Ei õnnestunud salvestada. Proovi uuesti.");
    expect(($("input[name='terms']") as HTMLInputElement).checked).toBe(true); // not cleared silently
    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-disabled")).toBeNull();
    expect($("[data-terms-gate]")?.getAttribute("data-terms-version")).toBe(V1);
    // the focus is not taken to the title of a notice that never came
    expect(document.activeElement).not.toBe($("[data-terms-gate] h1"));

    // pressed again once the server answers: the new notice, the box empty, no sentence
    fetchMock.mockImplementation((_input, init) => Promise.resolve(init?.method === "POST" ? json(409, { ok: false, error: "version" }) : json(200, view({ version: V2, text: { et: "Uus tekst." } }))));
    await click(button());
    expect($("[data-terms-gate]")?.getAttribute("data-terms-version")).toBe(V2);
    expect(($("input[name='terms']") as HTMLInputElement).checked).toBe(false);
    expect($("[data-terms-failed]")?.textContent).toBe("");
  });

  test.each([
    ["a platform's 404 page", () => new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } })],
    ["a proxy's 409 page", () => new Response("<html>conflict</html>", { status: 409, headers: { "content-type": "text/html" } })],
    ["a sign-in page's 401", () => new Response("<html>sign in</html>", { status: 401, headers: { "content-type": "text/html" } })],
    ["JSON that is not the API's 404", () => json(404, { message: "not found" })],
  ])("%s on accepting is a failure, not a changed version: the sentence, the box ticked, no page load", async (_name, answer) => {
    fetchMock.mockImplementation(async (_input, init) => (init?.method === "POST" ? answer() : json(200, view())));
    await mount();
    await tick();
    await click(button());
    expect(fetchMock).toHaveBeenCalledTimes(2); // the page and the acceptance: nothing loaded again
    expect($("[data-terms-failed]")?.textContent).toBe("Ei õnnestunud salvestada. Proovi uuesti.");
    expect(($("input[name='terms']") as HTMLInputElement).checked).toBe(true);
    expect(button().disabled).toBe(false);
  });

  test("a 409 whose reload finds the new version already accepted goes to the course", async () => {
    let loads = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === "POST") return json(409, { ok: false, error: "version" });
      return json(200, ++loads === 1 ? view() : view({ version: V2, accepted: true }));
    });
    await mount();
    await tick();
    await click(button());
    expect($("[data-terms-gate]")).toBeNull();
    expect($("[data-ecourse]")).not.toBeNull();
  });

  test("access that ended meanwhile (404 on accepting): the page says there is no access", async () => {
    let loads = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === "POST") return json(404, { ok: false, error: "slug" });
      return ++loads === 1 ? json(200, view()) : json(404, { ok: false });
    });
    await mount();
    await tick();
    await click(button());
    expect($("[data-account-state='noAccess']")).not.toBeNull();
    expect($("[data-terms-gate]")).toBeNull();
  });

  test("signed out or replaced while reading (401 on accepting): the page is loaded again and says so", async () => {
    vi.spyOn(window.location, "replace").mockImplementation(() => {});
    let loads = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === "POST") return json(401, { ok: false, reason: "replaced" });
      return ++loads === 1 ? json(200, view()) : json(401, { ok: false, reason: "replaced" });
    });
    await mount();
    await tick();
    await click(button());
    expect($("[data-account-state='replaced']")).not.toBeNull();
  });

  test.each([
    ["a server error", () => Promise.resolve(json(500, { ok: false }))],
    ["no answer", () => Promise.reject(new TypeError("network"))],
    ["a refused request", () => Promise.resolve(json(403, { ok: false }))],
    ["a 200 that is not ok", () => Promise.resolve(json(200, { ok: false }))],
  ])("%s: one plain sentence, the box stays ticked, and pressing again works", async (_name, failure) => {
    fetchMock.mockImplementation((_input, init) => (init?.method === "POST" ? failure() : Promise.resolve(json(200, view()))));
    await mount();
    await tick();
    await click(button());
    expect($("[data-terms-failed]")?.textContent).toBe("Ei õnnestunud salvestada. Proovi uuesti.");
    expect(($("input[name='terms']") as HTMLInputElement).checked).toBe(true);
    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-disabled")).toBeNull();
    expect($("[data-terms-gate]")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // no reload for a plain failure

    fetchMock.mockImplementation(async (_input, init) => (init?.method === "POST" ? json(200, { ok: true }) : json(200, view())));
    await click(button());
    expect($("[data-ecourse]")).not.toBeNull();
  });

  test("the failure sentence in Russian", async () => {
    fetchMock.mockImplementation((_input, init) => (init?.method === "POST" ? Promise.resolve(json(500, {})) : Promise.resolve(json(200, view()))));
    await mount("ru");
    await tick();
    await click(button());
    expect($("[data-terms-failed]")?.textContent).toBe("Не удалось сохранить. Попробуйте ещё раз.");
  });
});

describe("the course view (phase 3a: progress and lessons)", () => {
  test("the module's round mark is a picture only: its alternative text is empty (after the plain fallback line)", () => {
    const css = readFileSync(join(process.cwd(), "src/components/account/EcourseView.module.css"), "utf8");
    expect(css).toMatch(/content: "\+";\s*content: "\+" \/ "";/);
    expect(css).toMatch(/content: "−";\s*content: "−" \/ "";/);
  });

  /** The page with the terms accepted and this course data. */
  const open = async (over: Parameters<typeof view>[0] = {}, locale: Locale = "et") => {
    fetchMock.mockImplementation(async () => json(200, view({ accepted: true, ...over })));
    await mount(locale);
  };
  /** `window.matchMedia` answering `(min-width: 768px)` with `wide` (a computer or tablet) or not (a phone). */
  const screen = (wide: boolean) =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query === "(min-width: 768px)" ? wide : false, media: query, addEventListener() {}, removeEventListener() {} })),
    );
  const lesson = (id: number) => $(`[data-lesson="${id}"]`);

  test("the progress line, the thin bar and the one button 'Jätka' to the next lesson", async () => {
    await open();
    expect($("[data-ecourse-progress]")?.textContent).toBe("1 / 4 õppetundi tehtud");
    const bar = $("[data-ecourse] [role=progressbar]")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
    // named by the visible line (no second copy of its text for a screen reader)
    const line = $("[data-ecourse-progress]")!;
    expect(line.id).not.toBe("");
    expect(bar.getAttribute("aria-labelledby")).toBe(line.id);
    expect(bar.hasAttribute("aria-label")).toBe(false);
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("25%");
    const next = $("[data-ecourse-next]")!;
    expect(next.tagName).toBe("A");
    expect(next.textContent).toBe("Jätka");
    expect(next.getAttribute("href")).toBe("/konto/kursus/veebikursus/12");
    // one primary action: besides the lesson titles, the button is the page's only link, and there is no other button
    expect($$("[data-ecourse] a").filter((a) => !a.closest("[data-lesson]")).map((a) => a.textContent)).toEqual(["Jätka"]);
    expect($$("[data-ecourse] button")).toHaveLength(0);
    expect($("[data-ecourse-soon]")).toBeNull();
  });

  test("before the first lesson the button says 'Alusta'", async () => {
    await open({
      modules: [{ ...MODULES[0], lessons: [{ ...MODULES[0].lessons[0], state: "current" }] }],
      progress: { done: 0, total: 1, next: 11 },
    });
    expect($("[data-ecourse-progress]")?.textContent).toBe("0 / 1 õppetundi tehtud");
    expect($("[data-ecourse-next]")?.textContent).toBe("Alusta");
    expect($("[data-ecourse-next]")?.getAttribute("href")).toBe("/konto/kursus/veebikursus/11");
  });

  test("each lesson shows its state: done and open lessons are links to their pages, a locked one is not, with its label for screen readers", async () => {
    await open();
    expect(lesson(11)?.getAttribute("data-state")).toBe("done");
    expect(lesson(12)?.getAttribute("data-state")).toBe("current");
    expect(lesson(21)?.getAttribute("data-state")).toBe("locked");
    expect(lesson(22)?.getAttribute("data-state")).toBe("locked");
    expect(lesson(11)?.querySelector("a")?.getAttribute("href")).toBe("/konto/kursus/veebikursus/11");
    expect(lesson(11)?.querySelector("a")?.textContent).toBe("Tere tulemast");
    expect(lesson(12)?.querySelector("a")?.getAttribute("href")).toBe("/konto/kursus/veebikursus/12");
    expect(lesson(21)?.querySelector("a")).toBeNull();
    expect(lesson(21)?.textContent).toContain("Esimene harjutus");
    // the state as a word for a screen reader (the icon is hidden from it)
    expect(lesson(11)?.textContent).toContain("Tehtud");
    expect(lesson(12)?.textContent).toContain("Avatud");
    expect(lesson(21)?.textContent).toContain("Lukustatud");
    for (const id of [11, 12, 21]) expect(lesson(id)?.querySelector("svg")?.getAttribute("aria-hidden"), String(id)).toBe("true");
    // the lessons are in their modules, in order
    expect($$("[data-module='1'] [data-lesson]").map((e) => e.getAttribute("data-lesson"))).toEqual(["11", "12"]);
    expect($$("[data-module='2'] [data-lesson]").map((e) => e.getAttribute("data-lesson"))).toEqual(["21", "22"]);
  });

  test("'Avaneb, kui eelmine õppetund on tehtud.' once, under the first locked lesson", async () => {
    await open();
    const hints = $$("[data-locked-hint]");
    expect(hints).toHaveLength(1);
    expect(hints[0].textContent).toBe("Avaneb, kui eelmine õppetund on tehtud.");
    expect(hints[0].closest("[data-lesson]")?.getAttribute("data-lesson")).toBe("21");
  });

  test("a phone: only the module of the next lesson starts open; a wider screen: every module is open; a module counts its done lessons", async () => {
    const details = (id: number) => $(`[data-module='${id}'] details`) as HTMLDetailsElement;
    screen(false);
    await open();
    expect(details(1).open).toBe(true);
    expect(details(2).open).toBe(false);
    expect(details(1).querySelector("summary")?.textContent).toContain("1/2");
    expect(details(2).querySelector("summary")?.textContent).toContain("0/2");
    // the count as words for a screen reader; the short "1/2" is for the eye only
    const tally = (id: number) => [...details(id).querySelectorAll("summary span")];
    expect(tally(1).find((s) => s.textContent === "1/2")?.getAttribute("aria-hidden")).toBe("true");
    expect(tally(1).map((s) => s.textContent)).toContain("1 / 2 tehtud");
    expect(tally(2).map((s) => s.textContent)).toContain("0 / 2 tehtud");
    await act(async () => root.unmount());
    root = createRoot(container);
    screen(true);
    await mount();
    expect(details(1).open).toBe(true);
    expect(details(2).open).toBe(true);
  });

  test("no lessons yet: the module titles and 'Sisu lisandub peagi.', no progress line and no button", async () => {
    await open({ modules: MODULES.map((m) => ({ ...m, lessons: [] })), progress: { done: 0, total: 0, next: null } });
    expect(moduleTitles()).toEqual(["Sissejuhatus", "Praktika"]);
    expect($("[data-ecourse-soon]")?.textContent).toBe("Sisu lisandub peagi.");
    expect($("[data-ecourse-progress]")).toBeNull();
    expect($("[role=progressbar]")).toBeNull();
    expect($("[data-ecourse-next]")).toBeNull();
    expect($("[data-ecourse] details")).toBeNull();
  });

  test("every lesson done: no button, the line says so", async () => {
    await open({
      modules: MODULES.map((m) => ({ ...m, lessons: m.lessons.map((l) => ({ ...l, state: "done" as const })) })),
      progress: { done: 4, total: 4, next: null },
    });
    expect($("[data-ecourse-progress]")?.textContent).toBe("4 / 4 õppetundi tehtud");
    expect($("[data-ecourse-next]")).toBeNull();
    expect($("[data-locked-hint]")).toBeNull();
  });

  test("read-only (the admin's view as client): nothing is a link; the button and the lesson titles are aria-disabled", async () => {
    await act(async () => root.render(createElement(CourseView, { data: view({ accepted: true }), locale: "et", t: ecourseTexts(getDict("et")), readOnly: true })));
    expect($("[data-ecourse]")).not.toBeNull();
    expect($$("[data-ecourse] a")).toHaveLength(0);
    expect($("[data-ecourse-next]")?.getAttribute("aria-disabled")).toBe("true");
    expect($("[data-ecourse-next]")?.textContent).toBe("Jätka");
    for (const l of MODULES[0].lessons) expect(lesson(l.id)?.querySelector("[aria-disabled='true']")?.textContent, String(l.id)).toBe(l.title.et);
    // every module open, whatever the screen
    expect($$("[data-ecourse] details").every((d) => (d as HTMLDetailsElement).open)).toBe(true);
  });

  test("the server's markup of the read-only view (a server component renders it) has every module open and no link", () => {
    const html = renderToStaticMarkup(createElement(CourseView, { data: view({ accepted: true }), locale: "et", t: ecourseTexts(getDict("et")), readOnly: true }));
    expect(html).not.toContain("<a ");
    expect(html.match(/<details [^>]*open=""/g)).toHaveLength(2);
  });

  test("Russian: the title, the date line, the progress line and 'Продолжить'", async () => {
    await open({}, "ru");
    expect($("[data-ecourse] h1")?.textContent).toBe("Онлайн-курс");
    expect($("[data-ecourse-access]")?.textContent).toBe("Доступ до 22.03.2027");
    expect(moduleTitles()).toEqual(["Введение", "Praktika"]);
    expect($("[data-ecourse-progress]")?.textContent).toBe("Пройдено уроков: 1 / 4");
    expect($("[data-ecourse-next]")?.textContent).toBe("Продолжить");
    expect($("[data-ecourse-next]")?.getAttribute("href")).toBe("/ru/konto/kursus/veebikursus/12");
    expect(lesson(12)?.querySelector("a")?.getAttribute("href")).toBe("/ru/konto/kursus/veebikursus/12");
    expect($("[data-locked-hint]")?.textContent).toBe("Откроется, когда предыдущий урок будет пройден.");
    expect([...document.querySelectorAll("[data-module='1'] summary span")].map((s) => s.textContent)).toContain("Пройдено: 1 / 2");
    await act(async () => root.unmount());
    root = createRoot(container);
    await open({ progress: { ...PROGRESS, done: 0 } }, "ru");
    expect($("[data-ecourse-next]")?.textContent).toBe("Начать");
  });
});
