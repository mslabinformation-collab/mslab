import { readFileSync } from "node:fs";
import type { BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
import { test } from "./edit-lock";
import { submitsForms, expect } from "./test";
import { LOCAL_ADMINS } from "../local-secrets";
import { adminReady, editLang, seadedAutosave, seadedStatus, signInAsAdmin } from "./admin-login";
import { holdContractTexts, holdLegalDraft, legalDraftOf } from "./contracts";
import { onLocalDb, POST_SLUG_PREFIX, removeAdminRows, removePopupDrafts, removePostRows, snapshotRows, storedSubscriber, testEmail } from "./fixtures";
import { holdNewsletter } from "./newsletter";

// Task 13B: the site content editors (home page, practice, trainer, news, the popup, settings), each followed through to
// the public site. They change shared seed content, so they run after every other test (playwright.config.ts: the
// "chromium-edit" / "mobile-edit" projects) and put it back (fixtures.ts: row snapshots; posts "e2e-uudis-<project>-…").
// The two projects run side by side, so each changes rows the other does not: desktop MAXI, the hero slides and the
// statement, the trainer card and works, the contact settings and the popup; phone MINI, the FAQ, the centre's story
// and the privacy page. Both make their own post. Local dev server only: they sign in as Dim through the devLink.

const created = { tokens: new Set<string>(), sessions: new Set<string>() };
const undo: (() => Promise<unknown>)[] = [];
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const phone = (info: TestInfo) => info.project.name.startsWith("mobile");
const jpeg = (name: string) => ({ name, mimeType: "image/jpeg", buffer: readFileSync(`public/seed/${name}`) });

test.beforeEach(({ page }) => {
  submitsForms();
  // leaving an editor with unsaved changes asks first (beforeunload): the tests always leave
  page.on("dialog", (d) => void d.accept());
});

test.afterEach(async ({}, info) => {
  for (const step of undo.splice(0).reverse()) await step();
  await removeAdminRows({ tokens: created.tokens, sessions: created.sessions }).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
  expect(await removePostRows(info.project.name)).toBe(0);
});

/** Saves the rows a test is about to change and registers their restore for after the test. */
async function changing(...snapshots: Parameters<typeof snapshotRows>[]): Promise<void> {
  for (const s of snapshots) undo.push(await snapshotRows(...s));
}

/** Signs in as Dim through the devLink, under the login lock shared by all workers (admin-login.ts); lands on /admin. */
const signIn = (page: Page, context: BrowserContext, ip: string) => signInAsAdmin(page, context, ip, created);

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/** The space between the bottom of a text and the top of the form under it, in px (the popup's card and its preview). */
const gapAboveForm = async (text: Locator, form: Locator) => {
  const [t, f] = [await text.boundingBox(), await form.boundingBox()];
  return f!.y - (t!.y + t!.height);
};
const one = async <T>(query: (sql: Parameters<Parameters<typeof onLocalDb>[0]>[0]) => Promise<T[]>): Promise<T> => (await onLocalDb(query))[0];

// The site editors on the draft layer (admin UX pass piece 4a: Praktika): the page's one status chip (SaveStatus, README §1.4; its status region speaks
// the whole sentence, on a phone too), the PublishBar (README §1.8) and its desktop words (S3-P3-a's line after the labels), and a part's autosave.
const chip = (page: Page) => page.locator("[data-site-editor] [data-save-status]");
const publishBar = (page: Page) => page.locator("[data-publish-bar]");
const barWords = (page: Page) => page.locator("[data-publish-words]");
const draftWords = (labels: string) => `Avaldamata muudatused: ${labels.split(", ").length} · ${labels}. Avalikul lehel on näha eelmine versioon.`;
/** The answer 200 to a package's autosave (POST api/admin/sisu/practice/0/osa/<code>). */
const practiceSaved = (page: Page, code: string) =>
  page.waitForResponse((r) => r.url().endsWith(`/api/admin/sisu/practice/0/osa/${code}`) && r.request().method() === "POST" && r.status() === 200);

test.describe("practice packages (C5 Praktika on the draft layer; admin UX pass piece 4a, Task 4)", () => {
  // every field autosaves into its package's draft, and the one bar's „Avalda muudatused“ publishes every practice draft there is (R-e): one test at a
  // time makes them (edit-lock.ts `practiceDrafts`, shared with admin-eelvaade.spec.ts's preview of /praktika), and at its end none is left
  test.use({ practiceDrafts: true });

  test("a price waits in its draft („Mustand salvestatud“, the bar „{code} hind“) and /praktika keeps the old one until „Avalda muudatused“; Enter on the last point adds one; × and its undo; at 375 px the cards stack and nothing scrolls sideways", async ({ page, context, visitorIp }, info) => {
    test.slow(); // one long flow: the editor, the public pages, a publish and a second width
    // desktop changes MAXI, the phone project MINI (the projects run side by side, each on its own row)
    const code = phone(info) ? "MINI" : "MAXI";
    await changing(["practice_packages", { column: "code", value: code }]);
    const stored = () => one((sql) => sql<{ price: number; items: { et: string; ru?: string }[] }[]>`select price, items from practice_packages where code = ${code}`);
    const drafts = () => one((sql) => sql<{ n: number }[]>`select count(*)::int as n from content_drafts where entity = 'practice'`);
    const before = await stored();
    expect(before.price % 100, "a whole euro price").toBe(0);
    const oldPrice = String(before.price / 100);
    const newPrice = String(before.price / 100 + 7);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/praktika");
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Praktikapaketid");
    await expect(page.locator("[data-site-eyebrow]")).toHaveText("Koolitused");
    // no page-wide „Salvesta“ any more, and nothing waits yet: no bar
    await expect(page.getByRole("button", { name: "Salvesta", exact: true })).toHaveCount(0);
    await expect(publishBar(page)).toHaveCount(0);

    // the price: autosaved into the package's draft, the bar names it, the field says „· avaldamata“
    const card = page.locator(`[data-package="${code}"]`);
    await expect(card.getByRole("heading", { level: 2 })).toHaveText(code);
    const price = card.getByRole("textbox", { name: "Hind (€)", exact: true });
    await expect(price).toHaveValue(oldPrice);
    let saved = practiceSaved(page, code);
    await price.fill(newPrice);
    await price.blur();
    await saved;
    await expect(chip(page)).toHaveAttribute("data-save-kind", "saved");
    await expect(chip(page).locator("[role=status]")).toHaveText(/^Mustand salvestatud \d\d:\d\d$/);
    await expect(barWords(page)).toHaveText(draftWords(`${code} hind`));
    await expect(card.locator("[data-plain-field][data-unpublished] [data-unpublished-tag]")).toHaveText("· avaldamata");
    expect((await stored()).price, "live keeps its price").toBe(before.price);
    expect(await drafts()).toEqual({ n: 1 });

    // a visitor's /praktika (this browser, no draft mode): still the old price
    const visitor = await context.newPage();
    await visitor.goto("/praktika");
    const publicPrice = visitor.locator(`[data-practice] [data-package="${code}"] [data-price]`);
    await expect(publicPrice).toHaveText(`${oldPrice} €`);

    // „Sisaldab“: Enter on the last point adds one and puts the cursor in it (R-h); its Russian text too
    const items = card.locator(`[data-list-editor="${code}.items"]`);
    await expect(items.getByRole("heading", { level: 3 })).toHaveText("Sisaldab");
    await expect(items.getByRole("button", { name: "+ Lisa punkt (või Enter viimasel real)", exact: true })).toBeVisible();
    const rows = items.locator("[data-row]");
    const count = await rows.count();
    await rows.nth(count - 1).locator("[data-lang-field]").click();
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(count + 1);
    await expect(rows.nth(count).locator("[data-lang-field]")).toBeFocused();
    saved = practiceSaved(page, code);
    await page.keyboard.type("E2E punkt");
    await editLang(page, "ru");
    await rows.nth(count).locator("[data-lang-field]").fill("E2E пункт");
    await rows.nth(count).locator("[data-lang-field]").blur();
    await saved;
    await editLang(page, "et");
    expect(await noOverflow(page)).toBe(true);
    // × takes the point out at once with the UndoBar; while it shows, „Avalda muudatused“ (the phone's „Avalda“) is in sight and takes a click (the
    // UndoBar stands above the phone's bar); „Võta tagasi“ brings the point back with its texts
    await items.getByRole("button", { name: `Eemalda rida ${count + 1}` }).click();
    await expect(rows).toHaveCount(count);
    const undoBar = page.locator("[data-undo-bar]");
    await expect(undoBar).toContainText("Rida eemaldatud.");
    const go = page.locator("[data-publish-go]");
    await expect(go).toBeVisible();
    await go.click({ trial: true, timeout: 2000 });
    const [a, b] = [(await undoBar.boundingBox())!, (await go.boundingBox())!];
    expect(a.y + a.height <= b.y || b.y + b.height <= a.y || a.x + a.width <= b.x || b.x + b.width <= a.x, "the UndoBar is clear of „Avalda muudatused“").toBe(true);
    saved = practiceSaved(page, code);
    await undoBar.getByRole("button", { name: "Võta tagasi" }).click();
    await saved;
    await expect(rows).toHaveCount(count + 1);
    await expect(rows.nth(count).locator("[data-lang-field]")).toHaveValue("E2E punkt");
    await expect(barWords(page)).toHaveText(draftWords(`${code} hind, ${code} punktid`));
    expect((await stored()).items, "live keeps its points").toEqual(before.items);

    // „Avalda muudatused“: one press publishes the package; the bar goes, nothing is left in the draft
    const answer = page.waitForResponse((r) => r.url().endsWith("/api/admin/sisu/practice/0/avalda") && r.request().method() === "POST");
    await go.click();
    expect((await answer).status()).toBe(200);
    await expect(publishBar(page)).toHaveCount(0);
    await expect(chip(page)).toHaveAttribute("data-save-kind", "saved");
    const after = await stored();
    expect(after.price).toBe(before.price + 700);
    expect(after.items.at(-1)).toEqual({ et: "E2E punkt", ru: "E2E пункт" });
    expect(await drafts()).toEqual({ n: 0 });
    await expect(price).toHaveValue(newPrice);
    await visitor.reload();
    await expect(publicPrice).toHaveText(`${newPrice} €`);
    await expect(visitor.locator(`[data-practice] [data-package="${code}"]`).getByText("E2E punkt")).toBeVisible();
    await visitor.goto("/");
    await expect(visitor.locator(`[data-practice] [data-package="${code}"]`).getByText("E2E punkt")).toBeVisible();
    await visitor.goto("/ru/praktika");
    await expect(visitor.locator(`[data-package="${code}"]`).getByText("E2E пункт")).toBeVisible();
    await visitor.close();

    // a 1280 px laptop: MINI and MAXI side by side (review M-1)
    if (!phone(info)) {
      await page.setViewportSize({ width: 1280, height: 800 });
      const [left, right] = [(await page.locator('[data-package="MINI"]').boundingBox())!, (await page.locator('[data-package="MAXI"]').boundingBox())!];
      expect(Math.abs(left.y - right.y), "one row").toBeLessThan(1);
      expect(left.x + left.width, "MAXI right of MINI").toBeLessThanOrEqual(right.x);
      expect(await noOverflow(page)).toBe(true);
    }
    // 375 px: the two cards one under the other, and nothing scrolls sideways
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/admin/praktika");
    await adminReady(page);
    const [mini, maxi] = [(await page.locator('[data-package="MINI"]').boundingBox())!, (await page.locator('[data-package="MAXI"]').boundingBox())!];
    expect(mini.y + mini.height, "MAXI under MINI").toBeLessThanOrEqual(maxi.y);
    expect(maxi.x + maxi.width).toBeLessThanOrEqual(375);
    expect(await noOverflow(page)).toBe(true);
  });
});

/** The answer to a home part's autosave (POST api/admin/sisu/home/0/osa/<part>): 200, or the status asked for (400, a refusal). */
const homeSaved = (page: Page, part: string, status = 200) =>
  page.waitForResponse((r) => r.url().endsWith(`/api/admin/sisu/home/0/osa/${part}`) && r.request().method() === "POST" && r.status() === status);
const homePublished = (page: Page) => page.waitForResponse((r) => r.url().endsWith("/api/admin/sisu/home/0/avalda") && r.request().method() === "POST");
const homeDraftCount = () => one((sql) => sql<{ n: number }[]>`select count(*)::int as n from content_drafts where entity = 'home'`);
const slideCount = () => one((sql) => sql<{ n: number }[]>`select count(*)::int as n from hero_slides`);

// Avaleht (C1 on the draft layer; admin UX pass piece 4a, Task 6): every field autosaves into its part's draft (slides, statement, teaser, faq), and
// the one bar's „Avalda muudatused“ publishes every home draft there is (R-e). One test at a time makes them (edit-lock.ts `homeDrafts`: desktop the
// slides, the statement, the trainer card's text and the RU pass; the phone the FAQ — each in its own project only), and at its end none is left.
test.describe("home page, desktop: the slides (C1 Avaleht on the draft layer)", () => {
  test.use({ homeDrafts: "chromium-edit" });

  test("a new slide without a picture waits in the draft and „Avalda muudatused“ says „Puudub: slaid 6 pilt“; with its picture it publishes and the home page shows it; slide 1 turns dark (the header turns white on it); a script link is refused at its field; at 375 px nothing scrolls sideways", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "desktop changes the hero slides; the phone project the FAQ");
    test.slow(); // one long flow: the editor, a held publish, an upload, a second width, the publish and the public page
    await changing(["hero_slides"], ["pages", { column: "key", value: "statement" }]);
    await page.emulateMedia({ reducedMotion: "reduce" }); // no autoplay: slide 1 stays on screen
    await page.goto("/");
    await expect(page.locator("[data-hero]")).toHaveAttribute("data-tone", "light");
    await expect.poll(() => page.locator("header").evaluate((el) => getComputedStyle(el).color)).not.toBe("rgb(255, 255, 255)");
    expect(await slideCount(), "the seed's slides").toEqual({ n: 5 });

    await signIn(page, context, visitorIp);
    await page.goto("/admin/avaleht");
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Avaleht");
    await expect(page.locator("[data-site-eyebrow]")).toHaveText("Koduleht");
    await expect(page.locator("[data-home-editor] > section > h2")).toHaveText(["Slaidid", "MS LABi lause", "Koolitaja kaart", "KKK", "Koolitaja plokk"]);
    await expect(page.getByRole("link", { name: "Muuda lehel Koolitaja →", exact: true })).toHaveAttribute("href", "/admin/koolitaja");
    await expect(page.getByRole("button", { name: "Salvesta", exact: true })).toHaveCount(0);
    await expect(publishBar(page)).toHaveCount(0);

    // „+ Lisa slaid“: a new slide opens at the end with the cursor in its title; the list goes into the draft at once
    const slides = page.locator("[data-slide]");
    await expect(slides).toHaveCount(5);
    let saved = homeSaved(page, "slides");
    await page.getByRole("button", { name: "+ Lisa slaid", exact: true }).click();
    await saved;
    await expect(slides).toHaveCount(6);
    const added = slides.nth(5);
    await expect(added).toHaveAttribute("data-open", "");
    const title = added.getByRole("textbox", { name: "Pealkiri (eesti keeles)", exact: true });
    await expect(title).toBeFocused();
    const name = `E2E slaid ${unique()}`;
    saved = homeSaved(page, "slides");
    await title.fill(name);
    await title.blur();
    await saved;
    await expect(chip(page)).toHaveAttribute("data-save-kind", "saved");
    await expect(chip(page).locator("[role=status]")).toHaveText(/^Mustand salvestatud \d\d:\d\d$/);
    await expect(barWords(page)).toHaveText(draftWords("Slaidid"));
    expect(await slideCount(), "live keeps its slides").toEqual({ n: 5 });

    // „Avalda muudatused“ while the new slide has no picture: the slides are not published, and the bar says what is missing (R-d, S4-2)
    let answer = homePublished(page);
    await page.locator("[data-publish-go]").click();
    expect((await answer).status()).toBe(200);
    await expect(page.locator("[data-blocked-missing]")).toHaveText("Puudub: slaid 6 pilt");
    await expect(barWords(page)).toHaveText(draftWords("Slaidid"));
    expect(await slideCount()).toEqual({ n: 5 });
    expect(await homeDraftCount()).toEqual({ n: 1 });

    // the picture, uploaded into the open slide: saved at once, and the „Puudub“ line goes with that save
    const media = added.locator("[data-slide-media]");
    saved = homeSaved(page, "slides");
    await media.locator('input[type="file"]').setInputFiles([jpeg("brow-closeup.jpg")]);
    await expect(media.locator("[data-upload-status]")).toHaveText("Pilt lisatud.");
    await saved;
    await expect(page.locator("[data-blocked-missing]")).toHaveCount(0);
    await expect(media.locator("[data-focal-pick] img")).toHaveAttribute("src", /^\/media\/img\//);

    // slide 1 opened (the new one closes: one at a time), dark, with a desktop focal point
    const first = slides.nth(0);
    await first.getByRole("button", { name: /^Slaid 1/ }).click();
    await expect(first).toHaveAttribute("data-open", "");
    await expect(added).not.toHaveAttribute("data-open", "");
    saved = homeSaved(page, "slides");
    await first.getByRole("radio", { name: "Tume", exact: true }).check();
    await saved;
    await first.locator('[data-focal-axis="desktop-x"]').fill("30");
    await expect(first.locator('[data-focal-preview="desktop"] img')).toHaveCSS("object-position", "30% 50%");
    // a script link is refused at its field (the draft's own check), then a site path is taken
    const cta = first.getByRole("combobox", { name: "Nupp viib", exact: true });
    const refused = homeSaved(page, "slides", 400);
    await cta.fill("javascript:alert(1)");
    await cta.blur();
    await refused;
    await expect(cta).toHaveAttribute("aria-invalid", "true");
    saved = homeSaved(page, "slides");
    await cta.fill("/praktika");
    await cta.blur();
    await saved;
    await expect(cta).not.toHaveAttribute("aria-invalid", "true");
    // the statement, into its own draft
    const statement = page.getByRole("textbox", { name: "Lause (eesti keeles)", exact: true });
    saved = homeSaved(page, "statement");
    await statement.fill("E2E lause, mis on avalehel pärast avaldamist.");
    await statement.blur();
    await saved;
    await expect(barWords(page)).toHaveText(draftWords("Slaidid, Slaid 1 pilt, Slaid 1 nupp viib, Slaid 1 toon, MS LABi lause"));
    expect(await noOverflow(page)).toBe(true);

    // 375 px: the open slide and the rows inside the screen, the map is the select „Jaotised · Slaidid ▾“, nothing scrolls sideways
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(first).toHaveAttribute("data-open", "");
    await expect(page.locator("[data-section-face]")).toHaveText("Jaotised · Slaidid ▾");
    for (const right of await slides.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right))) expect(right).toBeLessThanOrEqual(375);
    expect(await noOverflow(page)).toBe(true);

    // „Avalda“ (the phone's bar): every home draft published, the bar goes, none is left
    answer = homePublished(page);
    await page.locator("[data-publish-go]").click();
    expect((await answer).status()).toBe(200);
    await expect(publishBar(page)).toHaveCount(0);
    expect(await homeDraftCount()).toEqual({ n: 0 });
    const stored = await onLocalDb((sql) => sql<{ title: { et: string }; tone: string; pos: string; href: string; key: string }[]>`select title, tone, image_pos as pos, cta_href as href, image_key as key from hero_slides order by sort, id`);
    expect(stored).toHaveLength(6);
    expect(stored[0]).toMatchObject({ tone: "dark", pos: "30% 50%", href: "/praktika" });
    expect(stored[5].title.et).toBe(name);
    expect(stored[5].key).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);

    // a visitor's home page: slide 1 dark (the header white on it) with its link, six slides, the new one sixth; the statement
    const visitor = await context.newPage();
    await visitor.emulateMedia({ reducedMotion: "reduce" });
    await visitor.goto("/");
    const hero = visitor.locator("[data-hero]");
    await expect(hero).toHaveAttribute("data-tone", "dark");
    await expect(hero.getByText(/^01 \/ 06$/)).toBeVisible();
    await expect(visitor.locator("html")).toHaveAttribute("data-hero-tone", "dark");
    await expect.poll(() => visitor.locator("header").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 255, 255)");
    await expect(hero.locator("[data-tone]").first()).toHaveAttribute("style", /--pos:\s*30% 50%/);
    await expect(hero.getByRole("link", { name: /Leia oma koolitus/ }).first()).toHaveAttribute("href", "/praktika");
    await expect(hero.locator('[data-hero-slides] > [aria-label="6 / 6"]')).toContainText(name);
    await expect(visitor.getByText("E2E lause,")).toBeVisible();
    await visitor.close();
  });

  test("the trainer card's text (C26): typed in ET and RU it waits in its draft; published, it is on / and /ru", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "desktop changes the trainer card's text; the phone project the FAQ");
    await changing(["pages", { column: "key", value: "trainer_teaser" }]);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/avaleht");
    await adminReady(page);
    const editor = page.locator("[data-teaser-editor]");
    await expect(editor.getByRole("heading", { level: 2 })).toHaveText("Koolitaja kaart");
    const et = editor.getByRole("textbox", { name: "Tekst (eesti keeles)", exact: true });
    await expect(et).toHaveValue(/^Kulmu- ja ripsmetehnikate meister ja koolitaja\. Õpetan nii, nagu oleksin ise tahtnud õppida/);
    await et.fill("E2E koolitaja tekst.");
    await editLang(page, "ru");
    const ru = editor.getByRole("textbox", { name: "Tekst (vene keeles)", exact: true });
    await ru.fill("E2E текст преподавателя.");
    const saved = homeSaved(page, "teaser");
    await ru.blur();
    await saved;
    await expect(barWords(page)).toHaveText(draftWords("Koolitaja kaart"));
    expect(await one((sql) => sql<{ body: { et: string } }[]>`select body from pages where key = 'trainer_teaser'`), "live keeps its text").not.toEqual({ body: { et: "E2E koolitaja tekst.", ru: "E2E текст преподавателя." } });
    const answer = homePublished(page);
    await page.locator("[data-publish-go]").click();
    expect((await answer).status()).toBe(200);
    await expect(publishBar(page)).toHaveCount(0);
    expect(await one((sql) => sql<{ body: unknown }[]>`select body from pages where key = 'trainer_teaser'`)).toEqual({ body: { et: "E2E koolitaja tekst.", ru: "E2E текст преподавателя." } });
    await page.goto("/");
    await expect(page.locator("[data-trainer-teaser]")).toContainText("E2E koolitaja tekst.");
    await page.goto("/ru");
    await expect(page.locator("[data-trainer-teaser]")).toContainText("E2E текст преподавателя.");
  });

  test("„RU puudub“ counts a closed slide and a folded answer too; „Järgmine →“ opens each and puts the cursor in its Russian field (nothing is published)", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "the desktop project's turn on the home drafts");
    await signIn(page, context, visitorIp);
    await page.goto("/admin/avaleht");
    await adminReady(page);
    await editLang(page, "ru");
    const line = page.locator("[data-ru-missing]:visible");
    const missing = async () => ((await line.count()) ? Number(/(\d+) väljal/.exec((await line.textContent()) ?? "")?.[1]) : 0);
    expect(await missing(), "the seed's home page is translated").toBe(0);
    // slide 1 opened and its Russian title emptied; slide 2 opened: slide 1 closes (one at a time), and the count still has its title
    const slides = page.locator("[data-slide]");
    const first = slides.nth(0);
    await first.getByRole("button", { name: /^Slaid 1/ }).click();
    let saved = homeSaved(page, "slides");
    await first.locator('[data-i18n="slides.0.title"]').fill("");
    await slides.nth(1).getByRole("button", { name: /^Slaid 2/ }).click();
    await saved;
    await expect(first).not.toHaveAttribute("data-open", "");
    await expect(first.locator("[data-lang-field]")).toHaveCount(0);
    await expect.poll(missing).toBe(1);
    // question 1's answer opened, its Russian text emptied, folded again: counted all the same
    const row = page.locator("[data-faq-row]").first();
    const toggle = row.locator("[data-faq-toggle]");
    await toggle.click();
    saved = homeSaved(page, "faq");
    await row.locator('[data-i18n="faq.0.a"]').fill("");
    await toggle.click();
    await saved;
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(missing).toBe(2);
    // „Järgmine →“: slide 1 opens with the cursor in its Russian title, then the answer opens with the cursor in its Russian text
    await page.locator("[data-ru-next]:visible").click();
    await expect(first).toHaveAttribute("data-open", "");
    await expect(first.locator('[data-i18n="slides.0.title"][data-lang-field="ru"]')).toBeFocused();
    await page.locator("[data-ru-next]:visible").click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(row.locator('[data-i18n="faq.0.a"][data-lang-field="ru"]')).toBeFocused();
    expect(await missing()).toBe(2); // opened, each counts once, not twice
    expect(await homeDraftCount()).toEqual({ n: 2 });
  });
});

