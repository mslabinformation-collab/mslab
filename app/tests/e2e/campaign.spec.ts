import type { Locator, Page } from "@playwright/test";
import { onLocalDb } from "./fixtures";
import { test, expect } from "./test";

// The home page's popup (admin UX pass piece 4b, Task 4; spec D3, rulings R-d, R-e; builder notes §5): one popup, the newsletter sign-up (campaign row
// 2) — the old campaign offer (row 1) is shown nowhere. Only on / and /ru, 8 s after the page appears, once in 30 days per browser (localStorage
// "mslab-popup", the time it was shown), never again in a browser that signed up ("mslab-nl"), never on any other page. A modal dialog: focus moves in
// and stays inside, Esc, ✕, the backdrop and (on a phone, where it is a bottom sheet) a downward swipe close it, and focus goes back. Its button follows
// Seaded's welcome code (S4-Q4): „Saa kood“ while there is one, else „Liitu“.
//
// These tests only read the seed's popup („Hea järgmine samm. Otse sinu postkasti.“, the seed picture; global-setup.ts ensureSeedPopup shows it in a
// database seeded before piece 4b). The tests that change it (Hüpikaken's switch and publish, a sign-up) are in admin-site.spec.ts, which runs after
// every other test (playwright.config.ts). Every test is a new browser context, so a browser that has not seen it.

const TITLE = "Hea järgmine samm. Otse sinu postkasti.";
const TITLE_RU = "Ваш следующий шаг. В вашем почтовом ящике.";
const DAY = 86_400_000;
const popup = (page: Page) => page.getByRole("dialog", { name: TITLE });
const anyDialog = (page: Page) => page.getByRole("dialog");
const stamp = (page: Page) => page.evaluate(() => localStorage.getItem("mslab-popup"));
const forget = (page: Page) => page.evaluate(() => localStorage.removeItem("mslab-popup"));
const scrollLocked = (page: Page) => page.evaluate(() => document.documentElement.style.overflow === "hidden");
/** The popup's button as Seaded's code makes it (S4-Q4): read from the local database, which the tests of this file do not change. */
const submitWords = async (ru = false) => {
  const [row] = await onLocalDb((sql) => sql<{ code: string | null }[]>`select value->>'welcomeCode' as code from settings where key = 'newsletter'`, { marksPages: false });
  const code = /^[A-Z0-9-]{1,30}$/.test(row?.code ?? "");
  return ru ? (code ? "Получить код" : "Подписаться") : code ? "Saa kood" : "Liitu";
};

/** A finger pulling `el` down by `distance` px (Chrome DevTools touch input, as in swipe.spec.ts). */
async function swipeDown(page: Page, el: Locator, distance: number) {
  const box = await el.boundingBox();
  if (!box) throw new Error("swipe target has no box");
  const x = box.x + box.width / 2;
  const fromY = box.y + 60;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: fromY + (distance * i) / steps }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

test.describe("the site's own timing (R-e)", () => {
  test.use({ campaignPopup: "site" });

  test("on / it opens after 8 s and stamps this browser; not again after a reload (30 days); never on /koolitused", async ({ page }) => {
    test.setTimeout(75_000);
    // Timed from the page's first byte (waitUntil "commit"). The popup's 8 s start later still, once the page has run its scripts, so for the first
    // 7 s there is no dialog at all: the old 6 s (or anything shorter) fails here.
    await page.goto("/", { waitUntil: "commit" });
    const start = Date.now();
    while (Date.now() - start < 7000) {
      expect(await anyDialog(page).count(), `no dialog at ${Date.now() - start} ms`).toBe(0);
      await page.waitForTimeout(250);
    }
    expect(await stamp(page)).toBeNull();
    await expect(popup(page)).toBeVisible({ timeout: 6000 });
    const shownAt = Number(await stamp(page)); // set when it is shown: the time
    expect(Math.abs(Date.now() - shownAt)).toBeLessThan(10_000);
    await expect(popup(page).getByRole("button", { name: await submitWords(), exact: true })).toBeVisible();
    await expect(page.getByText("Mitte praegu")).toHaveCount(0);

    await page.reload();
    await page.waitForTimeout(9000);
    await expect(anyDialog(page)).toHaveCount(0); // once in 30 days

    // a browser that last saw it 31 days ago gets it again
    await page.evaluate((at) => localStorage.setItem("mslab-popup", String(at)), Date.now() - 31 * DAY);
    await page.goto("/koolitused");
    await page.waitForTimeout(9000);
    await expect(anyDialog(page)).toHaveCount(0); // never on another page
    expect(Number(await stamp(page))).toBeLessThan(Date.now() - 30 * DAY);
  });
});

