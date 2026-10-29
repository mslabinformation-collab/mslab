import type { BrowserContext, Page } from "@playwright/test";
import { submitsForms, test, expect } from "./test";
import { ADMIN, freeLoginAddress, lockLogin, unlockLogin } from "./admin-login";
import { authTestEmail, expireAuthToken, onLocalDb, removeAdminRows, sessionExists, storedAuthTokens } from "./fixtures";
import { PROD_BUILD } from "./target";

// Task 11: admin sign-in by magic link. The tests that sign in or ask for a link run against the local dev server only.
// The only allowed address they ask a link for is Dim's (never Maria's: tests/unit/test-addresses.test.ts); locally the
// answer carries the link as devLink and nothing is e-mailed (server/login.ts). A link for Dim is asked for and used up
// (or deleted) under the login lock that every worker shares (admin-login.ts), so the parallel workers never reach the
// per-address cap, and the address's request count (B20: 3 in 10 minutes) is cleared right before each request. The tests
// delete the token and session rows they created. The GET-only tests also run against a deployment.
// Piece 4c, Task 5 (C8): the remembered address and „Muu aadress“ (R-h), the deep link after signing in (B19, R-f), and the 4th request's own
// message (B20, R-g), the same for an allowed and an unknown address.

const SENT_TITLE = "Link on teel";
/** The sent state's sentence (S4-47c), the same for any address: the address typed is in it. */
const sentTo = (address: string) => `Saatsime lingi aadressile ${address.trim()}. See kehtib 15 minutit.`;
const SENT_HINT = "Kirja pole? Vaata rämpsposti või saada uuesti 1 minuti pärast.";
const ADDRESS_LIMIT = "Saatsid juba 3 linki. Proovi 10 minuti pärast uuesti.";
const BUTTON = "Saada sisselogimislink";
const LINK_ERROR = "See sisselogimislink on aegunud või juba kasutatud. Telli uus link.";
const DAY = 24 * 60 * 60;

// Raw tokens and session ids created by the running test (tests of one worker run one after the other).
const created = { tokens: new Set<string>(), sessions: new Set<string>() };

test.afterEach(async () => {
  await removeAdminRows({ tokens: created.tokens, sessions: created.sessions }).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
  unlockLogin(); // a failed test may still hold it
});

const isAdmin = (address: string) => address.trim().toLowerCase() === ADMIN;

/** The link is read from the answer's devLink, which only `next dev` returns (server/login.ts): not on the local production build. */
function opensDevLink(): void {
  test.skip(PROD_BUILD, "opens the devLink: next dev only (a production build never returns it)");
}

const tokenOf = (link: string) => new URL(link).searchParams.get("t")!;
/** The link's path and query, to open on whatever origin the test runs against (the link carries the site's own origin). */
const pathOf = (link: string) => {
  const u = new URL(link);
  return u.pathname + u.search;
};

type Answer = { status: number; headers: Record<string, string>; body: { ok: boolean; devLink?: string; error?: string } };

/**
 * Types the address, clicks the button and returns the server's answer. The answer is read on the way through (a route
 * that fetches it and hands it on): Playwright's own response.json() never returns for these no-store streamed bodies.
 */
async function submitLogin(page: Page, address: string): Promise<Answer> {
  const answer = new Promise<Answer>((resolve, reject) =>
    page
      .route(
        "**/api/auth/request",
        async (route) => {
          try {
            const response = await route.fetch({ headers: await route.request().allHeaders() }); // keeps the visitor's x-forwarded-for
            const body = await response.json();
            await route.fulfill({ response });
            resolve({ status: response.status(), headers: response.headers(), body });
          } catch (e) {
            reject(e);
          }
        },
        { times: 1 },
      )
      .catch(reject),
  );
  if (isAdmin(address)) {
    await lockLogin(); // given back once the link is used (sessionCookie) or deleted
    await freeLoginAddress(); // B20: the test admin asks far more often than 3 times in 10 minutes
  }
  await page.getByLabel("E-post").fill(address);
  await page.getByRole("button", { name: BUTTON }).click();
  const a = await answer;
  if (a.body.devLink) created.tokens.add(tokenOf(a.body.devLink));
  return a;
}

