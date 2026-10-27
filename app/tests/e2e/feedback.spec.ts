import type { Page } from "@playwright/test";
import { DEV_REVIEW_KEY } from "../../src/server/review-key";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { LOCAL_FIXTURES, removeAdminRows } from "./fixtures";
import { deleteLocalComments, E2E_COMMENT } from "./local-kv";
import { E2E_REVIEW_KEY } from "./prod-build";
import { PROD_BUILD } from "./target";
import { expect, submitsForms, test } from "./test";

// Task 15: the design-review hub (/guide/, /p/<dir>/, /guide/tagasiside/) and its comment API (/api/feedback) inside
// the app, and the comment widget on the main site's public pages and (Dim 22.10) on every page of the admin.
// Against `next dev` there is no ADMIN_KEY: the list accepts the local development key (src/server/review-key.ts); the
// local production build never does, so it is started with an ADMIN_KEY of its own (prod-build.ts). The comments go to
// the server's KV (the kv_entries table of the local database), from which each test deletes its own again.

/** The key the local server's comment list accepts. */
const REVIEW_KEY = PROD_BUILD ? E2E_REVIEW_KEY : DEV_REVIEW_KEY;

type Item = { id: string; dir: string; route?: string; title?: string; device?: string; name?: string; mood?: string; text: string; done: boolean; link: string; el: { label?: string; sel?: string } };

const listComments = async (page: Page, key: string | null = REVIEW_KEY) => page.request.get("/api/feedback", { headers: key === null ? {} : { "x-key": key } });

async function commentById(page: Page, id: string): Promise<Item | undefined> {
  const res = await listComments(page);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { items: Item[] }).items.find((x) => x.id === id);
}

test.describe("design-review hub", () => {
  test("/guide redirects to /guide/, which shows the four directions with their pictures", async ({ page }) => {
    const res = await page.goto("/guide");
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/guide/");
    expect(res?.headers()["x-robots-tag"]).toContain("noindex");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Vali oma veebilehe suund.");
    const dirs = page.locator("#dirs article");
    await expect(dirs).toHaveCount(4);
    await expect(dirs.getByRole("heading", { level: 3 })).toHaveText(["A · Pehme toimetus", "B · Õppeteekond", "C · Kunst pilgus", "D · Studio"]);
    // relative asset URLs resolve under /guide/
    const thumb = dirs.first().locator("img").first();
    await thumb.scrollIntoViewIfNeeded();
    await expect(thumb).toHaveJSProperty("complete", true);
    expect(await thumb.evaluate((img: HTMLImageElement) => [new URL(img.src).pathname, img.naturalWidth > 0])).toEqual(["/guide/thumbs/a-d.jpg", true]);
    await expect(page.getByRole("button", { name: "Jäta kommentaar" })).toBeVisible(); // the widget, as before
  });

  test("/p/d/ renders the prototype with its own styles and script", async ({ page }) => {
    const res = await page.goto("/p/d/");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle("Avaleht — MS LAB Koolituskeskus"); // set by the prototype's app.js for its home view
    await expect(page.locator("#main h1").first()).toBeVisible();
    const css = await page.request.get("/p/d/styles.css");
    expect(css.status()).toBe(200);
    expect(await page.evaluate(() => [...document.styleSheets].some((s) => s.href?.endsWith("/p/d/styles.css") && s.cssRules.length > 0))).toBe(true);
    expect((await page.goto("/p/d"))?.url()).toMatch(/\/p\/d\/$/);
  });

  test("/guide/tagasiside/ asks for the key and refuses a wrong one", async ({ page }) => {
    await page.goto("/guide/tagasiside/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kommentaarid");
    await expect(page.getByText("Sisesta ligipääsuvõti.")).toBeVisible();
    test.skip(!LOCAL_FIXTURES, "a wrong key is only tried against the local dev server");
    await page.getByPlaceholder("Võti").fill("vale-võti");
    await page.getByRole("button", { name: "Ava" }).click();
    await expect(page.getByText("Vale võti.")).toBeVisible();
  });
});

