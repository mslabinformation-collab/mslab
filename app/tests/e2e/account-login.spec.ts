import type { Page } from "@playwright/test";
import { clearPasswordLock, clientEmail, expireLogins, insertClient, knownLoginCode, signInAsClient } from "./account";
import { onLocalDb, removeClientRows } from "./fixtures";
import { smallTargets } from "./targets";
import { LOCAL_URL, TARGET } from "./target";
import { submitsForms, test, expect } from "./test";

// Phase 2a Task 5: the client login page /konto/sisene (a code by e-mail), the header's "Minu konto" and the "signed in on
// another device" message (spec 2.1 rules 1, 3, 8). Every address is a sample one (`@example.test`, never mailed); each test
// starts by removing its own address's rows. A typo test that needs a real-looking domain answers the login request in the
// browser itself, so such an address never reaches the server.

const LOGIN = "/konto/sisene";
/** The signed-in /konto: "Minu koolitused" (account-dashboard.spec.ts tests it). */
const DASHBOARD = "[data-account-dashboard]";

const emailField = (page: Page) => page.getByLabel("E-post", { exact: true });
const codeField = (page: Page) => page.getByLabel("Kood", { exact: true });

/**
 * Opens the login page and waits until its form handles the submit itself (data-login-ready): the page-wide ready mark
 * (test.ts) can come first, and a tap before the form has hydrated posts the plain form (the page opens again, empty).
 */
async function openLogin(page: Page, path = LOGIN): Promise<void> {
  await page.goto(path);
  await expect(page.locator("[data-login-ready]")).toBeAttached();
}

/** The header's account button (and the phone menu's) says "Minu konto" → /konto, or "Logi sisse" → the login page. */
async function expectAccountButton(page: Page, isMobile: boolean, signedIn: boolean): Promise<void> {
  const links = page.locator("[data-account-link]");
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("data-account-link", signedIn ? "in" : "out");
    await expect(link).toHaveAttribute("href", signedIn ? "/konto" : "/konto/sisene");
  }
  const label = signedIn ? "Minu konto" : "Logi sisse";
  if (isMobile) {
    await page.locator("header").getByRole("button", { name: "Ava menüü" }).click();
    await expect(page.getByRole("dialog").getByRole("link", { name: label, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  } else {
    await expect(page.locator("header").getByRole("link", { name: label, exact: true })).toBeVisible();
  }
}

const WAIT = /^Uue koodi saad saata (\d+) s pärast\.$/;
/** Under "Saada uus kood" once a new code was asked for (final review M10: the lockout says what to do, the same for every address). */
const NO_MAIL = "Kui kirja ei tule, proovi poole tunni pärast uuesti.";

/** Counts this page's POSTs to /api/konto/login and /api/konto/code. */
function countPosts(page: Page): { login: number; code: number } {
  const posts = { login: 0, code: 0 };
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    const path = new URL(r.url()).pathname;
    if (path === "/api/konto/login") posts.login++;
    if (path === "/api/konto/code") posts.code++;
  });
  return posts;
}

/** Fills in the e-mail and asks for the code; the code step is on screen afterwards, its field focused. */
async function askForCode(page: Page, email: string): Promise<void> {
  await emailField(page).fill(email);
  await page.getByRole("button", { name: "Saada kood" }).click();
  await expect(page.getByText(`Saatsime 6-kohalise koodi aadressile ${email}.`)).toBeVisible();
  await expect(codeField(page)).toBeFocused();
}