/** Opens the login page and asks for a link. */
async function requestLink(page: Page, address: string): Promise<Answer> {
  await page.goto("/admin/login");
  return submitLogin(page, address);
}

/** The session cookie, if any. Called once the link has been opened: the link is used up, so the login lock is freed. */
async function sessionCookie(context: BrowserContext) {
  unlockLogin();
  const cookie = (await context.cookies()).find((c) => c.name === "__Host-mslab_admin");
  if (cookie) created.sessions.add(cookie.value);
  return cookie;
}

/** Signs in through the form and the devLink; lands on /admin. */
async function signIn(page: Page, context: BrowserContext, address: string): Promise<{ devLink: string; session: string }> {
  const { status, body } = await requestLink(page, address);
  expect(status).toBe(200);
  expect(body.devLink, "devLink in the local answer").toBeTruthy();
  await page.goto(pathOf(body.devLink!));
  await expect(page).toHaveURL(/\/admin$/);
  const cookie = await sessionCookie(context);
  expect(cookie, "session cookie").toBeTruthy();
  return { devLink: body.devLink!, session: cookie!.value };
}

test.describe("guard", () => {
  test("/admin without a session redirects to the login page, uncached and noindex", async ({ page, request }) => {
    const res = await request.get("/admin", { maxRedirects: 0 });
    expect([302, 303, 307]).toContain(res.status());
    expect(new URL(res.headers()["location"], "http://x").pathname).toBe("/admin/login");
    // `next dev` answers pages with "no-cache, must-revalidate"; the production build with "no-store" (checked on the deployment).
    expect(res.headers()["cache-control"]).toMatch(/no-store|no-cache/);
    expect(res.headers()["x-robots-tag"]).toContain("noindex");
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.getByRole("heading", { level: 1, name: "Halduse sisselogimine" })).toBeVisible();
  });

  test("a made-up session cookie is not a session (sent as a header: a __Host- cookie cannot be planted over http)", async ({ request }) => {
    for (const value of ["A".repeat(43), "nope", ""]) {
      const res = await request.get("/admin", { headers: { cookie: `__Host-mslab_admin=${value}` }, maxRedirects: 0 });
      expect([302, 303, 307], value).toContain(res.status());
      expect(new URL(res.headers()["location"], "http://x").pathname).toBe("/admin/login");
    }
  });

  test("B19: an admin page opened signed out sends her to the login page with the page as ?tagasi= (its query too; the fragment stays in the address bar)", async ({ page, request }) => {
    const res = await request.get("/admin/kalender?id=uus", { maxRedirects: 0 });
    expect([302, 303, 307]).toContain(res.status());
    const location = new URL(res.headers()["location"], "http://x");
    expect(location.pathname + location.search).toBe("/admin/login?tagasi=%2Fadmin%2Fkalender%3Fid%3Duus");
    await page.goto("/admin/testimine#kirjad-halduse-link");
    await expect(page).toHaveURL(/\/admin\/login\?tagasi=%2Fadmin%2Ftestimine#kirjad-halduse-link$/);
    // the panel's front page needs no way back: a sign-in lands there anyway
    const front = await request.get("/admin", { maxRedirects: 0 });
    expect(new URL(front.headers()["location"], "http://x").search).toBe("");
  });

  test("the admin login endpoints answer with Cache-Control: no-store", async ({ request }) => {
    const verify = await request.get("/api/auth/verify?t=nope", { maxRedirects: 0 });
    expect(verify.headers()["cache-control"]).toContain("no-store");
    expect(verify.headers()["referrer-policy"]).toBe("no-referrer");
    expect(verify.headers()["set-cookie"]).toBeUndefined();
  });
});