test.describe("home page, phone: the FAQ (C1 Avaleht on the draft layer)", () => {
  test.use({ homeDrafts: "mobile-edit" });

  test("a new question in ET and RU, moved to the top, waits in its draft; × and „Võta tagasi“; published, the home page shows it first", async ({ page, context, visitorIp }, info) => {
    test.skip(!phone(info), "the phone project changes the FAQ; desktop the hero slides");
    test.slow(); // the question typed in two languages, moved one place at a time, an undo, the publish and the public page
    await changing(["faq"]);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/avaleht");
    await adminReady(page);
    // the phone: the section map is the select „Jaotised · Slaidid ▾“
    await expect(page.locator("[data-section-face]")).toHaveText("Jaotised · Slaidid ▾");
    const faq = page.locator("#kkk");
    await expect(faq.getByRole("heading", { level: 2 })).toHaveText("KKK");
    const rows = faq.locator("[data-faq-row]");
    const count = await rows.count();
    // „+ Lisa küsimus“: a row at the end with its answer open and the cursor in its question; saved into the draft at once
    let saved = homeSaved(page, "faq");
    await faq.getByRole("button", { name: "+ Lisa küsimus", exact: true }).click();
    await saved;
    await expect(rows).toHaveCount(count + 1);
    const n = count + 1;
    await expect(faq.getByRole("textbox", { name: `Küsimus ${n} (eesti keeles)`, exact: true })).toBeFocused();
    const q = `E2E küsimus ${unique()}?`;
    await page.keyboard.type(q);
    await faq.getByRole("textbox", { name: `Vastus ${n} (eesti keeles)`, exact: true }).fill("E2E vastus.");
    await editLang(page, "ru");
    await faq.getByRole("textbox", { name: `Küsimus ${n} (vene keeles)`, exact: true }).fill("E2E вопрос?");
    const answerRu = faq.getByRole("textbox", { name: `Vastus ${n} (vene keeles)`, exact: true });
    await answerRu.fill("E2E ответ.");
    saved = homeSaved(page, "faq");
    await answerRu.blur();
    await saved;
    await editLang(page, "et");
    // to the top, one place at a time, each move saved at once
    for (let i = n; i > 1; i--) {
      saved = homeSaved(page, "faq");
      await faq.getByRole("button", { name: `Liiguta küsimus ${i} üles`, exact: true }).click();
      await saved;
    }
    await expect(faq.getByRole("button", { name: "Liiguta küsimus 1 üles", exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(faq.getByRole("textbox", { name: "Küsimus 1 (eesti keeles)", exact: true })).toHaveValue(q);
    // × takes question 2 out at once with the UndoBar; „Võta tagasi“ puts it back with its text
    const second = await faq.getByRole("textbox", { name: "Küsimus 2 (eesti keeles)", exact: true }).inputValue();
    saved = homeSaved(page, "faq");
    await faq.getByRole("button", { name: "Eemalda küsimus 2", exact: true }).click();
    await saved;
    await expect(rows).toHaveCount(count);
    const undoBar = page.locator("[data-undo-bar]");
    await expect(undoBar).toContainText("Küsimus eemaldatud.");
    saved = homeSaved(page, "faq");
    await undoBar.getByRole("button", { name: "Võta tagasi" }).click();
    await saved;
    await expect(rows).toHaveCount(count + 1);
    await expect(faq.getByRole("textbox", { name: "Küsimus 2 (eesti keeles)", exact: true })).toHaveValue(second);
    await expect(page.locator("[data-publish-phone]")).toHaveText("Avaldamata 1 · Eelvaade");
    expect(await noOverflow(page)).toBe(true);
    expect(await homeDraftCount()).toEqual({ n: 1 });

    // „Avalda“: published, the bar goes, nothing is left in the draft
    const answer = homePublished(page);
    await page.locator("[data-publish-go]").click();
    expect((await answer).status()).toBe(200);
    await expect(publishBar(page)).toHaveCount(0);
    expect(await homeDraftCount()).toEqual({ n: 0 });
    expect(await one((sql) => sql<{ q: { et: string; ru?: string } }[]>`select q from faq order by sort, id limit 1`)).toEqual({ q: { et: q, ru: "E2E вопрос?" } });

    await page.goto("/");
    await expect(page.locator("details").first().locator("summary")).toHaveText(q);
    await expect(page.getByText("E2E vastus.")).toBeVisible(); // the first one is open
    await page.goto("/ru");
    await expect(page.locator("details").first().locator("summary")).toHaveText("E2E вопрос?");
  });
});

/** The answer 200 to a trainer part's autosave (POST api/admin/sisu/trainer/0/osa/<part>). */
const trainerSaved = (page: Page, part: string) =>
  page.waitForResponse((r) => r.url().endsWith(`/api/admin/sisu/trainer/0/osa/${part}`) && r.request().method() === "POST" && r.status() === 200);

// Koolitaja (C2 on the draft layer; admin UX pass piece 4a, Task 5): every field autosaves into its part's draft, and the one bar's „Avalda muudatused“
// publishes every trainer draft there is (R-e). One test at a time makes them (edit-lock.ts `trainerDrafts`: desktop the gallery and the portrait, the
// phone a story — each in its own project only), and at its end none is left.
const trainerDraftCount = () => one((sql) => sql<{ n: number }[]>`select count(*)::int as n from content_drafts where entity = 'trainer'`);
/** The works on a visitor's /koolitaja, in their order (each one's picture). */
const shownWorks = (p: Page) => p.locator("[data-works] [data-work] img").evaluateAll((imgs) => imgs.map((img) => img.getAttribute("src")));

test.describe("trainer page, desktop: the gallery and the portrait (C2 Koolitaja on the draft layer)", () => {
  test.use({ trainerDrafts: "chromium-edit" });

  test("two gallery tiles swapped by drag and a new portrait with its focal point wait in their drafts (the bar „Portree, Galerii“) until „Avalda muudatused“; /koolitaja then shows the new order and the portrait framed by its point; at 375 px nothing scrolls sideways", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "desktop changes the trainer card and works; the phone project a story");
    test.slow(); // one long flow: the editor, the public pages, a publish and a second width
    await changing(["settings", { column: "key", value: "trainer" }], ["gallery_items", { column: "group", value: "trainer_works" }]);
    const storedTrainer = async () => (await one((sql) => sql<{ value: Record<string, unknown> }[]>`select value from settings where key = 'trainer'`)).value;
    const before = await storedTrainer();
    // the seed portrait (maria-standing): zoomed in, as tuned in Task 9; the works in their order
    await page.goto("/koolitaja");
    await expect(page.locator("[data-portrait] img")).not.toHaveCSS("transform", "none");
    const works = await shownWorks(page);
    expect(works.length, "the seed's works").toBeGreaterThan(2);

    await signIn(page, context, visitorIp);
    await page.goto("/admin/koolitaja");
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Koolitaja");
    await expect(page.locator("[data-site-eyebrow]")).toHaveText("Koduleht");
    await expect(page.locator("[data-trainer-editor] > section > h2")).toHaveText(["Portree ja tutvustus", "Numbrid", "Galerii", "Koolituskeskuse lugu", "Koolitaja teekond"]);
    await expect(page.getByRole("button", { name: "Salvesta", exact: true })).toHaveCount(0);
    await expect(publishBar(page)).toHaveCount(0);

    // „Galerii“: the counter and „+ Lisa“; the first tile dragged onto the second's place swaps them, saved at once into the gallery's draft
    const gallery = page.locator("#galerii");
    await expect(gallery.locator("[data-gallery-count]")).toHaveText(`Lohista järjekorra muutmiseks · ${works.length} / 24`);
    await expect(gallery.locator("[data-gallery-add] label")).toHaveText("+ Lisa");
    const tiles = gallery.locator("[data-gallery-item]");
    await expect(tiles).toHaveCount(works.length);
    const [first, second] = [await tiles.nth(0).getAttribute("data-gallery-item"), await tiles.nth(1).getAttribute("data-gallery-item")];
    await tiles.nth(1).scrollIntoViewIfNeeded(); // (a pointer goes only where the screen is)
    const handle = (await tiles.nth(0).locator('[data-drag-tool="handle"]').boundingBox())!;
    const target = (await tiles.nth(1).boundingBox())!;
    let saved = trainerSaved(page, "works");
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
    await page.mouse.up();
    await saved;
    await expect(tiles.nth(0)).toHaveAttribute("data-gallery-item", second!);
    await expect(tiles.nth(1)).toHaveAttribute("data-gallery-item", first!);
    await expect(chip(page).locator("[role=status]")).toHaveText(/^Mustand salvestatud \d\d:\d\d$/);
    await expect(barWords(page)).toHaveText(draftWords("Galerii"));
    // the picture's description under its tile (kept, builder notes §5): saved into the gallery's draft when it is left
    const description = tiles.nth(0).getByRole("textbox", { name: "Pildi kirjeldus (eesti keeles)", exact: true });
    saved = trainerSaved(page, "works");
    await description.fill("E2E kirjeldus");
    await description.blur();
    await saved;
    await expect(barWords(page)).toHaveText(draftWords("Galerii"));

    // „Portree ja tutvustus“: a new portrait (saved at once) and its focal point (saved when the field is left)
    const portrait = page.locator('#portree [data-single-image="portrait"]');
    saved = trainerSaved(page, "trainer");
    await portrait.locator('input[type="file"]').setInputFiles([jpeg("maria-seated.jpg")]);
    await expect(portrait.locator("[data-upload-status]")).toHaveText("Pilt lisatud.");
    await saved;
    const focal = page.locator("#portree [data-focal-point]");
    await focal.locator('[data-focal-axis="portrait-x"]').fill("30");
    await focal.locator('[data-focal-axis="portrait-y"]').fill("25");
    await expect(focal.locator('[data-focal-preview="portrait-0"] img')).toHaveCSS("object-position", "30% 25%");
    await expect(focal.locator('[data-focal-preview="portrait-0"] img')).toHaveCSS("transform", "none"); // an upload: no zoom
    saved = trainerSaved(page, "trainer");
    await focal.locator('[data-focal-axis="portrait-y"]').blur();
    await saved;
    await expect(barWords(page)).toHaveText(draftWords("Portree, Galerii"));
    expect(await noOverflow(page)).toBe(true);
    expect(await storedTrainer(), "live keeps its portrait").toEqual(before);
    expect(await trainerDraftCount()).toEqual({ n: 2 });

    // a visitor's /koolitaja (this browser, no draft mode): still the old order
    const visitor = await context.newPage();
    await visitor.goto("/koolitaja");
    expect(await shownWorks(visitor)).toEqual(works);

    // „Avalda muudatused“: both parts published, the bar goes, no draft is left
    const answer = page.waitForResponse((r) => r.url().endsWith("/api/admin/sisu/trainer/0/avalda") && r.request().method() === "POST");
    await page.locator("[data-publish-go]").click();
    expect((await answer).status()).toBe(200);
    await expect(publishBar(page)).toHaveCount(0);
    expect(await trainerDraftCount()).toEqual({ n: 0 });
    const after = await storedTrainer();
    expect(after.portraitKey).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
    expect(after).toMatchObject({ portraitPos: "30% 25%", contactPhotoKey: before.contactPhotoKey, name: before.name });
    const key = after.portraitKey as string;
    await visitor.reload();
    expect(await shownWorks(visitor)).toEqual([works[1], works[0], ...works.slice(2)]);
    await expect(visitor.locator("[data-works] [data-work] button").first()).toHaveAttribute("aria-label", /: E2E kirjeldus$/);
    const img = visitor.locator("[data-portrait] img");
    await expect(img).toHaveAttribute("src", `/media/${key}`);
    await expect(img).toHaveCSS("object-position", "30% 25%");
    await expect(img).toHaveCSS("transform", "none");
    await visitor.goto("/");
    const teaser = visitor.locator(`img[src="/media/${key}"]`).first();
    await expect(teaser).toHaveCSS("object-position", "30% 25%");
    await expect(teaser).toHaveCSS("transform", "none");
    await visitor.close();

    // 375 px: the tiles inside the screen, nothing scrolls sideways
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/admin/koolitaja");
    await adminReady(page);
    await expect(page.locator("#galerii [data-gallery-item]")).toHaveCount(works.length);
    for (const right of await page.locator("#galerii [data-gallery-item], #galerii [data-gallery-add]").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right)))
      expect(right).toBeLessThanOrEqual(375);
    expect(await noOverflow(page)).toBe(true);
  });
});

