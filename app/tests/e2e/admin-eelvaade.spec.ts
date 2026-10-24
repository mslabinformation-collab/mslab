import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { SEED_ECOURSE_SLUG } from "./account";
import { signInAsAdmin, type CreatedRows } from "./admin-login";
import { test } from "./edit-lock";
import { insertPreviewDraft, onLocalDb, PREVIEW_DRAFT_NOTE, removeAdminRows, removePreviewDrafts } from "./fixtures";
import { PROD_BUILD } from "./target";
import { expect, submitsForms } from "./test";

// The draft preview (admin UX pass piece 3a, Task 6; ruling R-h; README §1.8 „Eelvaade ↗“): api/admin/eelvaade turns on Next's draft mode and sends the
// admin to the public page, which then shows the course's unpublished changes over its live data, and a bar with „Avaldamata {n}“, the way out and
// „Loobu muudatustest“ (spec C3). The page is that draft only for a request with the draft-mode cookie AND a live admin session, and every visitor still
// gets the page the cache holds, without the bar. A draft of a seed course's title is written straight to the local database (fixtures.ts
// insertPreviewDraft). In the production build (E2E_PROD_BUILD=1) the pages are cached as on Vercel (incremental static regeneration), and the test checks
// that a draft-mode render is never kept; under `next dev` every request renders.

test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");
test.beforeEach(() => submitsForms());

const SLUG = SEED_ECOURSE_SLUG;
const COURSE = `/koolitused/${SLUG}`;
const PREVIEW = `/api/admin/eelvaade?tee=${encodeURIComponent(COURSE)}`;
const DRAFT = "E2E eelvaate pealkiri";
/** Next's draft-mode cookie. */
const BYPASS = "__prerender_bypass";
const BAR = "[data-preview-bar]";

const created: CreatedRows = { tokens: new Set(), sessions: new Set() };

test.afterEach(async ({ isMobile }) => {
  // The phone project's tests are skipped above, yet their hooks run: with both edit projects loaded (the full run, and `next dev` has no edit lock)
  // the phone worker's cleanup deleted the desktop test's fixture draft while that test was running (Task 12: a live title in the preview, a draft
  // that was gone after „Lõpeta eelvaade“). Only the project that runs these tests cleans up after them.
  if (isMobile) return;
  expect(await removePreviewDrafts()).toBe(0);
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
});

/** Asks until the answer comes from the cache (another test's fixture may have marked the pages stale: then the first request renders the page and stores it). */
async function fromCache(request: APIRequestContext, path: string) {
  let res = await request.get(path, { failOnStatusCode: false });
  for (let i = 0; i < 3 && res.headers()["x-nextjs-cache"] !== "HIT"; i++) res = await request.get(path, { failOnStatusCode: false });
  return res;
}

/**
 * The preview bar uses the admin's ConfirmPanel, its stylesheet and its words. None of that may reach a visitor: the stylesheets and scripts the visitor's page
 * links carry neither the ConfirmPanel's styles nor the PublishBar's words (the bar's code is loaded only for a request that renders it).
 */