test("a code by e-mail signs in and opens Minu konto; the header follows, and Logi sisse is back after logging out", async ({ page, isMobile }, info) => {
  submitsForms();
  const email = clientEmail("code", info.project.name);
  await removeClientRows(email);
  await openLogin(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Logi sisse");
  await expectAccountButton(page, isMobile, false);

  await askForCode(page, email);
  const field = codeField(page);
  await expect(field).toHaveAttribute("inputmode", "numeric");
  await expect(field).toHaveAttribute("autocomplete", "one-time-code");
  await expect(field).toHaveAttribute("maxlength", "6");
  await expect(page.getByText("Ei leia kirja? Vaata ka rämpsposti kausta.")).toBeVisible();
  // one primary button, usable at six digits; "Saada uus kood" waits its 60 s as quiet text; "Muuda e-posti"
  await expect(page.getByRole("button", { name: "Logi sisse", exact: true })).toBeDisabled();
  await expect(page.locator("[data-login-wait]")).toHaveText(WAIT);
  await expect(page.getByRole("button", { name: "Saada uus kood" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Muuda e-posti" })).toBeVisible();
  // big, readable digits in the site's number font (Jost)
  const digits = await field.evaluate((e) => ({ size: parseFloat(getComputedStyle(e).fontSize), font: getComputedStyle(e).fontFamily }));
  expect(digits.size).toBeGreaterThanOrEqual(32);
  expect(digits.font).toMatch(/Jost/i);

  // the sixth digit signs in by itself
  await field.pressSequentially(await knownLoginCode(email));
  await expect(page).toHaveURL(/\/konto$/);
  await expect(page.locator(DASHBOARD)).toBeVisible();
  await expectAccountButton(page, isMobile, true);

  await page.evaluate(() => fetch("/api/konto/logout", { method: "POST" }));
  await page.reload();
  // signed out, /konto sends the visitor to the login page, the e-mail already filled in
  await expect(page).toHaveURL(/\/konto\/sisene$/);
  await expect(emailField(page)).toHaveValue(email);
  await expectAccountButton(page, isMobile, false);
});

test("a login with the code forgets the favourites copy a previous session left on this device, also when the first account load fails", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("code-copy", info.project.name);
  await removeClientRows(email);
  try {
    await openLogin(page);
    // the previous person's hearts, left in this browser (as if they had never logged out)
    await page.evaluate(() => localStorage.setItem("mslab-account-fav", JSON.stringify(["kulmude-lami"])));
    await askForCode(page, email);
    // Minu koolitused cannot load this time (every load until it says so: the dev server's strict mode asks twice)
    await page.route("**/api/konto", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"ok":false,"error":"server"}' }));
    await codeField(page).pressSequentially(await knownLoginCode(email));
    await expect(page).toHaveURL(/\/konto$/);
    await expect(page.locator("[data-account-state='error']")).toBeVisible();
    await page.unroute("**/api/konto");
    expect(await page.evaluate(() => localStorage.getItem("mslab-account-fav"))).toBeNull();
  } finally {
    await removeClientRows(email);
  }
});

test("a wrong code says so, empties the field and keeps the focus there; the right code still signs in", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("wrong", info.project.name);
  await removeClientRows(email);
  await openLogin(page);
  await askForCode(page, email);
  const code = await knownLoginCode(email);
  const field = codeField(page);
  await field.pressSequentially(code === "000000" ? "111111" : "000000");
  await expect(page.getByText("Kood ei sobi. Proovi uuesti.")).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription(new RegExp(`Kood ei sobi\\. Proovi uuesti\\.`));
  await field.pressSequentially(code);
  await expect(page).toHaveURL(/\/konto$/);
});

test("an expired code asks for a new one, with Saada uus kood ready and focused; a pasted code with a space signs in", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("expired", info.project.name);
  await removeClientRows(email);
  await openLogin(page);
  await askForCode(page, email);
  await expireLogins(email);
  await codeField(page).pressSequentially("123456");
  await expect(page.getByText("Kood on aegunud. Saada uus kood.")).toBeVisible();
  const resend = page.getByRole("button", { name: "Saada uus kood", exact: true });
  await expect(resend).toBeEnabled();
  await expect(resend).toBeFocused();
  await expect(page.getByText(NO_MAIL)).toHaveCount(0);
  await resend.click();
  await expect(page.getByText("Saatsime uue koodi.")).toBeVisible();
  await expect(codeField(page)).toBeFocused();
  await expect(page.locator("[data-login-wait]")).toHaveText(WAIT); // the next one in 60 s
  await expect(resend).toHaveCount(0);
  // the same answer whether or not a mail went out: what to do if none comes (an address with its logins used up waits)
  await expect(page.getByText(NO_MAIL)).toBeVisible();

  // "123 456" pasted from the e-mail
  const code = await knownLoginCode(email);
  await codeField(page).evaluate((input, text) => {
    const data = new DataTransfer();
    data.setData("text", text);
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, `${code.slice(0, 3)} ${code.slice(3)}`);
  await expect(page).toHaveURL(/\/konto$/);
});

test("Saada uus kood waits 60 seconds, counted down as quiet text, then sends a new code", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("resend", info.project.name);
  await removeClientRows(email);
  await page.clock.install();
  await openLogin(page);
  await askForCode(page, email);
  const wait = page.locator("[data-login-wait]");
  const resend = page.getByRole("button", { name: "Saada uus kood", exact: true });
  await expect(wait).toHaveText("Uue koodi saad saata 60 s pärast.");
  await expect(resend).toHaveCount(0);
  await page.clock.fastForward("00:30");
  await expect(wait).toHaveText(/^Uue koodi saad saata 3\d s pärast\.$/);
  await page.clock.fastForward("00:31");
  await expect(wait).toHaveCount(0);
  await expect(resend).toBeEnabled();
  await expect(page.getByText(NO_MAIL)).toHaveCount(0); // not before a new code was asked for
  await resend.click();
  await expect(page.getByText("Saatsime uue koodi.")).toBeVisible();
  await expect(wait).toHaveText("Uue koodi saad saata 60 s pärast.");
  await expect(resend).toHaveCount(0);
  await expect(page.getByText(NO_MAIL)).toBeVisible();
  // typing the code takes "Saatsime uue koodi." away; the line stays, until Muuda e-posti
  await codeField(page).pressSequentially("1");
  await expect(page.getByText("Saatsime uue koodi.")).toHaveCount(0);
  await expect(page.getByText(NO_MAIL)).toBeVisible();
  await page.getByRole("button", { name: "Muuda e-posti" }).click();
  await expect(page.getByText(NO_MAIL)).toHaveCount(0);
});

test("the code step's one button: Logi sisse works at six digits; Enter before that asks for all six; the sixth digit and Enter sign in once", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("button", info.project.name);
  await removeClientRows(email);
  const posts = countPosts(page);
  await openLogin(page);
  await askForCode(page, email);
  const button = page.getByRole("button", { name: "Logi sisse", exact: true });
  const field = codeField(page);
  await field.pressSequentially("12");
  await expect(button).toBeDisabled();
  await page.keyboard.press("Enter"); // a phone's "Go" is Enter too
  await expect(page.getByText("Sisesta kõik 6 numbrit.")).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("12");
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
  expect(posts.code, "nothing is checked before six digits").toBe(0);

  await field.fill("");
  await expect(page.getByText("Sisesta kõik 6 numbrit.")).toHaveCount(0); // typing again takes the hint away
  await field.pressSequentially(await knownLoginCode(email));
  await page.keyboard.press("Enter"); // right after the sixth digit, which has already sent the code
  await expect(page).toHaveURL(/\/konto$/);
  expect(posts).toEqual({ login: 1, code: 1 });
});

test("after a failure of ours the code stays in the field, and Logi sisse tries it again", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("retry", info.project.name);
  await removeClientRows(email);
  await openLogin(page);
  await askForCode(page, email);
  const code = await knownLoginCode(email);
  let failing = true;
  await page.route("**/api/konto/code", (route) =>
    failing ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "server" }) }) : route.fallback(),
  );
  await codeField(page).pressSequentially(code);
  await expect(page.getByText("Midagi läks valesti. Proovi uuesti.")).toBeVisible();
  await expect(codeField(page)).toHaveValue(code);
  failing = false;
  await page.getByRole("button", { name: "Logi sisse", exact: true }).click();
  await expect(page).toHaveURL(/\/konto$/);
});