test.describe("trainer page, phone: a story (C2 Koolitaja on the draft layer)", () => {
  test.use({ trainerDrafts: "mobile-edit" });

  test("an empty story is folded to „tühi“ · „Lisa tekst“; the button opens it with the cursor in its title; typed, published, /koolitaja shows it", async ({ page, context, visitorIp }, info) => {
    test.skip(!phone(info), "the phone project changes the story; desktop the trainer card and works");
    await changing(["pages", { column: "key", value: "center_story" }]);
    // (the seed's story has text: emptied here, so its card starts folded)
    await onLocalDb((sql) => sql`update pages set title = ${sql.json({ et: "" })}, body = ${sql.json({ et: "" })} where key = 'center_story'`);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/koolitaja");
    await adminReady(page);
    const story = page.locator("#lugu");
    await expect(story.getByRole("heading", { level: 2 })).toHaveText("Koolituskeskuse lugu");
    await expect(story.locator("[data-story-fold]")).toHaveText("tühi · Lisa tekst ▸");
    await expect(story.getByRole("textbox")).toHaveCount(0);
    await story.getByRole("button", { name: "Lisa tekst", exact: true }).click();
    const title = story.getByRole("textbox", { name: "Pealkiri (eesti keeles)", exact: true });
    await expect(title).toBeFocused();
    await title.fill("E2E lugu");
    const body = story.getByRole("textbox", { name: "Tekst (eesti keeles)", exact: true });
    await body.fill("Esimene E2E lõik.\n\nTeine E2E lõik.");
    const saved = trainerSaved(page, "center_story");
    await body.blur();
    await saved;
    await expect(barWords(page)).toHaveText(draftWords("Koolituskeskuse lugu"));
    expect(await noOverflow(page)).toBe(true);
    const answer = page.waitForResponse((r) => r.url().endsWith("/api/admin/sisu/trainer/0/avalda") && r.request().method() === "POST");
    await page.locator("[data-publish-go]").click();
    expect((await answer).status()).toBe(200);
    await expect(publishBar(page)).toHaveCount(0);
    expect(await trainerDraftCount()).toEqual({ n: 0 });
    await page.goto("/koolitaja");
    const block = page.locator('[data-story="center_story"]');
    await expect(block.getByRole("heading")).toHaveText("E2E lugu");
    await expect(block.locator("p")).toHaveText(["Esimene E2E lõik.", "Teine E2E lõik."]);
  });
});

