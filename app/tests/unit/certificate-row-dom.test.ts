// @vitest-environment happy-dom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountCourseCard } from "@/components/account/AccountCourseCard";
import { EcourseView } from "@/components/account/EcourseView";
import { coursesTexts, ecourseTexts } from "@/components/account/texts";
import type { EcourseCard } from "@/domain/account-cards";
import type { CourseSteps } from "@/domain/completion";
import { getDict, type Locale } from "@/i18n/locales";
import type { CertificateView } from "@/server/certificates";
import type { EcourseView as EcourseData } from "@/server/client-data";

// "Tunnistus" in "Lõpetamine" (phase 3d, spec §5) in a browser-like document (happy-dom), with POST …/tunnistus answered here:
// - the row follows "Lõpetatud" once the course is completed, with the name field filled with her account's name;
// - the name is checked here with the server's own rule before anything is sent, and only one request goes however often she presses;
// - a short hint under the field says "Latin letters" before she submits, apart from the error, and the field's aria-describedby names it;
// - the number and the PDF's download link take the field's place, and the server's refusals are put in words;
// - the page keeps one primary button; the admin's read-only copy has nothing to press; it reads in Russian;
// - an ended access's course card links its certificate.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const COMPLETED = "2026-11-14T10:00:00.000Z";
const ISSUED: CertificateView = { id: 7, number: "MS LAB 2026-03", name: "Kati Kask", issuedAt: "2026-11-15T10:00:00.000Z", reissuedAt: null };
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
const DONE: CourseSteps = { lessons: { done: 2, total: 2, state: "done" }, test: { state: "done", triesLeft: null }, practical: { state: "done", round: 1 }, completedAt: COMPLETED };
const data = (over: Partial<EcourseData["completion"]> = {}, progress: EcourseData["progress"] = { done: 2, total: 2, next: null }): EcourseData => ({
  course: { slug: "veebikursus", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" }, modules: MODULES },
  access: { expiresAt: "2027-04-03T10:00:00.000Z" },
  terms: { version: "1", accepted: true, text: null },
  progress,
  completion: { ...DONE, protocolSent: false, certificate: null, certificateName: "Kati Kask", ...over },
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

let container: HTMLDivElement;
let root: Root;
const $ = <E extends Element = HTMLElement>(selector: string) => container.querySelector<E>(selector);
const $$ = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const show = (d: EcourseData, locale: Locale = "et", readOnly = false) =>
  act(async () => root.render(createElement(EcourseView, { data: d, locale, t: ecourseTexts(getDict(locale)), readOnly })));
const field = () => $<HTMLInputElement>("[data-certificate-name]");
/** Types into the controlled field as a person would (React listens to the native input event). */
const type = async (value: string) => {
  const input = field();
  expect(input, "the name field").not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = async () => {
  await act(async () => $<HTMLFormElement>("[data-certificate] form")!.requestSubmit());
  await settle();
};
const errorText = () => $("[data-certificate-error]")!.textContent;
/** The page's filled buttons and links ("Jätka", a step's way in, the certificate's): there may be one at most. */
const primaries = () => $$("[data-ecourse] a, [data-ecourse] button, [data-ecourse] [aria-disabled]").filter((e) => /btn/.test(e.className) && !/btnOutline/.test(e.className));
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

describe("the 'Tunnistus' row", () => {
  test("after 'Lõpetatud' once the course is completed: the line, 'Nimi tunnistusel' with her account's name, 'Kinnita ja koosta tunnistus' the page's one primary button; none before", async () => {
    await show(data({ completedAt: null, practical: { state: "review", round: 1 } }));
    expect($("[data-certificate]")).toBeNull();
    await show(data());
    const row = $("[data-certificate]")!;
    expect(row.closest("[data-completion]")).not.toBeNull();
    expect($("[data-step='done']")!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.getAttribute("data-step-state")).toBe("open");
    expect(row.textContent).toContain("Tunnistus");
    expect(row.textContent).toContain("Kontrolli, kuidas su nimi tunnistusel kirjas on");
    const label = row.querySelector("label")!;
    expect([label.textContent, label.htmlFor]).toEqual(["Nimi tunnistusel", field()!.id]);
    expect(field()!.value).toBe("Kati Kask");
    const issue = $("[data-certificate-issue]")!;
    expect([issue.tagName, issue.textContent]).toEqual(["BUTTON", "Kinnita ja koosta tunnistus"]);
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0]).toBe(issue);
    expect($("[data-certificate-number]")).toBeNull();
    expect($("[data-certificate-download]")).toBeNull();
  });

  test("a short hint under the field says 'Latin letters' before she submits, apart from the error message, and the field's aria-describedby names both (a Cyrillic account name is refused only on submit)", async () => {
    await show(data({ certificateName: "Катя Каск" }));
    const hint = $("[data-certificate-hint]")!;
    const error = $("[data-certificate-error]")!;
    expect(hint.textContent).toBe("Ladina tähtedega, nagu passis.");
    expect(hint.id).not.toBe("");
    expect(hint.id).not.toBe(error.id);
    expect(hint.contains(error) || error.contains(hint)).toBe(false);
    expect(hint.getAttribute("role")).toBeNull(); // a hint, not an alert: it is read with the field, not announced
    expect(field()!.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(field()!.value).toBe("Катя Каск"); // prefilled in Cyrillic, nothing refused yet
    expect(errorText()).toBe("");
    expect(field()!.getAttribute("aria-describedby")!.split(" ")).toEqual([hint.id, error.id]);
    // refused on submit: the error appears beside the hint, which stays and keeps its words
    await press();
    expect(errorText()).toBe("Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma).");
    expect($("[data-certificate-hint]")).toBe(hint);
    expect(hint.textContent).toBe("Ladina tähtedega, nagu passis.");
    expect(field()!.getAttribute("aria-describedby")!.split(" ")).toEqual([hint.id, error.id]);
    expect(fetchMock).not.toHaveBeenCalled();
    // Russian, with the no-break space after the one-letter preposition
    await show(data({ certificateName: "Катя Каск" }), "ru");
    expect($("[data-certificate-hint]")!.textContent).toBe("Латинскими буквами, как в\u00a0паспорте.");
    expect(field()!.getAttribute("aria-describedby")!.split(" ")).toContain($("[data-certificate-hint]")!.id);
    // the admin's read-only copy shows it too (the field is inert, the words are the same); once issued there is no field and no hint
    await show(data(), "et", true);
    expect($("[data-certificate-hint]")!.textContent).toBe("Ladina tähtedega, nagu passis.");
    await show(data({ certificate: ISSUED }));
    expect($("[data-certificate-hint]")).toBeNull();
  });

  test("the name is checked here first, with the server's own rule: digits, an emoji, Cyrillic (Latin letters as in the passport), or too long, is the field's error and nothing is sent", async () => {
    await show(data());
    await type("Kati 2");
    await press();
    expect(errorText()).toBe("Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma).");
    expect(field()!.getAttribute("aria-invalid")).toBe("true");
    expect(field()!.getAttribute("aria-describedby")!.split(" ")).toContain($("[data-certificate-error]")!.id);
    await type("Kati 😀");
    await press();
    expect(errorText()).toBe("Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma).");
    await type("Катя Каск");
    await press();
    expect(errorText()).toBe("Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma).");
    await type("A".repeat(81));
    await press();
    expect(errorText()).toBe("Nimi peab olema 2–80 tähemärki pikk");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a good name: sent once, as the rule writes it (a second press waits for the first); the number, 'Laadi tunnistus alla (PDF)' — a plain download link, the page's one primary — and 'Kui nimes on viga, kirjuta meile'; no field any more", async () => {
    let answer!: (res: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    await show(data());
    await type("  Mari-Liis   Tamm ");
    await press();
    await press(); // a double tap while the first is on its way
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0];
    expect([url, JSON.parse(String(init!.body))]).toEqual(["/api/konto/kursus/veebikursus/tunnistus", { name: "Mari-Liis Tamm" }]);
    const issue = $("[data-certificate-issue]")!;
    expect([issue.getAttribute("aria-disabled"), issue.textContent]).toEqual(["true", "Koostan tunnistust…"]);
    await act(async () => answer(json(200, { ok: true, certificate: ISSUED })));
    await settle();
    expect($("[data-certificate]")!.getAttribute("data-step-state")).toBe("done");
    const number = $("[data-certificate-number]")!;
    expect(number.textContent).toBe("Tunnistus nr. MS LAB 2026-03");
    expect(document.activeElement).toBe(number); // a screen reader hears what happened
    const download = $<HTMLAnchorElement>("[data-certificate-download]")!;
    expect([download.tagName, download.textContent, download.getAttribute("href"), download.hasAttribute("download")]).toEqual(["A", "Laadi tunnistus alla (PDF)", "/api/konto/tunnistus/7", true]);
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0]).toBe(download);
    const contact = $("[data-certificate-contact]")!;
    expect([contact.textContent, contact.getAttribute("href")]).toEqual(["Kui nimes on viga, kirjuta meile", "/kontakt"]);
    expect(field()).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  test("another device was first (409 'already'): that certificate is shown; the server's refusals in words, and the button can be pressed again", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { ok: false, error: "already", certificate: ISSUED }));
    await show(data());
    await press();
    expect($("[data-certificate-number]")!.textContent).toBe("Tunnistus nr. MS LAB 2026-03");
    const cases: [() => Promise<Response>, string][] = [
      [async () => json(400, { ok: false, error: "name", reason: "letters" }), "Kirjuta nimi ladina tähtedega nagu passis (lubatud on ka tühik, sidekriips ja ülakoma)."],
      [async () => json(400, { ok: false, error: "name", reason: "length" }), "Nimi peab olema 2–80 tähemärki pikk"],
      [async () => json(429, { ok: false, error: "rate" }), "Liiga palju katseid. Proovi mõne minuti pärast."],
      [async () => json(409, { ok: false, error: "notCompleted" }), "Midagi läks valesti. Proovi uuesti."],
      [async () => json(404, { ok: false }), "Midagi läks valesti. Proovi uuesti."],
      [
        async () => {
          throw new TypeError("offline");
        },
        "Midagi läks valesti. Proovi uuesti.",
      ],
    ];
    for (const [respond, text] of cases) {
      await act(async () => root.unmount()); // a fresh page: the row as it loads
      root = createRoot(container);
      fetchMock.mockImplementationOnce(respond);
      await show(data());
      await press();
      expect(errorText(), text).toBe(text);
      expect($("[data-certificate-issue]")!.hasAttribute("aria-disabled"), text).toBe(false);
      expect($("[data-certificate-number]"), text).toBeNull();
    }
  });

  test("issued already when the page loads: the number and the download, no field; the mark done; the focus stays where it was", async () => {
    await show(data({ certificate: ISSUED }));
    expect($("[data-certificate]")!.getAttribute("data-step-state")).toBe("done");
    expect($("[data-certificate-number]")!.textContent).toBe("Tunnistus nr. MS LAB 2026-03");
    expect($("[data-certificate-download]")!.getAttribute("href")).toBe("/api/konto/tunnistus/7");
    expect(field()).toBeNull();
    expect(document.activeElement).not.toBe($("[data-certificate-number]")); // only a certificate made here takes the focus
  });

  test("a lesson added after the completion ('Jätka' on the page): the certificate's button is an outline one, so the page keeps one primary", async () => {
    await show(data({ lessons: { done: 2, total: 3, state: "done" } }, { done: 2, total: 3, next: 13 }));
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0].hasAttribute("data-ecourse-next")).toBe(true);
    expect($("[data-certificate-issue]")!.className).toMatch(/btnOutline/);
  });

  test("read-only (the admin's view as client): the row is there with nothing to type, press or follow, also in the server's markup", async () => {
    await show(data(), "et", true);
    expect(field()!.disabled).toBe(true);
    const issue = $("[data-certificate-issue]")!;
    expect([issue.tagName, issue.getAttribute("aria-disabled")]).toEqual(["SPAN", "true"]);
    await show(data({ certificate: ISSUED }), "et", true);
    expect($("[data-certificate-download]")!.tagName).toBe("SPAN");
    expect($("[data-certificate-contact]")!.tagName).toBe("SPAN");
    expect($$("[data-ecourse] a")).toHaveLength(0);
    for (const over of [{}, { certificate: ISSUED }]) {
      const html = renderToStaticMarkup(createElement(EcourseView, { data: data(over), locale: "et", t: ecourseTexts(getDict("et")), readOnly: true }));
      expect(html).toContain('data-certificate=""');
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("<button");
    }
  });

  test("Russian: the row in Russian, a Cyrillic name refused in her words (Latin letters as in the passport) and nothing sent, the Latin one taken, the contact page under /ru", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, certificate: ISSUED }));
    await show(data(), "ru");
    const row = $("[data-certificate]")!;
    expect(row.textContent).toContain("Сертификат");
    expect(row.textContent).toContain("Проверьте, как ваше имя будет написано в\u00a0сертификате");
    expect(row.querySelector("label")!.textContent).toBe("Имя в\u00a0сертификате");
    expect($("[data-certificate-issue]")!.textContent).toBe("Подтвердить и создать сертификат");
    // her account's name may be in Cyrillic: the script font has none, so the rule asks for Latin letters as in her passport
    for (const name of ["Kati 2", "Катя Каск"]) {
      await type(name);
      await press();
      expect(errorText(), name).toBe("Напишите имя латинскими буквами, как в\u00a0паспорте (можно также пробел, дефис и апостроф).");
    }
    expect(posts()).toHaveLength(0);
    await type("Katja Kask");
    await press();
    expect(JSON.parse(String(posts()[0][1]!.body))).toEqual({ name: "Katja Kask" });
    expect($("[data-certificate-number]")!.textContent).toBe("Сертификат № MS LAB 2026-03");
    expect($("[data-certificate-download]")!.textContent).toBe("Скачать сертификат (PDF)");
    expect($("[data-certificate-contact]")!.getAttribute("href")).toBe("/ru/kontakt");
  });
});