test("the code step survives a reload (a phone that dropped the tab) with the rest of its 60 s, without a new code; Muuda e-posti forgets it", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("reload", info.project.name);
  await removeClientRows(email);
  const posts = countPosts(page);
  await openLogin(page);
  await askForCode(page, email);
  await page.reload();
  await expect(page.locator("[data-login-step='code']")).toBeVisible();
  await expect(page.getByText(`Saatsime 6-kohalise koodi aadressile ${email}.`)).toBeVisible();
  await expect(codeField(page)).toBeFocused();
  const seconds = Number(WAIT.exec((await page.locator("[data-login-wait]").textContent()) ?? "")?.[1]);
  expect(seconds).toBeGreaterThan(0);
  expect(seconds).toBeLessThanOrEqual(60);
  expect(posts.login, "the reload sends nothing").toBe(1);

  await page.getByRole("button", { name: "Muuda e-posti" }).click();
  await page.reload();
  await expect(page.locator("[data-login-step='email']")).toBeVisible();
  await expect(emailField(page)).toHaveValue(email);

  // signed in from a kept code step, the step is forgotten
  await askForCode(page, email);
  await page.reload();
  await codeField(page).pressSequentially(await knownLoginCode(email));
  await expect(page).toHaveURL(/\/konto$/);
  expect(await page.evaluate(() => sessionStorage.getItem("mslab-login-code"))).toBeNull();
  // (signed in, the login page would open Minu konto: sign out first to see it, once the dashboard's own request is answered)
  await expect(page.locator(DASHBOARD)).toBeVisible();
  await page.evaluate(() => fetch("/api/konto/logout", { method: "POST" }));
  await openLogin(page);
  await expect(page.locator("[data-login-step='email']")).toBeVisible();
});

