import { readFileSync } from "node:fs";
import type { BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
import { test } from "./edit-lock";
import { submitsForms, expect } from "./test";
import { LOCAL_ADMINS } from "../local-secrets";
import { adminReady, editLang, saveBarButton, seadedAutosave, seadedStatus, signInAsAdmin } from "./admin-login";
import { holdContractTexts, holdLegalDraft, legalDraftOf } from "./contracts";
import { onLocalDb, POST_SLUG_PREFIX, removeAdminRows, removePostRows, snapshotRows, storedSubscriber, testEmail } from "./fixtures";
import { holdNewsletter } from "./newsletter";

// Task 13B: the site content editors (home page, practice, trainer, news, campaign, settings), each followed through to
// the public site. They change shared seed content, so they run after every other test (playwright.config.ts: the
// "chromium-edit" / "mobile-edit" projects) and put it back (fixtures.ts: row snapshots; posts "e2e-uudis-<project>-…").
// The two projects run side by side, so each changes rows the other does not: desktop MAXI, the hero slides and the
// statement, the trainer card and works, the contact settings and the campaign; phone MINI, the FAQ, the centre's story
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

const status = (page: Page) => page.locator("[data-save-status]");
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
async function save(page: Page): Promise<void> {
  await saveBarButton(page).click();
  await expect(status(page)).toHaveText("Salvestatud.");
}
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

test.describe("home page", () => {
  test("slide 1 turns dark: the header turns white on it (A9); a slide without a picture is refused; the statement", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "desktop changes the hero slides; the phone project the FAQ");
    await changing(["hero_slides"], ["pages", { column: "key", value: "statement" }]);
    await page.emulateMedia({ reducedMotion: "reduce" }); // no autoplay: slide 1 stays on screen
    await page.goto("/");
    await expect(page.locator("[data-hero]")).toHaveAttribute("data-tone", "light");
    await expect.poll(() => page.locator("header").evaluate((el) => getComputedStyle(el).color)).not.toBe("rgb(255, 255, 255)");

    await signIn(page, context, visitorIp);
    await page.goto("/admin/avaleht");
    await adminReady(page);
    const slides = page.locator("[data-slide]");
    await expect(slides).toHaveCount(5);
    // a new slide without a picture: refused, it is marked and gets the focus; nothing is saved
    await page.getByRole("button", { name: "+ Lisa slaid" }).click();
    await expect(slides).toHaveCount(6);
    await expect(slides.nth(5).getByRole("button", { name: /^Slaid 6/ })).toBeFocused();
    await slides.nth(5).getByRole("textbox", { name: "Pealkiri (eesti keeles)", exact: true }).fill("E2E slaid");
    await page.getByRole("button", { name: "Salvesta", exact: true }).click();
    await expect(status(page)).toHaveText("Kontrolli märgitud välju.");
    await expect(slides.nth(5).locator("[data-single-image]")).toBeFocused();
    await expect(slides.nth(5).getByText("Lisa pilt.")).toBeVisible();
    expect(await one((sql) => sql<{ n: number }[]>`select count(*)::int as n from hero_slides`)).toEqual({ n: 5 });
    await page.getByRole("button", { name: "Eemalda slaid 6" }).click();
    await expect(slides).toHaveCount(5);

    // slide 1: dark, with a desktop focal point
    const first = slides.nth(0);
    await first.getByRole("button", { name: /^Slaid 1/ }).click();
    await expect(first.getByRole("button", { name: /^Slaid 1/ })).toHaveAttribute("aria-expanded", "true");
    await first.getByRole("radio", { name: "Tume" }).check();
    await expect(first.locator("[data-slide-tone]")).toHaveText("Tume");
    await first.locator('[data-focal-axis="desktop-x"]').fill("30");
    await expect(first.locator('[data-focal-preview="desktop"] img')).toHaveCSS("object-position", "30% 50%");
    // a script link is refused, then a site path is accepted
    const cta = first.getByRole("combobox", { name: "Nupp viib", exact: true });
    await cta.fill("javascript:alert(1)");
    await page.getByRole("button", { name: "Salvesta", exact: true }).click();
    await expect(status(page)).toHaveText("Kontrolli märgitud välju.");
    await expect(cta).toHaveAttribute("aria-invalid", "true");
    await expect(cta).toBeFocused();
    await cta.fill("/praktika");
    const statement = page.getByRole("textbox", { name: "Lause (eesti keeles)", exact: true });
    await statement.fill("E2E lause, mis on avalehel kohe näha.");
    expect(await noOverflow(page)).toBe(true);
    await save(page);
    const stored = await one((sql) => sql<{ tone: string; pos: string; href: string }[]>`select tone, image_pos as pos, cta_href as href from hero_slides order by sort, id limit 1`);
    expect(stored).toEqual({ tone: "dark", pos: "30% 50%", href: "/praktika" });

    // the public home page, on its very next request
    await page.goto("/");
    const hero = page.locator("[data-hero]");
    await expect(hero).toHaveAttribute("data-tone", "dark");
    await expect(hero.getByText(/^01 \/ 05$/)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-hero-tone", "dark");
    await expect.poll(() => page.locator("header").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 255, 255)");
    await expect(hero.locator("[data-tone]").first()).toHaveAttribute("style", /--pos:\s*30% 50%/);
    await expect(hero.getByRole("link", { name: /Leia oma koolitus/ }).first()).toHaveAttribute("href", "/praktika");
    await expect(page.getByText("E2E lause,")).toBeVisible();
    await page.goto("/ru");
    await expect(page.locator("[data-hero] [data-tone]").first().getByRole("link").first()).toHaveAttribute("href", "/ru/praktika");
  });

  test("the trainer card's text (C26): D's line by default; edited in ET and RU it is on / and /ru (round 2 item 5)", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "desktop changes the trainer card's text; the phone project the FAQ");
    await changing(["pages", { column: "key", value: "trainer_teaser" }]);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/avaleht");
    await adminReady(page);
    const editor = page.locator("[data-teaser-editor]");
    await expect(editor.getByRole("heading", { name: "Koolitaja kaart avalehel" })).toBeVisible();
    const et = editor.getByRole("textbox", { name: "Tekst (eesti keeles)", exact: true });
    await expect(et).toHaveValue(/^Kulmu- ja ripsmetehnikate meister ja koolitaja\. Õpetan nii, nagu oleksin ise tahtnud õppida/);
    await et.fill("E2E koolitaja tekst.");
    await editLang(page, "ru");
    await editor.getByRole("textbox", { name: "Tekst (vene keeles)", exact: true }).fill("E2E текст преподавателя.");
    await save(page);
    expect(await one((sql) => sql<{ body: unknown }[]>`select body from pages where key = 'trainer_teaser'`)).toEqual({ body: { et: "E2E koolitaja tekst.", ru: "E2E текст преподавателя." } });
    await page.goto("/");
    await expect(page.locator("[data-trainer-teaser]")).toContainText("E2E koolitaja tekst.");
    await page.goto("/ru");
    await expect(page.locator("[data-trainer-teaser]")).toContainText("E2E текст преподавателя.");
  });

  test("„RU puudub“ counts the folded slides too, and „Järgmine →“ opens one and puts the cursor in its Russian field (nothing is saved)", async ({ page, context, visitorIp }) => {
    await signIn(page, context, visitorIp);
    await page.goto("/admin/avaleht");
    await adminReady(page);
    await editLang(page, "ru");
    const first = page.locator("[data-slide]:visible").first();
    const toggle = first.locator("[data-tool='toggle']");
    const line = page.locator("[data-ru-missing]:visible");
    const count = async () => Number(/(\d+) väljal/.exec((await line.textContent()) ?? "")?.[1]);
    // slide 1 opened, its Russian title emptied on the screen, and folded again: the field is gone from the page, the count still has it
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await first.locator('[data-i18n="slides.0.title"]').fill("");
    await expect(line).toBeVisible();
    const open = await count();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(first.locator("[data-lang-field]")).toHaveCount(0);
    await expect.poll(count).toBe(open);
    // „Järgmine →“: the slide opens and the cursor is in one of its Russian fields (the first missing one on the page)
    await page.locator("[data-ru-next]:visible").click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(first.locator('[data-lang-field="ru"]:focus')).toHaveCount(1);
    expect(await count()).toBe(open); // opened, its fields count once, not twice
  });

  test("FAQ: a new question in ET and RU, moved to the top; the home page shows it first", async ({ page, context, visitorIp }, info) => {
    test.skip(!phone(info), "the phone project changes the FAQ; desktop the hero slides");
    await changing(["faq"]);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/avaleht");
    await adminReady(page);
    const faq = page.locator("[data-faq-editor]");
    const rows = faq.locator("[data-faq-row]");
    const count = await rows.count();
    await faq.getByRole("button", { name: "+ Lisa küsimus" }).click();
    await expect(rows).toHaveCount(count + 1);
    const n = count + 1;
    await expect(faq.getByRole("textbox", { name: `Küsimus ${n} (eesti keeles)`, exact: true })).toBeFocused();
    const q = `E2E küsimus ${unique()}?`;
    await page.keyboard.type(q);
    await faq.getByRole("textbox", { name: `Vastus ${n} (eesti keeles)`, exact: true }).fill("E2E vastus.");
    await editLang(page, "ru");
    await faq.getByRole("textbox", { name: `Küsimus ${n} (vene keeles)`, exact: true }).fill("E2E вопрос?");
    await faq.getByRole("textbox", { name: `Vastus ${n} (vene keeles)`, exact: true }).fill("E2E ответ.");
    for (let i = n; i > 1; i--) await faq.getByRole("button", { name: `Liiguta küsimus ${i} üles` }).click();
    await expect(faq.getByRole("button", { name: "Liiguta küsimus 1 üles" })).toHaveAttribute("aria-disabled", "true");
    expect(await noOverflow(page)).toBe(true);
    await save(page);
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

test.describe("news", () => {
  test("a new post: the address from its title, a draft until published, the cover required to publish; delete", async ({ page, context, visitorIp }, info) => {
    await signIn(page, context, visitorIp);
    await page.goto("/admin/uudised");
    await adminReady(page);
    await expect(page.locator("[data-post-row]")).not.toHaveCount(0);
    await page.locator("[data-add-post]").click();
    await expect(page).toHaveURL(/\/admin\/uudised\/uus$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Uus postitus");
    const title = `E2E uudis ${info.project.name} ${unique()}`;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    expect(slug.startsWith(`${POST_SLUG_PREFIX}${info.project.name}-`)).toBe(true);
    await page.getByRole("textbox", { name: "Pealkiri (eesti keeles)", exact: true }).fill(title);
    await page.getByRole("textbox", { name: "Kategooria (eesti keeles)", exact: true }).fill("Uudis");
    await page.getByRole("textbox", { name: "Tekst (eesti keeles)", exact: true }).fill("Esimene lõik.\n\nTeine lõik.");
    await page.getByRole("button", { name: "Salvesta", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/uudised\/\d+\?loodud=1$/);
    const editor = new URL(page.url()).pathname;
    await expect(page.getByText("Postitus loodud.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Aadress", exact: true })).toHaveValue(slug);
    await expect(page.locator("[data-post-state]")).toHaveText("Mustand");
    expect((await page.goto(`/uudised/${slug}`))!.status()).toBe(404);

    await page.goto(editor);
    await page.getByRole("checkbox", { name: "Avaldatud" }).check();
    await page.getByRole("button", { name: "Salvesta", exact: true }).click();
    await expect(status(page)).toHaveText("Kontrolli märgitud välju.");
    await expect(page.locator('[data-single-image="cover"]')).toBeFocused();
    await expect(page.getByText("Lisa pilt.")).toBeVisible();
    const cover = page.locator('[data-single-image="cover"]');
    await cover.locator('input[type="file"]').setInputFiles([jpeg("brow-closeup.jpg")]);
    await expect(cover.locator("[data-upload-status]")).toHaveText("Pilt lisatud.");
    expect(await noOverflow(page)).toBe(true);
    await save(page);
    await expect(page.locator("[data-post-state]")).toHaveText("Avaldatud");
    const row = await one((sql) => sql<{ cover: string; published: boolean }[]>`select cover_key as cover, published from posts where slug = ${slug}`);
    expect(row.published).toBe(true);
    expect(row.cover).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);

    await page.goto("/uudised");
    await expect(page.locator(`[data-news-card][href="/uudised/${slug}"]`)).toContainText(title);
    await page.goto(`/uudised/${slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.locator("[data-article-body] p")).toHaveText(["Esimene lõik.", "Teine lõik."]);
    await expect(page.locator("[data-article-cover] img")).toHaveAttribute("src", `/media/${row.cover}`);

    await page.goto(editor);
    await page.getByRole("button", { name: "Kustuta postitus" }).click();
    await page.getByRole("button", { name: "Jah, kustuta" }).click();
    await expect(page).toHaveURL(/\/admin\/uudised\?kustutatud=1$/);
    await expect(page.getByText("Postitus kustutatud.")).toBeVisible();
    expect((await page.goto(`/uudised/${slug}`))!.status()).toBe(404);
  });
});

test.describe("campaign (M2–M5)", () => {
  // The home page popup (Task 14) is followed here too: these tests change the campaign row, which the popup tests of
  // campaign.spec.ts read, so they run in this file's late projects. A short delay instead of the site's 6 s.
  test.use({ campaignPopup: 300 });

  test("the uploaded image is stored, /media serves it and the admin preview shows it; a script link is refused", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "one campaign: desktop changes it; the phone project only looks (next test)");
    await changing(["campaign"]);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/kampaania");
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hüpikaken");
    const camp = page.locator('[data-popup-section="campaign"]'); // the page has two editors: the campaign's fields
    const preview = page.locator("[data-campaign-preview]");
    await expect(preview.getByRole("heading")).toHaveText("−15% Lash Lift BOTOX koolitusele");
    await expect(page.getByText("Mitte praegu")).toHaveCount(0); // M3
    await expect(preview.locator("[data-campaign-card] a")).toHaveText("Leia enda koolitus"); // M4

    const image = page.locator('[data-single-image="campaign"]');
    await image.locator('input[type="file"]').setInputFiles([jpeg("gift-bag-serum.jpg")]);
    await expect(image.locator("[data-upload-status]")).toHaveText("Pilt lisatud.");
    const src = await image.locator("[data-current-image]").getAttribute("data-current-image");
    expect(src).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
    await expect(preview.locator("img")).toHaveAttribute("src", `/media/${src}`);
    // the texts follow in the preview, ET and RU
    await camp.getByRole("textbox", { name: "Pealkiri (eesti keeles)", exact: true }).fill("E2E kampaania");
    await expect(preview.getByRole("heading")).toHaveText("E2E kampaania");
    await camp.getByRole("textbox", { name: "Sooduskood", exact: true }).fill("e2e-10");
    await expect(preview.locator("[data-campaign-code]")).toHaveText("E2E-10");
    // a script link: refused, nothing saved
    const href = camp.getByRole("combobox", { name: "Nupp viib", exact: true });
    await href.fill("javascript:alert(1)");
    await page.getByRole("button", { name: "Salvesta", exact: true }).click();
    await expect(status(page)).toHaveText("Kontrolli märgitud välju.");
    await expect(href).toBeFocused();
    expect(await one((sql) => sql<{ image: string }[]>`select image_key as image from campaign where id = 1`)).toEqual({ image: "/seed/lash-editorial.jpg" });
    await href.fill("/koolitused/lash-lift-botox");
    // an empty button text in both languages: "Leia enda koolitus" (M4); the seed's Russian text is cleared too
    await camp.getByRole("textbox", { name: "Nupu tekst (eesti keeles)", exact: true }).fill("");
    await editLang(page, "ru");
    await camp.getByRole("textbox", { name: "Nupu tekst (vene keeles)", exact: true }).fill("");
    await save(page);

    const stored = await one((sql) => sql<{ image: string; code: string; cta: { et: string }; title: { et: string } }[]>`select image_key as image, code, cta_label as cta, title from campaign where id = 1`);
    expect(stored).toEqual({ image: src, code: "E2E-10", cta: { et: "Leia enda koolitus" }, title: { et: "E2E kampaania", ru: "−15% на курс Lash Lift BOTOX" } });
    const media = await page.request.get(`/media/${src}`);
    expect(media.status()).toBe(200);
    expect(media.headers()["content-type"]).toBe("image/jpeg");
    // after a reload the preview still shows the stored image
    await page.reload();
    await expect(page.locator("[data-campaign-preview] img")).toHaveAttribute("src", `/media/${src}`);
    await expect(page.locator("[data-campaign-preview] [data-campaign-card] a")).toHaveText("Leia enda koolitus");

    // the popup on the home page shows the uploaded picture and the saved texts (M1, M5)
    await page.goto("/");
    const popup = page.getByRole("dialog", { name: "E2E kampaania" });
    await expect(popup).toBeVisible();
    const picture = popup.locator("[data-campaign-card] img");
    await expect(picture).toHaveAttribute("src", `/media/${src}`);
    await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0); // R2 served it
    await expect(popup.locator("[data-campaign-code]")).toHaveText("E2E-10");
    await expect(popup.getByRole("link", { name: "Leia enda koolitus" })).toHaveAttribute("href", "/koolitused/lash-lift-botox");
    await expect(popup.getByText("Mitte praegu")).toHaveCount(0);
  });

  test("a switched-off campaign shows no popup; switched on again, it does", async ({ page }, info) => {
    test.skip(phone(info), "one campaign: desktop changes it");
    await changing(["campaign"]);
    await onLocalDb((sql) => sql`update campaign set active = false where id = 1`);
    for (const path of ["/", "/ru"]) {
      await page.goto(path);
      await page.waitForTimeout(1500);
      await expect(page.getByRole("dialog"), path).toHaveCount(0);
      expect(await page.evaluate(() => sessionStorage.getItem("mslab-camp")), path).toBeNull();
    }
    await onLocalDb((sql) => sql`update campaign set active = true where id = 1`);
    await page.goto("/");
    await expect(page.getByRole("dialog", { name: "−15% Lash Lift BOTOX koolitusele" })).toBeVisible();
  });
});

test.describe("the newsletter popup (phase 2c)", () => {
  test.use({ campaignPopup: 300 });

  /** The space between the bottom of a text and the top of the form under it, in px. */
  const gapAboveForm = async (text: Locator, form: Locator) => {
    const [t, f] = [await text.boundingBox(), await form.boundingBox()];
    return f!.y - (t!.y + t!.height);
  };

  /** The newsletter popup shown instead of the campaign (at most one active: the campaign first goes off). */
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
    await page.evaluate(() => sessionStorage.removeItem("mslab-camp")); // a new browser session …
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
    expect(await page.evaluate(() => sessionStorage.getItem("mslab-camp"))).toBeNull(); // the popup did not use up the session's turn either
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

  test("Russian, at a phone's width: the sheet with the form fits (no overflow, 44 px targets); the campaign is not shown meanwhile; switched off, none", async ({ page }, info) => {
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
    await expect(page.getByRole("dialog", { name: "−15% на курс Lash Lift BOTOX" })).toHaveCount(0);
    await onLocalDb((sql) => sql`update campaign set active = false`);
    await page.evaluate(() => sessionStorage.removeItem("mslab-camp"));
    await page.goto("/");
    await page.waitForTimeout(1200);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("Hüpikaken: 'Lehel näidatakse' Uudiskiri, its texts and the preview, saved; the home page shows it; Väljas shows none", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "one popup row: desktop changes it");
    await changing(["campaign"]);
    await signIn(page, context, visitorIp);
    await page.goto("/admin/kampaania");
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hüpikaken");
    const shown = page.getByRole("group", { name: "Lehel näidatakse" });
    await expect(shown.getByRole("radio", { name: "Kampaania" })).toBeChecked();
    await shown.getByRole("radio", { name: "Uudiskiri" }).check();
    const nl = page.locator('[data-popup-section="newsletter"]');
    await nl.getByRole("textbox", { name: "Pealkiri (eesti keeles)", exact: true }).fill("E2E uudiskiri");
    const preview = page.locator("[data-newsletter-preview]");
    await expect(preview.getByRole("heading")).toHaveText("E2E uudiskiri");
    await expect(preview.getByRole("button", { name: "Liitu" })).toBeVisible();
    await expect(page.locator("[data-campaign-editor] form")).toHaveCount(0); // the preview's form is a picture: no form inside the editor's
    // the picture is as tall as the popup: the same gap above the form, and the privacy word (a span, not a link) makes the line 44 px high like the link
    await expect.poll(() => gapAboveForm(preview.getByText("Uued koolitused, kasulikud mõtted"), preview.locator("[data-newsletter-form]"))).toBeCloseTo(18, 0);
    await expect(preview.locator("[data-newsletter-notice] a")).toHaveCount(0);
    expect((await preview.locator("[data-newsletter-notice]").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await save(page);
    const rows = await onLocalDb((sql) => sql<{ id: number; active: boolean }[]>`select id, active from campaign order by id`);
    expect(rows.map((r) => r.active)).toEqual([false, true]);
    await page.goto("/");
    await expect(page.getByRole("dialog", { name: "E2E uudiskiri" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/admin/kampaania");
    await adminReady(page);
    await page.getByRole("group", { name: "Lehel näidatakse" }).getByRole("radio", { name: "Väljas" }).check();
    await save(page);
    expect((await onLocalDb((sql) => sql<{ active: boolean }[]>`select active from campaign order by id`)).map((r) => r.active)).toEqual([false, false]);
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

  test("contact links (https only) and the newsletter discount autosave (no „Salvesta“) and reach the footer and the contact page", async ({ page, context, visitorIp }, info) => {
    test.skip(phone(info), "desktop changes the contact settings; the phone project the privacy page");
    await changing(["settings", { column: "key", value: "contact" }], ["settings", { column: "key", value: "newsletter" }]);
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
    await phoneField.fill("+372 5555 0199");
    await phoneField.press("Tab");
    const discount = page.getByRole("textbox", { name: "Tervitussoodustus", exact: true });
    const saved = await seadedAutosave(page, "newsletter", async () => {
      await discount.fill("15%");
      await discount.press("Tab");
    });
    expect(saved.status()).toBe(200);
    await expect(seadedStatus(page)).toHaveAttribute("data-save-kind", "saved");
    await expect.poll(async () => (await stored()).value).toMatchObject({ instagram: "https://www.instagram.com/mslab.e2e", phone: "+372 5555 0199" });

    await page.goto("/");
    const footer = page.locator("footer");
    await expect(footer.getByRole("link", { name: /Instagram/ })).toHaveAttribute("href", "https://www.instagram.com/mslab.e2e");
    await expect(footer.getByRole("link", { name: "+372 5555 0199" })).toHaveAttribute("href", "tel:+37255550199");
    await expect(footer.getByText(/15% tervitussoodustus/)).toBeVisible();
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
    for (const path of ["/admin/avaleht", "/admin/praktika", "/admin/koolitaja", "/admin/uudised", "/admin/uudised/uus", "/admin/kampaania", "/admin/seaded"]) {
      await page.goto(path);
      if (path === "/admin/avaleht") await page.locator("[data-slide]").first().getByRole("button", { name: /^Slaid 1/ }).click();
      expect(await noOverflow(page), path).toBe(true);
      await expect(page.getByText("Tulekul", { exact: true })).toHaveCount(0);
      for (const el of await page.locator("main button:visible, main input:visible:not([type=checkbox]):not([type=radio]):not([type=file]), main select:visible, main textarea:visible").all())
        expect((await el.boundingBox())!.height, `${path}: ${await el.evaluate((e) => e.outerHTML.slice(0, 80))}`).toBeGreaterThanOrEqual(44);
    }
    // the campaign preview: the card, D's wording, no "Mitte praegu"
    await page.goto("/admin/kampaania");
    await adminReady(page);
    await expect(page.locator("[data-campaign-preview] [data-campaign-card]")).toBeVisible();
    await expect(page.getByText("Mitte praegu")).toHaveCount(0);
  });
});