/** The answer 200 to a post's autosave (POST api/admin/sisu/post/<id>/osa/post). */
const postSaved = (page: Page, id: number) =>
  page.waitForResponse((r) => r.url().endsWith(`/api/admin/sisu/post/${id}/osa/post`) && r.request().method() === "POST" && r.status() === 200);

// C3 Uudised (admin UX pass piece 4b, Task 2; README §4 C3; the Part 4 C3 frame; S4-18…S4-24; rulings R-a, R-b, R-f, R-g): „Lisa postitus +“ makes the post
// at once; it saves straight to its row until „Avaldatud“ publishes it (S4-Q1 A: the cover, the title and the text in ET and RU); a published post's
// edits wait in its draft — the public page keeps the old text until „Avalda muudatused“. Each project makes, publishes and deletes its own post (its
// title names the project, so its address is `e2e-uudis-<project>-…`); one post's drafts are its own, so the two projects never meet.
test.describe("news", () => {
  test("„Lisa postitus +“, a title, a cover, ET and RU text; „Avaldatud“ on lists it on /uudised; an edit of the published text waits for „Avalda muudatused“; from 1180 px the list beside the post, at 375 px two screens with „← Uudised“; delete", async ({ page, context, visitorIp }, info) => {
    test.slow(); // one long flow: the editor, the public pages, a publish, two widths
    await signIn(page, context, visitorIp);
    await page.goto("/admin/uudised");
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Uudised");
    await expect(page.locator("[data-post-row]")).not.toHaveCount(0);

    // „Lisa postitus +“: the post at once (S4-19), ADM:2273's line, the cursor in „Pealkiri“; no bar, the switch off
    await page.locator("[data-add-post]").click();
    await expect(page).toHaveURL(/\/admin\/uudised\/\d+\?loodud=1$/);
    const id = Number(new URL(page.url()).pathname.split("/").at(-1));
    undo.push(() => onLocalDb((sql) => sql`delete from content_drafts where entity = 'post' and entity_id = ${id}`).then(() => onLocalDb((sql) => sql`delete from posts where id = ${id}`)));
    await adminReady(page);
    await expect(page.locator("[data-post-created]")).toHaveText("Postitus loodud. Lisa kaanepilt ja avalda, kui kõik on valmis.");
    const titleField = page.getByRole("textbox", { name: "Pealkiri (eesti keeles)", exact: true });
    await expect(titleField).toBeFocused();
    await expect(titleField).toHaveValue("Uus postitus");
    await expect(publishBar(page)).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Avaldatud" })).not.toBeChecked();

    // the title: the address follows it (R-g), and the list's row says it once saved
    const title = `E2E uudis ${info.project.name} ${unique()}`;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    expect(slug.startsWith(`${POST_SLUG_PREFIX}${info.project.name}-`)).toBe(true);
    let saved = postSaved(page, id);
    await titleField.fill(title);
    await expect(page.getByRole("textbox", { name: "Aadress", exact: true })).toHaveValue(slug);
    await titleField.blur();
    await saved;
    await expect(page.locator("[data-post-where]")).toHaveText(`Mustand · /uudised/${slug}`);
    expect(await one((sql) => sql<{ slug: string; published: boolean }[]>`select slug, published from posts where id = ${id}`)).toEqual({ slug, published: false });

    // the text, the category and the cover in Estonian; then „Avaldatud“: refused for the Russian title and text (S4-22)
    saved = postSaved(page, id);
    await page.getByRole("textbox", { name: "Tekst (eesti keeles)", exact: true }).fill("Esimene lõik.\n\nTeine lõik.");
    await page.getByRole("textbox", { name: "Kategooria (eesti keeles)", exact: true }).fill("Uudis");
    await page.getByRole("textbox", { name: "Kategooria (eesti keeles)", exact: true }).blur();
    await saved;
    const cover = page.locator('[data-single-image="cover"]');
    saved = postSaved(page, id);
    await cover.locator('input[type="file"]').setInputFiles([jpeg("brow-closeup.jpg")]);
    await expect(cover.locator("[data-upload-status]")).toHaveText("Pilt lisatud.");
    await saved;
    const switched = () => page.waitForResponse((r) => r.url().endsWith(`/api/admin/uudised/${id}/avaldatud`) && r.request().method() === "POST");
    let answer = switched();
    await page.getByRole("switch", { name: "Avaldatud" }).click();
    await answer;
    await expect(page.locator("[data-switch-error]")).toHaveText("Puudub: pealkiri (RU), tekst (RU)");
    await expect(page.getByRole("switch", { name: "Avaldatud" })).not.toBeChecked();

    // the Russian title and text, then „Avaldatud“ on: the post is public, with its bar's header now (no changes: no bar)
    await editLang(page, "ru");
    saved = postSaved(page, id);
    await page.getByRole("textbox", { name: "Pealkiri (vene keeles)", exact: true }).fill("E2E новость");
    await page.getByRole("textbox", { name: "Tekst (vene keeles)", exact: true }).fill("Первый абзац.");
    await page.getByRole("textbox", { name: "Tekst (vene keeles)", exact: true }).blur();
    await saved;
    await editLang(page, "et");
    answer = switched();
    await page.getByRole("switch", { name: "Avaldatud" }).click();
    expect((await answer).status()).toBe(200);
    await expect(page.getByRole("switch", { name: "Avaldatud" })).toBeChecked();
    await expect(page.locator("[data-site-view]")).toHaveAttribute("href", `/uudised/${slug}`);
    await expect(page.locator("[data-post-where]")).toHaveText(new RegExp(`^Avaldatud \\d\\d\\.\\d\\d\\.\\d{4} · /uudised/${slug}$`));
    await expect(page.locator(`[data-post-row="${id}"] [data-post-state]`)).toHaveText(/^Avaldatud · \d\d\.\d\d$/);
    const visitor = await context.newPage();
    await visitor.goto("/uudised");
    await expect(visitor.locator(`[data-news-card][href="/uudised/${slug}"]`)).toContainText(title);
    await visitor.goto(`/uudised/${slug}`);
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(visitor.locator("[data-article-body] p")).toHaveText(["Esimene lõik.", "Teine lõik."]);

    // the published text edited: its draft, on the bar („Tekst“, S4-24), the row „Avaldamata muudatused“; the public page keeps the old text until
    // „Avalda muudatused“
    saved = postSaved(page, id);
    const body = page.getByRole("textbox", { name: "Tekst (eesti keeles)", exact: true });
    await body.fill("Esimene lõik.\n\nTeine lõik.\n\nKolmas lõik.");
    await body.blur();
    await saved;
    await expect(barWords(page)).toHaveText(draftWords("Tekst"));
    await expect(chip(page).locator("[role=status]")).toHaveText(/^Mustand salvestatud \d\d:\d\d$/);
    await expect(page.locator(`[data-post-row="${id}"] [data-post-state]`)).toHaveText(/^Avaldamata muudatused · \d\d\.\d\d$/);
    await visitor.reload();
    await expect(visitor.locator("[data-article-body] p")).toHaveText(["Esimene lõik.", "Teine lõik."]);
    const published = page.waitForResponse((r) => r.url().endsWith(`/api/admin/sisu/post/${id}/avalda`) && r.request().method() === "POST");
    await page.locator("[data-publish-go]").click();
    expect((await published).status()).toBe(200);
    await expect(publishBar(page)).toHaveCount(0);
    await expect(page.locator(`[data-post-row="${id}"] [data-post-state]`)).toHaveText(/^Avaldatud · /);
    await visitor.reload();
    await expect(visitor.locator("[data-article-body] p")).toHaveText(["Esimene lõik.", "Teine lõik.", "Kolmas lõik."]);
    await visitor.close();

    // from 1180 px the list (320 px) stays at the left of the open post, its row marked; below that the post is a screen of its own
    if (!phone(info)) {
      const [list, editor] = [(await page.locator("[data-news-list]").boundingBox())!, (await page.locator("[data-news-editor]").boundingBox())!];
      expect(Math.round(list.width)).toBe(320);
      expect(list.x + list.width).toBeLessThanOrEqual(editor.x);
      await expect(page.locator(`[data-post-row="${id}"]`)).toHaveAttribute("aria-current", "page");
      await expect(page.locator("[data-post-back]")).toBeHidden();
      expect(await noOverflow(page)).toBe(true);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator("[data-news-list]")).toBeHidden();
    const back = page.locator("[data-post-back] a");
    await expect(back).toHaveText("← Uudised");
    expect(await noOverflow(page)).toBe(true);
    await back.click();
    await expect(page).toHaveURL(/\/admin\/uudised$/);
    await expect(page.locator("[data-news-list]")).toBeVisible();
    await expect(page.locator("[data-news-editor]")).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
    await page.locator(`[data-post-row="${id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/uudised/${id}$`));
    await adminReady(page);

    // „Kustuta postitus“ (S4-23): the question, then the list says so; the post's page is gone
    await page.getByRole("button", { name: "Kustuta postitus" }).click();
    await expect(page.locator("[data-confirm-panel] li")).toHaveText(["Postitus kaob blogist ja avalehelt.", "Seda ei saa tagasi võtta."]);
    await page.getByRole("button", { name: "Jah, kustuta" }).click();
    await expect(page).toHaveURL(/\/admin\/uudised\?kustutatud=1$/);
    await expect(page.locator("[data-post-deleted]")).toHaveText("Postitus kustutatud.");
    await expect(page.locator(`[data-post-row="${id}"]`)).toHaveCount(0);
    expect((await page.goto(`/uudised/${slug}`))!.status()).toBe(404);
  });
});