async function expectNoAdminCode(request: APIRequestContext, html: string) {
  const tags = html.match(/<(?:link|script)\s[^>]*>/g) ?? [];
  const urls = tags
    .filter((tag) => /rel="stylesheet"/.test(tag) || (tag.startsWith("<script") && / src="/.test(tag)))
    .map((tag) => /(?:href|src)="([^"]+)"/.exec(tag)?.[1])
    .filter((url): url is string => !!url && url.startsWith("/_next/"));
  expect(urls.length, "the page links its stylesheets and scripts").toBeGreaterThan(0);
  for (const url of new Set(urls)) {
    const body = await (await request.get(url)).text();
    expect(body, url).not.toContain("ConfirmPanel-module");
    expect(body, url).not.toContain("Loobu muudatustest");
  }
}

const hasBypass = async (context: BrowserContext) => (await context.cookies()).some((c) => c.name === BYPASS);
const draftRows = () => onLocalDb(async (sql) => (await sql<{ n: number }[]>`select count(*)::int as n from content_drafts where updated_by = ${PREVIEW_DRAFT_NOTE}`)[0].n, { marksPages: false });

/** Signs in and opens the course in the admin's preview; the draft title and the bar are there. */
async function openPreview(page: Page, context: BrowserContext, ip: string) {
  await signInAsAdmin(page, context, ip, created);
  const preview = await page.goto(PREVIEW);
  expect(new URL(page.url()).pathname).toBe(COURSE);
  await expect(page.locator("h1")).toHaveText(DRAFT);
  await expect(page.locator(BAR)).toBeVisible();
  return preview!;
}

test("a visitor gets the live page; the admin's „Eelvaade“ shows the draft and the bar; neither the preview nor a stale draft-mode cookie changes what the others get", async ({ page, context, browser, request, visitorIp }) => {
  const live = await insertPreviewDraft(SLUG, DRAFT);
  expect(live).not.toBe(DRAFT);

  // a visitor: the live title and no bar; in the production build the page is the cached one
  await page.goto(COURSE);
  await expect(page.locator("h1")).toHaveText(live);
  expect(await page.content()).not.toContain(DRAFT);
  await expect(page.locator(BAR)).toHaveCount(0);
  if (PROD_BUILD) {
    const cached = await fromCache(request, COURSE);
    expect(cached.headers()["x-nextjs-cache"]).toBe("HIT");
    const html = await cached.text();
    expect(html).not.toContain(DRAFT);
    expect(html).not.toContain("data-preview-bar");
    await expectNoAdminCode(request, html);
  }

  // the admin's „Eelvaade ↗“: draft mode on and the draft over the live title (the answer is rendered for her alone: no-store), with the bar
  const preview = await openPreview(page, context, visitorIp);
  // (the production build answers no-store; `next dev` sends every page "no-cache, must-revalidate", so there the page is only not cacheable)
  expect(preview.headers()["cache-control"]).toMatch(PROD_BUILD ? /no-store/ : /no-store|no-cache/);
  await expect(page.locator("[data-preview-count]")).toHaveText("Avaldamata 1");
  await expect(page.locator("[data-preview-discard]")).toHaveText("Loobu muudatustest");
  await expect(page.locator("[data-preview-exit]")).toHaveAttribute("href", `/api/admin/eelvaade?lopeta=1&tee=${encodeURIComponent(COURSE)}`);
  await expect(page.locator("[data-preview-exit]")).toHaveText("Lõpeta eelvaade");
  const bypass = (await context.cookies()).find((c) => c.name === BYPASS);
  expect(bypass, "the draft-mode cookie").toBeTruthy();
  // and the catalogue's card
  await page.goto("/koolitused");
  await expect(page.locator(`[data-course-card][href="${COURSE}"]`).getByRole("heading")).toHaveText(DRAFT);

  // a visitor who carries the draft-mode cookie (the cookie is no identity) but has no admin session: live, and no bar
  const stranger = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `${visitorIp}-stranger` } });
  try {
    await stranger.addCookies([bypass!]);
    const other = await stranger.newPage();
    await other.goto(COURSE);
    await expect(other.locator("h1")).toHaveText(live);
    expect(await other.content()).not.toContain(DRAFT);
    await expect(other.locator(BAR)).toHaveCount(0);
    await other.goto("/koolitused");
    await expect(other.locator(`[data-course-card][href="${COURSE}"]`).getByRole("heading")).toHaveText(live);
  } finally {
    await stranger.close();
  }

  // logging out ends the preview with the session: the draft-mode cookie is cleared (a copy of it that survives, as the stranger's, shows nothing)
  const out = await page.request.post("/api/auth/logout", { maxRedirects: 0 });
  expect(out.status()).toBe(303);
  expect(await hasBypass(context), "the draft-mode cookie is cleared").toBe(false);
  await page.goto(COURSE);
  await expect(page.locator("h1")).toHaveText(live);
  expect(await page.content()).not.toContain(DRAFT);
  await expect(page.locator(BAR)).toHaveCount(0);

  // nothing of the preview was kept: everyone else still gets the live page (in the production build, from the cache)
  const after = PROD_BUILD ? await fromCache(request, COURSE) : await request.get(COURSE);
  if (PROD_BUILD) expect(after.headers()["x-nextjs-cache"]).toBe("HIT");
  const html = await after.text();
  expect(html).not.toContain(DRAFT);
  expect(html).not.toContain("data-preview-bar");
});

test("the bar's way out (?lopeta=1) leaves draft mode: the same page, live, without the bar", async ({ page, context, visitorIp }) => {
  const live = await insertPreviewDraft(SLUG, DRAFT);
  await openPreview(page, context, visitorIp);
  await page.locator("[data-preview-exit]").click();
  await expect(page).toHaveURL((url) => url.pathname === COURSE);
  await expect(page.locator("h1")).toHaveText(live);
  await expect(page.locator(BAR)).toHaveCount(0);
  expect(await hasBypass(context)).toBe(false);
  expect(await draftRows(), "leaving the preview keeps the drafts").toBe(1);
});