test("a typo in a common domain asks Kas mõtlesid …? first: Jah, paranda corrects and sends, Ei, saada nii sends as typed", async ({ page }) => {
  const typed = ["kati", "gmial.com"].join("@");
  const fixed = ["kati", "gmail.com"].join("@");
  const sent: string[] = [];
  // answered here: the address never reaches the server (the domain is a real one)
  await page.route("**/api/konto/login", async (route) => {
    sent.push((route.request().postDataJSON() as { email: string }).email);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await openLogin(page);
  const field = emailField(page);
  await field.fill(`  ${typed.toUpperCase()} `); // trimmed and lower-cased as well
  await page.getByRole("button", { name: "Saada kood" }).click();
  await expect(page.getByText(`Kas mõtlesid ${fixed}?`)).toBeVisible();
  await expect(field).toHaveValue(typed);
  await expect(page.getByRole("button", { name: "Saada kood" })).toHaveCount(0); // the two answers take its place
  const yes = page.getByRole("button", { name: "Jah, paranda" });
  await expect(yes).toBeFocused();
  expect(sent, "nothing is sent before the answer").toEqual([]);
  await yes.click();
  await expect(page.getByText(`Saatsime 6-kohalise koodi aadressile ${fixed}.`)).toBeVisible();
  expect(sent).toEqual([fixed]);
  await page.getByRole("button", { name: "Muuda e-posti" }).click();
  await expect(field).toHaveValue(fixed); // the field is corrected
  await expect(field).toBeFocused();

  await field.fill(typed);
  await page.getByRole("button", { name: "Saada kood" }).click();
  await page.getByRole("button", { name: "Ei, saada nii" }).click();
  await expect(page.getByText(`Saatsime 6-kohalise koodi aadressile ${typed}.`)).toBeVisible();
  expect(sent).toEqual([fixed, typed]);
});

test("errors say what to do: a malformed address, too many tries, a server or network failure", async ({ page }) => {
  let answer: "rate" | "server" | "email" | "network" = "rate";
  let requests = 0;
  await page.route("**/api/konto/login", async (route) => {
    requests++;
    if (answer === "network") return route.abort("connectionfailed");
    const [status, body] = answer === "rate" ? [429, { ok: false, error: "rate" }] : answer === "email" ? [400, { ok: false, error: "email" }] : [500, { ok: false, error: "server" }];
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await openLogin(page);
  const field = emailField(page);
  const send = page.getByRole("button", { name: "Saada kood" });

  await field.fill("kati");
  await send.click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAccessibleDescription("Sisesta korrektne e-posti aadress.");
  await expect(field).toBeFocused();
  expect(requests, "a malformed address is not sent").toBe(0);

  const address = "e2e-client-errors@example.test";
  for (const [kind, text] of [
    ["rate", "Liiga palju katseid. Proovi mõne minuti pärast uuesti."],
    ["server", "Midagi läks valesti. Proovi uuesti."],
    ["network", "Midagi läks valesti. Proovi uuesti."],
    ["email", "Sisesta korrektne e-posti aadress."],
  ] as const) {
    answer = kind;
    await field.fill(address);
    await send.click();
    await expect(field, kind).toHaveAccessibleDescription(text);
    await expect(page.locator("[data-login-step='email']"), kind).toBeVisible(); // still the e-mail step, the address kept
    await expect(field).toHaveValue(address);
  }
});

test("the e-mail is remembered; a used or old link and a server failure show a notice above the filled-in form", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("again", info.project.name);
  await removeClientRows(email);
  // "Saada uus kood" without a remembered e-mail: just the empty form (its parameter is in the fragment, which no server or cache sees)
  await openLogin(page, `${LOGIN}#korda=1`);
  await expect(page).toHaveURL(/\/konto\/sisene$/);
  await expect(page.locator("[data-login-step='email']")).toBeVisible();
  await expect(emailField(page)).toHaveValue("");

  await askForCode(page, email);
  // the next visit (a new tab: the code step is kept per tab) starts with the e-mail filled in
  const next = await page.context().newPage();
  await next.goto(LOGIN);
  await expect(next.locator("[data-login-ready]")).toBeAttached();
  await expect(next.locator("[data-login-step='email']")).toBeVisible();
  await expect(emailField(next)).toHaveValue(email);
  await next.close();

  // the e-mail's button, used already or too old: the API sends the visitor here with #viga=link
  const verify = await page.request.get(`/api/konto/verify?t=${"e2e".repeat(15)}`, { maxRedirects: 0 });
  expect(verify.status()).toBe(303);
  expect(new URL(verify.headers()["location"]).pathname + new URL(verify.headers()["location"]).hash).toBe("/konto/sisene#viga=link");
  await page.goto(`/api/konto/verify?t=${"e2e".repeat(15)}`);
  await expect(page).toHaveURL(/\/konto\/sisene$/); // the parameter is read and removed: a reload does not repeat it
  await expect(page.locator("[data-login-banner='link']")).toHaveText("Link on aegunud või juba kasutatud. Saada uus kood.");
  await expect(emailField(page)).toHaveValue(email);

  await page.goto("/"); // (a visit that differs from the open page by its fragment only would not load it again)
  await page.goto(`${LOGIN}#viga=server`);
  await expect(page.locator("[data-login-banner='server']")).toHaveText("Midagi läks valesti. Proovi uuesti.");
  await expect(page).toHaveURL(/\/konto\/sisene$/);
  await expect(emailField(page)).toHaveValue(email);
  await page.reload();
  await expect(page.locator("[data-login-banner]")).toHaveCount(0);
});

test("a link that is already out there, with its parameter in the query, lands on the clean page with its notice: the server answers 303 to the fragment, the query is never rendered", async ({ page }) => {
  // asked directly: a 303 with no body to the same path, the parameter in the fragment, never kept
  const asked = await page.request.get(`${LOGIN}?viga=link`, { maxRedirects: 0 });
  expect(asked.status()).toBe(303);
  expect(asked.headers()["location"]).toBe("/konto/sisene#viga=link");
  expect(asked.headers()["cache-control"]).toBe("no-store");
  // a browser follows it: the clean address, the notice
  await page.goto(`${LOGIN}?viga=link`);
  await expect(page.locator("[data-login-ready]")).toBeAttached();
  await expect(page).toHaveURL(/\/konto\/sisene$/);
  await expect(page.locator("[data-login-banner='link']")).toHaveText("Link on aegunud või juba kasutatud. Saada uus kood.");
  await page.reload();
  await expect(page.locator("[data-login-banner]")).toHaveCount(0);
  // Russian, with a parameter we do not know: dropped
  await page.goto(`/ru/konto/sisene?viga=server&utm_source=x`);
  await expect(page).toHaveURL(/\/ru\/konto\/sisene$/);
  await expect(page.locator("[data-login-banner='server']")).toHaveText("Что-то пошло не так. Попробуйте ещё раз.");
});

test("an address in the fragment (#email=, the account button of an e-mail) fills the field once, before the remembered one, and is removed", async ({ page }) => {
  const remembered = "e2e-client-remembered@example.test";
  const given = "E2E-Client-Given@Example.test";
  await page.addInitScript((address) => localStorage.setItem("mslab-email", address), remembered);
  await openLogin(page, `${LOGIN}#email=${encodeURIComponent(given)}`);
  await expect(page).toHaveURL(/\/konto\/sisene$/);
  await expect(emailField(page)).toHaveValue(given.toLowerCase());
  await page.reload();
  await expect(page.locator("[data-login-ready]")).toBeAttached();
  await expect(emailField(page)).toHaveValue(remembered); // once: the parameter is gone, the remembered address is back
  // something that is no address is ignored
  await page.goto("/");
  await openLogin(page, `${LOGIN}#email=nope`);
  await expect(emailField(page)).toHaveValue(remembered);
  await expect(page).toHaveURL(/\/konto\/sisene$/);
  // and with a query, the old way (the server moves it into the fragment)
  await page.goto("/");
  await openLogin(page, `${LOGIN}?email=${encodeURIComponent(given)}`);
  await expect(emailField(page)).toHaveValue(given.toLowerCase());
  await expect(page).toHaveURL(/\/konto\/sisene$/);
});

/** The login page's address from the link under the code in a confirmation e-mail: the address and `kood=1` in the fragment. */
const codeStepLink = (email: string, path = LOGIN) => `${path}#email=${encodeURIComponent(email)}&kood=1`;

test("the link under the code in a confirmation e-mail (#email=…&kood=1) opens the code step for that address and sends nothing; the code from the e-mail signs in", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("kood", info.project.name);
  await removeClientRows(email);
  try {
    const code = await knownLoginCode(email); // the live login the e-mail carried
    const posts = countPosts(page);
    await openLogin(page, codeStepLink(email));
    await expect(page.locator("[data-login-step='code']")).toBeVisible();
    await expect(page.getByText(`Saatsime 6-kohalise koodi aadressile ${email}.`)).toBeVisible();
    await expect(codeField(page)).toBeFocused();
    await expect(page).toHaveURL(/\/konto\/sisene$/); // the parameters are removed from the address
    // a new code can be asked for at once (the code may be old): no 60 s wait
    await expect(page.getByRole("button", { name: "Saada uus kood", exact: true })).toBeEnabled();
    await expect(page.locator("[data-login-wait]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Logi sisse", exact: true })).toBeDisabled();
    // nothing was sent from this tab, so no code step is kept for a reload
    expect(await page.evaluate(() => sessionStorage.getItem("mslab-login-code"))).toBeNull();

    await codeField(page).pressSequentially(code);
    await expect(page).toHaveURL(/\/konto$/);
    await expect(page.locator(DASHBOARD)).toBeVisible();
    expect(posts, "the page sent no code request: only the typed code was checked").toEqual({ login: 0, code: 1 });
  } finally {
    await removeClientRows(email);
  }
});

test("#kood=1 with a code that has expired: Kood on aegunud, and Saada uus kood, ready at once, sends a new one that signs in", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("kood-old", info.project.name);
  await removeClientRows(email);
  try {
    const old = await knownLoginCode(email);
    await expireLogins(email);
    const posts = countPosts(page);
    await openLogin(page, codeStepLink(email));
    await expect(page.locator("[data-login-step='code']")).toBeVisible();
    await codeField(page).pressSequentially(old);
    await expect(page.getByText("Kood on aegunud. Saada uus kood.")).toBeVisible();
    const resend = page.getByRole("button", { name: "Saada uus kood", exact: true });
    await expect(resend).toBeEnabled();
    await expect(resend).toBeFocused();
    expect(posts.login).toBe(0);
    await resend.click();
    await expect(page.getByText("Saatsime uue koodi.")).toBeVisible();
    expect(posts.login).toBe(1);
    await expect(page.locator("[data-login-wait]")).toHaveText(WAIT); // from now on the 60 s count
    await codeField(page).pressSequentially(await knownLoginCode(email));
    await expect(page).toHaveURL(/\/konto$/);
  } finally {
    await removeClientRows(email);
  }
});