// C4 Hüpikaken on the draft layer (admin UX pass piece 4b, Task 4; README §4 C4, the Part 4 C4 frame; piece4-texts S4-25…S4-30; rulings R-c, R-d,
// R-e): the instant „Lehel näidatakse“ with its UndoBar, the offer's fields autosaved into the popup's draft and published by „Avalda muudatused“, the
// preview following the page's ET | RU; the home page's popup then shows the new title after the site's own 8 s. These tests change the popup row,
// which campaign.spec.ts reads, so they run in this file's late projects; one popup row: the desktop project changes it, the phone only looks.
test.describe("Hüpikaken (C4 on the draft layer; piece 4b, Task 4)", () => {
  test.use({ campaignPopup: "site" }); // (the visitor's tab waits the site's own 8 s)
  const switchAnswer = (page: Page) => page.waitForResponse((r) => r.url().endsWith("/api/admin/hupikaken/naita") && r.request().method() === "POST");
  const offerSaved = (page: Page) => page.waitForResponse((r) => r.url().endsWith("/api/admin/sisu/popup/0/osa/offer") && r.request().method() === "POST" && r.status() === 200);
  const popupRow = () => one((sql) => sql<{ active: boolean; title: { et: string; ru?: string }; image: string }[]>`select active, title, image_key as image from campaign where id = 2`);
  const discount = () => one((sql) => sql<{ n: string | null }[]>`select value->>'discountPercent' as n from settings where key = 'newsletter'`);

  test("„Lehel näidatakse“ off → „Hüpikaken peidetud.“ → „Võta tagasi“ → on; a picture, a title and a discount wait for „Avalda muudatused“ (the preview follows ET | RU); published, the home page's popup shows them after 8 s and the footer the discount; at 375 px the preview is under the card and nothing scrolls sideways", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "one popup row: desktop changes it");
    test.slow(); // one long flow: the switch, the offer, a publish, the site's 8 s and a second width
    await changing(["campaign"], ["settings", { column: "key", value: "newsletter" }]);
    await removePopupDrafts();
    undo.push(removePopupDrafts);
    // the seed's popup, shown (the old campaign offer, row 1, off: at most one is on)
    await onLocalDb(async (sql) => {
      await sql`update campaign set active = false where id = 1`;
      await sql`update campaign set active = true where id = 2`;
    });
    const before = await popupRow();
    await signIn(page, context, visitorIp);
    await page.goto("/admin/kampaania");
    await adminReady(page);
    await expect(page.locator("[data-site-eyebrow]")).toHaveText("Turundus");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hüpikaken");
    await expect(page.getByRole("button", { name: "Salvesta", exact: true })).toHaveCount(0);
    await expect(publishBar(page)).toHaveCount(0);
    expect((await page.locator("main").innerText()).toLowerCase()).not.toContain("kampaania");

    // the switch: off at once with its undo, „Võta tagasi“ switches it on again; on says nothing, and nothing of it is on the bar
    const shown = page.getByRole("switch", { name: "Lehel näidatakse" });
    await expect(shown).toBeChecked();
    await expect(page.locator("[data-popup-shown]")).toContainText("Avaneb uuele külastajale 8 s pärast · üks kord 30 päeva jooksul");
    let answer = switchAnswer(page);
    await shown.click();
    expect((await answer).status()).toBe(200);
    const undoBar = page.locator("[data-undo-bar]");
    await expect(undoBar).toContainText("Hüpikaken peidetud.");
    await expect(shown).not.toBeChecked();
    await expect.poll(async () => (await popupRow()).active).toBe(false);
    answer = switchAnswer(page);
    await undoBar.getByRole("button", { name: "Võta tagasi" }).click();
    expect((await answer).status()).toBe(200);
    await expect(undoBar).toHaveCount(0);
    await expect(shown).toBeChecked();
    expect((await popupRow()).active).toBe(true);
    await expect(publishBar(page)).toHaveCount(0);

    // the offer: a new picture, title and discount autosave into the popup's draft; the bar names them; live keeps its own
    const card = page.locator("#pakkumine");
    const preview = page.locator("[data-newsletter-preview]");
    const image = page.locator('[data-single-image="popup"]');
    let saved = offerSaved(page);
    await image.locator('input[type="file"]').setInputFiles([jpeg("brow-closeup.jpg")]);
    await expect(image.locator("[data-upload-status]")).toHaveText("Pilt lisatud.");
    await saved;
    const src = await image.locator("[data-current-image]").getAttribute("data-current-image");
    expect(src).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
    await expect(preview.locator("img")).toHaveAttribute("src", `/media/${src}`);
    const title = card.getByRole("textbox", { name: "Pealkiri (eesti keeles)", exact: true });
    saved = offerSaved(page);
    await title.fill("E2E hüpikaken");
    await title.blur();
    await saved;
    await expect(preview.getByRole("heading", { level: 2 })).toHaveText("E2E hüpikaken");
    const percent = card.getByRole("textbox", { name: "Soodustus (%)", exact: true });
    saved = offerSaved(page);
    await percent.fill("17");
    await percent.blur();
    await saved;
    await expect(chip(page).locator("[role=status]")).toHaveText(/^Mustand salvestatud \d\d:\d\d$/);
    await expect(barWords(page)).toHaveText(draftWords("Pealkiri, Pilt, Soodustus"));
    await expect(card.getByText("Koodi saad muuta: Seaded → „Tervituskood“.")).toBeVisible();
    expect(await popupRow()).toEqual(before);
    // the preview follows the page's ET | RU, with the rules line under it
    await editLang(page, "ru");
    await expect(preview).toHaveAttribute("lang", "ru");
    await expect(preview.getByRole("heading", { level: 2 })).toHaveText(before.title.ru ?? "");
    await editLang(page, "et");
    await expect(preview.getByRole("heading", { level: 2 })).toHaveText("E2E hüpikaken");
    // the preview is a picture of the popup: no form inside the page; as tall as the popup's card (the same gap above the form), the privacy word a
    // span (not a link) that makes the line 44 px high like the link
    await expect(page.locator("[data-campaign-editor] form")).toHaveCount(0);
    await expect.poll(() => gapAboveForm(preview.getByText("Uued koolitused, kasulikud mõtted"), preview.locator("[data-newsletter-form]"))).toBeCloseTo(18, 0);
    await expect(preview.locator("[data-newsletter-notice] a")).toHaveCount(0);
    expect((await preview.locator("[data-newsletter-notice]").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator("[data-popup-rules]")).toHaveText("Reeglid: kood saadetakse e-postiga kohe pärast liitumist; üks kasutus tellija kohta; ei liitu teiste soodustustega.");

    // „Avalda muudatused“: the row and the discount go live, the bar goes
    const published = page.waitForResponse((r) => r.url().endsWith("/api/admin/sisu/popup/0/avalda") && r.request().method() === "POST");
    await page.locator("[data-publish-go]").click();
    expect((await published).status()).toBe(200);
    await expect(publishBar(page)).toHaveCount(0);
    expect(await popupRow()).toEqual({ active: true, title: { ...before.title, et: "E2E hüpikaken" }, image: src });
    expect(await discount()).toEqual({ n: "17" });

    // a visitor's tab: the popup after the site's 8 s, with the new title and picture (served from the store); the footer's discount
    const visitor = await context.newPage();
    const start = Date.now();
    await visitor.goto("/", { waitUntil: "commit" });
    const dialog = visitor.getByRole("dialog", { name: "E2E hüpikaken" });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    expect(Date.now() - start, "not before its 8 s").toBeGreaterThanOrEqual(8000);
    const picture = dialog.locator("[data-newsletter-card] img");
    await expect(picture).toHaveAttribute("src", `/media/${src}`);
    await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    await visitor.keyboard.press("Escape");
    await expect(visitor.locator("footer").getByText("17% tervitussoodustus")).toBeVisible();
    await visitor.close();

    // 375 px: the preview under the card, nothing scrolls sideways
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/admin/kampaania");
    await adminReady(page);
    const [cardBox, previewBox] = [(await page.locator("#pakkumine").boundingBox())!, (await page.locator("[data-newsletter-preview]").boundingBox())!];
    expect(cardBox.y + cardBox.height, "the preview under the card").toBeLessThanOrEqual(previewBox.y);
    expect(await noOverflow(page)).toBe(true);
  });

  test("on refused, the live popup lacks its picture: „Puudub: pilt“ under the switch, which stays off; no bar", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "one popup row: desktop changes it");
    await changing(["campaign"]);
    await onLocalDb((sql) => sql`update campaign set active = false, image_key = '' where id = 2`);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/kampaania");
    await adminReady(page);
    const shown = page.getByRole("switch", { name: "Lehel näidatakse" });
    await expect(shown).not.toBeChecked();
    const answer = switchAnswer(page);
    await shown.click();
    expect(await (await answer).json()).toEqual({ ok: false, missing: ["pilt"] });
    await expect(page.locator("[data-switch-error]")).toHaveText("Puudub: pilt");
    await expect(shown).not.toBeChecked();
    await expect(page.locator("[data-undo-bar]")).toHaveCount(0);
    await expect(publishBar(page)).toHaveCount(0);
    expect(await one((sql) => sql<{ active: boolean }[]>`select active from campaign where id = 2`)).toEqual({ active: false });
  });
});

