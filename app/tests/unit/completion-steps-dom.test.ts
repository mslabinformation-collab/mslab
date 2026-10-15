// @vitest-environment happy-dom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AccountCourseCard } from "@/components/account/AccountCourseCard";
import { EcourseView } from "@/components/account/EcourseView";
import { coursesTexts, ecourseTexts } from "@/components/account/texts";
import type { EcourseCard } from "@/domain/account-cards";
import type { CourseSteps, StepState } from "@/domain/completion";
import { getDict, type Locale } from "@/i18n/locales";
import type { EcourseView as EcourseData } from "@/server/client-data";

// "Lõpetamine" under the e-course's modules (e-course completion, spec §4.1) in a browser-like document (happy-dom): the four steps in
// order with their states and reasons, a skipped step not shown, the way into the open step (the page's one button once the lessons are
// done), "Vaata protokolli" for an e-course without points, the admin's read-only copy with nothing to click, Russian (Review Focus 5);
// and the course card's "Lõpetatud {date}", also after the access has ended.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const COMPLETED = "2026-11-14T10:00:00.000Z";
const MODULES: EcourseData["course"]["modules"] = [
  {
    id: 1,
    title: { et: "Teooria", ru: "Теория" },
    lessons: [
      { id: 11, moduleId: 1, title: { et: "Sissejuhatus" }, state: "done" },
      { id: 12, moduleId: 1, title: { et: "Värvid" }, state: "done" },
    ],
  },
];
const steps = (over: Partial<CourseSteps> = {}): CourseSteps => ({
  lessons: { done: 2, total: 2, state: "done" },
  test: { state: "open", triesLeft: 3 },
  practical: { state: "locked", round: 0 },
  completedAt: null,
  ...over,
});
const data = (s: CourseSteps = steps(), protocolSent = false, progress: EcourseData["progress"] = { done: 2, total: 2, next: null }): EcourseData => ({
  course: { slug: "veebikursus", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" }, modules: MODULES },
  access: { expiresAt: "2027-04-03T10:00:00.000Z" },
  terms: { version: "1", accepted: true, text: null },
  progress,
  completion: { ...s, protocolSent, certificate: null, certificateName: "" },
});

let container: HTMLDivElement;
let root: Root;
const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const show = (d: EcourseData, locale: Locale = "et", readOnly = false) =>
  act(async () => root.render(createElement(EcourseView, { data: d, locale, t: ecourseTexts(getDict(locale)), readOnly })));
const step = (key: string) => $(`[data-step='${key}']`);
const name = (key: string) => step(key)?.querySelector("[data-step-name]")?.textContent;
const line = (key: string) => step(key)?.querySelector("[data-step-line]")?.textContent;
const link = (key: string) => step(key)?.querySelector("[data-step-link]") ?? null;
/** The page's links besides the lesson titles. */
const pageLinks = () => $$("[data-ecourse] a").filter((a) => !a.closest("[data-lesson]")).map((a) => a.textContent);

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the block on the e-course page", () => {
  test("after the modules: Õppetunnid → Teadmiste test → Praktiline töö → Lõpetatud, each with its state; a locked one says why", async () => {
    await show(data(steps({ lessons: { done: 1, total: 2, state: "open" }, test: { state: "locked", triesLeft: 3 } }), false, { done: 1, total: 2, next: 12 }));
    const block = $("[data-ecourse] > [data-completion]")!;
    expect(block).not.toBeNull();
    expect($("[data-modules]")!.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block.querySelector("h2")!.textContent).toBe("Lõpetamine");
    expect($$("[data-step]").map((e) => [e.getAttribute("data-step"), e.getAttribute("data-step-state")])).toEqual([
      ["lessons", "open"],
      ["test", "locked"],
      ["practical", "locked"],
      ["done", "locked"],
    ]);
    expect(["lessons", "test", "practical", "done"].map(name)).toEqual(["Õppetunnid", "Teadmiste test", "Praktiline töö", "Lõpetatud"]);
    expect(line("lessons")).toBe("1 / 2 tehtud");
    expect(line("test")).toBe("Avaneb, kui kõik õppetunnid on tehtud.");
    expect(line("practical")).toBe("Avaneb, kui test on sooritatud.");
    expect(line("done")).toBe("Kui kõik sammud on tehtud");
    expect($$("[data-step-link]")).toHaveLength(0);
    expect(pageLinks()).toEqual(["Jätka"]); // while lessons are left, "Jätka" is the page's one button
  });

  test("the lessons done, the test open: 'Ava test' is the page's one button, to the test page", async () => {
    await show(data());
    expect(line("lessons")).toBe("Kõik õppetunnid on tehtud");
    expect(line("test")).toBe("Avatud. Katseid jäänud: 3");
    const a = link("test")!;
    expect([a.tagName, a.textContent, a.getAttribute("href")]).toEqual(["A", "Ava test", "/konto/kursus/veebikursus/test"]);
    expect(a.className).toMatch(/btn/);
    expect(a.className).not.toMatch(/btnOutline/);
    expect(pageLinks()).toEqual(["Ava test"]);
  });

  test("the test waiting for Maria, to fix, out of tries, passed: the state in words, and the way to the results", async () => {
    const cases: [StepState, number | null, string, string][] = [
      ["review", null, "Ootab Maria hinnangut", "Vaata tulemust"],
      ["fix", null, "Paranda vastused", "Ava test"],
      ["used", 0, "Katsed on otsas. Maria sai teate ja avab testi sulle uuesti.", "Vaata tulemust"],
      ["done", null, "Sooritatud", "Vaata tulemust"],
    ];
    for (const [state, triesLeft, text, label] of cases) {
      await show(data(steps({ test: { state, triesLeft } })));
      expect(line("test"), state).toBe(text);
      expect(link("test")!.textContent, state).toBe(label);
      expect(link("test")!.getAttribute("href"), state).toBe("/konto/kursus/veebikursus/test");
      expect(link("test")!.className.includes("btnOutline") || !/(^|\s)\S*btn\S*/.test(link("test")!.className), state).toBe(state !== "fix");
    }
  });

  test("the practical work open, waiting, to fix, approved: its line and the way to its page", async () => {
    const cases: [StepState, string, string][] = [
      ["open", "Lisa fotod ja saada hindamiseks", "Ava praktiline töö"],
      ["review", "Ootab hindamist", "Vaata praktilist tööd"],
      ["fix", "Paranda märgitud punktid", "Ava praktiline töö"],
      ["done", "Kinnitatud", "Vaata praktilist tööd"],
    ];
    for (const [state, text, label] of cases) {
      await show(data(steps({ test: { state: "done", triesLeft: null }, practical: { state, round: 1 } })));
      expect(line("practical"), state).toBe(text);
      expect([link("practical")!.textContent, link("practical")!.getAttribute("href")], state).toEqual([label, "/konto/kursus/veebikursus/praktiline"]);
    }
  });

  test("completed: every step done, and 'Lõpetatud' with its date", async () => {
    await show(data(steps({ test: { state: "done", triesLeft: null }, practical: { state: "done", round: 2 }, completedAt: COMPLETED })));
    expect($$("[data-step]").map((e) => e.getAttribute("data-step-state"))).toEqual(["done", "done", "done", "done"]);
    expect(line("done")).toBe("Lõpetatud 14.11.2026");
    expect(step("done")!.querySelector("svg")).not.toBeNull(); // ✓ in the mark
  });

  test("a step the course does not have is not shown; without a test the practical work waits for the lessons; 'Vaata protokolli' for an e-course without points", async () => {
    await show(data(steps({ test: null, practical: null }), true));
    expect($$("[data-step]").map((e) => e.getAttribute("data-step"))).toEqual(["lessons", "done"]);
    const p = $("[data-view-protocol]")!;
    expect([p.textContent, p.getAttribute("href")]).toEqual(["Vaata protokolli", "/konto/kursus/veebikursus/praktiline"]);
    await show(data(steps({ lessons: { done: 1, total: 2, state: "open" }, test: null, practical: { state: "locked", round: 0 } }), false, { done: 1, total: 2, next: 12 }));
    expect($$("[data-step]").map((e) => e.getAttribute("data-step"))).toEqual(["lessons", "practical", "done"]);
    expect(line("practical")).toBe("Avaneb, kui kõik õppetunnid on tehtud.");
    expect($("[data-view-protocol]")).toBeNull();
  });

  test("a course without lessons yet ('Sisu lisandub peagi.') has no block", async () => {
    await show({ ...data(steps({ lessons: { done: 0, total: 0, state: "done" } }), false, { done: 0, total: 0, next: null }), course: { slug: "veebikursus", title: { et: "Kulmumeistri e-koolitus" }, modules: [{ ...MODULES[0], lessons: [] }] } });
    expect($("[data-completion]")).toBeNull();
    expect($("[data-ecourse-soon]")).not.toBeNull();
  });

  test("read-only (the admin's view as client): the steps are there, their links inert, also in the server's markup", async () => {
    const open = data(steps({ test: { state: "done", triesLeft: null }, practical: { state: "review", round: 1 } }));
    await show(open, "et", true);
    expect($$("[data-ecourse] a")).toHaveLength(0);
    expect(link("test")!.getAttribute("aria-disabled")).toBe("true");
    expect(link("practical")!.getAttribute("aria-disabled")).toBe("true");
    expect(link("practical")!.textContent).toBe("Vaata praktilist tööd");
    const notes = data(steps({ test: null, practical: null }), true);
    await show(notes, "et", true);
    expect($("[data-view-protocol]")!.getAttribute("aria-disabled")).toBe("true");
    const html = renderToStaticMarkup(createElement(EcourseView, { data: open, locale: "et", t: ecourseTexts(getDict("et")), readOnly: true }));
    expect(html).toContain('data-completion=""');
    expect(html).not.toContain("<a ");
  });

  test("Review Focus 5: Russian: the block in Russian, the addresses under /ru", async () => {
    await show(data(steps({ test: { state: "done", triesLeft: null }, practical: { state: "fix", round: 1 } })), "ru");
    expect($("[data-completion] h2")!.textContent).toBe("Завершение");
    expect(["lessons", "test", "practical", "done"].map(name)).toEqual(["Уроки", "Тест знаний", "Практическая работа", "Завершено"]);
    expect(line("lessons")).toBe("Все уроки пройдены");
    expect(line("test")).toBe("Сдан");
    expect(line("practical")).toBe("Исправьте отмеченные пункты");
    expect([link("practical")!.textContent, link("practical")!.getAttribute("href")]).toEqual(["Открыть практическую работу", "/ru/konto/kursus/veebikursus/praktiline"]);
    await show(data(steps({ test: { state: "open", triesLeft: 2 } })), "ru");
    expect(line("test")).toBe("Открыт. Осталось попыток: 2");
    expect(link("test")!.getAttribute("href")).toBe("/ru/konto/kursus/veebikursus/test");
    await show(data(steps({ test: { state: "done", triesLeft: null }, practical: { state: "done", round: 1 }, completedAt: COMPLETED })), "ru");
    expect(line("done")).toBe("Завершено 14.11.2026");
  });
});