test("#kood=1 without an address is ignored, #viga beats it, and the code step it opens is not kept for a reload", async ({ page }, info) => {
  const email = clientEmail("kood-rules", info.project.name);
  await openLogin(page, `${LOGIN}#kood=1`);
  await expect(page.locator("[data-login-step='email']")).toBeVisible();
  await expect(page).toHaveURL(/\/konto\/sisene$/);
  await page.goto("/");
  await openLogin(page, `${LOGIN}#email=nope&kood=1`);
  await expect(page.locator("[data-login-step='email']")).toBeVisible();

  await page.goto("/");
  await openLogin(page, `${LOGIN}#viga=link&email=${encodeURIComponent(email)}&kood=1`);
  await expect(page.locator("[data-login-step='email']")).toBeVisible();
  await expect(page.locator("[data-login-banner='link']")).toBeVisible();
  await expect(emailField(page)).toHaveValue(email);

  await page.goto("/");
  await openLogin(page, codeStepLink(email));
  await expect(page.locator("[data-login-step='code']")).toBeVisible();
  await page.reload();
  await expect(page.locator("[data-login-ready]")).toBeAttached();
  await expect(page.locator("[data-login-step='email']")).toBeVisible(); // nothing was sent from this tab: nothing to come back to
});

test("an old or mangled link with ?kood=1 in the query is moved into the fragment by the server and works the same (Estonian and Russian)", async ({ page }, info) => {
  const email = clientEmail("kood-query", info.project.name);
  const query = `kood=1&email=${encodeURIComponent(email)}`;
  const asked = await page.request.get(`${LOGIN}?${query}`, { maxRedirects: 0 });
  expect(asked.status()).toBe(303);
  expect(asked.headers()["location"]).toBe(`/konto/sisene#email=${encodeURIComponent(email)}&kood=1`);
  await page.goto(`${LOGIN}?${query}`);
  await expect(page.locator("[data-login-ready]")).toBeAttached();
  await expect(page.locator("[data-login-step='code']")).toBeVisible();
  await expect(page).toHaveURL(/\/konto\/sisene$/);

  await page.goto("/");
  await page.goto(`/ru/konto/sisene?${query}`);
  await expect(page.locator("[data-login-ready]")).toBeAttached();
  await expect(page.locator("[data-login-step='code']")).toBeVisible();
  await expect(page.getByText(`Мы отправили 6-значный код на адрес ${email}.`)).toBeVisible();
  await expect(page).toHaveURL(/\/ru\/konto\/sisene$/);
});

test("signed in on another device: one message and one button, which sends a new code and opens the code field", async ({ page, browser, isMobile }, info) => {
  submitsForms();
  const email = clientEmail("replaced", info.project.name);
  await removeClientRows(email);
  await signInAsClient(page, email);
  await expect(page.locator(DASHBOARD)).toBeVisible();

  // the same student signs in on another device (another browser)
  const other = await browser.newContext({ baseURL: TARGET || LOCAL_URL });
  try {
    await signInAsClient(await other.newPage(), email);
  } finally {
    await other.close();
  }

  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sinu konto avati teises seadmes");
  const again = page.getByRole("link", { name: "Saada uus kood" });
  await expect(again).toBeVisible();
  await expect(again).toHaveAttribute("href", "/konto/sisene#korda=1"); // the parameter travels in the fragment
  await expect(page.locator("main").getByRole("link")).toHaveCount(1); // one button, nothing else to choose
  await expectAccountButton(page, isMobile, false); // the answer cleared the hint cookie

  const posts = countPosts(page);
  await again.click();
  await expect(page).toHaveURL(/\/konto\/sisene$/);
  await expect(page.getByText(`Saatsime 6-kohalise koodi aadressile ${email}.`)).toBeVisible();
  await expect(codeField(page)).toBeFocused();
  await codeField(page).pressSequentially(await knownLoginCode(email));
  await expect(page).toHaveURL(/\/konto$/);
  await expect(page.locator(DASHBOARD)).toBeVisible();
  expect(posts.login, "?korda=1 sends exactly one code").toBe(1);
});

test("an account page that cannot load says so, and Proovi uuesti asks again (here: not signed in, so the login page opens)", async ({ page }) => {
  let failing = true;
  await page.route("**/api/konto", (route) =>
    failing ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "server" }) }) : route.fallback(),
  );
  await page.goto("/konto");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ei õnnestunud laadida.");
  await expect(page).toHaveURL(/\/konto$/); // no redirect: the visitor may well be signed in
  failing = false;
  await page.getByRole("button", { name: "Proovi uuesti" }).click();
  await expect(page).toHaveURL(/\/konto\/sisene$/);
});

test("in Russian: the page speaks Russian, the code opens /ru/konto and a first login makes a Russian account; a failed link opens the Russian page", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("ru", info.project.name);
  await removeClientRows(email);
  await openLogin(page, "/ru/konto/sisene");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Войти");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Отправить код" }).click();
  await expect(page.getByText(`Мы отправили 6-значный код на адрес ${email}.`)).toBeVisible();
  await expect(page.getByText("Не видите письма? Загляните в папку «Спам».")).toBeVisible();
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeDisabled();
  await expect(page.locator("[data-login-wait]")).toHaveText(/^Новый код можно отправить через \d+ с\.$/);
  await page.getByLabel("Код", { exact: true }).pressSequentially(await knownLoginCode(email));
  await expect(page).toHaveURL(/\/ru\/konto$/);
  await expect(page.locator(DASHBOARD)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Здравствуйте!"); // "Мои курсы" in Russian
  const [client] = await onLocalDb((sql) => sql<{ locale: string }[]>`select locale from clients where email = ${email}`);
  expect(client.locale, "the account speaks the language of the page it was made on").toBe("ru");

  // the button of a Russian e-mail (l=ru), used already or too old: the Russian login page says so
  await page.goto(`/api/konto/verify?t=${"e2e".repeat(15)}&l=ru`);
  await expect(page).toHaveURL(/\/ru\/konto\/sisene$/);
  await expect(page.locator("[data-login-banner='link']")).toHaveText("Ссылка устарела или уже использована. Отправьте новый код.");
});

