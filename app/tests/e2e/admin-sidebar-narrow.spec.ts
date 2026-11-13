import type { Locator, Page } from "@playwright/test";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { removeAdminRows } from "./fixtures";
import { test, expect } from "./test";

// The admin menu folds to its icons (Dim 13.11, the canvas „MS LAB admin sidebar collapse“): a round ‹ button on the logo's line folds the 235 px menu
// to a 72 px strip of 44 px icons, the page takes the room, and › opens it again. Each icon keeps its name for a screen reader; pointing at it (or Tab)
// shows the name in a small dark label beside the strip. The choice is a cookie (mslab-admin-nav, path /admin), so the server paints the next page
// folded already, with no jump. Below 900 px the phone bar and its menu are as before, names and all.

const created: CreatedRows = { tokens: new Set<string>(), sessions: new Set<string>() };

test.afterAll(async () => {
  await removeAdminRows(created);
});

const width = async (el: Locator) => (await el.boundingBox())?.width ?? 0;
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("the menu folds to its icons and back; the choice is kept for the next page, painted folded by the server", async ({ page, context, visitorIp, isMobile }) => {
  test.skip(isMobile, "the viewport is set here: desktop project only");
  await signInAsAdmin(page, context, visitorIp, created);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/sooduskoodid");
  await adminReady(page);

  const aside = page.locator("aside");
  const main = page.locator("#main");
  const tip = page.locator("[data-nav-tip]");
  const fold = aside.getByRole("button", { name: "Peida menüü nimed" });
  expect(await width(aside)).toBe(235);
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  // the button's name shows beside it when it is pointed at
  await fold.hover();
  await expect(tip).toHaveText("Peida menüü nimed");

  await fold.click();
  const open = aside.getByRole("button", { name: "Näita menüü nimesid" });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => width(aside)).toBe(72);
  expect((await main.boundingBox())!.x, "the page takes the room").toBe(72);
  expect(await noSideScroll(page)).toBe(true);
  expect((await context.cookies()).find((c) => c.name === "mslab-admin-nav")).toMatchObject({ value: "narrow", path: "/admin" });

  // the logo, the line under it, the group names and the e-mail make way; every entry is a 44 px icon, the folding group's too, with its name
  // kept for a screen reader, and the page's own entry marked
  await expect(aside.locator("nav a[href='/admin']")).toBeVisible(); // (Ülevaade's icon; the logo's link is hidden)
  await expect(aside.locator("img")).toBeHidden();
  await expect(aside.locator("[data-nav-group]").first()).toBeHidden();
  await expect(aside.locator("[data-nav-foot]")).not.toContainText("Sisse logitud", { useInnerText: true });
  const entries = aside.locator("nav a[data-nav]");
  for (const entry of await entries.all()) {
    await entry.scrollIntoViewIfNeeded();
    const box = (await entry.boundingBox())!;
    expect([box.width, box.height], `${await entry.getAttribute("data-nav")}: a 44 px icon`).toEqual([44, 44]);
    expect(box.x, "inside the strip").toBe(14);
  }
  await expect(aside.locator('a[data-nav="home"]')).toBeVisible();
  await expect(aside.getByRole("link", { name: /^Sooduskoodid/ })).toHaveAttribute("aria-current", "page");
  await expect(aside.getByRole("button", { name: "Logi välja" })).toBeVisible();

  // pointing at an icon shows its name beside the strip, level with the icon; it goes with the pointer, and Esc hides it
  const registrations = aside.locator('a[data-nav="registrations"]');
  await registrations.scrollIntoViewIfNeeded();
  await registrations.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Registreerimised");
  const [r, t] = [(await registrations.boundingBox())!, (await tip.boundingBox())!];
  expect(t.x, "beside the strip").toBeGreaterThanOrEqual(72 + 4);
  expect(Math.abs(t.y + t.height / 2 - (r.y + r.height / 2)), "level with its icon").toBeLessThanOrEqual(1);
  await page.mouse.move(700, 600);
  await expect(tip).toBeHidden();
  await registrations.focus();
  await expect(tip).toContainText("Registreerimised");
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();

  // the next page is folded from its first paint: the server reads the cookie
  const html = await (await page.request.get("/admin/kalender")).text();
  expect(html).toContain('data-admin-nav="narrow"');
  await page.reload();
  await adminReady(page);
  expect(await width(aside)).toBe(72);

  // a short screen: the footer stays whole and every icon can be reached in the strip
  await page.setViewportSize({ width: 1280, height: 700 });
  const foot = (await aside.locator("[data-nav-foot]").boundingBox())!;
  expect(foot.y + foot.height).toBeLessThanOrEqual(700);
  const nav = (await aside.locator("nav").boundingBox())!;
  for (const entry of await entries.all()) {
    await entry.scrollIntoViewIfNeeded();
    const e = (await entry.boundingBox())!;
    expect(e.y >= nav.y - 0.5 && e.y + e.height <= nav.y + nav.height + 0.5, `${await entry.getAttribute("data-nav")} reachable`).toBe(true);
  }

  // a phone width keeps its bar and its menu with the names, folded choice or not
  await page.setViewportSize({ width: 899, height: 900 });
  await expect(aside).toBeHidden();
  await page.getByRole("button", { name: "Ava menüü" }).click();
  await expect(page.locator("[data-admin-drawer]").getByRole("link", { name: /^Sooduskoodid/ })).toHaveText(/Sooduskoodid/);
  await page.locator("[data-admin-menu-close]").click();

  // › opens it again, and the cookie goes
  await page.setViewportSize({ width: 1440, height: 900 });
  await aside.getByRole("button", { name: "Näita menüü nimesid" }).click();
  await expect.poll(() => width(aside)).toBe(235);
  await expect(aside.getByRole("button", { name: "Peida menüü nimed" })).toHaveAttribute("aria-expanded", "true");
  await expect(aside.locator("img")).toBeVisible();
  expect((await context.cookies()).find((c) => c.name === "mslab-admin-nav")).toBeUndefined();
  expect(await (await page.request.get("/admin/kalender")).text()).not.toContain('data-admin-nav="narrow"');
});