test.describe("the dialog", () => {
  // long enough to put the focus somewhere first
  test.use({ campaignPopup: 2000 });

  test("the card in a modal dialog named by its title; focus moves in, Tab stays inside, Esc closes and gives the focus back", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const logo = page.getByRole("banner").getByRole("link", { name: "MS LAB Koolituskeskus — avaleht" });
    await logo.focus();
    const p = popup(page);
    await expect(p).toBeVisible();
    await expect(p).toHaveAttribute("aria-modal", "true");
    const titleId = await p.getAttribute("aria-labelledby");
    await expect(page.locator(`[id="${titleId}"]`)).toHaveText(TITLE);
    await expect(p.getByRole("heading", { level: 2 })).toHaveText(TITLE);
    // the picture, kicker, title and text, the form (no code, no consent box: the line under the button is the consent)
    const card = p.locator("[data-newsletter-card]");
    await expect(card.locator("img")).toHaveAttribute("src", "/seed/gift-bag-serum.jpg");
    await expect(card.getByText("MS LABi kirjad")).toBeVisible();
    await expect(card.getByText("Uued koolitused, kasulikud mõtted")).toBeVisible();
    await expect(p.getByRole("checkbox")).toHaveCount(0);
    await expect(p.locator("[data-newsletter-notice]")).toHaveText("Liitudes saad MS LABi uudiskirja. Saad igal ajal loobuda. Privaatsus");

    const close = p.getByRole("button", { name: "Sulge" });
    const email = p.getByLabel("Sinu e-post");
    const submit = p.getByRole("button", { name: await submitWords(), exact: true });
    const privacy = p.getByRole("link", { name: "Privaatsus" });
    await expect(close).toBeFocused();
    expect(await scrollLocked(page)).toBe(true);
    await page.keyboard.press("Tab");
    await expect(email).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(submit).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(privacy).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused(); // round again, never out to the page
    await page.keyboard.press("Shift+Tab");
    await expect(privacy).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(anyDialog(page)).toHaveCount(0);
    await expect(logo).toBeFocused();
    expect(await scrollLocked(page)).toBe(false);
  });

  test("✕ closes it and gives the focus back; a click on the card does not, a click on the backdrop does", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const logo = page.getByRole("banner").getByRole("link", { name: "MS LAB Koolituskeskus — avaleht" });
    await logo.focus();
    await expect(popup(page)).toBeVisible();
    await popup(page).getByRole("button", { name: "Sulge" }).click();
    await expect(anyDialog(page)).toHaveCount(0);
    await expect(logo).toBeFocused();
    expect(await scrollLocked(page)).toBe(false);

    await forget(page);
    await page.reload();
    const p = popup(page);
    await expect(p).toBeVisible();
    await p.getByText("Uued koolitused, kasulikud mõtted").click();
    await expect(p).toBeVisible();
    await page.mouse.click(6, 6); // the backdrop: the window's top left corner, outside the card (and above the phone sheet)
    await expect(anyDialog(page)).toHaveCount(0);
  });
});

