// @vitest-environment happy-dom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DetailsTab } from "@/components/account/DetailsTab";
import { detailsTexts } from "@/components/account/texts";
import { ACCOUNT_EVENT } from "@/components/account/useAccount";
import { getDict, type Locale } from "@/i18n/locales";
import type { ClientProfile, Dashboard } from "@/server/client-data";

// "Minu andmed" in a browser-like document (happy-dom), with fetch answered here: the profile with one "Salvesta", the language
// change that opens the other language's tab, the newsletter switch that saves at once, and "Kustuta konto" with its step.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const dashboard = (over: Partial<ClientProfile> = {}): Dashboard => ({
  client: { email: "kati@example.test", name: "Kati Tamm", phone: "", locale: "et", newsletter: false, passwordSetAt: null, ...over },
  cards: [],
  favourites: [],
  prepayment: null,
  resume: null,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);
const sent = (path: string) => fetchMock.mock.calls.filter(([url, init]) => url === path && init?.method !== undefined && init.method !== "GET").map(([, init]) => JSON.parse(String(init?.body)));
const gets = () => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === "GET");

const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const click = async (el: Element | null) => {
  expect(el, "the element to click").not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
/** Types into a controlled input as a person would (React listens to the native input event). */
const type = async (input: HTMLInputElement | null, value: string) => {
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = async () => {
  await act(async () => $<HTMLFormElement>("form")!.requestSubmit());
  await settle();
};
const mount = async (locale: Locale = "et") => {
  await act(async () => root.render(createElement(DetailsTab, { locale, t: detailsTexts(getDict(locale)) })));
  await settle();
};

/** The API: the dashboard for GET, `answers[path]` (default 200 { ok: true }) for the rest. */
function api(profile: Partial<ClientProfile> = {}, answers: Record<string, () => Promise<Response>> = {}) {
  fetchMock.mockImplementation(async (url, init) => {
    if ((init?.method ?? "GET") === "GET") return json(200, dashboard(profile));
    const answer = answers[String(url)];
    return answer ? answer() : json(200, { ok: true });
  });
}

let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>;
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  sessionStorage.clear();
  assign = vi.fn<(url: string | URL) => void>();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
  window.history.replaceState(null, "", "/konto/andmed");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const nameField = () => $<HTMLInputElement>("input[name='name']");
const phoneField = () => $<HTMLInputElement>("input[name='phone']");
const status = () => $("[data-details-status]")?.textContent;

describe("the static shell", () => {
  test("renders the waiting look only: no field, no e-mail, no button", () => {
    const html = renderToStaticMarkup(createElement(DetailsTab, { locale: "et", t: detailsTexts(getDict("et")) }));
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/<input|<form|Kustuta konto|Salvesta|Sinu andmed/);
  });
});

describe("name, phone and language", () => {
  test("filled from the account; Salvesta sends them as one line each and says Salvestatud.; typing again takes the word away", async () => {
    api({ name: "Kati Tamm", phone: "+372 5555" });
    await mount();
    expect(gets().map(([url]) => url)).toEqual(["/api/konto"]);
    expect($("h1")?.textContent).toBe("Sinu andmed");
    expect($("[data-account-email]")?.textContent).toBe("E-postkati@example.test");
    expect(nameField()?.value).toBe("Kati Tamm");
    expect(phoneField()?.value).toBe("+372 5555");
    expect($<HTMLInputElement>("input[data-language='et']")?.checked).toBe(true);
    expect($("[data-details-status]")?.getAttribute("role")).toBe("status");

    await type(nameField(), "  Kati   Kask ");
    await submit();
    expect(sent("/api/konto/andmed")).toEqual([{ name: "Kati Kask", phone: "+372 5555", locale: "et" }]);
    expect(fetchMock.mock.calls.find(([url]) => url === "/api/konto/andmed")?.[1]?.method).toBe("PATCH");
    expect(status()).toBe("Salvestatud.");
    expect(nameField()?.value).toBe("Kati Kask");
    expect(assign).not.toHaveBeenCalled();
    await type(phoneField(), "");
    expect(status()).toBe("");
  });

  test("a failure says so; a 401 loads the page again", async () => {
    let answer = () => Promise.resolve(json(500, { ok: false, error: "server" }));
    api({}, { "/api/konto/andmed": () => answer() });
    await mount();
    await submit();
    expect(status()).toBe("Ei õnnestunud salvestada. Proovi uuesti.");
    expect($("[data-details-status]")?.className).toMatch(/error/);

    vi.spyOn(window.location, "replace").mockImplementation(() => {});
    answer = () => Promise.resolve(json(401, { ok: false, reason: "none" }));
    await submit();
    expect(gets()).toHaveLength(2);
  });

  test("a new language is saved first, then the same tab opens in it with #salvestatud; the same language as the page stays", async () => {
    api();
    await mount();
    await click($("input[data-language='ru']"));
    await submit();
    expect(sent("/api/konto/andmed")).toEqual([{ name: "Kati Tamm", phone: "", locale: "ru" }]);
    expect(assign).toHaveBeenCalledWith("/ru/konto/andmed#salvestatud");
    expect(status()).toBe("");
    expect($("[data-details-save]")?.getAttribute("aria-disabled")).toBe("true"); // busy until the other page opens
  });

  test("an account in Russian on the Estonian page: saving without a change stays; choosing Estonian saves and stays (it is this page's language)", async () => {
    api({ locale: "ru" });
    await mount("et");
    expect($<HTMLInputElement>("input[data-language='ru']")?.checked).toBe(true);
    await submit();
    expect(assign).not.toHaveBeenCalled();
    await click($("input[data-language='et']"));
    await submit();
    expect(sent("/api/konto/andmed").map((b) => b.locale)).toEqual(["ru", "et"]);
    expect(assign).not.toHaveBeenCalled();
    expect(status()).toBe("Salvestatud.");
  });

  test("opened with #salvestatud (after a language change): Сохранено. once, and the fragment is gone", async () => {
    window.history.replaceState(null, "", "/ru/konto/andmed#salvestatud");
    api({ locale: "ru" });
    await mount("ru");
    expect($("h1")?.textContent).toBe("Ваши данные");
    expect(status()).toBe("Сохранено.");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/ru/konto/andmed");
  });
});

describe("Soovin MS LABi sooduspakkumisi ja uudiskirju saada", () => {
  test("a switch that saves at once with its own line, not with Salvesta; a failure puts it back", async () => {
    let answer = () => Promise.resolve(json(200, { ok: true }));
    api({}, { "/api/konto/uudiskiri": () => answer() });
    await mount();
    const sw = () => $<HTMLInputElement>("input[role='switch']")!;
    expect(sw().checked).toBe(false);
    expect(sw().closest("label")?.textContent).toBe("Soovin MS LABi sooduspakkumisi ja uudiskirju saada");
    await click(sw());
    expect(sent("/api/konto/uudiskiri")).toEqual([{ on: true }]);
    expect(sw().checked).toBe(true);
    expect($("[data-details-newsletter-status]")?.textContent).toBe("Salvestatud.");
    expect(status()).toBe("");
    expect(sent("/api/konto/andmed")).toEqual([]);

    answer = () => Promise.resolve(json(500, { ok: false }));
    await click(sw());
    expect(sent("/api/konto/uudiskiri")).toEqual([{ on: true }, { on: false }]);
    expect(sw().checked).toBe(true);
    expect($("[data-details-newsletter-status]")?.textContent).toBe("Ei õnnestunud salvestada. Proovi uuesti.");
  });
});

describe("Kustuta konto", () => {
  test("quiet text at the very bottom; the step takes the focus, Tühista and Esc give it back", async () => {
    api();
    await mount();
    const del = () => $("[data-delete-account]");
    const controls = [...document.querySelectorAll("[data-account-details] button, [data-account-details] input")];
    expect(controls.at(-1)).toBe(del());
    expect(del()?.textContent).toBe("Kustuta konto");
    expect(del()?.className).not.toMatch(/btn/);

    await click(del());
    const step = $("[data-delete-confirm]");
    expect(document.activeElement).toBe(step);
    expect(step?.getAttribute("role")).toBe("group");
    expect($(`#${CSS.escape(step!.getAttribute("aria-labelledby")!)}`)?.textContent).toBe("Kas kustutame su konto? Sinu registreeringud jäävad Mariale alles.");
    expect([...step!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Jah, kustuta", "Tühista"]);
    expect(document.querySelector("dialog")).toBeNull();

    await click($("[data-delete-no]"));
    expect($("[data-delete-confirm]")).toBeNull();
    expect(document.activeElement).toBe(del());

    await click(del());
    await act(async () => $("[data-delete-confirm]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect($("[data-delete-confirm]")).toBeNull();
    expect(document.activeElement).toBe(del());
    expect(sent("/api/konto/kustuta")).toEqual([]);
  });

  test("Jah, kustuta: one POST { confirm: true }; this browser forgets the account, the header is told, and the home page opens with #konto-kustutatud", async () => {
    api();
    await mount();
    localStorage.setItem("mslab-email", "kati@example.test");
    localStorage.setItem("mslab-fav", '["x"]'); // the browser's own list (not the account's) stays
    sessionStorage.setItem("mslab-login-code", JSON.stringify({ sentTo: "kati@example.test", sentAt: Date.now() }));
    localStorage.setItem("mslab-account-fav", '["kulmude-lami"]');
    sessionStorage.setItem("mslab-change-sent", JSON.stringify([{ id: 1, startsAt: "2026-12-01T08:00:00.000Z", at: Date.now() }]));
    const told = vi.fn();
    window.addEventListener(ACCOUNT_EVENT, told);
    await click($("[data-delete-account]"));
    await click($("[data-delete-yes]"));
    window.removeEventListener(ACCOUNT_EVENT, told);
    expect(sent("/api/konto/kustuta")).toEqual([{ confirm: true }]);
    expect(localStorage.getItem("mslab-email")).toBeNull();
    expect(sessionStorage.getItem("mslab-login-code")).toBeNull();
    expect(localStorage.getItem("mslab-account-fav")).toBeNull();
    expect(sessionStorage.getItem("mslab-change-sent")).toBeNull();
    expect(localStorage.getItem("mslab-fav")).toBe('["x"]');
    expect(told).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("/#konto-kustutatud");
  });

  test("Russian: the home page is /ru", async () => {
    api({ locale: "ru" });
    await mount("ru");
    await click($("[data-delete-account]"));
    expect($("[data-delete-confirm]")?.textContent).toContain("Удалить ваш личный кабинет? Ваши регистрации останутся у\u00a0Марии.");
    await click($("[data-delete-yes]"));
    expect(assign).toHaveBeenCalledWith("/ru#konto-kustutatud");
  });

  test("a failure says so and keeps the step (nothing forgotten); a 401 loads the page again", async () => {
    let answer = () => Promise.resolve(json(500, { ok: false, error: "server" }));
    api({}, { "/api/konto/kustuta": () => answer() });
    await mount();
    localStorage.setItem("mslab-email", "kati@example.test");
    await click($("[data-delete-account]"));
    await click($("[data-delete-yes]"));
    expect($("[data-delete-failed]")?.textContent).toBe("Kustutamine ei õnnestunud. Proovi uuesti.");
    expect($("[data-delete-failed]")?.getAttribute("role")).toBe("alert");
    expect($("[data-delete-confirm]")).not.toBeNull();
    expect(localStorage.getItem("mslab-email")).toBe("kati@example.test");
    expect(assign).not.toHaveBeenCalled();

    vi.spyOn(window.location, "replace").mockImplementation(() => {});
    answer = () => Promise.resolve(json(401, { ok: false, reason: "none" }));
    await click($("[data-delete-yes]"));
    expect(gets()).toHaveLength(2);
  });
});

describe("Parool (phase 2c)", () => {
  const savePassword = async () => {
    await act(async () => $<HTMLFormElement>("[data-password-form]")!.requestSubmit());
    await settle();
  };
  const passwordFields = () => [...document.querySelectorAll<HTMLInputElement>("[data-password-form] input[type=password]")];

  test("without a password: the sentence and 'Määra parool'; the form asks twice; too short, not the same, or the e-mail is said here and nothing is sent; Tühista closes it", async () => {
    api();
    await mount();
    expect($("[data-password-state]")?.textContent).toBe("Saad soovi korral määrata parooli ja siseneda edaspidi e-posti ja parooliga. Kood töötab alati edasi.");
    await click($("[data-password-set]"));
    const [first, second] = passwordFields();
    expect([first.getAttribute("autocomplete"), second.getAttribute("autocomplete")]).toEqual(["new-password", "new-password"]);
    expect(document.activeElement).toBe(first);
    await type(first, "lühike");
    await type(second, "lühike");
    await savePassword();
    expect($("[data-password-error]")?.textContent).toBe("Parool peab olema vähemalt 10 märki.");
    await type(first, "pikk-parool-2026");
    await type(second, "pikk-parool-2025");
    await savePassword();
    expect($("[data-password-error]")?.textContent).toBe("Paroolid ei ühti.");
    await type(first, "kati@example.test");
    await type(second, "kati@example.test");
    await savePassword();
    expect($("[data-password-error]")?.textContent).toBe("Parool ei tohi olla sinu e-posti aadress.");
    expect(sent("/api/konto/parool")).toEqual([]);
    await click($("[data-password-cancel]"));
    expect($("[data-password-form]")).toBeNull();
    expect(document.activeElement).toBe($("[data-password-set]"));
  });

  test("saved: 'Parool on määratud (muudetud {date}).' with 'Muuda parooli' and 'Eemalda parool', and 'Parool on salvestatud.'", async () => {
    api({}, { "/api/konto/parool": async () => json(200, { ok: true, passwordSetAt: "2026-10-08T10:00:00.000Z" }) });
    await mount();
    await click($("[data-password-set]"));
    const [first, second] = passwordFields();
    await type(first, "pikk-parool-2026");
    await type(second, "pikk-parool-2026");
    await savePassword();
    expect(sent("/api/konto/parool")).toEqual([{ password: "pikk-parool-2026" }]);
    expect($("[data-password-state]")?.textContent).toBe("Parool on määratud (muudetud 08.10.2026).");
    expect($("[data-password-status]")?.textContent).toBe("Parool on salvestatud.");
    expect($("[data-password-change]")?.textContent).toBe("Muuda parooli");
    expect($("[data-password-remove]")?.textContent).toBe("Eemalda parool");
    expect(document.activeElement).toBe($("[data-password-change]")); // the form is gone: the focus goes to the button that opens it again
  });

  test("the server's refusals: the e-mail rule, the hour's limit; a failure of ours", async () => {
    let answer = json(400, { ok: false, error: "email" });
    api({}, { "/api/konto/parool": async () => answer });
    await mount();
    await click($("[data-password-set]"));
    const [first, second] = passwordFields();
    await type(first, "pikk-parool-2026");
    await type(second, "pikk-parool-2026");
    await savePassword();
    expect($("[data-password-error]")?.textContent).toBe("Parool ei tohi olla sinu e-posti aadress.");
    answer = json(429, { ok: false, error: "rate" });
    await savePassword();
    expect($("[data-password-error]")?.textContent).toBe("Oled parooli juba mitu korda muutnud. Proovi tunni aja pärast uuesti.");
    answer = json(500, { ok: false, error: "server" });
    await savePassword();
    expect($("[data-password-error]")?.textContent).toBe("Ei õnnestunud salvestada. Proovi uuesti.");
  });

  test("with a password: 'Eemalda parool' asks once; 'Jah, eemalda' sends DELETE and the sentence without one comes back", async () => {
    api({ passwordSetAt: "2026-10-01T09:00:00.000Z" });
    await mount();
    expect($("[data-password-state]")?.textContent).toBe("Parool on määratud (muudetud 01.10.2026).");
    await click($("[data-password-remove]"));
    expect($("[data-password-confirm]")?.textContent).toContain("Kas eemaldame parooli? Saad edasi siseneda koodiga.");
    await click($("[data-password-remove-yes]"));
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/konto/parool" && init?.method === "DELETE")).toBe(true);
    expect($("[data-password-state]")?.getAttribute("data-password-state")).toBe("none");
    expect($("[data-password-status]")?.textContent).toBe("Parool on eemaldatud.");
  });

  test("Russian", async () => {
    api({ locale: "ru", passwordSetAt: "2026-10-01T09:00:00.000Z" });
    await mount("ru");
    expect($("[data-password-state]")?.textContent).toBe("Пароль задан (изменён 01.10.2026).");
  });
});

describe("Parool: the rest of the behaviour", () => {
  const savePassword = async () => {
    await act(async () => $<HTMLFormElement>("[data-password-form]")!.requestSubmit());
    await settle();
  };
  const passwordFields = () => [...document.querySelectorAll<HTMLInputElement>("[data-password-form] input[type=password]")];
  const SET = { passwordSetAt: "2026-10-01T09:00:00.000Z" };

  test("the part sits between the newsletter switch and 'Kustuta konto'", async () => {
    api();
    await mount();
    const [newsletter, password, danger] = ["[data-details-newsletter]", "[data-details-password]", "[data-delete-account]"].map((s) => $(s)!);
    expect(newsletter.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(password.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(password.tagName).toBe("SECTION");
    expect(password.getAttribute("aria-labelledby")).not.toBeNull();
    expect($(`#${CSS.escape(password.getAttribute("aria-labelledby")!)}`)?.textContent).toBe("Parool");
  });

  test("the form is accessible: two labelled fields, the error is read (alert) and tied to both, invalid until typed again; 'Salvesta parool' is not the primary button", async () => {
    api();
    await mount();
    await click($("[data-password-set]"));
    const [first, second] = passwordFields();
    expect(document.querySelector(`label[for='${first.id}']`)?.textContent).toBe("Uus parool");
    expect(document.querySelector(`label[for='${second.id}']`)?.textContent).toBe("Korda parooli");
    expect($("[data-password-save]")?.className).toMatch(/btnOutline/);
    expect($("[data-details-save]")?.className).not.toMatch(/btnOutline/); // the profile's "Salvesta" stays the one primary button
    expect($("[data-password-error]")?.getAttribute("role")).toBe("alert");
    expect(first.hasAttribute("aria-invalid")).toBe(false);
    await savePassword(); // empty: too short
    const describedBy = $("[data-password-error]")!.id;
    expect([first, second].map((f) => [f.getAttribute("aria-describedby"), f.getAttribute("aria-invalid")])).toEqual([
      [describedBy, "true"],
      [describedBy, "true"],
    ]);
    await type(first, "x");
    expect($("[data-password-error]")?.textContent).toBe("");
    expect(first.hasAttribute("aria-invalid")).toBe(false);
  });

  test("the server's own short / long answers are said too; a 200 without the date is a failure of ours", async () => {
    let answer = json(400, { ok: false, error: "short" });
    api({}, { "/api/konto/parool": async () => answer });
    await mount();
    await click($("[data-password-set]"));
    const [first, second] = passwordFields();
    await type(first, "pikk-parool-2026");
    await type(second, "pikk-parool-2026");
    await savePassword();
    expect($("[data-password-error]")?.textContent).toBe("Parool peab olema vähemalt 10 märki.");
    answer = json(400, { ok: false, error: "long" });
    await savePassword();
    expect($("[data-password-error]")?.textContent).toBe("Parool võib olla kuni 200 märki.");
    answer = json(200, { ok: true });
    await savePassword();
    expect($("[data-password-error]")?.textContent).toBe("Ei õnnestunud salvestada. Proovi uuesti.");
    expect($("[data-password-form]")).not.toBeNull();
  });

  test("one change at a time: a second submit while the first is on its way sends nothing", async () => {
    let release: (r: Response) => void = () => {};
    api({}, { "/api/konto/parool": () => new Promise<Response>((resolve) => (release = resolve)) });
    await mount();
    await click($("[data-password-set]"));
    const [first, second] = passwordFields();
    await type(first, "pikk-parool-2026");
    await type(second, "pikk-parool-2026");
    await savePassword();
    expect($("[data-password-save]")?.getAttribute("aria-disabled")).toBe("true");
    await savePassword();
    expect(sent("/api/konto/parool")).toHaveLength(1);
    await act(async () => release(json(200, { ok: true, passwordSetAt: "2026-10-08T10:00:00.000Z" })));
    await settle();
    expect($("[data-password-state]")?.getAttribute("data-password-state")).toBe("set");
  });

  test("a removal on its way: 'Muuda parooli' opens no form (the answer would close it); the answer then ends the removal as asked", async () => {
    let release: (r: Response) => void = () => {};
    api(SET, { "/api/konto/parool": () => new Promise<Response>((resolve) => (release = resolve)) });
    await mount();
    await click($("[data-password-remove]"));
    await click($("[data-password-remove-yes]"));
    expect($("[data-password-remove-yes]")?.getAttribute("aria-disabled")).toBe("true");
    await click($("[data-password-change]"));
    expect($("[data-password-form]")).toBeNull();
    expect($("[data-password-confirm]")).not.toBeNull();
    await act(async () => release(json(200, { ok: true })));
    await settle();
    expect($("[data-password-state]")?.getAttribute("data-password-state")).toBe("none");
    expect($("[data-password-form]")).toBeNull();
    expect($("[data-password-status]")?.textContent).toBe("Parool on eemaldatud.");
  });

  test("a failed removal says 'Ei õnnestunud eemaldada.' (not the saving's words), keeps the question and the password; the retry works", async () => {
    let answer = json(500, { ok: false, error: "server" });
    api(SET, { "/api/konto/parool": async () => answer });
    await mount();
    await click($("[data-password-remove]"));
    await click($("[data-password-remove-yes]"));
    expect($("[data-password-status]")?.textContent).toBe("Ei õnnestunud eemaldada. Proovi uuesti.");
    expect($("[data-password-status]")?.className).toMatch(/error/);
    expect($("[data-password-confirm]")).not.toBeNull();
    expect($("[data-password-state]")?.getAttribute("data-password-state")).toBe("set");
    answer = json(200, { ok: true });
    await click($("[data-password-remove-yes]"));
    expect($("[data-password-state]")?.getAttribute("data-password-state")).toBe("none");
    expect($("[data-password-status]")?.textContent).toBe("Parool on eemaldatud.");
    expect($("[data-password-status]")?.className).not.toMatch(/error/);
    expect(document.activeElement).toBe($("[data-password-set]"));
  });

  test("a removal over the hour's limit (429 rate) says the limit's sentence, in the error style, and keeps the question and the password; other failures keep 'Ei õnnestunud eemaldada.'", async () => {
    let answer = json(429, { ok: false, error: "rate" });
    api(SET, { "/api/konto/parool": async () => answer });
    await mount();
    await click($("[data-password-remove]"));
    await click($("[data-password-remove-yes]"));
    expect($("[data-password-status]")?.textContent).toBe("Oled parooli juba mitu korda muutnud. Proovi tunni aja pärast uuesti.");
    expect($("[data-password-status]")?.className).toMatch(/error/);
    expect($("[data-password-confirm]")).not.toBeNull();
    expect($("[data-password-state]")?.getAttribute("data-password-state")).toBe("set");
    answer = json(500, { ok: false, error: "server" });
    await click($("[data-password-remove-yes]"));
    expect($("[data-password-status]")?.textContent).toBe("Ei õnnestunud eemaldada. Proovi uuesti.");
  });

  test("the same limit in Russian", async () => {
    api({ ...SET, locale: "ru" }, { "/api/konto/parool": async () => json(429, { ok: false, error: "rate" }) });
    await mount("ru");
    await click($("[data-password-remove]"));
    await click($("[data-password-remove-yes]"));
    expect($("[data-password-status]")?.textContent).toBe(getDict("ru").account.details.password.rate);
    expect($("[data-password-status]")?.textContent).toMatch(/[а-я]/);
  });

  test("the question takes the focus; Tühista and Esc give it back to 'Eemalda parool' and send nothing", async () => {
    api(SET);
    await mount();
    await click($("[data-password-remove]"));
    const step = $("[data-password-confirm]");
    expect(document.activeElement).toBe(step);
    expect(step?.getAttribute("role")).toBe("group");
    expect($(`#${CSS.escape(step!.getAttribute("aria-labelledby")!)}`)?.textContent).toBe("Kas eemaldame parooli? Saad edasi siseneda koodiga.");
    expect([...step!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Jah, eemalda", "Tühista"]);
    await click($("[data-password-remove-no]"));
    expect($("[data-password-confirm]")).toBeNull();
    expect(document.activeElement).toBe($("[data-password-remove]"));
    await click($("[data-password-remove]"));
    await act(async () => $("[data-password-confirm]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect($("[data-password-confirm]")).toBeNull();
    expect(document.activeElement).toBe($("[data-password-remove]"));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  test("'Muuda parooli' opens the same form; Tühista gives the focus back to it", async () => {
    api(SET);
    await mount();
    await click($("[data-password-change]"));
    expect($("[data-password-form]")).not.toBeNull();
    expect($("[data-password-state]")).toBeNull();
    expect(document.activeElement).toBe(passwordFields()[0]);
    await click($("[data-password-cancel]"));
    expect($("[data-password-state]")?.getAttribute("data-password-state")).toBe("set");
    expect(document.activeElement).toBe($("[data-password-change]"));
  });

  test("a 401 on saving or removing loads the page's data again", async () => {
    vi.spyOn(window.location, "replace").mockImplementation(() => {});
    api(SET, { "/api/konto/parool": async () => json(401, { ok: false, reason: "none" }) });
    await mount();
    await click($("[data-password-remove]"));
    await click($("[data-password-remove-yes]"));
    expect(gets()).toHaveLength(2);
    await click($("[data-password-remove-no]"));
    await click($("[data-password-change]"));
    const [first, second] = passwordFields();
    await type(first, "pikk-parool-2026");
    await type(second, "pikk-parool-2026");
    await savePassword();
    expect(gets()).toHaveLength(3);
  });

  test("Russian: the strings, with a no-break space after one-letter words (в, с, к, о, у)", async () => {
    api({ locale: "ru" });
    await mount("ru");
    expect($("[data-password-state]")?.textContent).toBe("При желании вы можете задать пароль и входить по e-mail и паролю. Вход по коду всегда остаётся доступным.");
    expect($("[data-password-set]")?.textContent).toBe("Задать пароль");
    const { password } = getDict("ru").account.details;
    expect(Object.values(password).filter((text) => /(^|\s)[вскоуВСКОУ] \S/.test(text))).toEqual([]);
    expect(password.removeFailed).toBe("Не удалось удалить. Попробуйте ещё раз.");
    expect(password.email).toBe("Пароль не может совпадать с\u00a0вашим e-mail.");
    expect(password.removeQuestion).toBe("Удалить пароль? Вы сможете входить с\u00a0кодом.");
  });
});
