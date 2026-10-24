import type { APIRequestContext } from "@playwright/test";
import { SEED_ECOURSE_SLUG } from "./account";
import { signInAsAdmin, type CreatedRows } from "./admin-login";
import { test } from "./edit-lock";
import { insertPreviewDraft, removeAdminRows, removePreviewDrafts } from "./fixtures";
import { PROD_BUILD } from "./target";
import { expect, submitsForms } from "./test";

// The draft preview (admin UX pass piece 3a, Task 6; ruling R-h; README §1.8 „Eelvaade ↗“): api/admin/eelvaade turns on Next's draft mode and sends the
// admin to the public page, which then shows the course's unpublished changes over its live data; the page is that draft only for a request with
// the draft-mode cookie AND a live admin session, and every visitor still gets the page the cache holds. A draft of a seed course's title is written
// straight to the local database (fixtures.ts insertPreviewDraft). In the production build (E2E_PROD_BUILD=1) the pages are cached as on Vercel
// (incremental static regeneration), and the test checks that a draft-mode render is never kept; under `next dev` every request renders.

test.skip(({ isMobile }) => isMobile, "the same answers for every browser: desktop project only");
test.beforeEach(() => submitsForms());

const SLUG = SEED_ECOURSE_SLUG;
const COURSE = `/koolitused/${SLUG}`;
const PREVIEW = `/api/admin/eelvaade?tee=${encodeURIComponent(COURSE)}`;
const DRAFT = "E2E eelvaate pealkiri";
/** Next's draft-mode cookie. */
const BYPASS = "__prerender_bypass";

const created: CreatedRows = { tokens: new Set(), sessions: new Set() };

test.afterEach(async () => {
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

test("a visitor gets the live page; the admin's „Eelvaade“ shows the draft; neither the preview nor a stale draft-mode cookie changes what the others get", async ({ page, context, browser, request, visitorIp }) => {
  const live = await insertPreviewDraft(SLUG, DRAFT);
  expect(live).not.toBe(DRAFT);

  // a visitor: the live title; in the production build the page is the cached one
  await page.goto(COURSE);
  await expect(page.locator("h1")).toHaveText(live);
  expect(await page.content()).not.toContain(DRAFT);
  if (PROD_BUILD) {
    const cached = await fromCache(request, COURSE);
    expect(cached.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(await cached.text()).not.toContain(DRAFT);
  }

  // the admin's „Eelvaade ↗“: draft mode on and the draft over the live title (the answer is rendered for her alone: no-store)
  await signInAsAdmin(page, context, visitorIp, created);
  const preview = await page.goto(PREVIEW);
  expect(new URL(page.url()).pathname).toBe(COURSE);
  await expect(page.locator("h1")).toHaveText(DRAFT);
  expect(preview!.headers()["cache-control"]).toMatch(/no-store/);
  const bypass = (await context.cookies()).find((c) => c.name === BYPASS);
  expect(bypass, "the draft-mode cookie").toBeTruthy();
  // and the catalogue's card
  await page.goto("/koolitused");
  await expect(page.locator(`[data-course-card][href="${COURSE}"]`).getByRole("heading")).toHaveText(DRAFT);

  // a visitor who carries the draft-mode cookie (the cookie is no identity) but has no admin session: live
  const stranger = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `${visitorIp}-stranger` } });
  try {
    await stranger.addCookies([bypass!]);
    const other = await stranger.newPage();
    await other.goto(COURSE);
    await expect(other.locator("h1")).toHaveText(live);
    expect(await other.content()).not.toContain(DRAFT);
    await other.goto("/koolitused");
    await expect(other.locator(`[data-course-card][href="${COURSE}"]`).getByRole("heading")).toHaveText(live);
  } finally {
    await stranger.close();
  }

  // draft mode outlives logout: the cookie stays, the page is live again
  const out = await page.request.post("/api/auth/logout", { maxRedirects: 0 });
  expect(out.status()).toBe(303);
  expect((await context.cookies()).some((c) => c.name === BYPASS), "the draft-mode cookie is still set").toBe(true);
  await page.goto(COURSE);
  await expect(page.locator("h1")).toHaveText(live);
  expect(await page.content()).not.toContain(DRAFT);

  // nothing of the preview was kept: everyone else still gets the live page (in the production build, from the cache)
  const after = PROD_BUILD ? await fromCache(request, COURSE) : await request.get(COURSE);
  if (PROD_BUILD) expect(after.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(await after.text()).not.toContain(DRAFT);
});

test("„Lõpeta eelvaade“ (?lopeta=1) leaves draft mode: the same page is live again", async ({ page, context, visitorIp }) => {
  const live = await insertPreviewDraft(SLUG, DRAFT);
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto(PREVIEW);
  await expect(page.locator("h1")).toHaveText(DRAFT);
  await page.goto(`/api/admin/eelvaade?lopeta=1&tee=${encodeURIComponent(COURSE)}`);
  expect(new URL(page.url()).pathname).toBe(COURSE);
  await expect(page.locator("h1")).toHaveText(live);
  expect((await context.cookies()).some((c) => c.name === BYPASS)).toBe(false);
});
