// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { draftKey, TestPage } from "@/components/account/TestPage";
import { testTexts } from "@/components/account/texts";
import { getDict, type Locale } from "@/i18n/locales";

// The student's test /konto/kursus/<slug>/test (e-course completion, spec §4.2): every question on one page, numbered; radios for one right
// option, checkboxes and "Vali kõik õiged" for more; "Esita test" asks first with the try's number; a fail shows the score and the numbers of
// the wrong questions, never the right options; her answers wait in the browser until an attempt is accepted; the states after an attempt.

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
const type = (selector: string, text: string) =>
  act(async () => {
    const box = $(selector) as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
const checked = (selector: string) => ($(selector) as HTMLInputElement).checked;
const stateOf = () => $("[data-test-page]")!.getAttribute("data-test-state");

const SLUG = "kulmude-lami";
const API = `/api/konto/kursus/${SLUG}/test`;
const COURSE = { slug: SLUG, title: { et: "Kulmude lamineerimine", ru: "Ламинирование бровей" } };
const Q1 = { id: "q1choice", kind: "choice", text: "Mis värvi kasutad heledatel kulmudel?", options: [{ id: "o1right0", text: "Helepruun" }, { id: "o1wrong0", text: "Must" }], multiple: false };
const Q2 = {
  id: "q2multi0",
  kind: "choice",
  text: "Mis kuulub ettevalmistusse?",
  options: [{ id: "o2a00000", text: "Puhastus" }, { id: "o2b00000", text: "Kaitsekreem" }, { id: "o2c00000", text: "Kohv" }],
  multiple: true,
};
const Q3 = { id: "q3open00", kind: "open", text: "Kirjelda, kuidas valmistad kulmud ette." };
const Q4 = { id: "q4open00", kind: "open", text: "Mida teeksid järgmisel korral teisiti?" };
const ANSWERS = { q1choice: ["o1wrong0"], q2multi0: ["o2a00000", "o2b00000"], q3open00: "Puhastan, siis värvin." };
/** GET's answer: the test before any attempt, three tries, a course with points; `over` changes it. */
const view = (over: Record<string, unknown> = {}) => ({
  ok: true,
  course: COURSE,
  state: { kind: "none", triesLeft: 3 },
  passPercent: 80,
  tries: 3,
  triesLeft: 3,
  questions: [Q1, Q2, Q3],
  last: null,
  locked: false,
  readOnly: false,
  hasPoints: true,
  ...over,
});
/** Her newest attempt: the first, failed at 50 % with question 1 wrong. */
const attempt = (over: Record<string, unknown> = {}) => ({
  id: 41,
  number: 1,
  status: "failed",
  percent: 50,
  wrong: [1],
  questions: [Q1, Q2, Q3],
  answers: ANSWERS,
  review: null,
  submittedAt: "2026-10-13T10:00:00.000Z",
  ...over,
});
const FAILED = view({ state: { kind: "open", triesLeft: 2 }, triesLeft: 2, last: attempt() });
/** GET answers `get`; a POST answers [status, body]. */
const serve = (get: unknown, post: [number, unknown] = [200, FAILED]) =>
  fetchMock.mockImplementation(async (_url, init) => (init?.method === "POST" ? json(post[0], post[1]) : json(200, get)));
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => [url, JSON.parse(String(init?.body))]);
const draft = () => JSON.parse(window.localStorage.getItem(draftKey(SLUG)) ?? "null") as { answers: Record<string, unknown>; at: string } | null;
const render = async (locale: Locale = "et") => {
  await act(async () => root.render(createElement(TestPage, { slug: SLUG, locale, t: testTexts(getDict(locale)) })));
  await settle();
};
const again = async (locale: Locale = "et") => {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(locale);
};
/** ANSWERS, given on the page. */
const answerAll = async () => {
  await click($("[data-answer-option='o1wrong0']"));
  await click($("[data-answer-option='o2a00000']"));
  await click($("[data-answer-option='o2b00000']"));
  await type("[data-question='q3open00'] textarea", "Puhastan, siis värvin.");
};
const sendIt = async () => {
  await click($("[data-test-submit]"));
  await click($("[data-test-confirm] [data-confirm='yes']"));
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("a new attempt", () => {
  test("every question numbered, radios for one right option, checkboxes and 'Vali kõik õiged' for more; nothing is sent until all are answered and she confirms", async () => {
    serve(view());
    await render();
    expect(fetchMock.mock.calls[0][0]).toBe(API);
    expect(stateOf()).toBe("none");
    expect($("h1")!.textContent).toBe("Kulmude lamineerimine");
    expect($$("[data-question]").map((q) => q.getAttribute("data-question"))).toEqual(["q1choice", "q2multi0", "q3open00"]);
    expect($("[data-question='q1choice'] legend")!.textContent).toBe("1. Mis värvi kasutad heledatel kulmudel?");
    expect($("[data-question='q3open00'] label")!.textContent).toBe("3. Kirjelda, kuidas valmistad kulmud ette.");
    expect($$("[data-question='q1choice'] input").map((i) => i.getAttribute("type"))).toEqual(["radio", "radio"]);
    expect($$("[data-question='q2multi0'] input").map((i) => i.getAttribute("type"))).toEqual(["checkbox", "checkbox", "checkbox"]);
    expect($("[data-question='q2multi0']")!.textContent).toContain("Vali kõik õiged");
    expect($("[data-question='q1choice']")!.textContent).not.toContain("Vali kõik õiged");
    expect(container.textContent).toContain("Katse 1/3");
    expect(container.textContent).toContain("Vasta kõigile küsimustele ja vajuta „Esita test“.");

    await click($("[data-test-submit]"));
    expect($("[data-test-error]")!.textContent).toBe("Vasta kõigile küsimustele.");
    expect($("[data-test-confirm]")).toBeNull();
    await answerAll();
    expect($("[data-test-error]")).toBeNull(); // an answer given takes the line away
    expect($("[data-question='q3open00']")!.textContent).toContain("22 / 2000");
    await click($("[data-test-submit]"));
    expect($("[data-test-confirm]")!.textContent).toContain("Kas esitad testi? Katse 1/3.");
    expect($("[data-test-submit]")).toBeNull(); // one button at a time: the confirmation's
    expect(posts()).toEqual([]);
    await click($("[data-test-confirm] [data-confirm='no']"));
    expect($("[data-test-confirm]")).toBeNull();
    await sendIt();
    expect(posts()).toEqual([[API, { answers: ANSWERS }]]);
  });

  test("a fail: the score, the pass mark and the numbers of the wrong questions, never the right options; the draft goes; 'Proovi uuesti' opens a fresh form", async () => {
    serve(view());
    await render();
    await answerAll();
    expect(draft()!.answers).toEqual(ANSWERS);
    await sendIt();
    expect(stateOf()).toBe("open");
    const result = $("[data-test-result]")!;
    expect(result.textContent).toBe("Said 50 %, vaja 80 %. Valesti vastatud: 1.");
    expect(result.getAttribute("data-test-wrong")).toBe("1");
    expect(document.activeElement).toBe(result); // the button she pressed is gone
    expect($("[data-question]")).toBeNull();
    expect(draft()).toBeNull();
    expect($("[data-test-retry]")!.textContent).toBe("Proovi uuesti (2 katset jäänud)");
    expect($("[data-test-back]")!.getAttribute("href")).toBe("/konto/kursus/kulmude-lami");
    await click($("[data-test-retry]"));
    expect(container.textContent).toContain("Katse 2/3");
    expect(checked("[data-answer-option='o1wrong0']")).toBe(false);
    expect(($("[data-question='q3open00'] textarea") as HTMLTextAreaElement).value).toBe("");
  });

  test("one try left says so in the singular", async () => {
    serve(view({ state: { kind: "open", triesLeft: 1 }, triesLeft: 1, last: attempt({ number: 2 }) }));
    await render();
    expect($("[data-test-retry]")!.textContent).toBe("Proovi uuesti (1 katse jäänud)");
    await click($("[data-test-retry]"));
    expect(container.textContent).toContain("Katse 3/3");
  });

  test("her answers wait in the browser: a reload of the page puts them back", async () => {
    serve(view());
    await render();
    await answerAll();
    expect(draft()!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await again();
    expect(checked("[data-answer-option='o1wrong0']")).toBe(true);
    expect(checked("[data-answer-option='o2b00000']")).toBe(true);
    expect(checked("[data-answer-option='o2c00000']")).toBe(false);
    expect(($("[data-question='q3open00'] textarea") as HTMLTextAreaElement).value).toBe("Puhastan, siis värvin.");
  });

  test("a refused send keeps her answers and says why: too many, or anything else", async () => {
    serve(view(), [429, { ok: false, error: "rate" }]);
    await render();
    await answerAll();
    await sendIt();
    expect($("[data-test-error]")!.textContent).toBe("Liiga palju katseid. Proovi mõne minuti pärast.");
    expect(checked("[data-answer-option='o1wrong0']")).toBe(true);
    expect(draft()!.answers).toEqual(ANSWERS);
    serve(view(), [500, { ok: false, error: "server" }]);
    await sendIt();
    expect($("[data-test-error]")!.textContent).toBe("Midagi läks valesti. Proovi uuesti.");
  });

  test("Review Focus 3: Maria changed the test meanwhile — refused, no try used, the answers stay; the reload keeps those of the questions still there", async () => {
    serve(view(), [409, { ok: false, error: "changed" }]);
    await render();
    await answerAll();
    await sendIt();
    const error = $("[data-test-error]")!;
    expect(error.textContent).toContain("Test on vahepeal muutunud, laadi leht uuesti");
    expect(error.querySelector("button")!.textContent).toBe("Laadi uuesti");
    expect($("[data-test-submit]")).toBeNull(); // the next step is the reload
    expect(draft()!.answers).toEqual(ANSWERS);
    // Maria took question 2 out and added a fourth
    serve(view({ questions: [Q1, Q3, Q4] }));
    await click(error.querySelector("button"));
    expect($$("[data-question]").map((q) => q.getAttribute("data-question"))).toEqual(["q1choice", "q3open00", "q4open00"]);
    expect(checked("[data-answer-option='o1wrong0']")).toBe(true);
    expect(($("[data-question='q3open00'] textarea") as HTMLTextAreaElement).value).toBe("Puhastan, siis värvin.");
    expect(($("[data-question='q4open00'] textarea") as HTMLTextAreaElement).value).toBe("");
    expect(container.textContent).toContain("Katse 1/3");
    await type("[data-question='q4open00'] textarea", "Rohkem harjutamist.");
    await sendIt();
    expect(posts().at(-1)).toEqual([API, { answers: { q1choice: ["o1wrong0"], q3open00: "Puhastan, siis värvin.", q4open00: "Rohkem harjutamist." } }]);
  });
});

describe("the states after an attempt", () => {
  test("out of tries: her score and Maria's promise, no button to try", async () => {
    serve(view({ state: { kind: "used" }, triesLeft: 0, last: attempt({ number: 3 }) }));
    await render();
    expect(stateOf()).toBe("used");
    expect($("[data-test-result]")!.textContent).toBe("Said 50 %, vaja 80 %. Valesti vastatud: 1.");
    expect(container.textContent).toContain("Katsed on otsas. Maria sai teate ja avab testi sulle uuesti.");
    expect($("[data-test-retry]")).toBeNull();
    expect($("[data-test-submit]")).toBeNull();
  });

  test("open answers waiting for Maria: 'Ootab Maria hinnangut', her answers shown and not to be changed", async () => {
    serve(view({ state: { kind: "review" }, triesLeft: 2, last: attempt({ status: "review", percent: 100, wrong: [], answers: { ...ANSWERS, q1choice: ["o1right0"] } }) }));
    await render();
    expect(stateOf()).toBe("review");
    expect($("[data-test-result]")!.textContent).toBe("Ootab Maria hinnangut");
    expect(checked("[data-answer-option='o1right0']")).toBe(true);
    expect(($("[data-question='q1choice']") as HTMLFieldSetElement).disabled).toBe(true);
    expect(($("[data-question='q3open00'] textarea") as HTMLTextAreaElement).readOnly).toBe(true);
    expect($("[data-test-submit]")).toBeNull();
  });

  test("passed: 'Test on sooritatud' and the practical work next; a course without points leads back to the course", async () => {
    serve(view({ state: { kind: "passed" }, last: attempt({ status: "passed", percent: 100, wrong: [] }) }));
    await render();
    expect(stateOf()).toBe("passed");
    expect($("[data-test-result]")!.textContent).toBe("Test on sooritatud");
    expect([$("[data-test-next]")!.textContent, $("[data-test-next]")!.getAttribute("href")]).toEqual(["Ava praktiline töö", "/konto/kursus/kulmude-lami/praktiline"]);
    serve(view({ state: { kind: "passed" }, hasPoints: false, last: attempt({ status: "passed", percent: 100, wrong: [] }) }));
    await again();
    expect($("[data-test-next]")).toBeNull();
    expect([$("[data-test-back]")!.textContent, $("[data-test-back]")!.getAttribute("href")]).toEqual(["Tagasi koolitusele", "/konto/kursus/kulmude-lami"]);
  });

  test("the lessons not done: the reason and the way back, no questions; the access ended: her results only", async () => {
    serve(view({ locked: true }));
    await render();
    expect(stateOf()).toBe("locked");
    expect(container.textContent).toContain("Avaneb, kui kõik õppetunnid on tehtud.");
    expect($("[data-question]")).toBeNull();
    expect($("[data-test-back]")!.getAttribute("href")).toBe("/konto/kursus/kulmude-lami");
    serve(view({ readOnly: true, state: { kind: "open", triesLeft: 2 }, triesLeft: 2, last: attempt() }));
    await again();
    expect(stateOf()).toBe("readOnly");
    expect(container.textContent).toContain("Ligipääs on lõppenud: tulemusi saad vaadata, uut katset esitada ei saa.");
    expect($("[data-test-result]")!.textContent).toBe("Said 50 %, vaja 80 %. Valesti vastatud: 1.");
    expect($("[data-test-retry]")).toBeNull();
    expect($("[data-test-submit]")).toBeNull();
  });

  test("no test for her (no access, a course without questions): 'Seda testi ei leitud.' with the way back to the course", async () => {
    fetchMock.mockResolvedValue(json(404, { ok: false }));
    await render();
    expect($("[data-account-state='noTest']")!.textContent).toContain("Seda testi ei leitud.");
    expect($("[data-account-state='noTest'] a")!.getAttribute("href")).toBe("/konto/kursus/kulmude-lami");
  });
});

describe("Maria's 'Paranda'", () => {
  const FIX = view({
    state: { kind: "fix" },
    triesLeft: 2,
    last: attempt({
      status: "fix",
      percent: 100,
      wrong: [],
      questions: [Q1, Q2, Q3, Q4],
      answers: { q1choice: ["o1right0"], q2multi0: ["o2a00000", "o2b00000"], q3open00: "Puhastan.", q4open00: "Rohkem harjutamist." },
      review: { q3open00: { verdict: "fix", comment: "Lisa, millega puhastad." }, q4open00: { verdict: "ok", comment: "" } },
    }),
  });

  test("her comment under the answer to rewrite, the rest read-only; 'Saada uuesti' sends the same attempt back, no try used", async () => {
    serve(FIX, [200, view({ state: { kind: "review" }, triesLeft: 2, last: attempt({ status: "review", percent: 100, wrong: [] }) })]);
    await render();
    expect(stateOf()).toBe("fix");
    expect($("[data-test-result]")!.textContent).toBe("Maria palub mõned vastused üle vaadata.");
    expect($("[data-test-review-comment='q3open00']")!.textContent).toContain("Lisa, millega puhastad.");
    expect($("[data-test-review-comment='q4open00']")).toBeNull();
    expect(($("[data-question='q1choice']") as HTMLFieldSetElement).disabled).toBe(true);
    expect(($("[data-question='q4open00'] textarea") as HTMLTextAreaElement).readOnly).toBe(true);
    const box = $("[data-question='q3open00'] textarea") as HTMLTextAreaElement;
    expect([box.readOnly, box.value]).toEqual([false, "Puhastan."]);
    expect($("[data-test-submit]")!.textContent).toBe("Saada uuesti");
    await type("[data-question='q3open00'] textarea", "  ");
    await click($("[data-test-submit]"));
    expect($("[data-test-error]")!.textContent).toBe("Vasta kõigile küsimustele.");
    expect(posts()).toEqual([]);
    await type("[data-question='q3open00'] textarea", "Puhastan seebivaba puhastiga.");
    await click($("[data-test-submit]"));
    expect(posts()).toEqual([
      [`${API}/uuesti`, { attemptId: 41, answers: { q1choice: ["o1right0"], q2multi0: ["o2a00000", "o2b00000"], q3open00: "Puhastan seebivaba puhastiga.", q4open00: "Rohkem harjutamist." } }],
    ]);
    expect(stateOf()).toBe("review");
    expect($("[data-test-result]")!.textContent).toBe("Ootab Maria hinnangut");
  });
});

describe("in Russian", () => {
  test("Review Focus 5: a Russian-speaking student — the frame in Russian, Maria's questions as she wrote them", async () => {
    serve(view());
    await render("ru");
    expect($("h1")!.textContent).toBe("Ламинирование бровей");
    for (const text of ["Тест знаний", "Попытка 1/3", "Выберите все верные", "Ответьте на все вопросы и нажмите «Отправить тест».", "Mis värvi kasutad heledatel kulmudel?", "Helepruun"])
      expect(container.textContent).toContain(text);
    expect($("[data-test-submit]")!.textContent).toBe("Отправить тест");
    await answerAll();
    await click($("[data-test-submit]"));
    expect($("[data-test-confirm]")!.textContent).toContain("Отправить тест? Попытка 1/3.");
    await click($("[data-test-confirm] [data-confirm='yes']"));
    expect($("[data-test-result]")!.textContent).toBe("Ваш результат 50 %, нужно 80 %. Неверные ответы: 1.");
    expect($("[data-test-retry]")!.textContent).toBe("Попробовать ещё раз (осталось попыток: 2)");
    expect([$("[data-test-back]")!.textContent, $("[data-test-back]")!.getAttribute("href")]).toEqual(["Назад к курсу", "/ru/konto/kursus/kulmude-lami"]);
  });
});
