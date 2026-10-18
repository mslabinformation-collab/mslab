import type { Page } from "@playwright/test";
import { test } from "./edit-lock";
import { expect } from "./test";
import { holdLocalLock, HOME_REVIEWS_LOCK, insertReviewFixtures, LOCAL_FIXTURES, LOCK_WAIT_MS, removeReviewFixtures } from "./fixtures";

// The student reviews on the public pages (student reviews, Task 5; spec D5, D7): the course page's block and the home page's section. These tests
// WRITE published reviews (a few of them featured) of seed courses, which the course page and the home page then show, so they are one of the edit
// specs (playwright.config.ts EDITS): after every other test, and in the production build one test at a time (edit-lock.ts), because there every
// write marks the cached pages stale and a render that began before the write, in another worker, would otherwise be stored after the mark. Each
// project uses its own seed courses, so that the desktop and phone runs side by side never count each other's reviews. They delete exactly the ids
// they wrote (fixtures.ts), and global-setup / global-teardown sweep any an interrupted run left.

// The course page (spec D5, D7): the block after the course's content and before the trainer's card, six at first and „Näita kõiki“ for the rest.
// The reviews are written to the local database for the test and deleted by their ids afterwards. The desktop and the phone project each use their own
// course ("chromium-edit" and "mobile-edit" run side by side under `next dev`).
test.describe("student reviews on the course page", () => {
  test.skip(!LOCAL_FIXTURES, "writes reviews to the local database");
  const courseOf = (project: string) => (project.startsWith("mobile") ? "kulmude-lami" : "lash-lift-botox");
  const reviewsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `E2E Mari ${i + 1}.`, text: `E2E Soovitaksin ${i + 1}.\n\nTeine lõik ${i + 1}.` }));
  const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  test("six reviews and „Näita kõiki (2)“: the rest opens in place with no request, the button goes, the focus is on the first new review and Tab continues after it", async ({ page, isMobile }, info) => {
    const slug = courseOf(info.project.name);
    const ids = await insertReviewFixtures(slug, reviewsOf(8));
    try {
      await page.goto(`/koolitused/${slug}`);
      const block = page.locator('[data-reviews="course"]');
      await expect(block.getByRole("heading", { level: 2, name: "Õpilaste tagasiside" })).toBeVisible();
      // after the course's content ("Koolitusest" and the others) and before the trainer's card
      expect(await block.evaluate((el) => [el.previousElementSibling?.getAttribute("aria-label"), !!el.nextElementSibling?.querySelector("[data-trainer-card]")])).toEqual(["Koolitusest", true]);

      const items = block.locator("[data-review]");
      await expect(items).toHaveCount(6);
      // its own look: a plain block with space above it (as the trainer's card has), and words that are not a link's
      expect(await block.evaluate((el) => { const s = getComputedStyle(el); return [s.display, parseFloat(s.marginTop) >= 56]; })).toEqual(["block", true]);
      expect(await items.first().locator("blockquote").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
      await expect(items.first()).toContainText("E2E Soovitaksin 1.");
      await expect(items.first().locator("p")).toHaveText(["E2E Soovitaksin 1.", "Teine lõik 1."]); // (paragraphs)
      await expect(items.first()).toContainText("E2E Mari 1.");
      await expect(items.first()).toContainText(/\d{4}/); // (the month and year)
      await expect(block.locator("[data-reviews-notice]")).toHaveText("Tagasiside on MS LAB-i koolituse läbinud õpilastelt. Avaldame selle õpilase loal ja pärast kontrolli.");
      expect(await block.innerText()).not.toMatch(/[★☆]|keskmine|hinne/i); // (no stars, no score, no average)
      expect(await noOverflow(page)).toBe(true);

      const more = block.getByRole("button", { name: "Näita kõiki (2)" });
      await expect(more).toBeVisible();
      expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);

      // (only what the page itself fetches: a script, an image or a font is no request for the rest, and other calls of the site's own are not this block's)
      const requests: string[] = [];
      page.on("request", (r) => {
        if (r.resourceType() === "fetch" || r.resourceType() === "xhr") requests.push(new URL(r.url()).pathname);
      });
      if (isMobile) await more.tap();
      else {
        await more.focus();
        await page.keyboard.press("Enter");
      }
      await expect(items).toHaveCount(8);
      await expect(more).toHaveCount(0);
      await expect(items.nth(6)).toBeFocused(); // the first review newly shown
      await expect(items.nth(6)).toHaveAttribute("tabindex", "-1");
      await expect(items.nth(6)).toContainText("E2E Soovitaksin 7.");
      expect(requests.filter((p) => p === `/koolitused/${slug}` || /review|arvustus/i.test(p))).toEqual([]); // (it needed no request: not this page again, nor any call of reviews)
      expect(await noOverflow(page)).toBe(true);
      // the notice is still the last thing in the block
      expect(await block.evaluate((el) => (el.querySelector("[data-reviews-notice]")!.compareDocumentPosition(el.querySelector("[data-review]:last-child")!) & Node.DOCUMENT_POSITION_PRECEDING) !== 0)).toBe(true);

      if (!isMobile) {
        await page.keyboard.press("Tab");
        // Tab goes on from the review that was focused, not back to the top of the page
        expect(await items.nth(6).evaluate((li) => (li.compareDocumentPosition(document.activeElement!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)).toBe(true);
      }
    } finally {
      await removeReviewFixtures(ids);
    }
  });

  test("with six reviews there is no button; with none there is no block, heading or notice", async ({ page }, info) => {
    const slug = courseOf(info.project.name);
    const ids = await insertReviewFixtures(slug, reviewsOf(6));
    try {
      await page.goto(`/koolitused/${slug}`);
      await expect(page.locator('[data-reviews="course"] [data-review]')).toHaveCount(6);
      await expect(page.locator("[data-reviews-more]")).toHaveCount(0);
    } finally {
      await removeReviewFixtures(ids);
    }
    await page.goto(`/koolitused/${slug}`);
    await expect(page.locator("[data-reviews]")).toHaveCount(0);
    await expect(page.getByText("Õpilaste tagasiside")).toHaveCount(0);
    await expect(page.getByText("Tagasiside on MS LAB-i koolituse läbinud õpilastelt")).toHaveCount(0);
  });

  test("the Russian page: its own heading, notice, button and month; a review is shown as written, marked with its own language", async ({ page }, info) => {
    const slug = courseOf(info.project.name);
    const ids = await insertReviewFixtures(slug, [...reviewsOf(6), { name: "Мария М.", text: "Рекомендую всем!", locale: "ru", daysAgo: 20 }]);
    try {
      await page.goto(`/ru/koolitused/${slug}`);
      const block = page.locator('[data-reviews="course"]');
      await expect(block.getByRole("heading", { level: 2, name: "Отзывы учеников" })).toBeVisible();
      await expect(block.locator("[data-reviews-notice]")).toContainText("Отзывы оставляют ученики, прошедшие обучение в");
      await expect(block.getByRole("button", { name: "Показать все (1)" })).toBeVisible();
      await expect(block.locator("blockquote").first()).toHaveAttribute("lang", "et"); // (Estonian words on a Russian page)
      await expect(block.locator("[data-review]").first()).toContainText(/окт\.|нояб\.|дек\.|янв\.|февр\.|мар\.|апр\.|мая|июн\.|июл\.|авг\.|сент\./);
      await block.getByRole("button", { name: "Показать все (1)" }).click();
      const last = block.locator("[data-review]").last();
      await expect(last).toContainText("Рекомендую всем!");
      await expect(last.locator("blockquote")).not.toHaveAttribute("lang", /./); // (the page's own language needs no mark)
      await expect(block.locator("[data-review]").first().getByText("E2E Mari 1.")).toHaveAttribute("lang", "et"); // (the Estonian review's shown name is marked too)
    } finally {
      await removeReviewFixtures(ids);
    }
  });

  test("at 390, 834, 1194 and 1440: the page never scrolls sideways, the cards sit in 1, 2, 3 and 3 columns, and every control is at least 44 px tall", async ({ page, isMobile }, info) => {
    test.skip(isMobile, "the desktop project sets each width");
    const slug = courseOf(info.project.name);
    // one card with a name of 40 letters and a word of 400, to try to break the width
    const ids = await insertReviewFixtures(slug, [{ name: `E2E ${"M".repeat(36)}`, text: `Pikk${"sõna".repeat(100)}` }, ...reviewsOf(7)]);
    try {
      for (const [width, columns] of [[390, 1], [834, 2], [1194, 3], [1440, 3]] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/koolitused/${slug}`);
        const block = page.locator('[data-reviews="course"]');
        const items = block.locator("[data-review]");
        for (const phase of ["at first", "all open"]) {
          if (phase === "all open") await block.getByRole("button", { name: /^Näita kõiki/ }).click();
          await expect(items, `${width} ${phase}`).toHaveCount(phase === "at first" ? 6 : 8);
          expect(await noOverflow(page), `${width} ${phase}: no sideways scroll`).toBe(true);
          const boxes = await items.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
          expect(boxes.filter((b) => Math.round(b.top) === Math.round(boxes[0].top)).length, `${width} ${phase}: columns`).toBe(columns);
          for (const b of boxes) expect(b.right, `${width} ${phase}: inside the screen`).toBeLessThanOrEqual(width);
          for (const control of await block.locator("a, button").all()) expect((await control.boundingBox())!.height, `${width} ${phase}: a control`).toBeGreaterThanOrEqual(44);
        }
      }
    } finally {
      await removeReviewFixtures(ids);
    }
  });
});

// The home page (spec D5): the section „Õpilaste kogemused“ after the trainer section, with the published reviews that are featured, each naming its
// course. The reviews are written to the local database for the test and deleted by their ids afterwards. Desktop project only: a featured review
// shows on the home page whatever its course, so a second project writing at the same time would be counted (the phone is tried at 390 below).
// They use the two e-courses, which the course page's review tests do not. They also take the home page's turn (HOME_REVIEWS_LOCK): reviews.spec.ts, the
// whole path of one review, features a review of its own for a while, and these tests count what the section shows.
test.describe("student reviews on the home page", () => {
  test.skip(({ isMobile }) => isMobile, "the desktop project sets each width, and only one project writes featured reviews at a time");
  test.skip(!LOCAL_FIXTURES, "writes reviews to the local database");
  let giveBackHome: (() => Promise<void>) | null = null;
  test.beforeEach(async ({}, info) => {
    if (!LOCAL_FIXTURES) return;
    info.setTimeout(info.timeout + LOCK_WAIT_MS); // (the wait for the turn is added to the test's own time, as edit-lock.ts does)
    giveBackHome = await holdLocalLock(HOME_REVIEWS_LOCK, LOCK_WAIT_MS);
  });
  test.afterEach(async () => {
    await giveBackHome?.();
    giveBackHome = null;
  });
  const FIRST = "kulmukuju-ja-summeetria";
  const SECOND = "ripsmete-laminatsiooni-alused";
  const featured = (n: number, over: { locale?: "et" | "ru"; offset?: number } = {}) =>
    Array.from({ length: n }, (_, i) => ({ name: `E2E Mari ${i + 1 + (over.offset ?? 0)}.`, text: `E2E Soovitaksin ${i + 1 + (over.offset ?? 0)}.`, featured: true, locale: over.locale, daysAgo: 1 + i + (over.offset ?? 0) }));
  const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  test("the section after the trainer section: the six newest featured reviews, each with its course as a link; a review not featured is not there; the notice is under them", async ({ page }) => {
    const ids = [
      ...(await insertReviewFixtures(FIRST, featured(4))), // the newest four
      ...(await insertReviewFixtures(SECOND, featured(4, { offset: 4 }))), // and four older ones: the oldest two do not fit
      ...(await insertReviewFixtures(FIRST, [{ name: "E2E Ei ole avalehel.", text: "E2E Ainult koolituse lehel.", daysAgo: 0 }])),
    ];
    try {
      await page.goto("/");
      const section = page.locator('[data-reviews="home"]');
      await expect(section.getByRole("heading", { level: 2, name: "Õpilaste kogemused" })).toBeVisible();
      // right after the trainer section
      expect(await section.evaluate((el) => el.previousElementSibling?.hasAttribute("data-trainer-teaser"))).toBe(true);
      const items = section.locator("[data-review]");
      await expect(items).toHaveCount(6);
      // its own look: a plain block with its own space below, words that are not a link's, and the course's title underlined as a link is
      expect(await section.evaluate((el) => { const s = getComputedStyle(el); return [s.display, parseFloat(s.paddingBottom) >= 56]; })).toEqual(["block", true]);
      expect(await items.first().locator("blockquote").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
      expect(await items.first().getByRole("link").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("underline");
      await expect(items.locator("blockquote")).toHaveText(Array.from({ length: 6 }, (_, i) => `E2E Soovitaksin ${i + 1}.`));
      await expect(items.first()).toContainText("E2E Mari 1.");
      await expect(section).not.toContainText("E2E Ainult koolituse lehel.");
      await expect(section.getByRole("button")).toHaveCount(0); // (no „Näita kõiki“ here)
      const links = items.getByRole("link");
      await expect(links.first()).toHaveAttribute("href", `/koolitused/${FIRST}`);
      await expect(links.nth(4)).toHaveAttribute("href", `/koolitused/${SECOND}`);
      await expect(section.locator("[data-reviews-notice]")).toHaveText("Tagasiside on MS LAB-i koolituse läbinud õpilastelt. Avaldame selle õpilase loal ja pärast kontrolli.");
      expect(await section.innerText()).not.toMatch(/[★☆]|keskmine|hinne/i);
      // the course's title is a link to its page
      await links.first().click();
      await expect(page).toHaveURL(new RegExp(`/koolitused/${FIRST}$`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    } finally {
      await removeReviewFixtures(ids);
    }
    await page.goto("/");
    await expect(page.locator("[data-reviews]")).toHaveCount(0); // none featured: no section, no heading, no notice
    await expect(page.getByText("Õpilaste kogemused")).toHaveCount(0);
  });

  test("the Russian home page: its heading and notice, the course's title and the link under /ru, the words as written", async ({ page }) => {
    const ids = await insertReviewFixtures(FIRST, featured(2));
    try {
      await page.goto("/ru");
      const section = page.locator('[data-reviews="home"]');
      await expect(section.getByRole("heading", { level: 2, name: "Опыт учеников" })).toBeVisible();
      await expect(section.locator("[data-reviews-notice]")).toContainText("Отзывы оставляют ученики, прошедшие обучение в");
      await expect(section.locator("[data-review]").first().getByRole("link")).toHaveAttribute("href", `/ru/koolitused/${FIRST}`);
      await expect(section.locator("blockquote").first()).toHaveAttribute("lang", "et");
      await expect(section.locator("blockquote").first()).toHaveText("E2E Soovitaksin 1.");
    } finally {
      await removeReviewFixtures(ids);
    }
  });

  test("at 390, 834, 1194 and 1440: the page never scrolls sideways, the cards sit in 1, 2, 3 and 3 columns, and every link is at least 44 px tall", async ({ page }) => {
    const ids = [...(await insertReviewFixtures(FIRST, [{ name: `E2E ${"M".repeat(36)}`, text: `Pikk${"sõna".repeat(100)}`, featured: true }, ...featured(2, { offset: 1 })])), ...(await insertReviewFixtures(SECOND, featured(3, { offset: 3 })))];
    try {
      for (const [width, columns] of [[390, 1], [834, 2], [1194, 3], [1440, 3]] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        const section = page.locator('[data-reviews="home"]');
        const items = section.locator("[data-review]");
        await expect(items, `${width}`).toHaveCount(6);
        expect(await noOverflow(page), `${width}: no sideways scroll`).toBe(true);
        const boxes = await items.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
        expect(boxes.filter((b) => Math.round(b.top) === Math.round(boxes[0].top)).length, `${width}: columns`).toBe(columns);
        for (const b of boxes) expect(b.right, `${width}: inside the screen`).toBeLessThanOrEqual(width);
        for (const link of await section.getByRole("link").all()) expect((await link.boundingBox())!.height, `${width}: a link`).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await removeReviewFixtures(ids);
    }
  });
});