test.describe("login page", () => {
  test("Estonian page with its own root layout: noindex, labelled field, post form, logo, 44px targets, no overflow", async ({ page }) => {
    await page.goto("/admin/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "et");
    await expect(page).toHaveTitle(/Haldus/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const form = page.locator("[data-login-form]");
    await expect(form).toHaveAttribute("method", "post");
    const email = page.getByLabel("E-post");
    await expect(email).toHaveAttribute("type", "email");
    await expect(email).toHaveAttribute("autocomplete", "email");
    const button = page.getByRole("button", { name: BUTTON });
    await expect(button).toBeVisible();
    await expect(page.getByRole("link", { name: "MS LAB Koolituskeskuse avalehele" })).toHaveAttribute("href", "/");
    await expect(page.getByRole("link", { name: "MS LAB Koolituskeskuse avalehele" }).locator("img")).toBeVisible();
    for (const target of [email, button]) expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // the fonts of the shared module are applied (Jost heading, Manrope body)
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-family", /Jost/);
    await expect(button).toHaveCSS("font-family", /Manrope/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    // keyboard order: the field, then the button
    await email.focus();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
  });

  test("a link that did not work says so", async ({ page }) => {
    await page.goto("/admin/login?viga=link");
    await expect(page.locator("main").getByRole("alert")).toHaveText(LINK_ERROR);
    await page.goto("/admin/login?viga=server");
    await expect(page.locator("main").getByRole("alert")).toHaveText("Sisselogimine ei õnnestunud. Proovi uuesti.");
    await page.goto("/admin/login?viga=whatever");
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  });

  test("a wrong address: error on the field, focus on it, the typed text is kept; nothing is stored", async ({ page }) => {
    submitsForms();
    await page.goto("/admin/login");
    const email = page.getByLabel("E-post");
    await email.fill("vale-aadress");
    await page.getByRole("button", { name: BUTTON }).click();
    await expect(email).toBeFocused();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email).toHaveAccessibleDescription("Sisesta korrektne e-posti aadress.");
    await expect(email).toHaveValue("vale-aadress");
    await email.fill("");
    await page.getByRole("button", { name: BUTTON }).click();
    await expect(email).toBeFocused();
    await expect(page.locator("[data-login-status]")).toBeEmpty();
  });
});

// The test admin only (written loosely, as people type it), greeted by its ADMIN_NAMES name (.env.example).
for (const [address, name] of [[` ${ADMIN.toUpperCase()} `, "Dim"]] as const) {
  test(`${name}: the link from the e-mail signs in; the session lasts 30 days; logout ends it`, async ({ page, context, request, baseURL, isMobile }) => {
    submitsForms();
    opensDevLink();
    const { headers, body } = await requestLink(page, address);
    expect(headers["cache-control"]).toContain("no-store");
    // the neutral confirmation (S4-47c), announced in the status region, replaces the form
    const status = page.locator("[data-login-status]");
    await expect(status.getByRole("heading", { level: 2 })).toHaveText(SENT_TITLE);
    await expect(status.locator("[data-login-sent]")).toHaveText(sentTo(address));
    await expect(status).toContainText(SENT_HINT);
    await expect(status).toBeFocused();
    await expect(page.locator("[data-login-form]")).toBeHidden();

    await page.goto(pathOf(body.devLink!));
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Tere, ${name}.`);
    await expect(page.locator("html")).toHaveAttribute("lang", "et");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

    const cookie = (await sessionCookie(context))!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.expires - Date.now() / 1000).toBeGreaterThan(30 * DAY - 120);
    expect(cookie.expires - Date.now() / 1000).toBeLessThanOrEqual(30 * DAY + 5);
    expect(await page.evaluate(() => document.cookie)).not.toContain("__Host-mslab_admin"); // HttpOnly
    expect(await sessionExists(cookie.value)).toBe(true);

    // still signed in after a reload and on the login page, which sends a signed-in admin on to the panel
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Tere, ${name}.`);
    await page.goto("/admin/login");
    await expect(page).toHaveURL(/\/admin$/);

    // the session counts under the __Host- name only (positive control for the replay check after logout)
    const asHeader = (name: string) => request.get("/admin", { headers: { cookie: `${name}=${cookie.value}` }, maxRedirects: 0 });
    expect((await asHeader("__Host-mslab_admin")).status()).toBe(200);
    expect([302, 303, 307]).toContain((await asHeader("mslab_admin")).status());

    // logout: POST from the button (in the sidebar; on a phone in the menu drawer); the session row is deleted and the
    // cookie cleared
    if (isMobile) await page.getByRole("button", { name: "Ava menüü" }).click();
    await page.getByRole("button", { name: "Logi välja" }).click();
    await expect(page).toHaveURL(/\/admin\/login$/);
    expect(await sessionCookie(context)).toBeUndefined();
    expect(await sessionExists(cookie.value)).toBe(false);
    // R-h: the login page fills in the address the link went to, with „Muu aadress“ to empty the field
    const field = page.getByLabel("E-post");
    await expect(field).toHaveValue(address.trim());
    await page.getByRole("button", { name: "Muu aadress" }).click();
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
    await expect(page.getByRole("button", { name: "Muu aadress" })).toHaveCount(0);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login$/);
    // the old cookie value is dead even when presented again
    const replay = await request.get("/admin", { headers: { cookie: `__Host-mslab_admin=${cookie.value}` }, maxRedirects: 0 });
    expect([302, 303, 307]).toContain(replay.status());
    expect(new URL(replay.headers()["location"], baseURL!).pathname).toBe("/admin/login");
  });
}