test.describe("leaving the home page early", () => {
  // the course card is clicked once the page has loaded, well before the popup's time
  test.use({ campaignPopup: 4000 });

  test("a client-side move to a course before the popup's time: none there; back on the home page it comes", async ({ page }) => {
    await page.goto("/");
    await page.locator("[data-course-card]").first().click();
    await expect(page).toHaveURL(/\/koolitused\/[a-z0-9-]+$/);
    await page.waitForTimeout(4600);
    await expect(anyDialog(page)).toHaveCount(0);
    expect(await stamp(page)).toBeNull();
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(popup(page)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("short delay", () => {
  test.use({ campaignPopup: 300 });

  test("when the browser refuses storage, it is shown once per page load: not again after closing, nor back on the home page", async ({ page }) => {
    await page.addInitScript(() =>
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("blocked", "SecurityError");
        },
      }),
    );
    await page.goto("/");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(anyDialog(page)).toHaveCount(0);
    await page.waitForTimeout(1500);
    await expect(anyDialog(page)).toHaveCount(0);

    // home → course → home without a page load (the marker survives only in the same document)
    await page.evaluate(() => ((window as unknown as { sameLoad: boolean }).sameLoad = true));
    await page.locator("[data-course-card]").first().click();
    await expect(page).toHaveURL(/\/koolitused\/[a-z0-9-]+$/);
    await page.getByRole("banner").getByRole("link", { name: "MS LAB Koolituskeskus — avaleht" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("[data-hero]")).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(anyDialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { sameLoad?: boolean }).sameLoad)).toBe(true);

    // a new page load may show it once more
    await page.reload();
    await expect(popup(page)).toBeVisible();
  });

  test("the privacy link closes the popup on its way to /privaatsus; a ctrl/cmd-click opens it elsewhere and the popup stays", async ({ page, context }) => {
    await page.goto("/");
    const p = popup(page);
    const privacy = p.getByRole("link", { name: "Privaatsus" });
    await expect(p).toBeVisible();
    const opened = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await privacy.click({ modifiers: ["ControlOrMeta"] });
    (await opened)?.close();
    await expect(p).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await privacy.click();
    await expect(page).toHaveURL(/\/privaatsus$/);
    await expect(anyDialog(page)).toHaveCount(0);
    expect(await scrollLocked(page)).toBe(false);
  });

  test("/ru: the Russian card, controls and button; the privacy link stays in Russian", async ({ page }) => {
    await page.goto("/ru");
    const p = page.getByRole("dialog", { name: TITLE_RU });
    await expect(p.getByRole("button", { name: "Закрыть" })).toBeFocused();
    await expect(p.getByRole("button", { name: await submitWords(true), exact: true })).toBeVisible();
    await expect(p.getByRole("link", { name: "Конфиденциальность" })).toHaveAttribute("href", "/ru/privaatsus");
    expect(await stamp(page)).not.toBeNull();
  });

  test("never on any other page: catalogue, course, calendar, practice, cart, Russian pages, admin", async ({ page }) => {
    for (const path of ["/koolitused", "/koolitused/lash-lift-botox", "/koolituskalender", "/praktika", "/ostukorv", "/kontakt", "/ru/koolitused", "/ru/ostukorv", "/admin/login"]) {
      await page.goto(path);
      await page.waitForTimeout(900);
      await expect(anyDialog(page), path).toHaveCount(0);
      expect(await stamp(page), path).toBeNull();
    }
    await page.goto("/"); // the same browser still gets it on the home page
    await expect(popup(page)).toBeVisible();
  });

  test("no sideways scrolling at 360–2560; the picture beside the text when there is room; controls ≥ 44 px", async ({ page, isMobile }) => {
    test.skip(isMobile, "the desktop project sets each width");
    for (const [w, h] of [[360, 740], [375, 812], [390, 844], [834, 1112], [1024, 768], [1280, 800], [1440, 900], [2560, 1440]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/");
      const p = popup(page);
      await expect(p).toBeVisible();
      const panel = p.locator("[data-newsletter-panel]");
      await expect.poll(() => panel.evaluate((e) => getComputedStyle(e).transform), `${w}: settled`).toBe("none");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${w}: page`).toBeLessThanOrEqual(0);
      expect(await panel.evaluate((e) => e.scrollWidth - e.clientWidth), `${w}: card`).toBeLessThanOrEqual(0);
      for (const el of [p.getByRole("button", { name: "Sulge" }), p.getByRole("button", { name: await submitWords(), exact: true }), p.getByLabel("Sinu e-post")]) {
        const b = (await el.boundingBox())!;
        expect(b.height, `${w}: ${await el.evaluate((e) => e.outerHTML.slice(0, 60))}`).toBeGreaterThanOrEqual(44);
        expect(b.x + b.width, `${w}: inside the window`).toBeLessThanOrEqual(w);
      }
      const photo = (await p.locator("[data-newsletter-card] img").boundingBox())!;
      const title = (await p.getByRole("heading", { level: 2 }).boundingBox())!;
      const box = (await panel.boundingBox())!;
      if (w >= 834) {
        expect(photo.x + photo.width, `${w}: picture left of the text`).toBeLessThanOrEqual(title.x);
        expect(Math.abs(box.x + box.width / 2 - w / 2), `${w}: centred`).toBeLessThan(2);
        expect(box.width, `${w}: D's 840 px`).toBeLessThanOrEqual(840);
      } else {
        expect(photo.y + photo.height, `${w}: picture on top`).toBeLessThanOrEqual(title.y);
        expect(Math.round(box.y + box.height), `${w}: a bottom sheet`).toBe(h);
        expect(Math.round(box.width), `${w}: full width`).toBe(w);
      }
      await page.keyboard.press("Escape");
      await expect(anyDialog(page)).toHaveCount(0);
      await forget(page);
    }
  });
});

test.describe("phone: the bottom sheet closes with a downward swipe (Dim: swipe wherever it matters)", () => {
  test.skip(({ isMobile }) => !isMobile, "touch swipes: phone project only");
  test.use({ campaignPopup: 300 });

  test("a short pull springs back; a swipe down closes it", async ({ page }) => {
    await page.goto("/");
    const p = popup(page);
    const panel = p.locator("[data-newsletter-panel]");
    await expect(p).toBeVisible();
    await expect.poll(() => panel.evaluate((e) => getComputedStyle(e).transform)).toBe("none");
    const box = (await panel.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(page.viewportSize()!.height); // a bottom sheet
    await swipeDown(page, panel, 30);
    await expect(p).toBeVisible();
    await expect.poll(() => panel.evaluate((e) => getComputedStyle(e).transform)).toBe("none"); // back in place
    await swipeDown(page, panel, 260);
    await expect(anyDialog(page)).toHaveCount(0);
    expect(await scrollLocked(page)).toBe(false);
    await expect(page).toHaveURL(/\/$/); // a swipe is not a tap on a link
  });

  test("with reduced motion: no sliding, but the swipe still closes it", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const p = popup(page);
    const panel = p.locator("[data-newsletter-panel]");
    await expect(p).toBeVisible();
    expect(await panel.evaluate((e) => getComputedStyle(e).transitionDuration)).toBe("0s");
    expect(await panel.evaluate((e) => getComputedStyle(e).transform)).toBe("none"); // no entrance offset
    await swipeDown(page, panel, 260);
    await expect(anyDialog(page)).toHaveCount(0);
  });
});