describe("the course card's 'Laadi tunnistus alla' (spec §5)", () => {
  const card = (over: Partial<EcourseCard> = {}): EcourseCard => ({
    kind: "ecourse",
    course: { slug: "veebikursus", title: { et: "Kulmumeistri e-koolitus", ru: "Онлайн-курс бровиста" } },
    grantedAt: "2026-05-01T10:00:00.000Z",
    expiresAt: "2026-11-15T10:00:00.000Z",
    revoked: false,
    completedAt: COMPLETED,
    certificateId: 7,
    ...over,
  });
  const showCard = (c: EcourseCard, locale: Locale = "et", readOnly = false) =>
    act(async () =>
      root.render(
        createElement(AccountCourseCard, { card: c, now: new Date("2026-11-20T10:00:00.000Z"), locale, t: coursesTexts(getDict(locale)), pay: null, readOnly, sent: false, onChangeRequest: () => {} }),
      ),
    );
  const link = () => $("[data-card-certificate]");

  test("an ended access's card: a quiet download link to its PDF, the way back to it once the course page is closed", async () => {
    await showCard(card());
    expect($("[data-card]")!.hasAttribute("data-past")).toBe(true);
    const a = link()!;
    expect([a.tagName, a.textContent, a.getAttribute("href"), a.hasAttribute("download")]).toEqual(["A", "Laadi tunnistus alla", "/api/konto/tunnistus/7", true]);
    expect(a.className).not.toMatch(/btn/);
    await showCard(card(), "ru");
    expect(link()!.textContent).toBe("Скачать сертификат");
  });

  test("none while the access is open (the course page has the row), without a certificate, or for a revoked access; inert in the admin's view", async () => {
    await showCard(card({ expiresAt: "2027-04-03T10:00:00.000Z", progress: { done: 2, total: 2, next: null } }));
    expect(link()).toBeNull();
    await showCard(card({ certificateId: null }));
    expect(link()).toBeNull();
    await showCard(card({ certificateId: undefined }));
    expect(link()).toBeNull();
    await showCard(card({ revoked: true }));
    expect(link()).toBeNull();
    await showCard(card(), "et", true);
    expect([link()!.getAttribute("href"), link()!.getAttribute("aria-disabled")]).toEqual([null, "true"]);
  });
});
