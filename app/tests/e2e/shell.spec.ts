import { submitsForms, test, expect } from "./test";
import { LOCAL_FIXTURES, storedSubscriber, testEmail } from "./fixtures";

// Site shell (Task 6): B header with Manrope UI font (G3, G4), footer with the lilac newsletter (H13), ET + RU (G8).

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "desktop layout only");

  test("header and footer", async ({ page }) => {
    await page.goto("/");
    const header = page.locator("header");
    await expect(header.getByRole("link", { name: "Koolitused" })).toBeVisible();
    await expect(header.getByRole("link", { name: "Logi sisse" })).toBeVisible();
    const navFont = await header.getByRole("link", { name: "Koolitused" }).evaluate((el) => getComputedStyle(el).fontFamily);
    expect(navFont).toMatch(/Jost/i); // phase 2c: the menu in Jost
    await page.mouse.wheel(0, 900); await page.waitForTimeout(400);
    expect(await header.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
    await expect(page.locator("footer").getByText("Otse sinu postkasti.")).toBeVisible();
    await page.goto("/ru"); await expect(page.locator("header").getByRole("link", { name: "Курсы" })).toBeVisible();
  });

  test("login and language switch are Manrope 500 15px (G4); the menu is Jost (phase 2c, look.spec.ts)", async ({ page }) => {
    await page.goto("/");
    const header = page.locator("header");
    for (const el of [
      header.getByRole("link", { name: "Logi sisse" }),
      header.getByRole("link", { name: /Vaheta keelt/ }),
    ]) {
      const s = await el.evaluate((e) => { const c = getComputedStyle(e); return { f: c.fontFamily, w: c.fontWeight, z: c.fontSize }; });
      expect(s.f).toMatch(/Manrope/i); expect(s.w).toBe("500"); expect(s.z).toBe("15px");
    }
  });

  test("home header is transparent over the hero and follows the hero tone (G3, G5)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" }); // no autoplay changing the tone while the test sets it
    await page.goto("/");
    // The hero writes its slide's tone to <html> when it mounts: wait for that, or it can overwrite the test's value
    // (seen once under parallel load: "load" fired before the hero's effect ran).
    await expect(page.locator("html")).toHaveAttribute("data-hero-tone", "light");
    const header = page.locator("header");
    expect(await header.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    const ink = await header.evaluate((el) => getComputedStyle(el).color);
    await page.evaluate(() => { document.documentElement.dataset.heroTone = "dark"; });
    await expect.poll(() => header.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 255, 255)");
    await page.evaluate(() => { document.documentElement.dataset.heroTone = "light"; });
    await expect.poll(() => header.evaluate((el) => getComputedStyle(el).color)).toBe(ink);
  });

  test("inner pages have a white sticky header; the login page switches language", async ({ page }) => {
    await page.goto("/konto/sisene");
    const header = page.locator("header");
    const s = await header.evaluate((el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, pos: c.position }; });
    expect(s).toEqual({ bg: "rgb(255, 255, 255)", pos: "sticky" });
    await expect(page.getByRole("heading", { level: 1, name: "Logi sisse" })).toBeVisible();
    await header.getByRole("link", { name: /Vaheta keelt/ }).click();
    await expect(page).toHaveURL(/\/ru\/konto\/sisene$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.getByRole("heading", { level: 1, name: "Войти" })).toBeVisible();
  });

  test("the language switch keeps the query and hash, and leaves Ctrl/Shift/middle clicks to the browser (item 8)", async ({ page, context }) => {
    await page.goto("/koolitused?vorm=k#x");
    const lang = page.locator("header").getByRole("link", { name: /Vaheta keelt/ });
    // Ctrl+click: a new tab with the Russian page and the same query; this page stays as it is
    const [tab] = await Promise.all([context.waitForEvent("page"), lang.click({ modifiers: ["ControlOrMeta"] })]);
    await tab.waitForURL(/\/ru\/koolitused/);
    expect(new URL(tab.url()).pathname + new URL(tab.url()).search + new URL(tab.url()).hash).toBe("/ru/koolitused?vorm=k#x");
    await tab.close();
    await expect(page).toHaveURL(/\/koolitused\?vorm=k#x$/);
    // middle click: a new tab too (not this one)
    const [tab2] = await Promise.all([context.waitForEvent("page"), lang.click({ button: "middle" })]);
    await tab2.waitForURL(/\/ru\/koolitused/);
    expect(new URL(tab2.url()).pathname + new URL(tab2.url()).search).toBe("/ru/koolitused?vorm=k");
    await tab2.close();
    await expect(page).toHaveURL(/\/koolitused\?vorm=k#x$/);
    // a plain click switches this tab
    await lang.click();
    await expect(page).toHaveURL(/\/ru\/koolitused\?vorm=k#x$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  });

  test("the newsletter card is the footer's right third, not stretched across it, on wide screens (phase 2c: it was capped at 1400 px and centred, item 8)", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1300 });
    await page.goto("/konto/sisene");
    const card = page.locator("footer [data-footer-newsletter]");
    const links = page.locator("footer").getByRole("link", { name: "Kõik koolitused" });
    const box = (await card.boundingBox())!;
    expect(Math.round(box.x + box.width)).toBe(2560 - 100); // the footer's side padding (--page) is 100 px from 1818 px up
    expect(box.width).toBeGreaterThan(700);
    expect(box.width).toBeLessThan(800); // about a third of the 2360 px inside the padding, minus its share of the gap
    expect(box.x).toBeGreaterThan((await links.boundingBox())!.x);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await card.boundingBox())!.width).toBeLessThan(box.width); // narrower screens: the footer's width
  });

  test("unknown paths show a localized 404 inside the shell", async ({ page }) => {
    const et = await page.goto("/olematu-leht");
    expect(et?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Lehte ei leitud" })).toBeVisible();
    await expect(page.locator("header").getByRole("link", { name: "Koolitused" })).toBeVisible();
    const ru = await page.goto("/ru/net-takoj");
    expect(ru?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Страница не найдена" })).toBeVisible();
  });

  test("the whole host is noindex", async ({ request }) => {
    for (const p of ["/", "/ru", "/konto", "/brand/logo.png"]) {
      const res = await request.get(p);
      expect(res.headers()["x-robots-tag"], p).toBe("noindex, nofollow");
    }
  });

  test("newsletter form shows the sent state", async ({ page }, info) => {
    submitsForms();
    const addr = testEmail("shell-nl", info.project.name);
    await page.goto("/konto/sisene");
    const footer = page.locator("footer");
    await footer.getByLabel("Sinu e-post").fill(addr);
    await footer.getByRole("button", { name: "Liitu" }).click();
    await expect(footer.getByText("Aitäh, oled liitunud!")).toBeVisible();
    if (LOCAL_FIXTURES) expect(await storedSubscriber(addr)).toMatchObject({ email: addr, confirmed: true });
  });
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile layout only");

  test("burger menu opens and lists the six links, „Kontakt“ the last (UX pass 11.11 P9)", async ({ page }) => {
    await page.goto("/");
    const header = page.locator("header");
    await expect(header.getByRole("link", { name: "Koolituskalender", exact: true })).toHaveCount(0); // desktop menu hidden
    await header.getByRole("button", { name: "Ava menüü" }).click();
    const menu = page.getByRole("dialog");
    await expect(menu).toBeVisible();
    for (const name of ["Koolitused", "Koolituskalender", "Praktika", "Koolitaja", "Uudised ja nõuanded", "Kontakt"])
      await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Logi sisse" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("no horizontal overflow", async ({ page }) => {
    for (const p of ["/", "/konto/sisene", "/ru"]) {
      await page.goto(p);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), p).toBeLessThanOrEqual(390);
    }
  });
});