test.describe("the link", () => {
  test("works once: a second opening, in any browser, is refused", async ({ page, context, browser, baseURL }) => {
    submitsForms();
    opensDevLink();
    const { devLink, session } = await signIn(page, context, ADMIN);
    expect(await storedAuthTokens(ADMIN)).toContainEqual({ used: true });
    // another browser: the used link gives it no session
    const second = await (await browser.newContext({ baseURL: baseURL! })).newPage();
    await second.goto(pathOf(devLink));
    await expect(second).toHaveURL(/\/admin\/login\?viga=link$/);
    await expect(second.locator("main").getByRole("alert")).toHaveText(LINK_ERROR);
    expect((await second.context().cookies()).find((c) => c.name === "__Host-mslab_admin")).toBeUndefined();
    await second.context().close();
    expect(await sessionExists(session)).toBe(true); // the first session was not touched
  });

  test("a HEAD request (mail scanner) does not use it up", async ({ page, context, request }) => {
    submitsForms();
    opensDevLink();
    const { body } = await requestLink(page, ADMIN);
    const head = await request.head(pathOf(body.devLink!));
    expect(head.status()).toBe(405);
    await page.goto(pathOf(body.devLink!));
    await expect(page).toHaveURL(/\/admin$/);
    await sessionCookie(context);
  });

  test("a prefetch (Sec-Purpose / Purpose) is sent to the login page without using the link up", async ({ page, context, request }) => {
    submitsForms();
    opensDevLink();
    const { body } = await requestLink(page, ADMIN);
    for (const header of ["sec-purpose", "purpose"]) {
      const res = await request.get(pathOf(body.devLink!), { headers: { [header]: "prefetch" }, maxRedirects: 0 });
      expect(res.status()).toBe(303);
      expect(new URL(res.headers()["location"]).pathname + new URL(res.headers()["location"]).search).toBe("/admin/login");
      expect(res.headers()["set-cookie"]).toBeUndefined();
    }
    await page.goto(pathOf(body.devLink!)); // the real click still works
    await expect(page).toHaveURL(/\/admin$/);
    await sessionCookie(context);
  });

  test("expires after 15 minutes; the notice keeps the way back, so the next link still lands there", async ({ page, context }) => {
    submitsForms();
    opensDevLink();
    await page.goto("/admin/login?tagasi=%2Fadmin%2Fmaksed");
    const { body } = await submitLogin(page, ADMIN);
    await expireAuthToken(tokenOf(body.devLink!));
    unlockLogin(); // an expired link does not count towards the cap
    await page.goto(pathOf(body.devLink!));
    await expect(page).toHaveURL(/\/admin\/login\?viga=link&tagasi=%2Fadmin%2Fmaksed$/);
    await expect(page.locator("main").getByRole("alert")).toHaveText(LINK_ERROR);
    // review m-5: asked for again from the notice, the new link lands on the page she wanted
    const again = await submitLogin(page, ADMIN);
    await page.goto(pathOf(again.body.devLink!));
    await expect(page).toHaveURL(/\/admin\/maksed$/);
    await sessionCookie(context);
  });

  test("an unknown or malformed token is refused without a session", async ({ page, context }) => {
    for (const t of ["nope", "A".repeat(43), ""]) {
      await page.goto(`/api/auth/verify?t=${t}`);
      await expect(page).toHaveURL(/\/admin\/login\?viga=link$/);
      await expect(page.locator("main").getByRole("alert")).toHaveText(LINK_ERROR);
    }
    await page.goto("/api/auth/verify");
    await expect(page).toHaveURL(/\/admin\/login\?viga=link$/);
    expect((await context.cookies()).find((c) => c.name === "__Host-mslab_admin")).toBeUndefined();
  });
});

