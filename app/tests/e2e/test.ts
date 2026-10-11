import { test as base, expect, type Page, type Response } from "@playwright/test";
import { LOCAL_FIXTURES } from "./fixtures";
import { PROD_BUILD } from "./target";

// `test` for every spec that opens site pages.
// - Every test is its own visitor: the forms allow 5 submissions per 10 minutes per visitor IP (KV rate limit), and
//   against the local server (`next dev` or `next start`) the IP comes from x-forwarded-for, so repeated runs do not hit
//   the limit. On Vercel the edge sets x-forwarded-for itself and this header changes nothing.
// - Against anything but the local dev server (E2E_BASE_URL + E2E_ALLOW_REMOTE=1), every request but GET and HEAD is
//   blocked in the browser: a deployment's
//   database and notifications are real, and tests must never submit to it. Tests that submit call submitsForms()
//   and are skipped there.
// - The campaign popup (Task 14) opens on the home page 6 s after it loads and would cover whatever a test does there.
//   Unless a spec asks for it (`test.use({ campaignPopup: … })`), every page starts as if this browser session had seen
//   it already (sessionStorage "mslab-camp": the site's own once-per-session rule). "site" keeps the site's 6 s; a
//   number sets a shorter delay in ms through the page's test hook (window.__mslabCampaignDelay).
export type CampaignPopup = "off" | "site" | number;

/** A page of the public site (not the admin, the API, /media or the design-review hub), which carries the ready mark (the pay page /maksa/<token> is standalone HTML: no ready mark either). */
const SITE_PAGE = /^\/(?!admin(\/|$)|api\/|media\/|maksa\/|guide(\/|$)|p\/|_next\/)/;

/**
 * Waits after page.goto / page.reload until the public page has hydrated (<html data-site-ready>, SiteReady.tsx): a
 * click or tap that lands before React has taken the page over is lost, which under parallel load on the dev server
 * happened right after the load event. Not for a navigation that only waits for "commit", nor for non-HTML answers.
 */
async function untilReady(page: Page, response: Response | null, waitUntil: string | undefined): Promise<void> {
  if (!response || waitUntil === "commit") return;
  if (!(response.headers()["content-type"] ?? "").includes("text/html")) return;
  if (!SITE_PAGE.test(new URL(page.url()).pathname)) return;
  await page.locator("html[data-site-ready]").waitFor({ state: "attached" });
}

export const test = base.extend<{ visitorIp: string; campaignPopup: CampaignPopup; campaignInit: void }>({
  page: async ({ page }, provide) => {
    const goto = page.goto.bind(page);
    const reload = page.reload.bind(page);
    page.goto = async (url, options) => {
      const response = await goto(url, options);
      await untilReady(page, response, options?.waitUntil);
      return response;
    };
    page.reload = async (options) => {
      const response = await reload(options);
      await untilReady(page, response, options?.waitUntil);
      return response;
    };
    await provide(page);
  },
  campaignPopup: ["off", { option: true }],
  campaignInit: [
    async ({ context, campaignPopup }, use) => {
      if (campaignPopup === "off")
        await context.addInitScript(() => {
          try {
            sessionStorage.setItem("mslab-camp", "1");
          } catch {
            // a document without storage (about:blank, blocked storage)
          }
        });
      else if (typeof campaignPopup === "number")
        await context.addInitScript((ms) => {
          (window as unknown as { __mslabCampaignDelay?: number }).__mslabCampaignDelay = ms;
        }, campaignPopup);
      await use();
    },
    { auto: true },
  ],
  visitorIp: [
    async ({ context }, use, info) => {
      if (!LOCAL_FIXTURES) {
        // read-only: only GET and HEAD reach a deployment (no POST, PUT, PATCH, DELETE, …)
        await context.route("**/*", (route) => (["GET", "HEAD"].includes(route.request().method()) ? route.fallback() : route.abort("blockedbyclient")));
      } else if (PROD_BUILD) {
        // `next start` sends a cached page's Cache-Control as it is (s-maxage and stale-while-revalidate, meant for a
        // CDN). Chromium then answers a repeated prefetch from its own cache and asks again in the background, requests
        // Playwright never sees finish (networkidle never comes). On Vercel the CDN answers browsers with max-age=0,
        // must-revalidate instead. Routing the requests turns the browser's HTTP cache off: the nearest a local run gets.
        await context.route("**/*", (route) => route.fallback());
      }
      // the run-unique part first: the server keeps 64 characters of the address, and a key that is the same in every run
      // would collect the rate limit of repeated runs (5 per 10 minutes)
      const ip = `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${info.retry}-${info.project.name}-${info.testId}`;
      await context.setExtraHTTPHeaders({ "x-forwarded-for": ip });
      await use(ip);
    },
    { auto: true },
  ],
});

/** First line of every test that submits a form: it runs against the local dev server only, never a deployment. */
export function submitsForms(): void {
  test.skip(!LOCAL_FIXTURES, "submits a form: runs against the local dev server only, never a deployment");
}

export { expect };
