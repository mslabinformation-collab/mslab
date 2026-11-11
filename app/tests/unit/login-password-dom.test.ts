// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LoginForm } from "@/components/account/LoginForm";
import { PENDING_KEY } from "@/components/account/useAccount";
import { getDict, type Locale } from "@/i18n/locales";

// The login page's password step (phase 2c, spec 7): "Sisene parooliga" under the e-mail step, its own step kept in the fragment
// (#parool), "Saada mulle hoopis kood" back, and the answers of POST /api/konto/parool-login.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const replace = vi.fn<(url: string | URL) => void>();
const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const type = async (input: HTMLInputElement | null, value: string) => {
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const mount = async (locale: Locale = "et") => {
  const d = getDict(locale);
  await act(async () => root.render(createElement(LoginForm, { locale, t: { ...d.account.login, title: d.nav.login, badEmail: d.forms.errorEmail } })));
  await settle();
};
const signIn = async () => {
  await act(async () => $<HTMLFormElement>("[data-login-password]")!.requestSubmit());
  await settle();
};
const emailInput = () => $<HTMLInputElement>("[data-login-password] input[type=email]")!;
const pw = () => $<HTMLInputElement>("[data-login-password] input[type=password]")!;
const step = () => $("section")?.getAttribute("data-login-step");
const message = () => $("[data-login-password-error]")?.textContent;
/** Everything this page keeps in the browser (both storages) and its address, as one text. */
const keptInBrowser = () => {
  const kept: string[] = [window.location.href];
  for (const storage of [localStorage, sessionStorage]) for (let i = 0; i < storage.length; i++) kept.push(`${storage.key(i)}=${storage.getItem(storage.key(i)!)}`);
  return kept.join(" | ");
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  replace.mockReset();
  vi.spyOn(window.location, "replace").mockImplementation(replace);
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/konto/sisene");
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

test("'Sisene parooliga' opens the e-mail and password step and keeps it in the address (#parool); 'Saada mulle hoopis kood' goes back", async () => {
  await mount();
  await click($("[data-login-to-password]"));
  expect($("section")?.getAttribute("data-login-step")).toBe("password");
  expect(window.location.hash).toBe("#parool");
  expect([pw().name, pw().type, pw().getAttribute("autocomplete")]).toEqual(["password", "password", "current-password"]);
  expect([emailInput().name, emailInput().getAttribute("autocomplete")]).toEqual(["email", "username"]); // a password manager pairs the user name with the password
  await click($("[data-login-to-code]"));
  expect($("section")?.getAttribute("data-login-step")).toBe("email");
  expect(window.location.hash).toBe("");
});

test("#parool in the address opens the password step at once (a reload keeps it)", async () => {
  window.history.replaceState(null, "", "/konto/sisene#parool");
  await mount();
  expect($("section")?.getAttribute("data-login-step")).toBe("password");
});

test("the right e-mail and password: POST parool-login with the page's language, then 'Minu konto' in place of this page", async () => {
  fetchMock.mockResolvedValue(json(200, { ok: true, locale: "et" }));
  window.history.replaceState(null, "", "/konto/sisene#parool");
  await mount();
  await type($<HTMLInputElement>("[data-login-password] input[type=email]"), " Kati@Example.test ");
  await type($<HTMLInputElement>("[data-login-password] input[type=password]"), "pikk-parool-2026");
  await signIn();
  expect(fetchMock.mock.calls[0][0]).toBe("/api/konto/parool-login");
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toEqual({ email: "kati@example.test", password: "pikk-parool-2026", locale: "et" });
  expect(replace).toHaveBeenCalledWith("/konto");
});

test("wrong: 'E-post või parool ei sobi.' and the password emptied; locked: the 15 minutes sentence; our failure: try again", async () => {
  window.history.replaceState(null, "", "/konto/sisene#parool");
  await mount();
  await type(emailInput(), "kati@example.test");
  fetchMock.mockResolvedValueOnce(json(400, { ok: false, error: "password" }));
  await type(pw(), "vale-parool-2026");
  await signIn();
  expect($("[data-login-password-error]")?.textContent).toBe("E-post või parool ei sobi.");
  expect(pw().value).toBe("");
  expect(document.activeElement).toBe(pw());
  fetchMock.mockResolvedValueOnce(json(429, { ok: false, error: "locked" }));
  await type(pw(), "vale-parool-2026");
  await signIn();
  expect($("[data-login-password-error]")?.textContent).toBe("Liiga palju katseid. Proovi 15 minuti pärast uuesti või sisene koodiga.");
  fetchMock.mockResolvedValueOnce(json(500, { ok: false, error: "server" }));
  await signIn();
  expect($("[data-login-password-error]")?.textContent).toBe("Midagi läks valesti. Proovi uuesti.");
  expect(replace).not.toHaveBeenCalled();
});

test("Russian", async () => {
  await mount("ru");
  expect($("[data-login-to-password]")?.textContent).toBe("Войти с\u00a0паролем");
});

// ---------- beyond the brief's four: what the step must also do ----------

test("the e-mail typed in the e-mail step comes along to the password step, the password field has the focus; back, the address is kept and the e-mail field has it", async () => {
  await mount();
  await type($<HTMLInputElement>("[data-login-email] input"), "Kati@Example.test");
  await click($("[data-login-to-password]"));
  expect(step()).toBe("password");
  expect(emailInput().value).toBe("Kati@Example.test");
  expect(document.activeElement).toBe(pw());
  await click($("[data-login-to-code]"));
  expect(step()).toBe("email");
  expect($<HTMLInputElement>("[data-login-email] input")!.value).toBe("Kati@Example.test");
  expect(document.activeElement).toBe($("[data-login-email] input"));
});

test("without an address yet, the e-mail field of the password step has the focus; 'Sisene parooliga' is a quiet button outside the e-mail form, so Enter in the e-mail field still asks for a code", async () => {
  await mount();
  const toPassword = $<HTMLButtonElement>("[data-login-to-password]")!;
  expect(toPassword.type).toBe("button");
  expect(toPassword.closest("form")).toBeNull();
  expect(toPassword.textContent).toBe("Sisene parooliga");
  await click(toPassword);
  expect(document.activeElement).toBe(emailInput());
  expect($("[data-login-to-password]")).toBeNull();
  expect($("[data-login-to-code]")?.textContent).toBe("Saada mulle hoopis kood");
  expect($("[data-login-to-code]")?.closest("form")).toBeNull();
  expect($("[data-login-password] button[type=submit]")?.textContent).toBe("Logi sisse");
});

test("a malformed address and an empty password are told at once and send nothing: the first has the e-mail field, the second the password field", async () => {
  window.history.replaceState(null, "", "/konto/sisene#parool");
  await mount();
  await type(emailInput(), "kati");
  await type(pw(), "pikk-parool-2026");
  await signIn();
  expect(message()).toBe("Sisesta korrektne e-posti aadress.");
  expect(emailInput().getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(emailInput());
  await type(emailInput(), "kati@example.test");
  expect(message()).toBe(""); // typing takes the sentence away
  await type(pw(), "");
  await signIn();
  expect(message()).toBe("E-post või parool ei sobi.");
  expect(pw().getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(pw());
  expect(fetchMock).not.toHaveBeenCalled();
});

test("one sentence for every wrong answer, tied to both fields for a screen reader; typing takes it away", async () => {
  window.history.replaceState(null, "", "/konto/sisene#parool");
  await mount();
  fetchMock.mockResolvedValueOnce(json(400, { ok: false, error: "password" }));
  await type(emailInput(), "kati@example.test");
  await type(pw(), "vale-parool-2026");
  await signIn();
  const sentence = $("[data-login-password-error]")!;
  expect(sentence.id).not.toBe("");
  expect(sentence.getAttribute("aria-live")).toBe("polite");
  expect(emailInput().getAttribute("aria-describedby")).toBe(sentence.id);
  expect(pw().getAttribute("aria-describedby")).toBe(sentence.id);
  expect(pw().getAttribute("aria-invalid")).toBe("true");
  await type(pw(), "x");
  expect(message()).toBe("");
  expect(pw().getAttribute("aria-invalid")).toBeNull();
});

test("locked: the code login stays on the page and works; the way out of a lock is a code, and the typed address goes with it", async () => {
  window.history.replaceState(null, "", "/konto/sisene#parool");
  await mount();
  fetchMock.mockResolvedValueOnce(json(429, { ok: false, error: "locked" }));
  await type(emailInput(), "kati@example.test");
  await type(pw(), "pikk-parool-2026");
  await signIn();
  expect(message()).toBe("Liiga palju katseid. Proovi 15 minuti pärast uuesti või sisene koodiga.");
  expect($("[data-login-to-code]")?.textContent).toBe("Saada mulle hoopis kood");
  await click($("[data-login-to-code]"));
  expect(step()).toBe("email");
  expect(window.location.hash).toBe("");
  expect($<HTMLInputElement>("[data-login-email] input")!.value).toBe("kati@example.test");
  // the password step starts clean when it is opened again: no old sentence, no old password
  await click($("[data-login-to-password]"));
  expect(message()).toBe("");
  expect(pw().value).toBe("");
});

test("a network failure is our failure: 'Midagi läks valesti. Proovi uuesti.', the password is kept for the next try", async () => {
  window.history.replaceState(null, "", "/konto/sisene#parool");
  await mount();
  fetchMock.mockRejectedValueOnce(new TypeError("network"));
  await type(emailInput(), "kati@example.test");
  await type(pw(), "pikk-parool-2026");
  await signIn();
  expect(message()).toBe("Midagi läks valesti. Proovi uuesti.");
  expect(pw().value).toBe("pikk-parool-2026");
  expect(replace).not.toHaveBeenCalled();
});

test("one request at a time: a second submit while the first waits sends nothing; the field is read-only meanwhile", async () => {
  window.history.replaceState(null, "", "/konto/sisene#parool");
  await mount();
  let answer: (res: Response) => void = () => {};
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
  await type(emailInput(), "kati@example.test");
  await type(pw(), "pikk-parool-2026");
  await signIn();
  await signIn();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(pw().readOnly).toBe(true);
  await act(async () => answer(json(400, { ok: false, error: "password" })));
  await settle();
  expect(pw().readOnly).toBe(false);
  expect(message()).toBe("E-post või parool ei sobi.");
});

test("signed in: the e-mail is remembered, the favourites copy of a previous session is forgotten; the password reaches nothing but the request", async () => {
  fetchMock.mockResolvedValue(json(200, { ok: true, locale: "et" }));
  localStorage.setItem("mslab-account-fav", JSON.stringify(["kulmude-lami"]));
  window.history.replaceState(null, "", "/konto/sisene#parool");
  await mount();
  await type(emailInput(), "kati@example.test");
  await type(pw(), "pikk-parool-2026");
  await signIn();
  expect(replace).toHaveBeenCalledWith("/konto");
  expect(localStorage.getItem("mslab-account-fav")).toBeNull();
  expect(keptInBrowser()).toContain("kati@example.test"); // the address is remembered ...
  expect(keptInBrowser()).not.toContain("pikk-parool-2026"); // ... the password never
  expect(fetchMock.mock.calls[0][1]!.method).toBe("POST");
});

test("signed in with the password, a code step this tab kept is forgotten (it must not come back after a logout)", async () => {
  fetchMock.mockResolvedValue(json(200, { ok: true, locale: "et" }));
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ sentTo: "kati@example.test", sentAt: Date.now() }));
  window.history.replaceState(null, "", "/konto/sisene#parool");
  await mount();
  expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull(); // the step is kept until a login ends it
  await type(emailInput(), "kati@example.test");
  await type(pw(), "pikk-parool-2026");
  await signIn();
  expect(replace).toHaveBeenCalledWith("/konto");
  expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
});

test("'Sisene parooliga' does nothing while a code is on its way; the code step then opens with an address without #parool", async () => {
  let answer: (res: Response) => void = () => {};
  fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
  await mount();
  await type($<HTMLInputElement>("[data-login-email] input"), "kati@example.test");
  await act(async () => $<HTMLFormElement>("[data-login-email]")!.requestSubmit());
  await settle();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/konto/login"]); // the code is on its way
  await click($("[data-login-to-password]"));
  expect(step()).toBe("email");
  expect(window.location.hash).toBe("");
  await act(async () => answer(json(200, { ok: true })));
  await settle();
  expect(step()).toBe("code");
  expect(window.location.hash).toBe("");
});

test("a code step never has #parool in the address: an address that still carried it (an old notice link) loses it when the code goes out", async () => {
  window.history.replaceState(null, "", "/konto/sisene?viga=link#parool");
  fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
  await mount();
  expect(step()).toBe("email");
  expect($("[data-login-banner]")).not.toBeNull();
  await type($<HTMLInputElement>("[data-login-email] input"), "kati@example.test");
  await act(async () => $<HTMLFormElement>("[data-login-email]")!.requestSubmit());
  await settle();
  expect(step()).toBe("code");
  expect(window.location.hash).toBe("");
});

test("the strings of the step in Russian, with a no-break space after the one-letter word", async () => {
  window.history.replaceState(null, "", "/ru/konto/sisene#parool");
  await mount("ru");
  expect(step()).toBe("password");
  expect($("[data-login-password] label[for]")?.textContent).toBe("E-mail");
  expect($("[data-login-password] input[type=password]")?.closest("div")?.querySelector("label")?.textContent).toBe("Пароль");
  expect($("[data-login-password] button[type=submit]")?.textContent).toBe("Войти");
  expect($("[data-login-to-code]")?.textContent).toBe("Лучше пришлите мне код");
  await type(emailInput(), "kati@example.test");
  await type(pw(), "pikk-parool-2026");
  fetchMock.mockResolvedValueOnce(json(400, { ok: false, error: "password" }));
  await signIn();
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body)).locale).toBe("ru");
  expect(message()).toBe("E-mail или пароль не подходят.");
  fetchMock.mockResolvedValueOnce(json(429, { ok: false, error: "locked" }));
  await type(pw(), "pikk-parool-2026");
  await signIn();
  expect(message()).toBe("Слишком много попыток. Попробуйте через 15 минут или войдите с\u00a0кодом.");
  fetchMock.mockResolvedValueOnce(json(200, { ok: true, locale: "ru" }));
  await signIn();
  expect(replace).toHaveBeenCalledWith("/ru/konto");
});

// UX pass 11.11 P22 (the Vaiksed board): the e-mail step says whom the page is for and what happens next, under the heading; the other steps do not
test("the e-mail step has the one line under „Logi sisse“; the password step has none", async () => {
  await mount();
  expect($("[data-login-intro]")?.textContent).toBe("Õpilase konto: saadame su e-postile ühekordse koodi. Konto tekib e-koolituse ostu või registreerimisega.");
  await act(async () => $<HTMLButtonElement>("[data-login-to-password]")!.click());
  await settle();
  expect($("[data-login-intro]")).toBeNull();
  await act(async () => root.unmount());
  root = createRoot(container);
  window.history.replaceState(null, "", "/ru/konto/sisene");
  await mount("ru");
  expect($("[data-login-intro]")?.textContent).toBe("Кабинет ученика: мы отправим одноразовый код на ваш e-mail. Кабинет появляется после покупки онлайн-курса или регистрации.");
});