test("no horizontal overflow on both login steps: this project's width, then 834 and 2560", async ({ page }) => {
  await page.route("**/api/konto/login", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
  const scrolls = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  for (const size of [null, { width: 834, height: 1112 }, { width: 2560, height: 1300 }]) {
    if (size) await page.setViewportSize(size);
    for (const path of [LOGIN, "/ru/konto/sisene"]) {
      const at = `${path} at ${size?.width ?? "the project's width"}`;
      await openLogin(page, path);
      await expect(page.locator("[data-login-step='email']")).toBeVisible();
      expect(await scrolls(), `${at}: e-mail step`).toBe(false);
      await page.locator("[data-login-email] input").fill("e2e-client-a-very-long-address-for-the-layout-check@example.test");
      await page.locator("[data-login-email] button[type='submit']").click();
      await expect(page.locator("[data-login-step='code']")).toBeVisible();
      expect(await scrolls(), `${at}: code step`).toBe(false);
      await page.evaluate(() => sessionStorage.clear()); // the next path starts at the e-mail step, not the kept code step
    }
  }
});

/** The words of the page's heading on the screen (the h1's own box is wider than they are): their left edge and their middle; and the h1's top on the page. */
const headingWords = (page: Page) =>
  page.locator("main h1").evaluate((h) => {
    const range = document.createRange();
    range.selectNodeContents(h);
    const box = range.getBoundingClientRect();
    return { left: box.left, middle: (box.left + box.right) / 2, top: h.getBoundingClientRect().top + window.scrollY };
  });

/** Where the page's content starts: the left padding of `selector` (the site's side padding, --page). */
const contentEdge = (page: Page, selector: string) => page.locator(selector).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));

/** The middle of an element on the screen. */
const middleOf = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return box.x + box.width / 2;
};

test("wider than 900 px the login page (both steps), Sinu konto avati teises seadmes and the 404 stand in the middle with their labels at the left; at 900 and 390 px at the left edge; every heading at the same height; the empty cart always at the left", async ({ page }) => {
  // Dim 06.11: the 440 px column stood under the logo on a wide screen. The heading of the login page and of the message pages it leads to
  // and from share the page's middle and its height, so it stays where it was when one leads to the other; the labels and fields keep their left edge.
  await page.route("**/api/konto/login", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
  await page.route("**/api/konto", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ ok: false, reason: "replaced" }) }));
  for (const width of [1440, 901, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const wide = width > 900;
    const at = `at ${width} px`;

    await openLogin(page);
    const login = await headingWords(page);
    const edge = await contentEdge(page, "[data-login-step]");
    if (wide) {
      expect(Math.abs(login.middle - width / 2), `${at}: „Logi sisse“ in the middle`).toBeLessThanOrEqual(1);
      expect(Math.abs((await middleOf(page, "[data-login-step] > div")) - width / 2), `${at}: the column in the middle`).toBeLessThanOrEqual(1);
    } else {
      expect(Math.abs(login.left - edge), `${at}: „Logi sisse“ at the left edge`).toBeLessThanOrEqual(1);
    }
    const label = (await page.locator("[data-login-email] label").boundingBox())!;
    const field = (await emailField(page).boundingBox())!;
    expect(Math.abs(label.x - field.x), `${at}: the label „E-post“ starts where its field does`).toBeLessThanOrEqual(1);

    await emailField(page).fill("e2e-client-layout-centre@example.test");
    await page.getByRole("button", { name: "Saada kood" }).click();
    await expect(page.locator("[data-login-step='code']")).toBeVisible();
    const code = await headingWords(page);
    expect(Math.abs(code.left - login.left), `${at}: the code step's heading where the e-mail step's was`).toBeLessThanOrEqual(1);
    expect(Math.abs(code.top - login.top), `${at}: … and at its height`).toBeLessThanOrEqual(1);
    // the code field a little taller than the e-mail field, never the block it was (Dim 06.11: about 80 px looked enormous)
    const codeHeight = (await codeField(page).boundingBox())!.height;
    expect(codeHeight, `${at}: „Kood“ is no lower than „E-post“`).toBeGreaterThanOrEqual(field.height);
    expect(codeHeight, `${at}: „Kood“ is at most 60 px tall`).toBeLessThanOrEqual(60);
    await page.evaluate(() => sessionStorage.clear()); // the next width starts at the e-mail step, not the kept code step

    await page.goto("/konto");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sinu konto avati teises seadmes");
    const replaced = await headingWords(page);
    if (wide) expect(Math.abs(replaced.middle - login.middle), `${at}: its heading shares the login heading's middle`).toBeLessThanOrEqual(1);
    else expect(Math.abs(replaced.left - login.left), `${at}: its heading starts where the login heading does`).toBeLessThanOrEqual(1);
    expect(Math.abs(replaced.top - login.top), `${at}: its heading at the login heading's height`).toBeLessThanOrEqual(1);

    await page.goto("/olematu-leht");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lehte ei leitud");
    const missing = await headingWords(page);
    if (wide) expect(Math.abs(missing.middle - width / 2), `${at}: the 404 heading in the middle`).toBeLessThanOrEqual(1);
    else expect(Math.abs(missing.left - edge), `${at}: the 404 heading at the left edge`).toBeLessThanOrEqual(1);
    expect(Math.abs(missing.top - login.top), `${at}: the 404 heading at the login heading's height`).toBeLessThanOrEqual(1);

    await page.goto("/ostukorv");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ostukorv on tühi");
    const cart = await headingWords(page);
    expect(Math.abs(cart.left - (await contentEdge(page, "[data-notice-align='start']"))), `${at}: the empty cart at the left edge`).toBeLessThanOrEqual(1);
    expect(Math.abs(cart.top - login.top), `${at}: … at the login heading's height`).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), `${at}: no horizontal overflow`).toBe(false);
  }
});

// ---------- a browser that is signed in already (final review I2) ----------

/** The pages this tab loads as documents (paths in order): a redirect loop would show as a growing list. */
function documents(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) paths.push(new URL(r.url()).pathname);
  });
  return paths;
}

/** The readable hint cookie `mslab_in=1` alone, without a session: what a browser keeps when its session ended unseen. */
const staleHint = () => ({ name: "mslab_in", value: "1", url: TARGET || LOCAL_URL });

test("signed in, the login page and the account button of a confirmation e-mail (#email= her own address) open Minu konto at once, with no code asked for", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("forward", info.project.name);
  await removeClientRows(email);
  try {
    await signInAsClient(page, email);
    await expect(page.locator(DASHBOARD)).toBeVisible();
    const posts = countPosts(page);
    await page.goto("/");
    await page.goto(`${LOGIN}#email=${encodeURIComponent(email)}`);
    await expect(page).toHaveURL(/\/konto$/);
    await expect(page.locator(DASHBOARD)).toBeVisible();
    // in place of the login page in the history: Back goes to the page before it
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    // the plain login page, and the Russian one (Minu konto in the page's language)
    await page.goto(LOGIN);
    await expect(page).toHaveURL(/\/konto$/);
    await page.goto(`/ru/konto/sisene#email=${encodeURIComponent(email)}`);
    await expect(page).toHaveURL(/\/ru\/konto$/);
    await expect(page.locator(DASHBOARD)).toBeVisible();
    expect(posts, "no code was asked for or checked").toEqual({ login: 0, code: 0 });
  } finally {
    await removeClientRows(email);
  }
});

