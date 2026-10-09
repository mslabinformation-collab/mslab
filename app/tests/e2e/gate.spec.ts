import { randomBytes } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { PREVIEW_COOKIE, signPreview } from "../../src/lib/preview-cookie";
import { ADMIN } from "./admin-login";
import { onLocalDb, removeAdminRows, sha256Hex, storedSubscriber, testEmail } from "./fixtures";
import { GATE_PREVIEW_SECRET, GATE_URL, gateRun } from "./gate";
import { expect, submitsForms, test } from "./test";

// The coming-soon gate (hotfix 08.10) on a production build started with SITE_GATE=1: `npx playwright test -c
// playwright.gate.config.ts` (it builds and starts the server itself, tests/e2e/gate.ts). Skipped in the main e2e run, whose
// server shows the site as it is. Visitors get the coming-soon page at every address, in their language, and can sign up
// for the newsletter there (the server action posts to the visitor's own address, which the gate answers with the same
// page; one step since 09.10, so the sign-up subscribes at once) and unsubscribe with the link of the welcome mail; an admin's sign-in sets
// the preview cookie and the whole site shows; logout ends it.

test.skip(!gateRun(), "the gate's own run: npx playwright test -c playwright.gate.config.ts");

const HEADING_ET = "Uus koduleht on peagi valmis.";
const HEADING_RU = "Новый сайт скоро будет готов.";

/** The browser's HTTP cache off (`next start` sends the static page's s-maxage as it is; tests/e2e/test.ts does the same for its production build). */
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (route) => route.fallback());
});