test.describe("the newsletter popup (phase 2c)", () => {
  test.use({ campaignPopup: 300 });

  /** The newsletter popup shown, the old campaign offer off (at most one active: the campaign first goes off). */
  const showNewsletter = () =>
    onLocalDb(async (sql) => {
      await sql`update campaign set active = false where id = 1`;
      await sql`update campaign set active = true where id = 2`;
    });

  test("it opens on the home page with its texts and the form; a sign-up says so inside and is never shown again in this browser", async ({ page }, info) => {
    test.skip(phone(info), "one popup row: desktop changes it");
    undo.push(await holdNewsletter(info)); // (a confirmed subscriber is a recipient of the newsletter e2e test's press: they take turns)
    await changing(["campaign"]);
    await showNewsletter();
    await page.goto("/");
    const popup = page.getByRole("dialog", { name: "Hea järgmine samm. Otse sinu postkasti." });
    await expect(popup).toBeVisible();
    await expect(popup.locator("[data-newsletter-card] img")).toHaveAttribute("src", "/seed/gift-bag-serum.jpg");
    await expect(popup.getByText("MS LABi kirjad")).toBeVisible();
    await expect(popup.locator("[data-campaign-code]")).toHaveCount(0); // no code in the popup: it comes in the welcome mail
    // no consent box (owner decision 08.10): the line under the button says signing up is the consent, with the privacy link
    await expect(popup.getByRole("checkbox")).toHaveCount(0);
    const notice = popup.locator("[data-newsletter-notice]");
    await expect(notice).toHaveText("Liitudes saad MS LABi uudiskirja. Saad igal ajal loobuda. Privaatsus");
    await expect(notice.getByRole("link", { name: "Privaatsus" })).toHaveAttribute("href", "/privaatsus");
    // the gap between the text and the form is the card's own 18 px (the form adds no margin of its own on top of it); polled: the card rises into place first
    await expect.poll(() => gapAboveForm(popup.getByText("Uued koolitused, kasulikud mõtted"), popup.locator("[data-newsletter-form]"))).toBeCloseTo(18, 0);
    const addr = testEmail("nl-popup", info.project.name);
    await popup.getByLabel("Sinu e-post").fill(addr);
    await popup.getByRole("button", { name: "Liitu" }).click();
    await expect(popup.locator("[data-newsletter-status]")).toHaveText("Aitäh, oled liitunud! Saatsime sulle tervituskirja.");
    expect(await storedSubscriber(addr)).toMatchObject({ email: addr, confirmed: true }); // one step: subscribed at once
    expect(await page.evaluate(() => localStorage.getItem("mslab-nl"))).toBe("1");
    await page.keyboard.press("Escape");
    await page.evaluate(() => localStorage.removeItem("mslab-popup")); // its 30 days over …
    await page.reload();
    await page.waitForTimeout(1200);
    await expect(page.getByRole("dialog")).toHaveCount(0); // … still none: signed up here
  });

  test("the confirmed landing (/?uudiskiri=kinnitatud) shows no newsletter popup over the notice, even past the delay; this browser is marked signed up, so a reload of / still shows none", async ({ page }, info) => {
    test.skip(phone(info), "one popup row: desktop changes it");
    await changing(["campaign"]);
    await showNewsletter();
    await page.goto("/?uudiskiri=kinnitatud#kood=E2E-TERE");
    await expect(page.locator("[data-flash-notice]")).toHaveAttribute("data-flash-notice", "ok");
    await expect(page.locator("[data-flash-code]")).toContainText("E2E-TERE");
    await page.waitForTimeout(1500); // well past the 300 ms delay of this describe
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("mslab-nl"))).toBe("1");
    expect(await page.evaluate(() => localStorage.getItem("mslab-popup"))).toBeNull(); // the popup did not use up its turn either
    await page.reload(); // the address is plain "/" by now (FlashNotice took the parameter and the code out)
    await page.waitForTimeout(1500);
    await expect(page.getByRole("dialog")).toHaveCount(0); // signed up in this browser: still none
  });

  test("any other landing (/?uudiskiri=vigane) shows no popup on that load either, but marks nothing: the next visit gets it", async ({ page }, info) => {
    test.skip(phone(info), "one popup row: desktop changes it");
    await changing(["campaign"]);
    await showNewsletter();
    await page.goto("/?uudiskiri=vigane");
    await expect(page.locator("[data-flash-notice]")).toHaveAttribute("data-flash-notice", "warn");
    await page.waitForTimeout(1500);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("mslab-nl"))).toBeNull();
    await page.goto("/");
    await expect(page.getByRole("dialog", { name: "Hea järgmine samm. Otse sinu postkasti." })).toBeVisible(); // the delay does work here
  });

  test("the unsubscribed landing (/?uudiskiri=loobutud) shows its notice and no popup, and marks nothing (only kinnitatud marks this browser): the next visit gets the popup", async ({ page }, info) => {
    test.skip(phone(info), "one popup row: desktop changes it");
    await changing(["campaign"]);
    await showNewsletter();
    await page.goto("/?uudiskiri=loobutud");
    await expect(page.locator("[data-flash-notice]")).toHaveAttribute("data-flash-notice", "ok");
    await expect(page.locator("[data-flash-notice]")).toContainText("Oled uudiskirjast loobunud.");
    await expect(page.locator("[data-flash-notice]")).toContainText("Me ei saada sulle enam MS LABi uudiskirja.");
    await page.waitForTimeout(1500);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("mslab-nl"))).toBeNull();
    await page.goto("/");
    await expect(page.getByRole("dialog", { name: "Hea järgmine samm. Otse sinu postkasti." })).toBeVisible();
  });

  test("Russian, at a phone's width: the sheet with the form fits (no overflow, 44 px targets); switched off, none; the old campaign offer's row on, none either (R-d)", async ({ page }, info) => {
    test.skip(phone(info), "one popup row: desktop changes it (and sets the phone's width here)");
    await changing(["campaign"]);
    await showNewsletter();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/ru");
    const popup = page.getByRole("dialog", { name: "Ваш следующий шаг. В вашем почтовом ящике." });
    await expect(popup).toBeVisible();
    const submit = popup.getByRole("button", { name: "Подписаться" });
    await expect(submit).toBeVisible();
    expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const link = popup.locator("[data-newsletter-notice]").getByRole("link", { name: "Конфиденциальность" });
    await expect(link).toHaveAttribute("href", "/ru/privaatsus");
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await popup.locator("[data-newsletter-panel]").evaluate((p) => p.scrollWidth <= p.clientWidth)).toBe(true);
    await onLocalDb((sql) => sql`update campaign set active = false`);
    await page.evaluate(() => localStorage.removeItem("mslab-popup"));
    await page.goto("/");
    await page.waitForTimeout(1200);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // the old campaign offer (row 1) on, as a database from before piece 4b may have it: the site shows it nowhere
    await onLocalDb((sql) => sql`update campaign set active = true where id = 1`);
    for (const path of ["/", "/ru"]) {
      await page.evaluate(() => localStorage.removeItem("mslab-popup"));
      await page.goto(path);
      await page.waitForTimeout(1200);
      await expect(page.getByRole("dialog"), path).toHaveCount(0);
    }
  });
});