test("„Loobu muudatustest“ on the preview page asks, discards the course's drafts, and ends the preview on the live page", async ({ page, context, visitorIp }) => {
  const live = await insertPreviewDraft(SLUG, DRAFT);
  await openPreview(page, context, visitorIp);
  await page.locator("[data-preview-discard]").click();
  await expect(page.locator("[data-confirm-panel]")).toContainText("Kas loobun 1 muudatusest? Avalikul lehel jääb praegune versioon.");
  // „Katkesta“ steps back out: nothing was discarded
  await page.locator("[data-confirm-panel]").getByRole("button", { name: "Katkesta" }).click();
  await expect(page.locator("[data-confirm-panel]")).toHaveCount(0);
  await expect(page.locator("[data-preview-discard]")).toBeFocused();
  expect(await draftRows()).toBe(1);
  await page.locator("[data-preview-discard]").click();
  await page.locator("[data-confirm-panel]").getByRole("button", { name: "Jah, loobu" }).click();
  await expect(page).toHaveURL((url) => url.pathname === COURSE);
  await expect(page.locator("h1")).toHaveText(live);
  await expect(page.locator(BAR)).toHaveCount(0);
  expect(await hasBypass(context)).toBe(false);
  expect(await draftRows(), "the drafts are gone").toBe(0);
});

test("„Vaata kodulehte“ (api/admin/preview) ends the preview too: the live site is what she sees there", async ({ page, context, visitorIp }) => {
  const live = await insertPreviewDraft(SLUG, DRAFT);
  await openPreview(page, context, visitorIp);
  await page.goto("/api/admin/preview");
  expect(await hasBypass(context)).toBe(false);
  await page.goto(COURSE);
  await expect(page.locator("h1")).toHaveText(live);
  await expect(page.locator(BAR)).toHaveCount(0);
});

test("the eelvaade route's ?lopeta=1 itself leaves draft mode", async ({ page, context, visitorIp }) => {
  const live = await insertPreviewDraft(SLUG, DRAFT);
  await openPreview(page, context, visitorIp);
  await page.goto(`/api/admin/eelvaade?lopeta=1&tee=${encodeURIComponent(COURSE)}`);
  expect(new URL(page.url()).pathname).toBe(COURSE);
  await expect(page.locator("h1")).toHaveText(live);
  expect(await hasBypass(context)).toBe(false);
});

test("the catalogue in the admin's preview: „Eelvaade“ and the way out „Lõpeta eelvaade“ (Dim 24.10, D-4); a visitor's has no bar and no admin code; the way out leaves draft mode", async ({ page, context, request, visitorIp }) => {
  const CATALOGUE = "/koolitused";
  const live = await insertPreviewDraft(SLUG, DRAFT);
  const card = () => page.locator(`[data-course-card][href="${COURSE}"]`).getByRole("heading");

  // a visitor: the live card and no bar; in the production build the page is the cached one, with nothing of the admin's
  await page.goto(CATALOGUE);
  await expect(card()).toHaveText(live);
  await expect(page.locator(BAR)).toHaveCount(0);
  if (PROD_BUILD) {
    const cached = await fromCache(request, CATALOGUE);
    expect(cached.headers()["x-nextjs-cache"]).toBe("HIT");
    const html = await cached.text();
    expect(html).not.toContain(DRAFT);
    expect(html).not.toContain("data-preview-bar");
    expect(html).not.toContain("Lõpeta eelvaade");
    await expectNoAdminCode(request, html);
  }

  // the admin's preview: the draft on the card, and the slim bar (no count, nothing to discard)
  await openPreview(page, context, visitorIp);
  await page.goto(CATALOGUE);
  await expect(card()).toHaveText(DRAFT);
  await expect(page.locator(`${BAR} [data-preview-label]`)).toHaveText("Eelvaade");
  const exit = page.locator(`${BAR} [data-preview-exit]`);
  await expect(exit).toHaveText("Lõpeta eelvaade");
  await expect(exit).toHaveAttribute("href", `/api/admin/eelvaade?lopeta=1&tee=${encodeURIComponent(CATALOGUE)}`);
  await expect(page.locator("[data-preview-discard], [data-preview-count]")).toHaveCount(0);
  // the Russian catalogue leaves to the Russian catalogue
  await page.goto(`/ru${CATALOGUE}`);
  await expect(page.locator(`${BAR} [data-preview-exit]`)).toHaveAttribute("href", `/api/admin/eelvaade?lopeta=1&tee=${encodeURIComponent(`/ru${CATALOGUE}`)}`);

  // the way out: draft mode off, the same catalogue as a visitor sees it, the drafts kept
  await page.goto(CATALOGUE);
  await exit.click();
  await expect(page).toHaveURL((url) => url.pathname === CATALOGUE);
  await expect(card()).toHaveText(live);
  await expect(page.locator(BAR)).toHaveCount(0);
  expect(await hasBypass(context)).toBe(false);
  expect(await draftRows(), "leaving the preview keeps the drafts").toBe(1);

  // nothing of the preview was kept: everyone else still gets the live catalogue (in the production build, from the cache)
  const after = PROD_BUILD ? await fromCache(request, CATALOGUE) : await request.get(CATALOGUE);
  if (PROD_BUILD) expect(after.headers()["x-nextjs-cache"]).toBe("HIT");
  const html = await after.text();
  expect(html).not.toContain(DRAFT);
  expect(html).not.toContain("data-preview-bar");
});