test.describe("comment API", () => {
  test("no body → 400, list without or with a wrong key → 401, unknown comment → 404", async ({ page }) => {
    submitsForms();
    for (const res of [
      await page.request.post("/api/feedback", { headers: { "content-type": "application/json" } }),
      await page.request.post("/api/feedback", { data: { name: "x" } }),
    ])
      expect(res.status()).toBe(400);
    expect((await listComments(page, null)).status()).toBe(401);
    expect((await listComments(page, "wrong-key")).status()).toBe(401);
    expect((await page.request.patch("/api/feedback/zzzzzzzzzzzzzz", { data: { done: true } })).status()).toBe(401);
    expect((await page.request.get("/api/feedback/zzzzzzzzzzzzzz")).status()).toBe(404);
    const big = await page.request.post("/api/feedback", { data: { text: `${E2E_COMMENT} ${"x".repeat(20_000)}` } });
    expect(big.status()).toBe(413);
  });
});

test.describe("comment widget on the main site", () => {
  test("is on the public pages, and not on the admin's login page (signed out: no preview cookie, a comment could not be sent)", async ({ page }) => {
    await page.goto("/koolitused");
    await expect(page.locator('script[src="/feedback.js?v=6"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Jäta kommentaar" })).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-fb-dir", /.*/); // (the site's comments stay "site")
    await page.goto("/admin/login");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator('script[src*="feedback.js"]')).toHaveCount(0);
    await expect(page.locator("#mslab-fb")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Jäta kommentaar" })).toHaveCount(0);
  });

  test("a comment marked on /koolitused is listed as a main-site comment, opens at its place and can be marked done", async ({ page }, info) => {
    submitsForms();
    const text = `${E2E_COMMENT} ${info.project.name} ${Date.now().toString(36)} Pealkiri võiks olla suurem`;
    const ids: string[] = [];
    try {
      await page.goto("/koolitused");
      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toBeVisible();
      await page.getByRole("button", { name: "Jäta kommentaar" }).click();
      const panel = page.getByRole("dialog", { name: "Jäta kommentaar" });
      await panel.getByLabel("Sinu nimi").fill("E2E Maria");
      await panel.getByRole("button", { name: "Muuta" }).click();

      // marking a place: the bar sits above the sticky header, the outline follows the pointer
      await panel.getByRole("button", { name: /Märgi koht lehel/ }).click();
      const bar = page.locator("#mslab-fb .fb-bar");
      await expect(bar).toBeVisible();
      const onTop = await bar.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      });
      expect(onTop).toBe(true);
      const box = (await heading.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const headingText = (await heading.textContent())!.trim();
      await expect(panel.getByText(`Koht: ${headingText}`)).toBeVisible();

      await panel.getByLabel("Kommentaar").fill(text);
      const sent = page.waitForResponse((r) => r.url().endsWith("/api/feedback") && r.request().method() === "POST");
      await panel.getByRole("button", { name: "Saada" }).click();
      const res = await sent;
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ok: boolean; id: string; stored: boolean; telegram: boolean };
      ids.push(body.id);
      expect(body).toMatchObject({ ok: true, stored: true, telegram: false }); // no TELEGRAM_BOT_TOKEN locally
      await expect(page.getByText("Aitäh! Kommentaar on saadetud ✓")).toBeVisible();

      // listed with the key, as a main-site comment linking back to the page
      const item = await commentById(page, body.id);
      expect(item).toMatchObject({
        dir: "site",
        route: "/koolitused",
        title: "Koolitused",
        device: info.project.name.startsWith("mobile") ? "mob" : "desk",
        name: "E2E Maria",
        mood: "change",
        text,
        done: false,
        el: { label: headingText },
      });
      expect(item!.link).toBe(new URL(`/koolitused?fb=${body.id}`, page.url()).href);

      // "Näita kohta": the page outlines the marked heading and shows the comment next to it
      await page.goto(new URL(item!.link).pathname + new URL(item!.link).search);
      const note = page.locator("#mslab-fb .fb-note");
      await expect(note).toContainText(text);
      await expect(note).toContainText("E2E Maria");
      await expect(note).not.toContainText("täpset kohta ei leitud");
      const outline = page.locator("#mslab-fb .fb-hl");
      await expect(outline).toBeVisible();
      const [o, h] = [(await outline.boundingBox())!, (await heading.boundingBox())!];
      expect(Math.abs(o.y + 4 - h.y)).toBeLessThan(2);
      expect(Math.abs(o.height - 8 - h.height)).toBeLessThan(2);

      // PATCH round trip (the list page's "Tehtud ✓"), and without the key nothing changes
      expect((await page.request.patch(`/api/feedback/${body.id}`, { data: { done: true } })).status()).toBe(401);
      expect((await commentById(page, body.id))!.done).toBe(false);
      const done = await page.request.patch(`/api/feedback/${body.id}`, { headers: { "x-key": REVIEW_KEY }, data: { done: true } });
      expect(done.status()).toBe(200);
      expect((await commentById(page, body.id))!.done).toBe(true);
      expect((await page.request.patch(`/api/feedback/${body.id}`, { headers: { "x-key": REVIEW_KEY }, data: { done: "yes" } })).status()).toBe(400);
      expect((await page.request.patch(`/api/feedback/${body.id}`, { headers: { "x-key": REVIEW_KEY }, data: { done: false } })).status()).toBe(200);

      // the list page shows it under "Põhileht" with the link, and marks it done
      await page.goto(`/guide/tagasiside/#key=${REVIEW_KEY}`);
      const card = page.locator("article.card").filter({ hasText: text });
      await expect(card).toBeVisible();
      await expect(card.getByText("Põhileht", { exact: true })).toBeVisible();
      await expect(card.getByRole("link", { name: "Näita kohta" })).toHaveAttribute("href", item!.link);
      await card.getByRole("button", { name: "Tehtud ✓" }).click();
      await expect(card).toHaveCount(0); // the default filter shows open comments only
      expect((await commentById(page, body.id))!.done).toBe(true);
    } finally {
      if (ids.length) await deleteLocalComments(ids);
    }
    expect(await commentById(page, ids[0])).toBeUndefined();
  });
});