test.describe("settings", () => {
  test("375 × 812: the section map is the „Jaotised ▾“ select under the header; a choice goes to its section below the phone bar; the old anchors land in „Maksmine“; nothing scrolls sideways", async ({ page, context, visitorIp }, info) => {
    test.skip(!phone(info), "the phone project");
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, context, visitorIp);
    await page.goto("/admin/seaded");
    await adminReady(page);
    const select = page.locator("[data-section-select]");
    await expect(select).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Jaotised" })).toBeHidden();
    await expect(select.locator("[data-section-face]")).toHaveText(/^Jaotised · Kontakt\s*▾$/);
    expect(await select.locator("option").allTextContents()).toEqual(["Kontakt", "Uudiskiri", "Maksmine", "Tunnistus", "Lepingud ja tingimused", "Halduse ligipääs"]);
    const box = (await select.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(375 - 16 + 0.5);
    // under the header, before the first card
    const head = (await page.locator("[data-seaded-head]").boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(head.y + head.height);
    expect(box.y).toBeLessThan((await page.locator("[data-contact-card]").boundingBox())!.y);
    expect(await noOverflow(page)).toBe(true);
    // the chip in its short form beside the H1, the one status of the page
    await expect(page.locator("[data-save-status][data-save-kind]")).toHaveCount(1);
    const top = (id: string) => page.locator(`#${id}`).evaluate((el) => Math.round(el.getBoundingClientRect().top));
    await select.locator("select").selectOption("maksmine");
    await expect(select.locator("[data-section-face]")).toContainText("Maksmine");
    await expect.poll(() => top("maksmine")).toBeGreaterThanOrEqual(64);
    await expect.poll(() => top("maksmine")).toBeLessThanOrEqual(64 + 24 + 4);
    await select.locator("select").selectOption("ligipaas");
    await expect.poll(async () => (await page.locator("[data-admin-emails]").boundingBox())!.y).toBeLessThan(812);
    // the old anchors, arriving from another page (a link of the drawer, a bookmark): #arve, #ettemaks, #jarelmaks at the top of „Maksmine“ (below
    // the phone bar), #tunnistus its section. (A fresh load each time: a jump within the page could race the select's smooth scroll above.)
    for (const alias of ["arve", "ettemaks", "jarelmaks"]) {
      await page.goto("about:blank");
      await page.goto(`/admin/seaded#${alias}`);
      await adminReady(page);
      await expect.poll(() => top("maksmine"), alias).toBeGreaterThanOrEqual(64);
      await expect.poll(() => top("maksmine"), alias).toBeLessThanOrEqual(64 + 24 + 4);
    }
    await page.goto("about:blank");
    await page.goto("/admin/seaded#tunnistus");
    await adminReady(page);
    await expect.poll(() => top("tunnistus")).toBeGreaterThanOrEqual(64);
    await expect.poll(() => top("tunnistus")).toBeLessThanOrEqual(64 + 24 + 4);
    expect(await noOverflow(page)).toBe(true);
  });

  test("contact links (https only) autosave (no „Salvesta“) and reach the footer and the contact page; „Uudiskiri“ has no discount field (piece 4b)", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "desktop changes the contact settings; the phone project the privacy page");
    await changing(["settings", { column: "key", value: "contact" }]);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/seaded");
    await adminReady(page);
    await expect(page.locator("[data-contact-card]").getByRole("button")).toHaveCount(0);
    const stored = () => one((sql) => sql<{ value: Record<string, string> }[]>`select value from settings where key = 'contact'`);
    const before = (await stored()).value;
    const instagram = page.getByRole("textbox", { name: "Instagram", exact: true });
    const refused = await seadedAutosave(page, "contact", async () => {
      await instagram.fill("javascript:alert(1)");
      await instagram.press("Tab");
    });
    expect(refused.status()).toBe(400);
    await expect(seadedStatus(page)).toHaveAttribute("data-save-kind", "invalid");
    await expect(instagram).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Sisesta täielik aadress, mis algab https://.")).toBeVisible();
    expect((await stored()).value.instagram).toBe(before.instagram); // (nothing of it stored)
    await instagram.fill("https://www.instagram.com/mslab.e2e");
    const phoneField = page.getByRole("textbox", { name: "Telefon", exact: true });
    const saved = await seadedAutosave(page, "contact", async () => {
      await phoneField.fill("+372 5555 0199");
      await phoneField.press("Tab");
    });
    expect(saved.status()).toBe(200);
    await expect(seadedStatus(page)).toHaveAttribute("data-save-kind", "saved");
    await expect.poll(async () => (await stored()).value).toMatchObject({ instagram: "https://www.instagram.com/mslab.e2e", phone: "+372 5555 0199" });
    // „Uudiskiri“ is the welcome code alone: the discount is Hüpikaken's „Soodustus (%)“ (piece 4b S4-Q2 A)
    await expect(page.locator("[data-newsletter-card]").getByRole("textbox")).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Tervitussoodustus", exact: true })).toHaveCount(0);

    await page.goto("/");
    const footer = page.locator("footer");
    await expect(footer.getByRole("link", { name: /Instagram/ })).toHaveAttribute("href", "https://www.instagram.com/mslab.e2e");
    await expect(footer.getByRole("link", { name: "+372 5555 0199" })).toHaveAttribute("href", "tel:+37255550199");
    // (the footer's discount is Hüpikaken's published one, read as its number: `{discountPercent}%`, piece 4b R-c)
    await expect(footer.getByText(/\d{1,2}% tervitussoodustus/)).toBeVisible();
    await page.goto("/kontakt");
    await expect(page.locator("[data-contact-details]").getByRole("link", { name: /instagram\.com\/mslab\.e2e/ })).toBeVisible();
  });

  test("Tervituskood: saved in Seaded; the first confirmation link lands on the home page with the code, the second without", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "desktop changes the newsletter setting");
    undo.push(await holdNewsletter(info)); // (the confirmed row it makes is a recipient of the newsletter e2e test's press: they take turns)
    await changing(["settings", { column: "key", value: "newsletter" }]);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/seaded");
    await adminReady(page);
    const code = page.getByRole("textbox", { name: "Tervituskood", exact: true });
    const saved = await seadedAutosave(page, "newsletter", async () => {
      await code.fill("e2e-tere");
      await code.press("Tab");
    });
    expect(saved.status()).toBe(200);
    await expect(seadedStatus(page)).toHaveAttribute("data-save-kind", "saved");
    expect(await one((sql) => sql<{ code: string }[]>`select value->>'welcomeCode' as code from settings where key = 'newsletter'`)).toEqual({ code: "E2E-TERE" });
    const addr = testEmail("welcome", info.project.name);
    const token = "w".repeat(40) + info.project.name.slice(0, 3).padEnd(3, "x");
    await onLocalDb((sql) => sql`insert into subscribers (email, locale, token) values (${addr}, 'et', ${token})`, { marksPages: false });
    await page.goto(`/api/newsletter/confirm?t=${token}`);
    await expect(page.locator("[data-flash-code]")).toHaveText("Sinu tervituskood: E2E-TERE. Lisa kood registreerimisel lahtrisse „Sõnum“.");
    expect(new URL(page.url()).hash).toBe(""); // the fragment is gone from the address
    await page.goto(`/api/newsletter/confirm?t=${token}`);
    await expect(page.locator("[data-flash-notice]")).toHaveAttribute("data-flash-notice", "ok");
    await expect(page.locator("[data-flash-code]")).toHaveCount(0);
  });

  test("Lepingud ja tingimused (piece 3b, Task 5): the contact contract types into its draft only, the chips insert at the cursor, a missing title is said on the press, the sample posts the screen; „Avalda uus leping“ asks, then publishes a new version; the e-course contract likewise", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "desktop changes the contract texts; the phone project the privacy page");
    // (contracts.spec.ts writes the contact text too, and runs beside this one under `next dev`: they take turns, and the turn puts the two rows back)
    undo.push(await holdContractTexts(info));
    await changing(["pages", { column: "key", value: "course_terms" }], ["settings", { column: "key", value: "courseTermsVersion" }]);
    undo.push(await holdLegalDraft("contract_contact"));
    undo.push(await holdLegalDraft("course_terms"));
    // her own contact text not written yet (the turn puts back what was there)
    await onLocalDb(async (sql) => {
      await sql`delete from pages where key = 'contract_contact'`;
      await sql`delete from settings where key = 'contractContactVersion'`;
    });
    await signIn(page, context, visitorIp);
    await page.goto("/admin/seaded");
    await adminReady(page);

    const TITLE = "E2E Kontaktkoolituse leping";
    const BODY = "E2E {nimi} registreerub koolitusele {koolitus}.\n\nHind {hind}.";
    const contactRows = () => one((sql) => sql<{ n: number }[]>`select count(*)::int as n from pages where key = 'contract_contact'`);
    const contactVersion = () => one((sql) => sql<{ v: string | null }[]>`select (select value #>> '{}' from settings where key = 'contractContactVersion') as v`);
    const card = page.locator('[data-legal-editor="contract_contact"]');
    await expect(card.getByRole("heading", { level: 2 })).toHaveText("Kontaktkoolituse leping");
    await expect(card.getByText("Tühi rida alustab uut lõiku.")).toBeVisible();
    await expect(card.locator("[data-placeholder-chip]")).toHaveText(["+ nimi", "+ e-post", "+ koolitus", "+ toimumine", "+ hind", "+ ettemaks"]);
    const title = card.getByRole("textbox", { name: "Pealkiri (eesti keeles)", exact: true });
    const body = card.getByRole("textbox", { name: "Tekst (eesti keeles)", exact: true });
    expect(await noOverflow(page)).toBe(true);

    // typed, with the chips at the cursor: the text goes to its draft only
    await body.fill("E2E ");
    await card.locator('[data-placeholder-chip="nimi"]').click();
    await page.keyboard.insertText(" registreerub koolitusele ");
    await card.locator('[data-placeholder-chip="koolitus"]').click();
    await page.keyboard.insertText(".\n\nHind ");
    await card.locator('[data-placeholder-chip="hind"]').click();
    await page.keyboard.insertText(".");
    await expect(body).toHaveValue(BODY);
    await expect(body).toBeFocused(); // (a chip keeps the cursor in the text)
    await body.blur();
    await expect.poll(async () => (await legalDraftOf("contract_contact"))?.value.body.et, { timeout: 15_000 }).toBe(BODY);
    expect(await contactRows()).toEqual({ n: 0 });
    expect(await contactVersion()).toEqual({ v: null });
    await expect(card.locator("[data-tag-long]")).toHaveText("Avaldamata muudatus");
    await expect(page.locator('nav a[href="#lepingud"] [data-section-status]')).toHaveText(/\d+ avaldamata/);

    // the press finds the title empty: said in the field, which takes the focus; no panel
    await card.getByRole("button", { name: "Avalda uus leping", exact: true }).click();
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await expect(card.getByText("Täida see väli (eesti keeles).")).toBeVisible();
    await expect(title).toBeFocused();
    await expect(card.locator("[data-confirm-panel]")).toHaveCount(0);

    // the sample posts the screen's texts; a post without them is the draft (R-d); nothing is stored or published by it
    await title.fill(TITLE);
    const sample = card.locator("[data-contract-sample-form]");
    await expect(sample).toHaveAttribute("method", "post");
    await expect(sample).toHaveAttribute("action", "/api/admin/naidisleping");
    await expect(sample).toHaveAttribute("target", "_blank");
    await expect(sample.locator('input[name="titleEt"]')).toHaveValue(TITLE);
    await expect(sample.locator('input[name="bodyEt"]')).toHaveValue(BODY);
    await expect(sample.getByRole("button", { name: "Näidisleping (PDF)", exact: true })).toBeVisible();
    await expect(sample.getByRole("button", { name: "Näidisleping vene keeles (PDF)" })).toHaveCount(0); // no Russian text yet
    await expect(sample).toContainText("Näidis tehakse kaardi praegustest väärtustest, ka avaldamata. Midagi ei avaldata.");
    const pdf = await page.request.post("/api/admin/naidisleping", { form: { lang: "et" } });
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect(pdf.headers()["content-disposition"]).toBe('inline; filename="MS-LAB-naidisleping.pdf"');
    expect(pdf.headers()["cache-control"]).toBe("private, no-store");
    expect((await pdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(await contactRows()).toEqual({ n: 0 });

    // the Russian text makes the Russian sample available
    await editLang(page, "ru"); // (one switch for the whole page: both fields of the card, and the e-course card's too)
    await card.getByRole("textbox", { name: "Pealkiri (vene keeles)", exact: true }).fill("E2E Договор очного обучения");
    await card.getByRole("textbox", { name: "Tekst (vene keeles)", exact: true }).fill("E2E Ученик {nimi}.");
    await expect(sample.getByRole("button", { name: "Näidisleping vene keeles (PDF)", exact: true })).toBeVisible();
    await editLang(page, "et");

    // „Avalda uus leping“: the panel (S3-P3-j); „Jah, avalda“ sends what is typed first, then publishes it: a new version
    await card.getByRole("button", { name: "Avalda uus leping", exact: true }).click();
    const panel = card.locator("[data-confirm-panel]");
    await expect(panel.locator("p").first()).toHaveText("Kas avaldan uue kontaktkoolituse lepingu?");
    await expect(panel.locator("li")).toHaveText(["Uus tekst kehtib uutele registreeringutele.", "Varem kinnitatud lepingud jäävad selliseks, nagu need kinnitati."]);
    const answer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/admin/oigustekst/contract_contact/avalda");
    await panel.getByRole("button", { name: "Jah, avalda", exact: true }).click();
    expect((await answer).status()).toBe(200);
    await expect(card.locator("[data-legal-said]")).toHaveText("Uus kontaktkoolituse leping on avaldatud.");
    await expect(card.locator("[data-legal-tag]")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Avalda uus leping", exact: true })).toHaveCount(0);
    const stored = await one((sql) => sql<{ title: { et: string; ru: string }; body: { et: string; ru: string } }[]>`select title, body from pages where key = 'contract_contact'`);
    expect(stored).toEqual({ title: { et: TITLE, ru: "E2E Договор очного обучения" }, body: { et: BODY, ru: "E2E Ученик {nimi}." } });
    const version = await contactVersion();
    expect(Math.abs(Date.now() - new Date(version.v!).getTime())).toBeLessThan(120_000);
    expect(await legalDraftOf("contract_contact")).toBeNull();

    // the e-course contract (P-11 „E-koolituse leping“): its title is the contract's (ruling R3); published, a new version, its text untouched
    const ecourse = page.locator('[data-legal-editor="course_terms"]');
    await expect(ecourse.getByRole("heading", { level: 2 })).toHaveText("E-koolituse leping");
    await expect(ecourse).toContainText("Soovitus: „E-koolituse leping“.");
    await expect(ecourse.locator("[data-placeholder-chip]")).toHaveCount(6);
    const before = await one((sql) => sql<{ body: unknown; v: string | null }[]>`select body, (select value #>> '{}' from settings where key = 'courseTermsVersion') as v from pages where key = 'course_terms'`);
    await ecourse.getByRole("textbox", { name: "Pealkiri (eesti keeles)", exact: true }).fill("E2E E-koolituse leping");
    await ecourse.getByRole("button", { name: "Avalda uus leping", exact: true }).click();
    const ecoursePanel = ecourse.locator("[data-confirm-panel]");
    await expect(ecoursePanel.locator("p").first()).toHaveText("Kas avaldan uue e-koolituse lepingu?");
    // (the count of the students asked again — distinct clients with an active access, R-e — is the page's read: one line, or none at 0)
    const lines = await ecoursePanel.locator("li").allTextContents();
    expect(lines.at(-1)).toBe("Vana leping jääb alles ja märgitakse asendatuks.");
    for (const line of lines.slice(0, -1)) expect(line).toMatch(/^(\d+ aktiivset õpilast peavad|1 aktiivne õpilane peab) selle järgmisel sisselogimisel uuesti kinnitama\.$/);
    const ecourseAnswer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/admin/oigustekst/course_terms/avalda");
    await ecoursePanel.getByRole("button", { name: "Jah, avalda", exact: true }).click();
    expect((await ecourseAnswer).status()).toBe(200);
    await expect(ecourse.locator("[data-legal-said]")).toHaveText("Uus e-koolituse leping on avaldatud.");
    const after = await one((sql) => sql<{ title: { et: string }; body: unknown; v: string | null }[]>`select title, body, (select value #>> '{}' from settings where key = 'courseTermsVersion') as v from pages where key = 'course_terms'`);
    expect(after.title.et).toBe("E2E E-koolituse leping");
    expect(after.body).toEqual(before.body);
    expect(after.v).not.toBe(before.v);
  });

  test("on a phone (Part 4): the privacy text opens full screen with „Muuda teksti“ and types into its draft only; „Avalda uus tekst“ asks and publishes it in two paragraphs; the admin addresses are shown, not editable", async ({ page, context, visitorIp }, info) => {
    test.skip(!phone(info), "the phone project changes the privacy page; desktop the contracts");
    await changing(["pages", { column: "key", value: "privacy" }]);
    undo.push(await holdLegalDraft("privacy"));
    await signIn(page, context, visitorIp);
    await page.goto("/admin/seaded");
    await adminReady(page);
    const admins = page.locator("[data-admin-emails] li");
    await expect(admins).toHaveText(LOCAL_ADMINS);
    await expect(page.locator("[data-admin-emails] input")).toHaveCount(0);

    const TEXT = "E2E privaatsus, esimene lõik.\n\nTeine lõik.";
    const stored = () => one((sql) => sql<{ body: { et: string } }[]>`select body from pages where key = 'privacy'`);
    const live = (await stored()).body.et;
    const card = page.locator('[data-legal-editor="privacy"]');
    await expect(card.getByText("Pikk tekst avaneb täisekraanil.")).toBeVisible();
    await expect(card.getByRole("textbox")).toHaveCount(0); // (the fields open full screen)
    expect(await noOverflow(page)).toBe(true);
    const open = card.getByRole("link", { name: "Muuda teksti", exact: true });
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await open.click();
    await expect(page).toHaveURL(/\/admin\/seaded\?tekst=privacy$/);
    const drawer = page.getByRole("dialog", { name: "Privaatsus" });
    await expect(drawer).toBeVisible();
    const body = drawer.getByRole("textbox", { name: "Tekst (eesti keeles)", exact: true });
    await body.fill(TEXT);
    expect(await drawer.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
    await drawer.getByRole("button", { name: "Sulge" }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/\/admin\/seaded$/);
    await expect.poll(async () => (await legalDraftOf("privacy"))?.value.body.et, { timeout: 15_000 }).toBe(TEXT);
    expect((await stored()).body.et).toBe(live); // nothing live by typing
    await expect(card.locator("[data-tag-short]")).toHaveText("Avaldamata");
    await expect(card.locator("[data-tag-long]")).toBeHidden();

    // „Avalda uus tekst“ (S3-P3-k): the question, the line, „Jah, avalda“
    await card.getByRole("button", { name: "Avalda uus tekst", exact: true }).click();
    const panel = card.locator("[data-confirm-panel]");
    await expect(panel.locator("p").first()).toHaveText("Kas avaldan lehe „Privaatsus“ uue teksti?");
    await expect(panel.locator("li")).toHaveText(["Uus tekst on avalikul lehel kohe näha."]);
    expect(await noOverflow(page)).toBe(true);
    const answer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/admin/oigustekst/privacy/avalda");
    await panel.getByRole("button", { name: "Jah, avalda", exact: true }).click();
    expect((await answer).status()).toBe(200);
    await expect(card.locator("[data-legal-said]")).toHaveText("Uus tekst on avaldatud.");
    expect((await stored()).body.et).toBe(TEXT);
    expect(await legalDraftOf("privacy")).toBeNull();

    await page.goto("/privaatsus");
    await expect(page.locator("[data-legal-body] p")).toHaveText(["E2E privaatsus, esimene lõik.", "Teine lõik."]);
  });
});

