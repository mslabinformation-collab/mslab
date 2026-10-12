import { readFileSync } from "node:fs";
import type { BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
import { submitsForms, test, expect } from "./test";
import { adminReady, signInAsAdmin } from "./admin-login";
import {
  courseOrder,
  EDIT_CITY_PREFIX,
  insertEditSession,
  NEW_COURSE_SLUG_PREFIX,
  onLocalDb,
  registerOnSession,
  removeAdminRows,
  removeEditRows,
  restoreCourse,
  snapshotCourse,
  snapshotOrder,
  storedCourse,
  storedSession,
} from "./fixtures";
import { laterSaturday } from "./seed-sessions";

// Task 13A: the course editor, the badge editor, the image upload and the admin calendar, each followed through to the
// public site. These tests change real seed content (a title, a badge, the gallery, the order, sessions of a seed
// course), so they run after every other test (playwright.config.ts: the "chromium-edit" / "mobile-edit" projects) and
// put everything back (fixtures.ts: course snapshots, "E2E …" sessions). The two projects run side by side, so each has
// its own course and its own session cities. Local dev server only: they sign in as Dim through the devLink.

const created = { tokens: new Set<string>(), sessions: new Set<string>() };
const undo: (() => Promise<unknown>)[] = [];

/** Each project edits its own seed course (both e-learning, neither has a badge in the seed). */
const mine = (info: TestInfo) =>
  info.project.name.startsWith("mobile")
    ? { slug: "ripsmete-laminatsiooni-alused", title: "Ripsmete laminatsiooni alused", price: "150" }
    : { slug: "kulmukuju-ja-summeetria", title: "Kulmukuju ja sümmeetria", price: "95" };
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

test.beforeEach(({ page }) => {
  submitsForms();
  // leaving the editor with unsaved changes asks first (beforeunload): the tests always leave
  page.on("dialog", (d) => void d.accept());
});

test.afterEach(async ({}, info) => {
  for (const step of undo.splice(0).reverse()) await step();
  await removeAdminRows({ tokens: created.tokens, sessions: created.sessions }).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
  expect(await removeEditRows(info.project.name)).toBe(0);
});

/** Saves the course and registers its restore for after the test. */
async function changing(slug: string): Promise<number> {
  const id = await snapshotCourse(slug);
  undo.push(() => restoreCourse(id));
  return id;
}

/** Signs in as Dim through the devLink, under the login lock shared by all workers (admin-login.ts); lands on /admin. */
const signIn = (page: Page, context: BrowserContext, ip: string) => signInAsAdmin(page, context, ip, created);

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const status = (page: Page) => page.locator("[data-save-status]");

async function save(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Salvesta", exact: true }).click();
  await expect(status(page)).toHaveText("Salvestatud.");
}

/** The course's card in the public catalogue. */
const publicCard = (page: Page, slug: string, prefix = ""): Locator => page.locator(`[data-course-card][href="${prefix}/koolitused/${slug}"]`);

test.describe("course editor", () => {
  test("the ET title edited in the admin is on the public course page and card; RU falls back, then gets its own", async ({ page, context, visitorIp }, info) => {
    const c = mine(info);
    const id = await changing(c.slug);
    // the seed has a Russian title now (round 2): this test starts from a course without one (put back afterwards)
    await onLocalDb((sql) => sql`update courses set title = jsonb_build_object('et', title->>'et') where slug = ${c.slug}`);
    const before = await storedCourse(c.slug);
    await signIn(page, context, visitorIp);

    await page.goto("/admin/koolitused");
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Koolitused");
    const row = page.locator(`[data-course-row="${c.slug}"]`);
    await expect(row.locator("[data-course-state]")).toHaveText("Avaldatud");
    await expect(row.locator("[data-sample]")).toHaveText("Näidis");
    expect(await noOverflow(page)).toBe(true);
    await row.getByRole("link", { name: `Muuda: ${c.title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/koolitused/${id}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(c.title);
    await expect(page.locator("[data-course-editor] [data-sample]")).toHaveText("Näidis");
    await expect(page.getByRole("link", { name: /Vaata lehel/ })).toHaveAttribute("href", `/koolitused/${c.slug}`);

    const title = page.getByRole("textbox", { name: "Koolituse nimi (eesti keeles)" });
    await expect(title).toHaveValue(c.title);
    await expect(status(page)).toHaveText("");
    const newTitle = `${c.title} · E2E ${unique()}`;
    await title.fill(newTitle);
    await expect(status(page)).toHaveText("Salvestamata muudatused");
    await save(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(newTitle);
    const after = await storedCourse(c.slug);
    expect(after.title).toEqual({ et: newTitle });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.images).toEqual(before.images);
    expect(await noOverflow(page)).toBe(true);

    // the public site, on its very next request
    await page.goto(`/koolitused/${c.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(newTitle);
    await expect(page).toHaveTitle(new RegExp(newTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await page.goto("/koolitused");
    await expect(publicCard(page, c.slug).getByRole("heading")).toHaveText(newTitle);
    await page.goto(`/ru/koolitused/${c.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(newTitle); // no Russian title yet: the Estonian one

    // the Russian title: the RU tab shows the ET text as its placeholder and "tõlge tulekul" until it is written
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);
    const langs = page.getByRole("group", { name: "Keel: Koolituse nimi" });
    await expect(langs.getByRole("button", { name: /RU/ })).toContainText("tõlge tulekul");
    await langs.getByRole("button", { name: /RU/ }).click();
    await expect(langs.getByRole("button", { name: /RU/ })).toHaveAttribute("aria-pressed", "true");
    const ru = page.getByRole("textbox", { name: "Koolituse nimi (vene keeles)" });
    await expect(ru).toHaveAttribute("placeholder", newTitle);
    await ru.fill("Форма бровей E2E");
    await expect(langs.getByRole("button", { name: /RU/ })).not.toContainText("tõlge tulekul");
    await save(page);
    expect((await storedCourse(c.slug)).title).toEqual({ et: newTitle, ru: "Форма бровей E2E" });
    await page.goto(`/ru/koolitused/${c.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Форма бровей E2E");
    await page.goto(`/koolitused/${c.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(newTitle);
  });

  test("badge 'Uus' in Orhidee (D badge editor): the live card preview, then the public card; 'Puudub' takes it off", async ({ page, context, visitorIp }, info) => {
    const c = mine(info);
    const id = await changing(c.slug);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);

    const editor = page.locator("[data-badge-editor]");
    await expect(editor.getByRole("heading", { name: "Koolituse märgis" })).toBeVisible();
    await expect(editor.getByRole("button", { name: "Puudub" })).toHaveAttribute("aria-pressed", "true");
    const preview = editor.locator("[data-badge-preview] [data-course-card]");
    await expect(preview).toContainText(c.title); // the real course card, with this course's data
    await expect(preview.getByText("Uus", { exact: true })).toHaveCount(0);

    await editor.getByRole("button", { name: "Uus", exact: true }).click();
    await editor.getByRole("button", { name: "Orhidee" }).click();
    await expect(editor.getByRole("button", { name: "Orhidee" })).toHaveAttribute("aria-pressed", "true");
    const own = editor.getByLabel("Oma tekst (kuni 18 märki)");
    await expect(own).toHaveValue("Uus");
    await expect(own).toHaveAttribute("maxlength", "18");
    const ownRu = editor.getByLabel("Tekst vene keeles (kuni 18 märki)");
    await expect(ownRu).toHaveValue("Новинка"); // the quick label brings its Russian text (round 2 item 1c)
    const previewBadge = preview.getByText("Uus", { exact: true });
    await expect(previewBadge).toHaveCSS("background-color", "rgb(221, 212, 220)");
    await expect(previewBadge).toHaveCSS("color", "rgb(34, 34, 34)");
    for (const b of await editor.locator("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await save(page);
    expect((await storedCourse(c.slug)).badge).toEqual({ label: { et: "Uus", ru: "Новинка" }, bg: "#DDD4DC", fg: "#222222" });

    await page.goto("/koolitused");
    const badge = publicCard(page, c.slug).getByText("Uus", { exact: true });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveCSS("background-color", "rgb(221, 212, 220)");
    await expect(badge).toHaveCSS("color", "rgb(34, 34, 34)");
    await page.goto(`/koolitused/${c.slug}`);
    await expect(page.locator("[data-course-tags]").getByText("Uus", { exact: true })).toBeVisible();
    await page.goto(`/ru/koolitused/${c.slug}`);
    await expect(page.locator("[data-course-tags]").getByText("Новинка", { exact: true })).toBeVisible();
    await page.goto("/ru/koolitused");
    await expect(publicCard(page, c.slug, "/ru").getByText("Новинка", { exact: true })).toBeVisible();
    await page.goto("/admin/koolitused");
    await adminReady(page);
    await expect(page.locator(`[data-course-row="${c.slug}"] [data-badge]`)).toHaveText("Uus");

    // an own text in Ploom, then none at all
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);
    await own.fill("Sügise hitt");
    await expect(ownRu).toHaveValue(""); // the preset's Russian text went with the preset
    await ownRu.fill("Хит осени");
    await editor.getByRole("button", { name: "Tuhkroos" }).click();
    await expect(preview.getByText("Sügise hitt", { exact: true })).toHaveCSS("color", "rgb(34, 34, 34)"); // ink on rose: AA
    await editor.getByRole("button", { name: "Ploom" }).click();
    await expect(preview.getByText("Sügise hitt", { exact: true })).toHaveCSS("background-color", "rgb(107, 79, 92)");
    await expect(editor.getByRole("button", { name: "Uus", exact: true })).toHaveAttribute("aria-pressed", "false");
    await save(page);
    expect((await storedCourse(c.slug)).badge).toEqual({ label: { et: "Sügise hitt", ru: "Хит осени" }, bg: "#6B4F5C", fg: "#ffffff" });
    await editor.getByRole("button", { name: "Puudub" }).click();
    await expect(own).toHaveValue("");
    await expect(ownRu).toBeDisabled();
    await expect(preview.getByText("Sügise hitt")).toHaveCount(0);
    await save(page);
    expect((await storedCourse(c.slug)).badge).toBeNull();
    await page.goto("/koolitused");
    await expect(publicCard(page, c.slug).getByText("Uus", { exact: true })).toHaveCount(0);
  });

  test("the type switch shows only that type's fields; a published course without a price is refused, nothing saved", async ({ page, context, visitorIp }, info) => {
    const c = mine(info);
    const id = await changing(c.slug);
    const before = await storedCourse(c.slug);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);

    // e-learning: price, access, videos, discount — no group / individual price, duration or includes
    const typeSwitch = page.locator("[data-type-switch]");
    await expect(typeSwitch.getByRole("radio", { name: "E-õpe" })).toBeChecked();
    await expect(page.getByLabel("Hind (€)")).toHaveValue(c.price);
    // (text fields by role: an ET / RU switch is labelled "Keel: <field>", which getByLabel would find too)
    const field = (name: string | RegExp) => page.getByRole("textbox", { name, exact: typeof name === "string" });
    for (const name of ["Ligipääs (kuud)", "Videotunde", /^Soodustus järgmiselt koolituselt/]) await expect(field(name)).toHaveCount(1);
    for (const name of ["Grupikoolituse hind (€)", "Individuaalkoolituse hind (€)", /^Kestus/]) await expect(field(name)).toHaveCount(0);
    await expect(page.locator('[data-list-editor="includes"]')).toHaveCount(0);
    await expect(page.locator("[data-protocol-stages]")).toHaveCount(0); // "Protokolli punktid" are a contact course's only
    await expect(page.getByText(/hübriid/i)).toHaveCount(0); // no third type anywhere

    await typeSwitch.getByRole("radio", { name: "Kontaktõpe" }).check();
    for (const name of ["Grupikoolituse hind (€)", "Individuaalkoolituse hind (€)", /^Kestus/]) await expect(field(name)).toHaveCount(1);
    for (const name of ["Hind (€)", "Ligipääs (kuud)", "Videotunde", /^Soodustus/]) await expect(field(name)).toHaveCount(0);
    await expect(page.locator('[data-list-editor="includes"] h3')).toHaveText("Koolitus sisaldab");
    await expect(page.locator("[data-protocol-stages] h3")).toHaveText("Protokolli punktid");
    await typeSwitch.getByRole("radio", { name: "E-õpe" }).check();
    await expect(page.getByLabel("Hind (€)")).toHaveValue(c.price); // switching back keeps what was there

    // published without a price: the field is marked and gets the focus; the database is untouched
    await page.getByLabel("Hind (€)").fill("");
    await page.getByRole("button", { name: "Salvesta", exact: true }).click();
    await expect(status(page)).toHaveText("Kontrolli märgitud välju.");
    await expect(page.getByLabel("Hind (€)")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Hind (€)")).toBeFocused();
    await expect(page.getByText("Avaldatud koolitusel peab olema hind.")).toBeVisible();
    const after = await storedCourse(c.slug);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  test("a contact course with sessions keeps its type: E-õpe is disabled and explained; every radio and checkbox has a name", async ({ page, context, visitorIp }) => {
    const booked = await storedCourse("kulmumeistri-baaskoolitus"); // seed sessions point to it
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${booked.id}`);
    await adminReady(page);
    const typeSwitch = page.locator("[data-type-switch]");
    await expect(typeSwitch.getByRole("radio", { name: "Kontaktõpe", exact: true })).toBeChecked();
    await expect(typeSwitch.getByRole("radio", { name: "E-õpe", exact: true })).toBeDisabled();
    await expect(page.locator("[data-type-hint]")).toHaveText(/Sellel koolitusel on toimumisi või registreerimisi/);
    // names from the visible text, never the input's value ("on")
    const tree = await page.locator("[data-course-editor]").ariaSnapshot();
    expect(tree).not.toMatch(/(radio|checkbox) "on"/);
    for (const name of ['radio "Baaskoolitus"', 'radio "Täiendkoolitus"', 'radio "E-õpe"', 'radio "Kontaktõpe"', 'checkbox "Avaldatud"', 'checkbox "Näidissisu"', 'checkbox "Lash Lift BOTOX baaskoolitus"'])
      expect(tree, name).toContain(name);
    await expect(page.getByRole("checkbox", { name: "Avaldatud", exact: true })).toHaveAccessibleDescription(/Avaldatud koolitus on avalikul lehel nähtav/);
    // the badge's presets and swatches are named buttons
    for (const name of ["Puudub", "Uus", "Tint", "Orhidee", "Tuhkroos", "Ploom", "Hele"])
      await expect(page.locator("[data-badge-editor]").getByRole("button", { name, exact: true })).toHaveCount(1);
  });

  test("lists (ET/RU rows, ↑ ↓, add, remove) are saved in their order", async ({ page, context, visitorIp }, info) => {
    const c = mine(info);
    const id = await changing(c.slug);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);
    const outcomes = page.locator('[data-list-editor="outcomes"]');
    const rows = outcomes.locator("[data-row]");
    const count = await rows.count();
    const first = await rows.nth(0).locator("[data-lang-field]").inputValue();
    const second = await rows.nth(1).locator("[data-lang-field]").inputValue();
    // ↑ is aria-disabled on the first row, ↓ on the last; the focus stays on the moved row's button
    await expect(outcomes.getByRole("button", { name: "Liiguta rida 1 üles" })).toHaveAttribute("aria-disabled", "true");
    await expect(outcomes.getByRole("button", { name: `Liiguta rida ${count} alla` })).toHaveAttribute("aria-disabled", "true");
    await outcomes.getByRole("button", { name: "Liiguta rida 2 üles" }).click();
    await expect(rows.nth(0).locator("[data-lang-field]")).toHaveValue(second);
    await expect(rows.nth(1).locator("[data-lang-field]")).toHaveValue(first);
    await outcomes.getByRole("button", { name: "Lisa rida" }).click();
    await expect(rows).toHaveCount(count + 1);
    await expect(rows.nth(count).locator("[data-lang-field]")).toBeFocused();
    await page.keyboard.type("E2E õpiväljund");
    await outcomes.getByRole("button", { name: /^RU/ }).click();
    await rows.nth(count).locator("[data-lang-field]").fill("E2E результат");
    await outcomes.getByRole("button", { name: "ET", exact: true }).click();
    await outcomes.getByRole("button", { name: "Eemalda rida 3" }).click();
    await expect(rows).toHaveCount(count);
    await save(page);

    await page.goto(`/koolitused/${c.slug}`);
    const items = page.locator("[data-outcomes] li");
    await expect(items).toHaveCount(count);
    await expect(items.nth(0)).toContainText(second);
    await expect(items.nth(1)).toContainText(first);
    await expect(items.last()).toContainText("E2E õpiväljund");
    await page.goto(`/ru/koolitused/${c.slug}`);
    await expect(page.locator("[data-outcomes] li").last()).toContainText("E2E результат");
  });

  test("gallery: upload (resized, without camera data), reorder, describe; the public page and /media show it", async ({ page, context, visitorIp, isMobile }, info) => {
    const c = mine(info);
    const id = await changing(c.slug);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);
    const gallery = page.locator("[data-gallery-editor]");
    const items = gallery.locator("[data-gallery-item]");
    const before = await items.count();

    // a JPEG with an EXIF block that carries a marker (stands for a camera's GPS position), and a PNG
    const marker = "MSLAB-E2E-GPS-MARKER";
    const jpeg = readFileSync("public/seed/course-manual.jpg");
    const tiff = Buffer.concat([Buffer.from("II*\0", "latin1"), Buffer.from([8, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from(marker)]);
    const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif]);
    const withExif = Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
    expect(withExif.includes(marker)).toBe(true);
    await gallery.locator('input[type="file"]').setInputFiles([
      { name: "IMG_20260930_Liis.jpg", mimeType: "image/jpeg", buffer: withExif },
      { name: "lill.png", mimeType: "image/png", buffer: readFileSync("public/seed/flower-hero.png") },
    ]);
    await expect(gallery.locator("[data-upload-status]")).toHaveText("Lisatud 2 pilti.");
    await expect(items).toHaveCount(before + 2);
    const keys = await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-gallery-item")!));
    const [jpgKey, pngKey] = keys.slice(before);
    expect(jpgKey).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
    expect(pngKey).toMatch(/^img\/[0-9a-f-]{36}\.(webp|png)$/); // PNG becomes WebP where the browser can write it

    // /media: the stored bytes are a JPEG without the EXIF block, with the image headers
    const media = await page.request.get(`/media/${jpgKey}`);
    expect(media.status()).toBe(200);
    expect(media.headers()["content-type"]).toBe("image/jpeg");
    expect(media.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(media.headers()["x-content-type-options"]).toBe("nosniff");
    expect(media.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect(media.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox"); // the route's own, not every page's
    // Vercel's CDN keeps it as long as the browser does, so a repeat never reaches the function (server/media.ts)
    expect(media.headers()["vercel-cdn-cache-control"]).toBe("public, max-age=31536000, immutable");
    const body = await media.body();
    expect([...body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(body.includes(marker)).toBe(false);
    expect(body.includes("Exif")).toBe(false);
    expect((await page.request.get(`/media/${jpgKey.replace(".jpg", ".svg")}`)).status()).toBe(404);
    expect((await page.request.get("/media/img/../secret")).status()).toBe(404);

    // the new JPEG becomes the main picture: dragged with a mouse, ↑ on a phone
    const last = items.nth(before);
    if (isMobile) {
      for (let n = before + 1; n > 1; n--) await gallery.getByRole("button", { name: `Liiguta pilt ${n} ettepoole` }).click();
    } else {
      // both pictures on screen: a drag cannot scroll the page on its way
      const size = page.viewportSize()!;
      await page.setViewportSize({ width: size.width, height: 2400 });
      await items.nth(0).scrollIntoViewIfNeeded();
      await last.locator("img").dragTo(items.nth(0).locator("img"));
      await page.setViewportSize(size);
    }
    await expect(items.nth(0)).toHaveAttribute("data-gallery-item", jpgKey);
    await expect(items.nth(0)).toContainText("Põhipilt");
    await items.nth(0).getByRole("textbox", { name: "Pildi kirjeldus (eesti keeles)" }).fill("E2E õppematerjal");
    // the PNG goes again
    const pngIndex = (await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-gallery-item")))).indexOf(pngKey);
    await gallery.getByRole("button", { name: `Eemalda pilt ${pngIndex + 1}` }).click();
    await expect(items).toHaveCount(before + 1);
    await save(page);
    const stored = await storedCourse(c.slug);
    expect(stored.images[0]).toBe(jpgKey);
    expect(stored.images).not.toContain(pngKey);

    await page.goto(`/koolitused/${c.slug}`);
    await expect(page.locator("[data-gallery-main] img")).toHaveAttribute("src", `/media/${jpgKey}`);
    await expect(page.locator("[data-gallery-main]")).toHaveAttribute("aria-label", /E2E õppematerjal/);
    await page.goto("/koolitused");
    await expect(publicCard(page, c.slug).locator("img")).toHaveAttribute("src", `/media/${jpgKey}`);
  });

  test("a second pick while an upload runs is queued and announced, not dropped; the file field is reset", async ({ page, context, visitorIp }, info) => {
    const c = mine(info);
    const id = await changing(c.slug);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);
    // every upload answer waits a little, so the second pick surely comes while the first is still running
    await page.route("**/api/admin/upload", async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });
    const gallery = page.locator("[data-gallery-editor]");
    const items = gallery.locator("[data-gallery-item]");
    const before = await items.count();
    const input = gallery.locator('input[type="file"]');
    const jpeg = (name: string) => ({ name, mimeType: "image/jpeg", buffer: readFileSync(`public/seed/${name}`) });
    await input.setInputFiles([jpeg("certificate-white.jpg")]);
    await expect(gallery.locator('[data-upload-status="busy"]')).toBeVisible();
    await input.setInputFiles([jpeg("gift-bag-serum.jpg")]);
    await expect(gallery.locator("[data-upload-status]")).toHaveText("Lisasin järjekorda 1 pilti (kokku 2).");
    await expect(input).toHaveValue("");
    await expect(gallery.locator("[data-upload-status]")).toHaveText("Lisatud 2 pilti.", { timeout: 15_000 });
    await expect(items).toHaveCount(before + 2);
    const keys = await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-gallery-item")!));
    for (const key of keys.slice(before)) expect(key).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
    await expect(input).toHaveValue("");
  });

  test("the upload answers the admin can be told apart: no image store set up (503 storage), a body Vercel itself refuses (413 without our JSON)", async ({ page, context, visitorIp }, info) => {
    const c = mine(info);
    const id = await changing(c.slug);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);
    const gallery = page.locator("[data-gallery-editor]");
    const items = gallery.locator("[data-gallery-item]");
    const before = await items.count();
    const input = gallery.locator('input[type="file"]');
    const status = gallery.locator("[data-upload-status]");
    const jpeg = { name: "certificate-white.jpg", mimeType: "image/jpeg", buffer: readFileSync("public/seed/certificate-white.jpg") };
    // our own 503 for production without the R2 variables
    await page.route("**/api/admin/upload", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "storage" }) }));
    await input.setInputFiles([jpeg]);
    await expect(status).toHaveText("Piltide salvestamine pole seadistatud — anna arendajale teada.");
    await expect(status).toHaveAttribute("data-upload-status", "error");
    // Vercel's platform answer to a request body over 4.5 MB: a 413 with a plain body, not our JSON
    await page.unroute("**/api/admin/upload");
    await page.route("**/api/admin/upload", (route) => route.fulfill({ status: 413, contentType: "text/plain", body: "Request Entity Too Large" }));
    await input.setInputFiles([jpeg]);
    await expect(status).toHaveText("Pilt on liiga suur (kuni 4 MB).");
    // any other 503 is the generic message
    await page.unroute("**/api/admin/upload");
    await page.route("**/api/admin/upload", (route) => route.fulfill({ status: 503, contentType: "text/plain", body: "unavailable" }));
    await input.setInputFiles([jpeg]);
    await expect(status).toHaveText("Üleslaadimine ei õnnestunud. Proovi uuesti.");
    await expect(items).toHaveCount(before); // nothing was added
  });

  test("upload API: only signed-in, same-site requests with a real JPEG / PNG / WebP of at most 4 MB", async ({ page, context, visitorIp, playwright }) => {
    const jpeg = readFileSync("public/seed/course-manual.jpg");
    const post = (data: { name: string; mimeType: string; buffer: Buffer }, headers: Record<string, string> = {}) =>
      page.request.post("/api/admin/upload", { multipart: { file: data }, headers });
    // no session
    const anon = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
    const res401 = await anon.post("/api/admin/upload", { multipart: { file: { name: "a.jpg", mimeType: "image/jpeg", buffer: jpeg } } });
    expect(res401.status()).toBe(401);
    await anon.dispose();

    await signIn(page, context, visitorIp);
    expect((await post({ name: "a.jpg", mimeType: "image/jpeg", buffer: jpeg }, { origin: "https://evil.example" })).status()).toBe(403);
    const html = await post({ name: "pilt.jpg", mimeType: "image/jpeg", buffer: Buffer.from("<!doctype html><script>alert(1)</script>") });
    expect(html.status()).toBe(415);
    expect(await html.json()).toEqual({ ok: false, error: "content" });
    const svg = await post({ name: "x.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") });
    expect(await svg.json()).toEqual({ ok: false, error: "type" });
    // over 4 MB (Vercel refuses bodies over 4.5 MB itself): 413 from the announced length alone, and from the file's own size
    const huge = Buffer.concat([jpeg.subarray(0, 4), Buffer.alloc(5 * 1024 * 1024)]);
    expect((await post({ name: "huge.jpg", mimeType: "image/jpeg", buffer: huge })).status()).toBe(413);
    const big = Buffer.concat([jpeg.subarray(0, 4), Buffer.alloc(4 * 1024 * 1024)]);
    const bigRes = await post({ name: "big.jpg", mimeType: "image/jpeg", buffer: big });
    expect(bigRes.status()).toBe(413);
    expect(await bigRes.json()).toEqual({ ok: false, error: "size" });
    const ok = await post({ name: "a.jpg", mimeType: "image/jpeg", buffer: jpeg });
    expect(ok.status()).toBe(201);
    const { key } = (await ok.json()) as { key: string };
    expect(key).toMatch(/^img\/[0-9a-f-]{36}\.jpg$/);
    expect(Buffer.compare(await (await page.request.get(`/media/${key}`)).body(), jpeg)).toBe(0);
  });

  test("'Lisa koolitus' creates a draft (not on the public site) with a slug made from its name", async ({ page, context, visitorIp }, info) => {
    await signIn(page, context, visitorIp);
    await page.goto("/admin/koolitused");
    await adminReady(page);
    await page.locator("[data-add-course]").click();
    await expect(page).toHaveURL(/\/admin\/koolitused\/uus$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Uus koolitus");
    await expect(page.locator("[data-course-state]")).toHaveText("Mustand");
    await expect(page.locator("[data-type-switch]").getByRole("radio", { name: "Kontaktõpe" })).toBeChecked();
    const name = `E2E uus ${info.project.name} ${unique()}`;
    await page.getByRole("textbox", { name: "Koolituse nimi (eesti keeles)" }).fill(name);
    await page.getByLabel("Grupikoolituse hind (€)").fill("199,50");
    // "Protokolli punktid" (phase protocols): a new contact course has none yet; the headings go with the course, a blank row is dropped, the order is kept
    const stages = page.locator("[data-protocol-stages]");
    await expect(stages.locator("[data-protocol-stage]")).toHaveCount(0);
    await stages.locator("[data-add-stage]").click();
    await page.keyboard.type("Ettevalmistus"); // (the new field has the focus)
    await stages.locator("[data-add-stage]").click(); // a blank row
    await stages.locator("[data-add-stage]").click();
    await page.keyboard.type("  Värvimine ");
    await expect(stages.locator("[data-protocol-stage]")).toHaveCount(3);
    await page.getByRole("button", { name: "Salvesta", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/koolitused\/\d+\?loodud=1$/);
    await expect(page.getByText("Koolitus loodud.", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    const slug = name.toLowerCase().replace(/ /g, "-");
    expect(slug.startsWith(NEW_COURSE_SLUG_PREFIX)).toBe(true);
    await expect(page.getByLabel("Aadress")).toHaveValue(slug);
    await expect(page.getByLabel("Grupikoolituse hind (€)")).toHaveValue("199,50");
    await expect(stages.locator("[data-protocol-stage]")).toHaveCount(2); // the blank row was dropped
    await expect(stages.locator('[data-protocol-stage="0"]')).toHaveValue("Ettevalmistus");
    await expect(stages.locator('[data-protocol-stage="1"]')).toHaveValue("Värvimine");
    expect((await courseOrder()).indexOf(slug)).toBeGreaterThanOrEqual(6); // after the six seed courses
    expect((await page.request.get(`/koolitused/${slug}`)).status()).toBe(404); // a draft
    await page.goto("/admin/koolitused");
    await adminReady(page);
    await expect(page.locator(`[data-course-row="${slug}"] [data-course-state]`)).toHaveText("Mustand");
  });

  test("course order: ↑ / ↓ in the list is the public order", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(isMobile, "the order is shared by all courses: one project changes it");
    const c = mine(info);
    undo.push(await snapshotOrder());
    // the seed courses only: the other project may add a draft at the end meanwhile
    const seedOrder = async () => (await courseOrder()).filter((s) => !s.startsWith(NEW_COURSE_SLUG_PREFIX));
    await signIn(page, context, visitorIp);
    const order = await seedOrder();
    const at = order.indexOf(c.slug);
    expect(at).toBeGreaterThan(0);
    await page.goto("/admin/koolitused");
    await adminReady(page);
    await page.getByRole("button", { name: `Liiguta üles: ${c.title}` }).click();
    await expect.poll(seedOrder).toEqual([...order.slice(0, at - 1), c.slug, order[at - 1], ...order.slice(at + 1)]);
    await expect(page.getByRole("button", { name: `Liiguta üles: ${c.title}` })).toBeFocused();
    await expect(page.locator("[data-course-row]").nth(at - 1)).toHaveAttribute("data-course-row", c.slug);
    await page.goto("/koolitused");
    await expect(page.locator("[data-course-card]").nth(at - 1)).toHaveAttribute("href", `/koolitused/${c.slug}`);
    await page.goto("/admin/koolitused");
    await adminReady(page);
    await expect(page.locator("[data-course-row]").first().getByRole("button", { name: /Liiguta üles/ })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("button", { name: `Liiguta alla: ${c.title}` }).click();
    await expect.poll(seedOrder).toEqual(order);
    await expect(page.getByRole("button", { name: `Liiguta alla: ${c.title}` })).toBeFocused();
  });
});

test.describe("calendar", () => {
  const COURSE = { slug: "kulmumeistri-baaskoolitus", title: "Kulmumeistri baaskoolitus" };

  test("add a session → it is on the public course page and calendar; edit (cancel) → 'Tühistatud'; delete → gone", async ({ page, context, visitorIp }, info) => {
    const city = `${EDIT_CITY_PREFIX}${info.project.name} ${unique()}`;
    await signIn(page, context, visitorIp);
    await page.goto("/admin/kalender");
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kalender");
    expect(await noOverflow(page)).toBe(true);
    await page.locator("[data-add-session]").click();
    const dialog = page.getByRole("dialog", { name: "Uus toimumine" });
    await expect(dialog).toBeVisible();

    // nothing filled: every field says what is missing, the first one gets the focus
    await dialog.getByLabel("Algus").fill("");
    await dialog.getByRole("button", { name: "Lisa toimumine" }).click();
    await expect(dialog.getByLabel("Koolitus")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByLabel("Koolitus")).toBeFocused();
    for (const text of ["Vali koolitus.", "Sisesta kuupäev.", "Sisesta kellaaeg, näiteks 10:00.", "Sisesta linn."]) await expect(dialog.getByText(text)).toBeVisible();

    await dialog.getByLabel("Koolitus").selectOption({ label: COURSE.title });
    const when = laterSaturday("11:30"); // after every sample session, whatever the day of the run (was 13.03.2027)
    await dialog.getByLabel("Kuupäev").fill(when.input);
    await dialog.getByLabel("Algus").fill("11:30");
    await dialog.getByLabel("Linn").fill(city);
    await dialog.getByLabel("Toimumiskoht").fill("E2E saal");
    await dialog.getByLabel("Kohti").fill("5");
    await dialog.getByLabel("Keel").selectOption("ET / RU");
    await dialog.getByRole("button", { name: "Lisa toimumine" }).click();
    await expect(page).toHaveURL(/\/admin\/kalender\?lisatud=\d+$/);
    await expect(page.locator('[data-flash="added"]')).toHaveText("Toimumine lisatud.");
    await expect(dialog).toBeHidden();
    const row = page.locator("[data-session-row][data-highlight]");
    await expect(row).toContainText(city);
    await expect(row).toContainText(when.shown);
    await expect(row).toContainText("0 / 5 kinnitatud");
    const stored = (await storedSession(city))!;
    expect(stored.startsAt.toISOString()).toBe(when.at.toISOString()); // 11:30 Estonian time
    expect(stored).toMatchObject({ capacity: 5, status: "scheduled", venue: "E2E saal" });

    // public: the course page offers it, the calendar lists it
    await page.goto(`/koolitused/${COURSE.slug}`);
    const option = page.locator(`[data-session="${stored.id}"]`);
    await expect(option).toContainText(city);
    await expect(option).toContainText(when.shown);
    await page.goto("/koolituskalender");
    const calRow = page.locator("[data-calendar-row]", { hasText: city });
    await expect(calRow).toContainText(when.dayMonth);
    await expect(calRow).toContainText("Vabu kohti · 5");
    await expect(calRow).toContainText(COURSE.title);

    // edit: cancelled, 3 seats
    await page.goto("/admin/kalender");
    await adminReady(page);
    await page.getByRole("link", { name: `Muuda toimumist: ${COURSE.title}, ${when.shown}, ${city}` }).click();
    const edit = page.getByRole("dialog", { name: `Toimumine: ${COURSE.title}, ${when.shown}` });
    await expect(edit).toBeVisible();
    await expect(edit.getByLabel("Kuupäev")).toHaveValue(when.input);
    await expect(edit.getByLabel("Algus")).toHaveValue("11:30");
    await edit.getByLabel("Kohti").fill("3");
    await edit.getByRole("radio", { name: "Tühistatud" }).check();
    await edit.getByRole("button", { name: "Salvesta toimumine" }).click();
    await expect(edit.getByText("Toimumine salvestatud.")).toBeVisible();
    expect(await storedSession(city)).toMatchObject({ capacity: 3, status: "cancelled" });
    await page.goto("/koolituskalender");
    await expect(page.locator("[data-calendar-row]", { hasText: city })).toHaveAttribute("data-state", "cancelled");

    // delete, after a confirmation
    await page.goto(`/admin/kalender?id=${stored.id}`);
    await adminReady(page);
    const del = page.getByRole("dialog");
    await del.getByRole("button", { name: "Kustuta toimumine" }).click();
    await expect(del.getByText("Kas kustutan selle toimumise?")).toBeFocused();
    await del.getByRole("button", { name: "Jah, kustuta" }).click();
    await expect(page).toHaveURL(/\/admin\/kalender\?kustutatud=1$/);
    await expect(page.locator('[data-flash="deleted"]')).toHaveText("Toimumine kustutatud.");
    await expect(page.locator("[data-session-row]", { hasText: city })).toHaveCount(0);
    expect(await storedSession(city)).toBeNull();
    await page.goto(`/koolitused/${COURSE.slug}`);
    await expect(page.locator("[data-session]", { hasText: city })).toHaveCount(0);
  });

  test("a session with a registration cannot be deleted (cancel it instead)", async ({ page, context, visitorIp }, info) => {
    const city = `${EDIT_CITY_PREFIX}${info.project.name} ${unique()}`;
    const id = await insertEditSession(COURSE.slug, city);
    await registerOnSession(id, info.project.name);
    await signIn(page, context, visitorIp);
    // an upcoming session opened from the "Möödunud" list still shows its registrations
    await page.goto(`/admin/kalender?aeg=moodunud&id=${id}`);
    await adminReady(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { level: 2 })).toHaveText(COURSE.title);
    await expect(dialog.locator("[data-session-registrations]")).toHaveText("Registreerimisi: 0 kinnitatud, 1 ootab ettemaksu.");
    // a contact course's session: one tap to its protocols (phase protocols)
    await expect(dialog.locator("[data-session-protocols]")).toHaveText("Protokollid");
    await expect(dialog.locator("[data-session-protocols]")).toHaveAttribute("href", `/admin/protokollid?sessioon=${id}`);
    await dialog.getByRole("button", { name: "Sulge" }).click();
    await expect(page).toHaveURL(/\/admin\/kalender\?aeg=moodunud$/);
    await page.goto(`/admin/kalender?id=${id}`);
    await adminReady(page);
    await expect(dialog.locator("[data-session-registrations]")).toHaveText("Registreerimisi: 0 kinnitatud, 1 ootab ettemaksu.");
    await dialog.getByRole("button", { name: "Kustuta toimumine" }).click();
    await dialog.getByRole("button", { name: "Jah, kustuta" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Sellel toimumisel on registreerimisi");
    expect(await storedSession(city)).not.toBeNull();
    await dialog.getByRole("button", { name: "Sulge" }).click();
    await expect(page).toHaveURL(/\/admin\/kalender$/);
    await expect(page.locator("[data-session-row]", { hasText: city })).toContainText("1 ootab ettemaksu");
  });

  test("a session row of a non-contact course: not in the public calendar; its drawer keeps its own course, never another", async ({ page, context, visitorIp }, info) => {
    // Such a row cannot be made any more (a course with sessions keeps its type); one is written directly here.
    const online = mine(info);
    const city = `${EDIT_CITY_PREFIX}${info.project.name} ${unique()}`;
    const id = await insertEditSession(online.slug, city);
    await page.goto("/koolituskalender");
    await expect(page.locator("[data-calendar-row]", { hasText: city })).toHaveCount(0);

    await signIn(page, context, visitorIp);
    await page.goto(`/admin/kalender?id=${id}`);
    await adminReady(page);
    const dialog = page.getByRole("dialog", { name: new RegExp(`^Toimumine: ${online.title},`) });
    await expect(dialog.getByRole("heading", { level: 2 })).toHaveText(online.title);
    await expect(dialog.locator("[data-session-protocols]")).toHaveCount(0); // protocols are for contact courses only
    const course = dialog.getByLabel("Koolitus");
    await expect(course).toHaveValue(String((await storedCourse(online.slug)).id)); // its own course, not the first contact course
    await dialog.getByLabel("Kohti").fill("3");
    await dialog.getByRole("button", { name: "Salvesta toimumine" }).click();
    await expect(dialog.getByText("Vali koolitus.")).toBeVisible(); // saving it under an e-learning course is refused
    expect(await storedSession(city)).toMatchObject({ capacity: 4 }); // and nothing moved or changed
  });
});