test("signed in, the login page stays for another address (a shared device) and for an address that asks it for something (viga, kood, korda)", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("stay", info.project.name);
  const other = clientEmail("stay-other", info.project.name);
  await removeClientRows(email);
  try {
    await signInAsClient(page, email);
    await expect(page.locator(DASHBOARD)).toBeVisible();
    await openLogin(page, `${LOGIN}#email=${encodeURIComponent(other)}`);
    await expect(page).toHaveURL(/\/konto\/sisene$/);
    await expect(page.locator("[data-login-step='email']")).toBeVisible();
    await expect(emailField(page)).toHaveValue(other);

    await page.goto("/");
    await openLogin(page, `${LOGIN}#viga=link`);
    await expect(page.locator("[data-login-banner='link']")).toBeVisible();

    await page.goto("/");
    await openLogin(page, `${LOGIN}#email=${encodeURIComponent(email)}&kood=1`);
    await expect(page.locator("[data-login-step='code']")).toBeVisible();

    // korda=1 sends a code (answered here: this test spends none)
    await page.route("**/api/konto/login", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
    await page.goto("/");
    await openLogin(page, `${LOGIN}#korda=1`);
    await expect(page.locator("[data-login-step='code']")).toBeVisible();
    await expect(page).toHaveURL(/\/konto\/sisene$/);
  } finally {
    await removeClientRows(email);
  }
});

test("a hint cookie without a session (stale): the login page tries Minu konto once, which clears it and sends her back to the form; no loop", async ({ page, context }) => {
  await context.addCookies([staleHint()]);
  const loads = documents(page);
  await page.goto(LOGIN);
  await expect(page).toHaveURL(/\/konto\/sisene$/);
  await expect(page.locator("[data-login-ready]")).toBeAttached();
  await expect(page.locator("[data-login-step='email']")).toBeVisible();
  expect((await context.cookies()).some((c) => c.name === "mslab_in"), "the 401 cleared the hint").toBe(false);
  await page.waitForTimeout(1500); // nothing more happens
  expect(loads).toEqual([LOGIN, "/konto", LOGIN]);
});

test("a hint the server could not clear still does not loop: the account page marks the way back (#valja=1) and the login page shows its form", async ({ page, context }) => {
  await context.addCookies([staleHint()]);
  // "signed out", answered here without the cookie that clears the hint
  await page.route("**/api/konto", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ ok: false, reason: "none" }) }));
  const loads = documents(page);
  await page.goto(LOGIN);
  await expect(page.locator("[data-login-ready]")).toBeAttached();
  await expect(page.locator("[data-login-step='email']")).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/konto\/sisene$/); // the mark is read and removed
  expect((await context.cookies()).some((c) => c.name === "mslab_in"), "the hint is still there").toBe(true);
  expect(loads).toEqual([LOGIN, "/konto", LOGIN]);
});

// ---------- the password (phase 2c, Task 14): "Sisene parooliga" ----------

test("a password (phase 2c): set in Minu andmed; after logging out 'Sisene parooliga' signs in with it; a wrong one says so; 5 wrong ones lock it", async ({ page }, info) => {
  submitsForms();
  const email = clientEmail("password", info.project.name);
  await removeClientRows(email);
  await clearPasswordLock(email);
  await insertClient(email);
  try {
    await signInAsClient(page, email);
    await page.goto("/konto/andmed");
    await page.getByRole("button", { name: "Määra parool" }).click();
    await page.getByLabel("Uus parool").fill("pikk-parool-2026");
    await page.getByLabel("Korda parooli").fill("pikk-parool-2026");
    await page.getByRole("button", { name: "Salvesta parool" }).click();
    await expect(page.locator("[data-password-status]")).toHaveText("Parool on salvestatud.");
    await page.evaluate(() => fetch("/api/konto/logout", { method: "POST" }));

    await openLogin(page);
    await page.getByRole("button", { name: "Sisene parooliga" }).click();
    await expect(page).toHaveURL(/\/konto\/sisene#parool$/);
    await emailField(page).fill(email);
    await page.getByLabel("Parool", { exact: true }).fill("vale-parool-2026");
    await page.getByRole("button", { name: "Logi sisse", exact: true }).click();
    await expect(page.locator("[data-login-password-error]")).toHaveText("E-post või parool ei sobi.");
    await expect(page.getByLabel("Parool", { exact: true })).toHaveValue(""); // the wrong password is gone ...
    await expect(page.getByLabel("Parool", { exact: true })).toBeFocused(); // ... and the field is ready for the next one
    await expect(page.getByLabel("Parool", { exact: true })).toHaveAccessibleDescription("E-post või parool ei sobi.");
    await page.reload(); // the step stays (#parool)
    await expect(page.locator("[data-login-step]")).toHaveAttribute("data-login-step", "password");
    await emailField(page).fill(email);
    await page.getByLabel("Parool", { exact: true }).fill("pikk-parool-2026");
    await page.getByRole("button", { name: "Logi sisse", exact: true }).click();
    await expect(page).toHaveURL(/\/konto$/);
    await expect(page.locator(DASHBOARD)).toBeVisible();

    // the lock: 5 wrong ones (one above) and then even the right one is refused for 15 minutes
    await page.evaluate(() => fetch("/api/konto/logout", { method: "POST" }));
    await openLogin(page, `${LOGIN}#parool`);
    await emailField(page).fill(email);
    for (let i = 0; i < 4; i++) {
      await page.getByLabel("Parool", { exact: true }).fill(`vale-${i}-parool-2026`);
      await page.getByRole("button", { name: "Logi sisse", exact: true }).click();
      await expect(page.locator("[data-login-password-error]")).toHaveText("E-post või parool ei sobi.");
    }
    await page.getByLabel("Parool", { exact: true }).fill("pikk-parool-2026");
    await page.getByRole("button", { name: "Logi sisse", exact: true }).click();
    await expect(page.locator("[data-login-password-error]")).toHaveText("Liiga palju katseid. Proovi 15 minuti pärast uuesti või sisene koodiga.");
    await page.getByRole("button", { name: "Saada mulle hoopis kood" }).click();
    await expect(page.locator("[data-login-step]")).toHaveAttribute("data-login-step", "email");
    expect(new URL(page.url()).hash).toBe("");
  } finally {
    await clearPasswordLock(email);
    await removeClientRows(email);
  }
});

test("the password never leaves the request: not in the address, the storage or the history, while it is typed and while the request is out; the fields pair user name and password for a password manager", async ({ page }) => {
  const SECRET = "salajane-parool-2026";
  const sent: { url: string; body: string }[] = [];
  // the request is held (the answer waits for `release`), so everything below can be looked at while the password is still typed
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/konto/parool-login", async (route) => {
    sent.push({ url: route.request().url(), body: route.request().postData() ?? "" });
    await held;
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "password" }) });
  });
  /** Where the browser could keep the password: the address, both storages, the history entry's state and the cookies. */
  const leaks = () =>
    page.evaluate(
      (secret) => ({
        address: location.href.includes(secret),
        storage: JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes(secret),
        history: JSON.stringify(history.state ?? null).includes(secret),
        cookies: document.cookie.includes(secret),
      }),
      SECRET,
    );
  const none = { address: false, storage: false, history: false, cookies: false };

  await openLogin(page, `${LOGIN}#parool`);
  const password = page.getByLabel("Parool", { exact: true });
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await expect(emailField(page)).toHaveAttribute("autocomplete", "username"); // the user name of the password, as a password manager pairs them
  await emailField(page).fill("e2e-client-password-leak@example.test");
  await password.fill(SECRET);
  await expect(password).toHaveValue(SECRET);
  expect(await leaks(), "typed, nothing sent yet").toEqual(none);

  await page.getByRole("button", { name: "Logi sisse", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(password).toHaveValue(SECRET); // still typed (read-only), the answer is on hold
  expect(await leaks(), "the request is out").toEqual(none);
  // React keeps a controlled field's value in the markup (the value attribute) while it is typed: the password is in the page then, in the
  // field only. What is guaranteed is the list above and that it is gone from the page when the answer empties the field (below).
  expect(sent[0].url).not.toContain(SECRET);
  expect(JSON.parse(sent[0].body)).toEqual({ email: "e2e-client-password-leak@example.test", password: SECRET, locale: "et" });

  release();
  await expect(page.locator("[data-login-password-error]")).toHaveText("E-post või parool ei sobi.");
  await expect(password).toHaveValue("");
  expect(await leaks(), "after a wrong answer").toEqual(none);
  expect(await page.content(), "a wrong answer empties the field: the password is nowhere in the page").not.toContain(SECRET);

  // the way back to the code: its e-mail field keeps the autocomplete it had before the password step existed
  await page.getByRole("button", { name: "Saada mulle hoopis kood" }).click();
  await expect(emailField(page)).toHaveAttribute("autocomplete", "email");
});

