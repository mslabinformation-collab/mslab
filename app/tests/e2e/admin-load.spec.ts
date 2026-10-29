import { randomBytes } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { removeAdminRows } from "./fixtures";
import { E2E_REVIEW_KEY } from "./prod-build";
import { PROD_BUILD } from "./target";
import { test, expect } from "./test";

// The production build under load: a burst of signed-in admin pages, one after another and side by side, with public
// pages and public answers that read the database at the same time, all answer (one database pool for the process,
// db/client.ts; the signed-in admin looked up once per request, server/auth.ts). On 02.10.2026 the live Cloudflare
// Worker answered about a quarter of the admin pages with a 500; the check on Vercel (03.10.2026) repeated this by hand.
//
// The load test is for the local production build only (E2E_PROD_BUILD): it signs in by writing to the local database. The sidebar
// test after it (admin UX pass, Task 2) runs under `next dev` and the production build alike.

const ADMIN_PAGES = [
  "/admin",
  "/admin/avaleht",
  "/admin/kalender",
  "/admin/kampaania",
  "/admin/koolitaja",
  "/admin/koolitused",
  "/admin/maksed",
  "/admin/opilased",
  "/admin/paringud",
  "/admin/praktika",
  "/admin/protokollid",
  "/admin/registreerimised",
  "/admin/seaded",
  "/admin/tagasiside",
  "/admin/uudised",
  "/admin/uudiskiri",
];

/** Public pages (cached once rendered: a revalidation by another test renders them again from the database). */
const PUBLIC_PAGES = ["/ru/koolitaja", "/ru/praktika", "/ru/uudised", "/ru/kontakt", "/privaatsus", "/tingimused"];

const created: CreatedRows = { tokens: new Set<string>(), sessions: new Set<string>() };

test.afterAll(async () => {
  await removeAdminRows(created);
});

type Answer = { path: string; status: number; note: string };

/**
 * What React writes into the HTML of a Suspense boundary whose content threw after the shell was sent: the error's digest on the boundary
 * (`data-dgst`) and the call that makes the browser render the boundary again (`$RX(`; the function's own definition reads `$RX=`).
 */
const SERVER_ERROR_MARKERS = ["data-dgst", "$RX("];

async function adminGet(request: APIRequestContext, cookie: string, path: string): Promise<Answer> {
  const res = await request.get(path, { headers: { cookie }, maxRedirects: 0, failOnStatusCode: false });
  const html = await res.text();
  const notes: string[] = [];
  if (res.status() === 200) {
    // the admin shell, rendered for the signed-in admin (a failed session lookup is a 500, a lost session a redirect)
    if (!html.includes('href="#main"')) notes.push("no admin shell");
    // (panel)/loading.tsx streams the page after the shell, so a page whose read throws still answers 200 with the shell: the page's own
    // content (every page here has a heading) and the absence of React's server-error markers say the page itself was rendered
    if (!html.includes("<h1")) notes.push("no page content");
  }
  for (const marker of SERVER_ERROR_MARKERS) if (html.includes(marker)) notes.push(`server error marker ${marker}`);
  return { path, status: res.status(), note: notes.join("; ") };
}

async function publicPage(request: APIRequestContext, path: string): Promise<Answer> {
  const res = await request.get(path, { maxRedirects: 0, failOnStatusCode: false });
  await res.body();
  return { path, status: res.status(), note: "" };
}

/** The review comment list: read from the KV table of the database on every request. */
async function commentList(request: APIRequestContext): Promise<Answer> {
  const res = await request.get("/api/feedback", { headers: { "x-key": E2E_REVIEW_KEY }, failOnStatusCode: false });
  const body = (await res.json().catch(() => null)) as { items?: unknown[] } | null;
  return { path: "/api/feedback", status: res.status(), note: Array.isArray(body?.items) ? "" : "no comment list" };
}

/** The newsletter link with a token nobody has: one SELECT; "viga" would mean the database failed. */
async function confirmLink(request: APIRequestContext): Promise<Answer> {
  const res = await request.get(`/api/newsletter/confirm?t=${randomBytes(32).toString("base64url")}`, { maxRedirects: 0, failOnStatusCode: false });
  const outcome = new URL(res.headers()["location"] ?? "/", "http://x").searchParams.get("uudiskiri");
  return { path: "/api/newsletter/confirm", status: res.status(), note: outcome === "vigane" ? "" : `uudiskiri=${outcome}` };
}

const failures = (answers: Answer[], ok: (a: Answer) => boolean) => answers.filter((a) => !ok(a) || a.note).map((a) => `${a.path}: ${a.status} ${a.note}`.trim());

