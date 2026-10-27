import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../e2e/test";
import { LOCAL_FIXTURES } from "../e2e/fixtures";

// Every public page, ET and RU, at 390 / 834 / 1440 / 2560 (the projects of playwright.visual.config.ts):
// - no horizontal overflow (document scrollWidth ≤ clientWidth);
// - no console errors or uncaught page errors while it loads and is scrolled through;
// - a full-page screenshot in visual-shots/<local|remote>/<width>/<page>.png, with a <page>.json next to it (address,
//   status, widths, errors), for checking Maria's list against the pictures.
// The home page's popup (the newsletter sign-up) is shown on its own pictures (avaleht-kampaania), not over every home page picture.

const PAGES: [key: string, path: string][] = [
  ["avaleht", "/"],
  ["koolitused", "/koolitused"],
  ["koolitus-kontaktope", "/koolitused/kulmumeistri-baaskoolitus"],
  ["koolitus-e-ope", "/koolitused/kulmumeistri-e-koolitus"],
  ["koolituskalender", "/koolituskalender"],
  ["praktika", "/praktika"],
  ["koolitaja", "/koolitaja"],
  ["uudised", "/uudised"],
  ["uudis", "/uudised/kuidas-valida-endale-sobiv-kulmukoolitus"],
  ["kontakt", "/kontakt"],
  ["privaatsus", "/privaatsus"],
  ["tingimused", "/tingimused"],
  ["ostukorv", "/ostukorv"],
  ["konto-sisene", "/konto/sisene"],
  ["404", "/olematu-leht"],
];

const OUT = join(process.cwd(), "visual-shots", LOCAL_FIXTURES ? "local" : "remote");

/** Scrolls to the bottom and back in steps, so lazy pictures load, then waits for every picture on the page. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  // every picture a visitor would see by scrolling down is loaded; a lazy one that is not shown (the closed phone menu's
  // logo) or lies further along a horizontal carousel only loads when it is opened or scrolled to, as for a visitor
  await page
    .waitForFunction(
      () =>
        [...document.images].every((img) => {
          if (img.complete) return true;
          const r = img.getBoundingClientRect();
          return img.loading === "lazy" && (img.getClientRects().length === 0 || r.right <= 0 || r.left >= window.innerWidth);
        }),
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {}); // a picture that never loads shows up in the screenshot (and as a console error)
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300); // the header's scrolled state settles back at the top
}

async function check(page: Page, key: string, path: string, opts: { status: number; fullPage: boolean }) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // the 404 page's own document answers 404 on purpose; Chrome reports that as a failed resource
    if (opts.status === 404 && /status of 404/.test(m.text()) && m.location().url.endsWith(path)) return;
    errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  const res = await page.goto(path, { waitUntil: "load" });
  expect(res?.status(), `${path} status`).toBe(opts.status);
  await page.waitForLoadState("networkidle").catch(() => {});
  await settle(page);

  const width = test.info().project.name.replace(/^w/, "");
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  const dir = join(OUT, width);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${key}.png`), fullPage: opts.fullPage, animations: "disabled", caret: "hide" });
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({ page: key, url: new URL(path, test.info().project.use.baseURL).href, width: Number(width), status: res?.status(), scrollWidth, clientWidth, errors }, null, 2));

  expect(scrollWidth, `${path}: horizontal overflow at ${width}`).toBeLessThanOrEqual(clientWidth);
  expect(errors, `${path}: console errors`).toEqual([]);
}

for (const locale of ["et", "ru"] as const) {
  test.describe(locale.toUpperCase(), () => {
    for (const [key, path] of PAGES) {
      const url = locale === "et" ? path : path === "/" ? "/ru" : `/ru${path === "/olematu-leht" ? "/net-takoj" : path}`;
      test(`${locale}-${key} ${url}`, async ({ page }) => {
        await check(page, `${locale}-${key}`, url, { status: key === "404" ? 404 : 200, fullPage: true });
      });
    }

    test.describe("the home page's popup", () => {
      test.use({ campaignPopup: 0 }); // shown at once (test hook), as it shows 8 s after the home page opens
      const url = locale === "et" ? "/" : "/ru";
      test(`${locale}-avaleht-kampaania ${url}`, async ({ page }) => {
        const shown = page.waitForSelector("[data-newsletter-popup][open]", { timeout: 15_000 });
        await check(page, `${locale}-avaleht-kampaania`, url, { status: 200, fullPage: false });
        await shown;
        await expect(page.getByRole("dialog")).toBeVisible();
        const width = test.info().project.name.replace(/^w/, "");
        await page.waitForTimeout(500); // the card has risen (no motion with reduced motion anyway)
        await page.screenshot({ path: join(OUT, width, `${locale}-avaleht-kampaania.png`), animations: "disabled" });
      });
    });
  });
}