describe("the course card's 'Lõpetatud'", () => {
  const card = (over: Partial<EcourseCard> = {}): EcourseCard => ({
    kind: "ecourse",
    course: { slug: "veebikursus", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" } },
    grantedAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2027-03-01T10:00:00.000Z",
    revoked: false,
    progress: { done: 2, total: 2, next: null },
    ...over,
  });
  const showCard = (c: EcourseCard, locale: Locale = "et") =>
    act(async () =>
      root.render(
        createElement(AccountCourseCard, {
          card: c,
          now: new Date("2026-11-20T10:00:00.000Z"),
          locale,
          t: coursesTexts(getDict(locale)),
          pay: null,
          readOnly: false,
          sent: false,
          onChangeRequest: () => {},
        }),
      ),
    );

  test("an open, completed course: 'Lõpetatud {date}' under 'Läbitud ✓' (the lessons' line keeps its logic); none before", async () => {
    await showCard(card({ completedAt: COMPLETED }));
    expect($("[data-card-completed]")!.textContent).toBe("Lõpetatud 14.11.2026");
    expect($("[data-card-finished]")!.textContent).toBe("Läbitud ✓");
    await showCard(card({ completedAt: null }));
    expect($("[data-card-completed]")).toBeNull();
    await showCard(card());
    expect($("[data-card-completed]")).toBeNull();
  });

  test("the access has ended: the card is past, its date stays; Russian", async () => {
    const ended = card({ expiresAt: "2026-11-15T10:00:00.000Z", progress: undefined, completedAt: COMPLETED });
    await showCard(ended);
    expect($("[data-card]")!.hasAttribute("data-past")).toBe(true);
    expect($("[data-card-completed]")!.textContent).toBe("Lõpetatud 14.11.2026");
    await showCard(ended, "ru");
    expect($("[data-card-completed]")!.textContent).toBe("Завершено 14.11.2026");
  });
});