test.describe("every editor at phone width", () => {
  test("no sideways scrolling, every control at least 44 px tall, no 'Tulekul'", async ({ page, context, visitorIp }, info) => {
    test.skip(!phone(info), "390 px");
    await signIn(page, context, visitorIp);
    // (a post's editor: the seed's first post; a new post is made at once now, piece 4b)
    const post = await one((sql) => sql<{ id: number }[]>`select id from posts order by published_at desc, id desc limit 1`);
    for (const path of ["/admin/avaleht", "/admin/praktika", "/admin/koolitaja", "/admin/uudised", `/admin/uudised/${post.id}`, "/admin/kampaania", "/admin/seaded"]) {
      await page.goto(path);
      if (path === "/admin/avaleht") await page.locator("[data-slide]").first().getByRole("button", { name: /^Slaid 1/ }).click();
      expect(await noOverflow(page), path).toBe(true);
      await expect(page.getByText("Tulekul", { exact: true })).toHaveCount(0);
      for (const el of await page.locator("main button:visible, main input:visible:not([type=checkbox]):not([type=radio]):not([type=file]), main select:visible, main textarea:visible").all())
        expect((await el.boundingBox())!.height, `${path}: ${await el.evaluate((e) => e.outerHTML.slice(0, 80))}`).toBeGreaterThanOrEqual(44);
    }
    // Hüpikaken's preview: the popup's card, under the offer's card at this width
    await page.goto("/admin/kampaania");
    await adminReady(page);
    await expect(page.locator("[data-newsletter-preview] [data-newsletter-card]")).toBeVisible();
    await expect(page.getByText("Mitte praegu")).toHaveCount(0);
  });
});