test.describe("who can sign in", () => {
  test("an address outside the allow-list gets the same confirmation, no token row and no devLink", async ({ page }, info) => {
    submitsForms();
    const stranger = authTestEmail(info.project.name);
    const { status, body } = await requestLink(page, stranger);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    await expect(page.locator("[data-login-sent]")).toHaveText(sentTo(stranger)); // word for word what an allowed address sees
    await expect(page.locator("[data-login-status]")).toBeFocused();
    expect(await storedAuthTokens(stranger)).toEqual([]);
  });

  test("the allowed and the not allowed address see the same page text (the address they typed aside)", async ({ page }, info) => {
    submitsForms();
    const text = async (address: string) => {
      const { body } = await requestLink(page, address);
      const shown = await page.locator("[data-login-status]").innerText();
      if (body.devLink) {
        await removeAdminRows({ tokens: [tokenOf(body.devLink)] }); // never opened: deleted at once, then the lock is free
        unlockLogin();
      }
      return shown.replace(address, "{email}");
    };
    const allowed = await text(ADMIN);
    const refused = await text(authTestEmail(info.project.name));
    expect(allowed).toContain("{email}");
    expect(refused).toBe(allowed);
  });

  test("„Muu aadress“ under the sent state brings the form back, empty, with the cursor in the field", async ({ page }, info) => {
    submitsForms();
    const stranger = authTestEmail(info.project.name);
    await requestLink(page, stranger);
    await page.locator("[data-login-status]").getByRole("button", { name: "Muu aadress" }).click();
    await expect(page.locator("[data-login-form]")).toBeVisible();
    await expect(page.getByLabel("E-post")).toBeFocused();
    await expect(page.getByLabel("E-post")).toHaveValue("");
    // the address the link went to is remembered for the next visit all the same
    await page.reload();
    await expect(page.getByLabel("E-post")).toHaveValue(stranger);
  });
});