/** Is the page the coming-soon page of `heading`'s language, alone (no site header, footer or review widget)? */
async function expectComingSoon(page: Page, heading = HEADING_ET): Promise<void> {
  await expect(page.locator("[data-coming-soon]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  await expect(page.locator("header, footer, nav")).toHaveCount(0);
  await expect(page.locator("script[src*='feedback.js']")).toHaveCount(0);
}

async function noHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

test.describe("a visitor", () => {
  test("every address of the site is the coming-soon page (200, the address kept, noindex), in its language", async ({ page }) => {
    for (const path of ["/", "/koolitused", "/koolitused/kulmude-lami", "/koolituskalender", "/konto", "/konto/sisene?viga=link", "/uudised", "/guide/", "/p/d/", "/olematu-leht", "/et/koolitused"]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      expect(res?.headers()["x-robots-tag"], path).toBe("noindex, nofollow");
      await expectComingSoon(page);
      expect(new URL(page.url()).pathname, path).toBe(path.split("?")[0]);
      await expect(page).toHaveTitle("MS LAB Koolituskeskus");
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    }
    for (const path of ["/ru", "/ru/koolitused", "/ru/konto"]) {
      expect((await page.goto(path))?.status(), path).toBe(200);
      await expectComingSoon(page, HEADING_RU);
      await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    }
  });

  test("the account's API and the review comments answer 404 without the page; the admin login, robots.txt and the logo are there", async ({ page, request }) => {
    for (const path of ["/api/konto/me", "/api/feedback"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
      expect(await res.json(), path).toEqual({ ok: false, error: "not_found" });
    }
    expect((await request.post("/api/feedback", { data: {} })).status()).toBe(404);
    expect((await request.get("/robots.txt")).status()).toBe(200);
    expect((await request.get("/brand/logo.png")).headers()["content-type"]).toContain("image/png");
    expect((await request.get("/og.jpg")).status()).toBe(200);
    await page.goto("/admin/login");
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(HEADING_ET);
    await expect(page.locator("[data-coming-soon]")).toHaveCount(0);
  });

  test("a mailed account link (/api/konto/verify?…) opened in the browser is the coming-soon page, and its sign-up works there; a script still gets 404 JSON", async ({ page }, info) => {
    submitsForms();
    const res = await page.goto("/api/konto/verify?t=not-a-real-token-0000000000");
    expect(res?.status()).toBe(200);
    await expectComingSoon(page);
    expect(new URL(page.url()).pathname).toBe("/api/konto/verify");
    await page.locator("html[data-site-ready]").waitFor({ state: "attached" }); // tests/e2e/test.ts waits on site pages only, not /api
    // the page's own fetch to a gated API: the JSON answer
    expect(await page.evaluate(async () => (await fetch("/api/konto/me")).status)).toBe(404);
    // the newsletter's server action posts to this same address, and the coming-soon page answers it
    const addr = testEmail("gate-api", info.project.name);
    try {
      await page.getByLabel("Sinu e-post").fill(addr);
      await page.getByRole("button", { name: "Liitu" }).click();
      await expect(page.locator("[data-newsletter-status]")).toContainText("Aitäh, oled liitunud!");
      expect((await storedSubscriber(addr))?.email).toBe(addr);
    } finally {
      await onLocalDb((sql) => sql`delete from subscribers where email = ${addr}`, { marksPages: false });
    }
  });

  test("the page: logo, heading, one line, the sign-up with its line (no privacy link here); no horizontal overflow, 44px targets", async ({ page }) => {
    await page.goto("/koolitused");
    await expect(page.getByRole("img", { name: "MS LAB" })).toBeVisible();
    await expect(page.getByText("Liitu uudiskirjaga — anname teada, kui avame.")).toBeVisible();
    await expect(page.getByLabel("Sinu e-post")).toBeVisible();
    await expect(page.getByRole("button", { name: "Liitu" })).toBeVisible();
    // no consent box: the line under the button says signing up is the consent; no privacy link (the gate does not serve that page)
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    const notice = page.locator("[data-newsletter-notice]");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText("Liitudes saad MS LABi uudiskirja. Saad igal ajal loobuda.");
    await expect(notice.getByRole("link")).toHaveCount(0);
    await expect(page.locator("a[href*='privaatsus']")).toHaveCount(0);
    expect(await noHorizontalOverflow(page)).toBe(true);
    for (const target of [page.getByLabel("Sinu e-post"), page.getByRole("button", { name: "Liitu" })])
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await notice.boundingBox())!.height).toBeLessThan(44); // the line keeps its own height: no 44px target
    const button = (await page.getByRole("button", { name: "Liitu" }).boundingBox())!;
    expect((await notice.boundingBox())!.y).toBeGreaterThanOrEqual(button.y + button.height); // directly under the button
    await page.screenshot({ path: test.info().outputPath("tulekul-et.png"), fullPage: true });
    await page.goto("/ru");
    expect(await noHorizontalOverflow(page)).toBe(true);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    const noticeRu = page.locator("[data-newsletter-notice]");
    await expect(noticeRu).toHaveText("Подписываясь, вы получаете рассылку MS LAB. Отписаться можно в любой момент.");
    await expect(noticeRu.getByRole("link")).toHaveCount(0);
    await expect(page.locator("a[href*='privaatsus']")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("tulekul-ru.png"), fullPage: true });
  });

  test("signs up from any address (the server action is answered by the coming-soon page), is subscribed at once, and the unsubscribe link's notice shows there", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("gate", info.project.name);
    try {
      await page.goto("/koolitused/kulmude-lami");
      await page.getByLabel("Sinu e-post").fill(addr);
      await page.getByRole("button", { name: "Liitu" }).click();
      const status = page.locator("[data-newsletter-status]");
      await expect(status).toContainText("Aitäh, oled liitunud!");
      await expect(status).toBeFocused();
      const sub = await storedSubscriber(addr);
      expect(sub).toMatchObject({ email: addr, locale: "et", confirmed: true });
      await expect(status).toContainText("Saatsime sulle tervituskirja.");

      // the unsubscribe link of the welcome mail passes the gate and opens its own page (not the coming-soon page); the button then lands on
      // the coming-soon page with the notice
      await page.goto(`/api/newsletter/loobu?t=${sub!.token}`);
      await expect(page.getByRole("heading", { name: "Uudiskirjast loobumine" })).toBeVisible();
      expect((await storedSubscriber(addr))?.confirmed).toBe(true); // opening the link unsubscribes no one
      await page.getByRole("button", { name: "Loobu uudiskirjast" }).click();
      await expectComingSoon(page);
      const notice = page.locator("[data-flash-notice]");
      await expect(notice).toContainText("Oled uudiskirjast loobunud.");
      await expect(notice).toContainText("Me ei saada sulle enam MS LABi uudiskirja.");
      await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe("/");
      expect(await storedSubscriber(addr)).toBeNull();

      // the confirmation link of the old flow still passes too, and a wrong one says so
      await page.goto("/api/newsletter/confirm?t=not-a-real-token-0000000000");
      await expect(page.locator("[data-flash-notice='warn']")).toContainText("See kinnituslink ei kehti.");
    } finally {
      await onLocalDb((sql) => sql`delete from subscribers where email = ${addr}`, { marksPages: false });
    }
  });

  test("the welcome code (phase 2c): the first confirmation lands on the coming-soon page with #kood=… and the notice shows the code, in the subscriber's language; the second click shows none", async ({ page }, info) => {
    test.skip(info.project.name !== "w1440", "sets Seaded's welcome code once, on the desktop project");
    submitsForms();
    const subscribers = [
      { addr: testEmail("gate-code-et", info.project.name), locale: "et", token: "g".repeat(40) + "et1", line: "Sinu tervituskood: E2E-GATE. Lisa kood registreerimisel lahtrisse „Sõnum“.", path: "/" },
      { addr: testEmail("gate-code-ru", info.project.name), locale: "ru", token: "g".repeat(40) + "ru1", line: "Ваш приветственный код: E2E-GATE. Укажите его при регистрации в поле «Сообщение».", path: "/ru" },
    ];
    // the setting as it was (the row may be missing): put back below. No public page shows the welcome code, so no page is marked stale.
    const before = await onLocalDb((sql) => sql<{ value: object }[]>`select value from settings where key = 'newsletter'`, { marksPages: false });
    try {
      await onLocalDb(async (sql) => {
        const value = sql.json({ ...(before[0]?.value ?? { discountLabel: "10%" }), welcomeCode: "E2E-GATE" });
        await sql`insert into settings (key, value) values ('newsletter', ${value}) on conflict (key) do update set value = excluded.value`;
        for (const s of subscribers) await sql`insert into subscribers (email, locale, token) values (${s.addr}, ${s.locale}, ${s.token})`;
      }, { marksPages: false });
      for (const s of subscribers) {
        await page.goto(`/api/newsletter/confirm?t=${s.token}`);
        await expectComingSoon(page, s.locale === "ru" ? HEADING_RU : HEADING_ET);
        await expect(page.locator("[data-flash-notice='ok']")).toBeVisible();
        await expect(page.locator("[data-flash-code]")).toHaveText(s.line);
        // the notice has taken the fragment out of the address; the server's own HTML of the page never held the code
        await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search + new URL(page.url()).hash).toBe(s.path);
        expect(await (await page.request.get(s.path)).text()).not.toContain("E2E-GATE");
        await page.goto(`/api/newsletter/confirm?t=${s.token}`);
        await expect(page.locator("[data-flash-notice='ok']")).toBeVisible();
        await expect(page.locator("[data-flash-code]")).toHaveCount(0);
      }
    } finally {
      await onLocalDb(async (sql) => {
        if (before[0]) await sql`update settings set value = ${sql.json(before[0].value as never)} where key = 'newsletter'`;
        else await sql`delete from settings where key = 'newsletter'`;
        for (const s of subscribers) await sql`delete from subscribers where email = ${s.addr}`;
      }, { marksPages: false });
    }
  });

  test("a Russian sign-up from /ru", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("gate-ru", info.project.name);
    try {
      await page.goto("/ru/kontakt");
      await page.getByLabel("Ваш e-mail").fill(addr);
      await page.getByRole("button", { name: "Подписаться" }).click();
      await expect(page.locator("[data-newsletter-status]")).toContainText("Спасибо, вы подписались!");
      expect((await storedSubscriber(addr))?.locale).toBe("ru");
    } finally {
      await onLocalDb((sql) => sql`delete from subscribers where email = ${addr}`, { marksPages: false });
    }
  });

  test("a forged, expired or foreign preview cookie is no way in", async ({ page, context }) => {
    const now = Date.now();
    const good = await signPreview(GATE_PREVIEW_SECRET, now);
    const [exp, sig] = good.split(".");
    for (const value of [`${Number(exp) + 3600}.${sig}`, await signPreview(GATE_PREVIEW_SECRET, now - 31 * 86_400_000), await signPreview("another-key-0123456789abcdef0123", now), "1"]) {
      await setPreview(context, value);
      await page.goto("/koolitused");
      await expectComingSoon(page);
    }
  });

  test("Montonio's webhook goes through: a POST is answered by the app (400 for a token it cannot verify), not the gate, and is never redirected (phase 2b)", async ({ request }) => {
    const res = await request.post("/api/payments/notify", { data: { orderToken: "not-a-token" }, maxRedirects: 0 });
    expect(res.status()).toBe(400);
    expect(res.status() >= 300 && res.status() < 400).toBe(false);
    expect(res.headers()["location"]).toBeUndefined();
    expect(await res.json()).toEqual({ ok: false });
    // the webhook is that one address: POST only (Next.js answers the rest 405), and the rest of /api/payments stays behind the gate
    expect((await request.get("/api/payments/notify", { maxRedirects: 0 })).status()).toBe(405);
    for (const path of ["/api/payments/return", "/api/payments/notify/"]) {
      const gated = await request.post(path, { data: { orderToken: "not-a-token" }, maxRedirects: 0 });
      expect(gated.status(), path).toBe(404);
      expect(await gated.json(), path).toEqual({ ok: false, error: "not_found" });
    }
  });
});