/** The password step and the link to it at 390, 834 and 1440 px, in both languages: no overflow, no control under 44 px, nothing outside the screen. */
for (const [language, prefix] of [["Estonian", ""], ["Russian", "/ru"]] as const) {
  test(`the password step in ${language} holds at 390, 834 and 1440 px: the link, the step, a wrong answer and the lock (no overflow, targets of 44 px)`, async ({ page }, info) => {
    const ru = prefix === "/ru";
    const words = ru
      ? { to: "Войти с паролем", code: "Лучше пришлите мне код", wrong: "E-mail или пароль не подходят.", locked: "Слишком много попыток. Попробуйте через 15 минут или войдите с кодом.", submit: "Войти", password: "Пароль", email: "E-mail" }
      : { to: "Sisene parooliga", code: "Saada mulle hoopis kood", wrong: "E-post või parool ei sobi.", locked: "Liiga palju katseid. Proovi 15 minuti pärast uuesti või sisene koodiga.", submit: "Logi sisse", password: "Parool", email: "E-post" };
    let answer: 400 | 429 = 400;
    await page.route("**/api/konto/parool-login", (route) =>
      route.fulfill({ status: answer, contentType: "application/json", body: JSON.stringify({ ok: false, error: answer === 400 ? "password" : "locked" }) }),
    );
    const own = info.project.use.viewport!;
    const holds = async (label: string) => {
      for (const width of [390, 834, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const box = (await page.locator("[data-login-step]").boundingBox())!;
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${label}: no horizontal overflow at ${width}`).toBe(true);
        expect(await smallTargets(page.locator("[data-login-step]")), `${label}: every control is 44 px or taller at ${width}`).toEqual([]);
        expect(box.x >= 0 && box.x + box.width <= width, `${label}: the page is on the screen at ${width}`).toBe(true);
      }
      await page.setViewportSize(own);
    };

    await openLogin(page, `${prefix}${LOGIN}`);
    await expect(page.getByRole("button", { name: words.to, exact: true })).toBeVisible();
    await holds(`${language} / the e-mail step with the link`);

    await page.getByRole("button", { name: words.to, exact: true }).click();
    await expect(page).toHaveURL(/#parool$/);
    await expect(page.getByRole("button", { name: words.code, exact: true })).toBeVisible();
    await holds(`${language} / the password step`);

    await page.getByLabel(words.email, { exact: true }).fill("e2e-client-layout-check@example.test");
    await page.getByLabel(words.password, { exact: true }).fill("vale-parool-2026");
    await page.getByRole("button", { name: words.submit, exact: true }).click();
    await expect(page.locator("[data-login-password-error]")).toHaveText(words.wrong);
    await holds(`${language} / a wrong answer`);

    answer = 429;
    await page.getByLabel(words.password, { exact: true }).fill("vale-parool-2026");
    await page.getByRole("button", { name: words.submit, exact: true }).click();
    await expect(page.locator("[data-login-password-error]")).toHaveText(words.locked);
    await expect(page.getByRole("button", { name: words.code, exact: true })).toBeVisible(); // the way out of a lock stays on the page
    await holds(`${language} / the lock`);

    await page.getByRole("button", { name: words.code, exact: true }).click();
    await expect(page.locator("[data-login-step]")).toHaveAttribute("data-login-step", "email");
    expect(new URL(page.url()).hash).toBe("");
  });
}