// Task 16 item 11: the comment button moves up so that it never covers the site's own bottom-right messages.
test.describe("the comment button keeps clear of the site's messages", () => {
  const fab = (page: Page) => page.getByRole("button", { name: "Jäta kommentaar" });
  /** The button is entirely above `el` (or beside it): no overlap. */
  async function clearOf(page: Page, el: import("@playwright/test").Locator) {
    await expect(el).toBeVisible();
    await expect
      .poll(async () => {
        const [a, b] = [await fab(page).boundingBox(), await el.boundingBox()];
        if (!a || !b) return "no box";
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        return overlap ? `overlap: button ${JSON.stringify(a)} message ${JSON.stringify(b)}` : "clear";
      })
      .toBe("clear");
    expect((await fab(page).boundingBox())!.y).toBeGreaterThanOrEqual(0); // still on screen
  }

  test("above the course page's share toast", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true })); // the toast path
    await page.goto("/koolitused/kulmumeistri-baaskoolitus");
    await expect(fab(page)).toBeVisible();
    await page.getByRole("button", { name: "Jaga koolitust" }).first().click();
    await clearOf(page, page.locator("[data-fab-avoid][role='status']").filter({ hasText: /\S/ }).first());
    // and back down once the toast is gone (2.6 s)
    await expect.poll(async () => (await fab(page).evaluate((e) => getComputedStyle(e).bottom)), { timeout: 6000 }).toBe("16px");
  });

  test("above the newsletter notice", async ({ page }) => {
    await page.goto("/?uudiskiri=kinnitatud");
    await expect(fab(page)).toBeVisible();
    await clearOf(page, page.locator("[data-flash-notice] [data-fab-avoid]"));
  });

  test("never on the works gallery's arrows on /koolitaja at 1440×900 (N4)", async ({ page, isMobile }) => {
    test.skip(isMobile, "the arrows reach the button's corner on the desktop layout");
    await page.goto("/koolitaja");
    await expect(fab(page)).toBeVisible();
    const arrows = page.locator("[data-works] [data-fab-avoid]");
    // the arrows are in the button's corner on first view: the case that needs the lift
    const box = (await arrows.boundingBox())!;
    expect(box.x + box.width, "arrows under the button's column").toBeGreaterThan(1440 - 16 - 120);
    expect(box.y + box.height, "arrows near the bottom").toBeGreaterThan(900 - 16 - 48);
    await clearOf(page, arrows);
    for (const name of ["Eelmine", "Järgmine"]) await clearOf(page, page.locator("[data-works]").getByRole("button", { name }));
  });

  test("never on the footer newsletter's Liitu at any scroll position, 1440×900 (N4)", async ({ page, isMobile }) => {
    test.skip(isMobile, "Liitu reaches the button's corner on the desktop layout");
    for (const path of ["/ostukorv", "/koolitaja"]) {
      await page.goto(path);
      await expect(fab(page)).toBeVisible();
      const liitu = page.locator("[data-newsletter-form]").getByRole("button", { name: "Liitu" });
      const top = await liitu.evaluate((e) => e.getBoundingClientRect().top + scrollY);
      for (const below of [8, 24, 48, 72]) {
        // scroll until Liitu's bottom is `below` px above the window's bottom edge, where the button sits
        await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, top + 49 + below - 900));
        await clearOf(page, liitu);
      }
    }
  });

  test.describe("the home page's popup", () => {
    test.use({ campaignPopup: 1500 }); // the popup after 1.5 s (test hook), once the widget is on the page

    test("above the popup's sheet on a phone", async ({ page, isMobile }) => {
      test.skip(!isMobile, "the bottom sheet is the phone layout");
      await page.goto("/");
      await expect(fab(page)).toBeVisible();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10000 });
      await clearOf(page, page.locator("[data-newsletter-panel]"));
    });
  });
});