/** The preview cookie in this browser, as the server would set it. */
async function setPreview(context: BrowserContext, value: string): Promise<void> {
  await context.addCookies([{ name: PREVIEW_COOKIE, value, url: GATE_URL, httpOnly: true, secure: true, sameSite: "Lax" }]);
}

test.describe("an admin", () => {
  test("a valid preview cookie shows the whole site, the account's 303 and the 404 page included", async ({ page, context }) => {
    await setPreview(context, await signPreview(GATE_PREVIEW_SECRET));
    await page.goto("/");
    await expect(page.locator("[data-coming-soon]")).toHaveCount(0);
    await expect(page.locator("header")).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();
    await page.goto("/koolitused");
    await expect(page.locator("[data-coming-soon]")).toHaveCount(0);
    await page.goto("/ru/koolitused");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.locator("[data-coming-soon]")).toHaveCount(0);
    // what the gate shows is no page of the site
    for (const path of ["/tulekul", "/tulekul/et", "/tulekul/ru"]) expect((await page.goto(path))?.status(), path).toBe(404);
  });

  test("sign-in sets the preview cookie; 'Vaata kodulehte' gives it again; logout clears it", async ({ page, context }, info) => {
    test.skip(info.project.name !== "w1440", "signs in once, on the desktop project");
    const raw = randomBytes(32).toString("base64url");
    const created = { tokens: new Set([raw]), sessions: new Set<string>() };
    try {
      // a login link for the placeholder admin, as server/auth.ts createLoginToken stores it (a production build has no devLink)
      await onLocalDb((sql) => sql`insert into auth_tokens (hash, email, expires_at) values (${sha256Hex(raw)}, ${ADMIN}, ${new Date(Date.now() + 15 * 60_000)})`, { marksPages: false });
      await page.goto(`/api/auth/verify?t=${raw}`);
      await expect(page).toHaveURL(/\/admin$/);
      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === "__Host-mslab_admin");
      created.sessions.add(session!.value);
      const preview = cookies.find((c) => c.name === PREVIEW_COOKIE);
      expect(preview).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
      expect(preview!.expires - Date.now() / 1000).toBeGreaterThan(29 * 86_400);

      await page.goto("/");
      await expect(page.locator("[data-coming-soon]")).toHaveCount(0);
      await expect(page.locator("header")).toBeVisible();

      // an admin signed in before the gate: the session but no preview cookie sees the coming-soon page …
      await context.clearCookies({ name: PREVIEW_COOKIE });
      await page.goto("/");
      await expectComingSoon(page);
      // … until "Vaata kodulehte" in the admin's top line (a new window: the route sets the cookie and opens the home page)
      await page.goto("/admin");
      const link = page.getByRole("link", { name: /Vaata kodulehte/ });
      await expect(link).toHaveAttribute("href", "/api/admin/preview");
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const [site] = await Promise.all([context.waitForEvent("page"), link.click()]);
      await site.waitForLoadState();
      expect(new URL(site.url()).pathname).toBe("/");
      await expect(site.locator("[data-coming-soon]")).toHaveCount(0);
      await expect(site.locator("header")).toBeVisible();
      await site.close();

      // the sidebar's "Vaata lehte ↗" goes the same way
      await context.clearCookies({ name: PREVIEW_COOKIE });
      const sidebar = page.locator("aside").getByRole("link", { name: /Vaata lehte/ });
      await expect(sidebar).toHaveAttribute("href", "/api/admin/preview");
      const [again] = await Promise.all([context.waitForEvent("page"), sidebar.click()]);
      await again.waitForLoadState();
      expect(new URL(again.url()).pathname).toBe("/");
      await expect(again.locator("[data-coming-soon]")).toHaveCount(0);
      await again.close();

      // logout clears the pass with the session
      await page.locator("aside").getByRole("button", { name: "Logi välja" }).click();
      await expect(page).toHaveURL(/\/admin\/login$/);
      expect((await context.cookies()).find((c) => c.name === PREVIEW_COOKIE)).toBeUndefined();
      await page.goto("/");
      await expectComingSoon(page);
    } finally {
      await removeAdminRows(created);
    }
  });
});