// B19 (ruling R-f, Review Focus 3): the page she opened signed out is where the link lands her, its fragment included; any other way back lands
// on /admin. Each sign-in asks for a link for Dim under the login lock, the address's count cleared first.
test.describe("the way back after signing in (B19)", () => {
  /** A link for Dim asked for by hand with `tagasi`, from the connection `ip` (one per few requests: the per-IP limit is 5), under the login lock. */
  async function linkFor(page: Page, tagasi: string, ip: string): Promise<string> {
    await lockLogin();
    await freeLoginAddress();
    const res = await page.request.post("/api/auth/request", { data: { email: ADMIN, tagasi }, headers: { "x-forwarded-for": ip } });
    expect(res.status()).toBe(200);
    const { devLink } = (await res.json()) as { devLink?: string };
    expect(devLink, "devLink in the local answer").toBeTruthy();
    created.tokens.add(tokenOf(devLink!));
    return devLink!;
  }

  test("a deep link opened signed out: the login page keeps it, the mailed link carries it, and the sign-in lands on it, fragment included", async ({ page, context }) => {
    submitsForms();
    opensDevLink();
    const [{ id }] = await onLocalDb((sql) => sql<{ id: number }[]>`select id from course_sessions order by id limit 1`, { marksPages: false });
    await page.goto(`/admin/kalender?id=${id}#proov`);
    await expect(page).toHaveURL(new RegExp(`/admin/login\\?tagasi=%2Fadmin%2Fkalender%3Fid%3D${id}#proov$`));
    const { body } = await submitLogin(page, ADMIN);
    // the link carries the way back as one encoded value, the fragment the form added included
    expect(body.devLink).toContain(`&tagasi=%2Fadmin%2Fkalender%3Fid%3D${id}%23proov`);
    expect(new URL(body.devLink!).searchParams.get("tagasi")).toBe(`/admin/kalender?id=${id}#proov`);
    await page.goto(pathOf(body.devLink!));
    await expect(page).toHaveURL(new RegExp(`/admin/kalender\\?id=${id}#proov$`));
    await expect(page.locator("[data-drawer]").first()).toBeVisible(); // the session's drawer, as she asked for it
    expect(await sessionCookie(context), "session cookie").toBeTruthy();
  });

  test("Review Focus 3: a way back that is not an admin page of this site lands on /admin: on the page, in the request and in a link it was forged into", async ({ page, context, visitorIp }) => {
    submitsForms();
    opensDevLink();
    // on the login page: dropped there, so the form sends none
    await page.goto(`/admin/login?tagasi=${encodeURIComponent("//evil.example/admin")}`);
    const { body } = await submitLogin(page, ADMIN);
    expect(new URL(body.devLink!).searchParams.has("tagasi")).toBe(false);
    await page.goto(pathOf(body.devLink!));
    await expect(page).toHaveURL(/\/admin$/);
    await sessionCookie(context);
    // sent by hand: the request drops it, so the link carries none
    for (const tagasi of ["/\\evil.example", "%2F%2Fevil.example", "/admin/login", "/admin/kalen\tder", "/admin/kalender\n"]) {
      const link = await linkFor(page, tagasi, `a-${visitorIp}`);
      expect(new URL(link).searchParams.has("tagasi"), JSON.stringify(tagasi)).toBe(false);
      await page.goto(pathOf(link));
      await expect(page, JSON.stringify(tagasi)).toHaveURL(/\/admin$/);
      await sessionCookie(context);
    }
    // forged into a good link: the link checks it again
    for (const forged of ["//evil.example", "/\\evil.example", "/admin/%2F%2Fevil", `/admin/${"k".repeat(300)}`]) {
      const link = await linkFor(page, "/admin/maksed", `f-${visitorIp}`);
      await page.goto(`${pathOf(link).replace(/&tagasi=[^&]*/, "")}&tagasi=${encodeURIComponent(forged)}`);
      await expect(page, forged).toHaveURL(/\/admin$/);
      await sessionCookie(context);
    }
  });
});