test("signed-in admin pages one after another and side by side, with public answers between them: every answer is right", async ({ page, context, request, isMobile }) => {
  test.skip(!PROD_BUILD, "the production build under load: the local production build only (E2E_PROD_BUILD=1)");
  test.skip(isMobile, "the same answers for every browser: desktop project only");
  test.setTimeout(240_000);
  await signInAsAdmin(page, context, "", created);
  const session = (await context.cookies()).find((c) => c.name === "__Host-mslab_admin")!.value;
  const cookie = `__Host-mslab_admin=${session}`;

  const admin: Answer[] = [];
  const pub: Answer[] = [];
  for (let i = 0; i < 40; i++) admin.push(await adminGet(request, cookie, ADMIN_PAGES[i % ADMIN_PAGES.length]));
  for (let round = 0; round < 10; round++) {
    const [answers, publicAnswers, link] = await Promise.all([
      Promise.all([0, 1, 2, 3].map((j) => adminGet(request, cookie, ADMIN_PAGES[(round * 4 + j) % ADMIN_PAGES.length]))),
      Promise.all([...[0, 1].map((j) => publicPage(request, PUBLIC_PAGES[(round * 2 + j) % PUBLIC_PAGES.length])), commentList(request)]),
      confirmLink(request),
    ]);
    admin.push(...answers);
    pub.push(...publicAnswers, link);
  }

  expect(admin).toHaveLength(80);
  expect(failures(admin, (a) => a.status === 200), "admin pages").toEqual([]);
  expect(failures(pub, (a) => (a.path === "/api/newsletter/confirm" ? a.status === 303 : a.status === 200)), "public answers").toEqual([]);
});

// Admin UX pass, Task 2: the Shell lives in the (panel) layout, so it is not rendered again when the visitor moves between pages. The
// sidebar reads its active entry from the address (sections.ts activeSection): it must follow a click on another entry and Back without a
// reload, and the ready mark must still be on.
test("the sidebar stays on screen and marks the entry of the address after a click and after Back", async ({ page, context, visitorIp, isMobile }) => {
  test.skip(isMobile, "the sidebar is the phone bar's drawer on a phone: desktop project only");
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto("/admin/maksed");
  await adminReady(page);

  const entry = (key: string) => page.locator(`aside a[data-nav="${key}"]`);
  await expect(entry("payments")).toHaveAttribute("aria-current", "page");
  await expect(entry("registrations")).not.toHaveAttribute("aria-current", "page");
  // the sidebar element itself must survive the navigations (a full reload would drop the mark)
  await page.locator("aside").first().evaluate((el) => el.setAttribute("data-kept", "1"));

  await entry("registrations").click();
  // (a badged row opens its page already filtered: the waiting registrations)
  await expect(page).toHaveURL(/admin.registreerimised(\?staatus=ootab)?$/);
  await expect(entry("registrations")).toHaveAttribute("aria-current", "page");
  await expect(entry("payments")).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator("html[data-admin-ready]")).toBeAttached();

  await page.goBack();
  await expect(page).toHaveURL(/admin.maksed$/);
  await expect(entry("payments")).toHaveAttribute("aria-current", "page");
  await expect(entry("registrations")).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator("aside[data-kept]")).toHaveCount(1);
  await expect(page.locator("html[data-admin-ready]")).toBeAttached();
});