// Dim 22.10: the comment bubble is on every signed-in admin page too (not on the login page: nobody signed out can send a comment through the
// gate), while the review tools are on.
test.describe("comment widget in the admin", () => {
  const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
  const bubble = (page: Page) => page.getByRole("button", { name: "Jäta kommentaar" });

  test.afterEach(async () => {
    await removeAdminRows(created).catch(() => {});
    created.tokens.clear();
    created.sessions.clear();
  });

  test("the „Kommentaar“ pill is on /admin after signing in", async ({ page, context, visitorIp }, info) => {
    submitsForms();
    await signInAsAdmin(page, context, visitorIp, created);
    await adminReady(page);
    await expect(page.locator('script[src="/feedback.js?v=6"]')).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("data-fb-dir", "admin");
    await expect(bubble(page)).toBeVisible();
    // (a phone shows the bubble without its word)
    if (!info.project.name.startsWith("mobile")) await expect(bubble(page)).toContainText("Kommentaar");
  });

  test("a comment sent from an admin page is listed as an admin comment, opens at its place and shows under „Haldus“", async ({ page, context, visitorIp }, info) => {
    submitsForms();
    await signInAsAdmin(page, context, visitorIp, created);
    await adminReady(page);
    await page.goto("/admin/koolitused");
    await adminReady(page);
    const text = `${E2E_COMMENT} ${info.project.name} ${Date.now().toString(36)} Nupp võiks olla suurem`;
    const ids: string[] = [];
    try {
      await bubble(page).click();
      const panel = page.getByRole("dialog", { name: "Jäta kommentaar" });
      await panel.getByLabel("Sinu nimi").fill("E2E Dim");
      // mark the page's heading: the place is kept (selector, position), the heading's words are not (an admin page can show a student's name)
      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toBeVisible();
      await panel.getByRole("button", { name: /Märgi koht lehel/ }).click();
      const box = (await heading.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(panel.getByText("Koht: valitud element")).toBeVisible();
      await panel.getByLabel("Kommentaar").fill(text);
      const sent = page.waitForResponse((r) => r.url().endsWith("/api/feedback") && r.request().method() === "POST");
      await panel.getByRole("button", { name: "Saada" }).click();
      const res = await sent;
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ok: boolean; id: string; stored: boolean };
      ids.push(body.id);
      expect(body).toMatchObject({ ok: true, stored: true });
      await expect(page.getByText("Aitäh! Kommentaar on saadetud ✓")).toBeVisible();

      const item = await commentById(page, body.id);
      expect(item).toMatchObject({ dir: "admin", route: "/admin/koolitused", name: "E2E Dim", text, done: false });
      expect(item!.el.sel, "the place's selector").toEqual(expect.any(String));
      expect(item!.el).not.toHaveProperty("label");
      expect(item!.el).not.toHaveProperty("snippet");
      expect(item!.link).toBe(new URL(`/admin/koolitused?fb=${body.id}`, page.url()).href);

      // „Näita kohta“: the admin page itself, the comment shown on it (the session is the admin's)
      await page.goto(new URL(item!.link).pathname + new URL(item!.link).search);
      // (no place was marked, so the widget looks for one for about 5 s before it shows the note by itself)
      await expect(page.locator("#mslab-fb .fb-note")).toContainText(text, { timeout: 15_000 });

      // the list page names it „Haldus“
      await page.goto(`/guide/tagasiside/#key=${REVIEW_KEY}`);
      const card = page.locator("article.card").filter({ hasText: text });
      await expect(card).toBeVisible();
      await expect(card.getByText("Haldus", { exact: true })).toBeVisible();
      await expect(card.getByRole("link", { name: "Näita kohta" })).toHaveAttribute("href", item!.link);
    } finally {
      if (ids.length) await deleteLocalComments(ids);
    }
    expect(await commentById(page, ids[0])).toBeUndefined();
  });

  // The bubble lifts itself above the admin's bars at the bottom of the screen; here a site editor's publish bar (Avaleht's, admin UX pass piece 4a: on a
  // phone it is fixed at the foot of the screen with „Avalda“ on its right, the bubble's corner; on a laptop it stands under the H1), at a phone's size
  // and a laptop's. Nothing of the bar may lie under the bubble. The bar is there as soon as a field differs from live; the field's autosave is answered
  // here in the browser, so this test writes no draft (the edit projects' home tests take their turn on the home drafts: edit-lock.ts `homeDrafts`).
  for (const size of [{ width: 375, height: 812 }, { width: 1280, height: 800 }]) {
    test(`the bubble covers no button of the publish bar at ${size.width}×${size.height}`, async ({ page, context, visitorIp }, info) => {
      test.skip(info.project.name.startsWith("mobile"), "sets its own sizes: the desktop project only");
      submitsForms();
      await signInAsAdmin(page, context, visitorIp, created);
      await page.setViewportSize(size);
      await page.route("**/api/admin/sisu/home/0/osa/*", (route) => route.fulfill({ json: { ok: true, version: "d:0.1", savedAt: new Date().toISOString() } }));
      await page.goto("/admin/avaleht");
      await adminReady(page);
      await expect(bubble(page)).toBeVisible();
      const statement = page.getByRole("textbox", { name: "Lause (eesti keeles)", exact: true });
      await statement.fill(`${await statement.inputValue()} E2E`);
      await expect(page.locator("[data-publish-go]")).toBeVisible();
      // (the field is further down the page: back to the top, where a laptop's bar stands under the H1; a phone's is at the foot either way)
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const fab = document.querySelector("#mslab-fb .fb-fab")!.getBoundingClientRect();
            const bar = document.querySelector("[data-publish-bar]")!;
            const hits = [...bar.querySelectorAll("button, a")]
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.left < fab.right && fab.left < r.right && r.top < fab.bottom && fab.top < r.bottom;
              })
              .map((el) => el.textContent?.trim());
            // the centre of „Avalda muudatused“ (the phone's „Avalda“) is the button's own (not the bubble's)
            const go = bar.querySelector("[data-publish-go]")!.getBoundingClientRect();
            const top = document.elementFromPoint(go.left + go.width / 2, go.top + go.height / 2);
            return top && !top.closest("#mslab-fb") ? hits : [...hits, "covered: Avalda"];
          }),
        )
        .toEqual([]);
    });
  }
});