test.describe("limits", () => {
  // B20 (ruling R-g, Review Focus 4): 3 requests per typed address in 10 minutes, allowed or not; the 4th says so instead of claiming a link was sent.
  test("B20: the 4th request for one address says „Saatsid juba 3 linki…“ (429 `address`), the same for an unknown and the allowed address", async ({ page, visitorIp }, info) => {
    submitsForms();
    await page.goto("/admin/login");
    const stranger = authTestEmail(info.project.name);
    /** One request by hand from the connection `ip` (the server keeps an address's first 64 characters: the prefix makes it another one). */
    const ask = async (email: string, ip: string) => {
      const res = await page.request.post("/api/auth/request", { data: { email }, headers: { "x-forwarded-for": ip } });
      const body = (await res.json()) as { ok: boolean; error?: string; devLink?: string };
      if (body.devLink) created.tokens.add(tokenOf(body.devLink));
      return { status: res.status(), ok: body.ok, error: body.error };
    };
    // four for the unknown address
    const unknown = [];
    for (let i = 0; i < 4; i++) unknown.push(await ask(stranger, `u-${visitorIp}`));
    // four for the allowed one, from another connection, under the login lock (its links are deleted before the lock is given back)
    await lockLogin();
    await freeLoginAddress();
    const allowed = [];
    for (let i = 0; i < 4; i++) allowed.push(await ask(ADMIN, `a-${visitorIp}`));
    await removeAdminRows({ tokens: created.tokens });
    await freeLoginAddress();
    unlockLogin();
    const ok = { status: 200, ok: true, error: undefined };
    expect(unknown).toEqual([ok, ok, ok, { status: 429, ok: false, error: "address" }]);
    expect(allowed).toEqual(unknown);
    expect(await storedAuthTokens(stranger)).toEqual([]);

    // the page: the 5th for the unknown address, from this visitor's own connection, says so instead of claiming a link was sent
    await page.getByLabel("E-post").fill(stranger);
    await page.getByRole("button", { name: BUTTON }).click();
    const alert = page.locator("main").getByRole("alert");
    await expect(alert).toHaveText(ADDRESS_LIMIT);
    await expect(alert).toBeFocused();
    await expect(page.locator("[data-login-status]")).toBeEmpty();
    await expect(page.getByLabel("E-post")).toHaveValue(stranger);
  });

  test("5 requests per 10 minutes per visitor (any addresses), then a polite message (429 `rate`)", async ({ page }, info) => {
    submitsForms();
    await page.goto("/admin/login");
    const strangers = Array.from({ length: 6 }, () => authTestEmail(info.project.name));
    const answers = await page.evaluate(async (addresses) => {
      const out: { status: number; error?: string }[] = [];
      for (const address of addresses.slice(0, 5)) {
        const r = await fetch("/api/auth/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: address }) });
        out.push({ status: r.status, error: ((await r.json()) as { error?: string }).error });
      }
      return out;
    }, strangers);
    expect(answers).toEqual(Array.from({ length: 5 }, () => ({ status: 200 })));
    await page.getByLabel("E-post").fill(strangers[5]);
    const refused = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/request");
    await page.getByRole("button", { name: BUTTON }).click();
    expect((await refused).status()).toBe(429);
    const alert = page.locator("main").getByRole("alert");
    await expect(alert).toHaveText("Liiga palju katseid. Proovi mõne minuti pärast.");
    await expect(alert).toBeFocused();
    for (const s of strangers) expect(await storedAuthTokens(s)).toEqual([]);
  });

  test("only JSON is accepted, and logout is POST only", async ({ request }) => {
    submitsForms();
    const form = await request.post("/api/auth/request", { form: { email: ADMIN } });
    expect(form.status()).toBe(415);
    const get = await request.get("/api/auth/logout", { maxRedirects: 0 });
    expect(get.status()).toBe(405);
    const foreign = await request.post("/api/auth/logout", { headers: { origin: "https://evil.example" }, maxRedirects: 0 });
    expect(foreign.status()).toBe(403); // a POST from another site is refused before anything happens
    const logout = await request.post("/api/auth/logout", { maxRedirects: 0 });
    expect([302, 303, 307]).toContain(logout.status());
    expect(new URL(logout.headers()["location"], "http://x").pathname).toBe("/admin/login");
    expect(logout.headers()["set-cookie"]).toBeUndefined(); // no cookie sent, nothing to clear
  });
});