// Admin UX pass, Task 3: the grouped sidebar from 900 px, the phone bar below it (README §1.1). A tablet between 641 and 899 px wide used to
// get a narrow 190 px sidebar; it now gets the phone bar, and nothing may run off the side.
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("768 px wide: the phone bar shows, its menu opens with every group, and nothing overflows sideways; 900 px is the sidebar", async ({ page, context, visitorIp, isMobile }) => {
  test.skip(isMobile, "the viewport is set here: desktop project only");
  await signInAsAdmin(page, context, visitorIp, created);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/admin/maksed");
  await adminReady(page);

  await expect(page.locator("aside")).toBeHidden();
  // no top line below 900 px: the page starts under the bar, and „Vaata kodulehte ↗“ is in the menu only
  await expect(page.locator("[data-admin-top]")).toBeHidden();
  await expect(page.locator("[data-admin-preview]")).toBeHidden();
  const bar = page.locator("header").first();
  await expect(bar).toBeVisible();
  expect((await bar.boundingBox())!.height).toBe(64);
  await expect(bar.locator("[data-admin-bar-title]")).toHaveText("Maksed ja arved");
  const button = page.getByRole("button", { name: "Ava menüü" });
  const box = (await button.boundingBox())!;
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([44, 44]);
  expect(await noSideScroll(page)).toBe(true);

  await button.click();
  const drawer = page.locator("[data-admin-drawer]");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("[data-nav-group]")).toHaveText(["Igapäevane töö", "Koolitused", "Koduleht ja uudiskiri", "Haldus"]);
  await expect(drawer.locator("button[data-nav-fold]")).toHaveCount(0); // the phone menu has no fold
  await expect(drawer.locator('a[data-nav="home"]')).toBeVisible(); // … its last group is open
  await expect(drawer.getByRole("link", { name: /Vaata kodulehte/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Vaata kodulehte/ })).toHaveCount(1); // once on the screen
  expect(await noSideScroll(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  // 899 px is still the phone bar; 900 px is the sidebar, and an open menu closes when the window grows into it
  await page.setViewportSize({ width: 899, height: 1024 });
  await expect(bar).toBeVisible();
  await expect(page.locator("aside")).toBeHidden();
  await button.click();
  await expect(drawer).toBeVisible();
  await page.setViewportSize({ width: 900, height: 1024 });
  await expect(drawer).toBeHidden();
  await expect(bar).toBeHidden();
  await expect(page.locator("aside")).toBeVisible();
  await expect(page.locator("[data-admin-top]")).toBeVisible(); // the top line is back, with its „Vaata kodulehte ↗“
  await expect(page.getByRole("link", { name: /Vaata kodulehte/ })).toHaveCount(1);
  expect((await page.locator("aside").boundingBox())!.width).toBe(235);
  expect(await noSideScroll(page)).toBe(true);
});

test("1440 px wide: the sidebar with its groups; the folding group opens on a tap, keeps the choice, and a page inside it holds it open", async ({ page, context, visitorIp, isMobile }) => {
  test.skip(isMobile, "the viewport is set here: desktop project only");
  await signInAsAdmin(page, context, visitorIp, created);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/maksed");
  await adminReady(page);

  const aside = page.locator("aside");
  await expect(aside).toBeVisible();
  await expect(page.getByRole("button", { name: "Ava menüü" })).toBeHidden();
  await expect(aside.locator("[data-nav-group]")).toHaveText(["Igapäevane töö", "Koolitused", "Koduleht ja uudiskiri", "Haldus"]);
  // the heading's capitals are CSS, not text
  await expect(aside.locator('p[data-nav-group="daily"]')).toHaveCSS("text-transform", "uppercase");

  const fold = aside.locator("button[data-nav-fold]");
  const home = aside.locator('a[data-nav="home"]');
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(home).toBeHidden();
  expect((await fold.boundingBox())!.height).toBe(44);

  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(home).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("mslab-nav-fold"))).toBe("open");

  // the choice is kept for the next visit …
  await page.reload();
  await adminReady(page);
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await adminReady(page);
  await expect(fold).toHaveAttribute("aria-expanded", "false");

  // … but a page inside the group holds it open, with its own entry marked
  await page.goto("/admin/avaleht");
  await adminReady(page);
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(aside.locator('a[data-nav="home"]')).toHaveAttribute("aria-current", "page");
  await fold.click({ force: true }); // (it says aria-disabled while the page holds it open, which Playwright's click waits out)
  await expect(fold).toHaveAttribute("aria-expanded", "true");

  // the footer is the aside's own: it holds the e-mail and the way out; on a screen shorter than the menu only the menu scrolls, so the footer stays
  // whole at the foot of the window (admin polish F6: the aside scrolled as a whole, its footer cut at 900 and 800 px)
  const foot = aside.locator("[data-nav-foot]");
  await expect(foot).toContainText("Sisse logitud");
  await expect(foot.getByRole("button", { name: "Logi välja" })).toBeVisible();
  expect(await aside.evaluate((el) => getComputedStyle(el).overflowY)).toBe("hidden");
  expect(await aside.locator("nav").evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
  // Review Focus 3: at 1440 × 900 and 1280 × 800 with „Koduleht ja uudiskiri“ open, the footer is whole on the screen and every entry can be reached
  // in the menu (scrolled to it), each then wholly inside the menu's box
  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(size);
    const box = (await foot.boundingBox())!;
    expect(box.y, `${size.width}: the footer's top on the screen`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${size.width}: the footer's foot on the screen`).toBeLessThanOrEqual(size.height);
    const nav = (await aside.locator("nav").boundingBox())!;
    for (const entry of await aside.locator("nav a[data-nav]").all()) {
      await entry.scrollIntoViewIfNeeded();
      const r = (await entry.boundingBox())!;
      expect(r.y >= nav.y - 0.5 && r.y + r.height <= nav.y + nav.height + 0.5, `${size.width}: ${await entry.textContent()} reachable`).toBe(true);
      expect(r.height).toBe(44);
    }
    expect(await page.evaluate(() => window.scrollY), `${size.width}: only the menu scrolled, not the page`).toBe(0);
  }
  expect(await noSideScroll(page)).toBe(true);
});

// Admin UX pass: the scroll-lock layout shift is fixed with `scrollbar-gutter: stable` for the admin only (<html data-admin>, set by the admin's
// root layout). The public site keeps its layout: a gutter there would take the width of a classic scrollbar off every full-width band.
test("the scrollbar gutter is stable on the admin's pages (menu and drawer scroll lock) and left alone on the public site", async ({ page }) => {
  const gutter = () => page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter);
  await page.goto("/admin/login");
  await expect(page.locator("html[data-admin]")).toBeAttached();
  expect(await gutter()).toBe("stable");
  await page.goto("/");
  await expect(page.locator("html[data-admin]")).toHaveCount(0);
  expect(await gutter()).toBe("auto");
});
