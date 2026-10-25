import { readFileSync } from "node:fs";
import type { BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
import { test } from "./edit-lock";
import { submitsForms, expect } from "./test";
import { adminReady, editLang, signInAsAdmin } from "./admin-login";
import {
  courseOrder,
  EDIT_CITY_PREFIX,
  holdLocalLock,
  insertEditSession,
  LOCK_WAIT_MS,
  NEW_COURSE_SLUG_PREFIX,
  onLocalDb,
  registerOnSession,
  removeAdminRows,
  removeEditRows,
  restoreCourse,
  snapshotCourse,
  snapshotOrder,
  storedCourse,
  storedCourseTest,
  storedSession,
} from "./fixtures";
import { laterSaturday } from "./seed-sessions";
import { dragWithFinger } from "./touch";

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

test.afterEach(async ({ page }, info) => {
  // the course editor autosaves (admin UX pass piece 3a): a save still waiting or on its way when the test ends would land after the course is put
  // back, as a draft of it the next test would see; so the page first settles (or gives up after 10 s) and goes, then the course is put back
  const editing = page.locator("[data-course-editor] [data-save-status]");
  if (await editing.count().catch(() => 0)) await expect(editing).not.toHaveAttribute("data-save-kind", /^(dirty|saving)$/, { timeout: 10_000 }).catch(() => {});
  await page.goto("about:blank").catch(() => {});
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

/** The course editor's one status chip (SaveStatus; README §1.4) and the words its status region speaks (the whole sentence, on a phone too). */
const chip = (page: Page) => page.locator("[data-course-editor] [data-save-status]");
const spoken = (page: Page) => chip(page).locator("[role=status]");
/** The answer to a card's autosave of `part` (POST api/admin/koolitus/<id>/osa/<part>), with the status `status`. */
const partSaved = (page: Page, part: string, status = 200) =>
  page.waitForResponse((r) => r.url().endsWith(`/osa/${part}`) && r.request().method() === "POST" && r.status() === status);
/** The PublishBar (README §1.8): its words on the desktop bar (S3-P3-a's line after the labels), and its „Avalda muudatused“ (the phone's „Avalda“). */
const publishBar = (page: Page) => page.locator("[data-publish-bar]");
const barWords = (page: Page) => page.locator("[data-publish-words]");
const draftWords = (labels: string) => `Avaldamata muudatused: ${labels.split(", ").length} · ${labels}. Avalikul lehel on näha eelmine versioon.`;

/** „Avalda muudatused“: every card's waiting save first, then the publish (api/admin/koolitus/<id>/avalda); the bar goes and the cards start from live. */
async function publish(page: Page): Promise<void> {
  const answer = page.waitForResponse((r) => /\/api\/admin\/koolitus\/\d+\/avalda$/.test(r.url()) && r.request().method() === "POST");
  await page.locator("[data-publish-go]").click();
  expect((await answer).status()).toBe(200);
  await expect(publishBar(page)).toHaveCount(0);
  await expect(chip(page)).toHaveAttribute("data-save-kind", "saved");
}

/**
 * While the UndoBar shows, `button` (the PublishBar's „Avalda muudatused“, the phone's „Avalda“) is in sight and takes a click: nothing stands over it
 * (Playwright's trial click checks that the button itself receives it), and on a phone the bar stands above the bottom bar (Task 8 review M-2).
 */
async function notCovered(page: Page, button: Locator): Promise<void> {
  const undo = page.locator("[data-undo-bar]");
  await expect(undo).toBeVisible();
  await expect(button).toBeVisible();
  await button.click({ trial: true, timeout: 2000 });
  const [a, b] = [(await undo.boundingBox())!, (await button.boundingBox())!];
  expect(a.y + a.height <= b.y || b.y + b.height <= a.y || a.x + a.width <= b.x || b.x + b.width <= a.x, "the UndoBar is clear of the button").toBe(true);
}

/** The course's card in the public catalogue. */
const publicCard = (page: Page, slug: string, prefix = ""): Locator => page.locator(`[data-course-card][href="${prefix}/koolitused/${slug}"]`);

test.describe("course editor", () => {
  test("a published course's ET title: autosaved into its draft (the bar names it, the public page keeps the old one) until „Avalda muudatused“; RU the same way", async ({ page, context, visitorIp }, info) => {
    test.slow(); // one long flow: under the whole suite's load on `next dev` it needs more than the default 30 s (about 15 s alone, 24 to 31 s in the full run)
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
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(c.title);
    await expect(page.getByRole("link", { name: "← Koolitused", exact: true })).toHaveAttribute("href", "/admin/koolitused");
    await expect(page.locator("[data-course-editor] [data-sample]")).toHaveText("Näidis");
    await expect(page.getByRole("link", { name: /Vaata lehel/ })).toHaveAttribute("href", `/koolitused/${c.slug}`);
    // no page-wide „Salvesta“ any more, and nothing unpublished yet: no bar
    await expect(page.getByRole("button", { name: "Salvesta", exact: true })).toHaveCount(0);
    await expect(publishBar(page)).toHaveCount(0);
    await expect(chip(page)).toHaveAttribute("data-save-kind", "saved");

    const title = page.getByRole("textbox", { name: "Koolituse nimi (eesti keeles)" });
    await expect(title).toHaveValue(c.title);
    const newTitle = `${c.title} · E2E ${unique()}`;
    const saved = partSaved(page, "basics");
    await title.fill(newTitle);
    await expect(chip(page)).toHaveAttribute("data-save-kind", "dirty");
    await title.blur();
    await saved;
    await expect(spoken(page)).toHaveText(/^Mustand salvestatud \d\d:\d\d$/);
    await expect(barWords(page)).toHaveText(draftWords("Koolituse nimi"));
    await expect(title.locator("xpath=ancestor::*[@data-i18n-box][1]").locator("[data-unpublished-tag]")).toHaveText("· avaldamata");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(newTitle);
    // the record is live's still (a draft): the public page has the old title
    expect((await storedCourse(c.slug)).title).toEqual(before.title);
    await page.goto(`/koolitused/${c.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(c.title);

    // „Avalda muudatused“: live, on the public site's very next request
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);
    await expect(title).toHaveValue(newTitle); // (the draft, read again)
    await publish(page);
    const after = await storedCourse(c.slug);
    expect(after.title).toEqual({ et: newTitle });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.images).toEqual(before.images);
    await expect(title).toHaveValue(newTitle);
    expect(await noOverflow(page)).toBe(true);
    await page.goto(`/koolitused/${c.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(newTitle);
    await expect(page).toHaveTitle(new RegExp(newTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await page.goto("/koolitused");
    await expect(publicCard(page, c.slug).getByRole("heading")).toHaveText(newTitle);
    await page.goto(`/ru/koolitused/${c.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(newTitle); // no Russian title yet: the Estonian one

    // the Russian title: the page's RU switch shows the ET text above the field and as its placeholder, and "tõlge tulekul" stays until it is written
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);
    // (:visible — a page that is still being swapped in by the stream holds a hidden server copy of itself, which a plain CSS locator would find as well)
    const titleBox = page.locator("[data-i18n-box]:visible", { has: page.locator('[data-i18n="title"]') });
    await expect(titleBox.locator("[data-ru-pending]")).toHaveText("tõlge tulekul"); // (in ET mode too)
    await editLang(page, "ru");
    const ru = page.getByRole("textbox", { name: "Koolituse nimi (vene keeles)" });
    await expect(titleBox.locator("[data-et-ref]")).toHaveText(`ET${newTitle}`);
    await expect(ru).toHaveAttribute("placeholder", newTitle);
    await expect(titleBox.locator("[data-ru-pending]")).toHaveText("tõlge tulekul");
    const savedRu = partSaved(page, "basics");
    await ru.fill("Форма бровей E2E");
    await expect(titleBox.locator("[data-ru-pending]")).toHaveCount(0);
    await ru.blur();
    await savedRu;
    await publish(page);
    expect((await storedCourse(c.slug)).title).toEqual({ et: newTitle, ru: "Форма бровей E2E" });
    await page.goto(`/ru/koolitused/${c.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Форма бровей E2E");
    await page.goto(`/koolitused/${c.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(newTitle);
  });

  test("„Eelvaade ↗“ shows the draft on the course's live address with the preview bar; „Loobu muudatustest“ asks, then the cards show live again", async ({ page, context, visitorIp, isMobile }, info) => {
    test.slow(); // one long flow: under the whole suite's load on `next dev` it needs more than the default 30 s (about 15 s alone, 24 to 31 s in the full run)
    test.skip(isMobile, "„Loobu muudatustest“ is on the desktop bar (on a phone, behind „Eelvaade“): the desktop project");
    const c = mine(info);
    const id = await changing(c.slug);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);
    const summary = page.getByRole("textbox", { name: "Lühikirjeldus (eesti keeles)" });
    const live = await summary.inputValue();
    const draft = `${live} E2E eelvaade ${unique()}`;
    const saved = partSaved(page, "basics");
    await summary.fill(draft);
    await summary.blur();
    await saved;
    await expect(barWords(page)).toHaveText(draftWords("Lühikirjeldus"));
    // the preview: the public page at its live address in draft mode (a new tab of its own)
    const preview = page.locator("[data-publish-preview]");
    await expect(preview).toHaveAttribute("href", `/api/admin/eelvaade?tee=${encodeURIComponent(`/koolitused/${c.slug}`)}`);
    await expect(preview).toHaveAttribute("target", "_blank");
    const tab = await context.newPage();
    await tab.goto((await preview.getAttribute("href"))!);
    await expect(tab).toHaveURL(new RegExp(`/koolitused/${c.slug}$`));
    await expect(tab.getByText(draft, { exact: true }).first()).toBeVisible();
    await expect(tab.locator("[data-preview-bar] [data-preview-count]")).toHaveText("Avaldamata 1");
    // a visitor (no session, no draft mode) has the live text and no bar
    const visitor = await context.browser()!.newContext();
    const other = await visitor.newPage();
    await other.goto(`/koolitused/${c.slug}`);
    await expect(other.getByText(draft, { exact: true })).toHaveCount(0);
    await expect(other.locator("[data-preview-bar]")).toHaveCount(0);
    await visitor.close();
    // the preview's way out („Lõpeta eelvaade“, Dim 24.10): live again, without the bar
    await expect(tab.locator("[data-preview-exit]")).toHaveText("Lõpeta eelvaade");
    await tab.locator("[data-preview-exit]").click();
    await expect(tab).toHaveURL(new RegExp(`/koolitused/${c.slug}$`));
    await expect(tab.locator("[data-preview-bar]")).toHaveCount(0);
    await expect(tab.getByText(draft, { exact: true })).toHaveCount(0);
    await tab.close();

    // „Loobu muudatustest“: asked first; „Katkesta“ keeps the draft; „Jah, loobu“ drops it, the field shows live, the bar goes
    await page.locator("[data-publish-discard]").click();
    const panel = page.locator("[data-publish-bar] [data-confirm-panel]");
    await expect(panel).toContainText("Kas loobun 1 muudatusest? Avalikul lehel jääb praegune versioon.");
    await panel.getByRole("button", { name: "Katkesta" }).click();
    await expect(page.locator("[data-publish-discard]")).toBeFocused();
    await page.locator("[data-publish-discard]").click();
    const discarded = page.waitForResponse((r) => r.url().endsWith(`/api/admin/koolitus/${id}/loobu`) && r.status() === 200);
    await panel.getByRole("button", { name: "Jah, loobu" }).click();
    await discarded;
    await expect(publishBar(page)).toHaveCount(0);
    await expect(summary).toHaveValue(live);
    expect(await onLocalDb((sql) => sql`select part from content_drafts where entity = 'course' and entity_id = ${id}`)).toHaveLength(0);
  });

  test("the modules card on a published course (Task 9; README B2, B18): a name and a move wait in the draft — the bar names them, the rows say „avaldamata“, another card keeps its field; „Loobu muudatustest“ brings live back; „Avalda muudatused“ clears the tags", async ({ page, context, visitorIp, isMobile }, info) => {
    test.slow(); // one long flow: under the whole suite's load on `next dev` it needs more than the default 30 s (about 15 s alone, 24 to 31 s in the full run)
    const c = mine(info);
    const id = await changing(c.slug); // (the snapshot holds its modules and lessons too: put back after the test, also what „Avalda“ wrote)
    /** The course's modules as stored (live), in order. */
    const storedModules = () =>
      onLocalDb((sql) => sql<{ id: number; title: string; unpublished: boolean }[]>`
        select id, title->>'et' as title, unpublished from course_modules where course_id = ${id} order by position, id`);
    const live = await storedModules();
    expect(live.length).toBeGreaterThanOrEqual(3);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);
    const card = page.locator("[data-lessons-editor]");
    const shownIds = () => card.locator("[data-drag-row]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-drag-row"))));
    const shownNames = () => card.locator("[data-module] [data-i18n^='module-']").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    await expect.poll(shownNames).toEqual(live.map((m) => m.title));
    await expect(publishBar(page)).toHaveCount(0);
    // another card's field, the same node through the names, the move and the new module (no card starts over: only a press does that)
    const summary = page.getByRole("textbox", { name: "Lühikirjeldus (eesti keeles)" });
    await summary.evaluate((el) => ((el as HTMLElement & { e2eMark?: string }).e2eMark = "same"));
    const sameSummary = () => summary.evaluate((el) => (el as HTMLElement & { e2eMark?: string }).e2eMark ?? "");
    const labels = async (words: string, n: number) => {
      if (isMobile) await expect(page.locator("[data-publish-phone]")).toHaveText(`Avaldamata ${n} · Eelvaade`);
      else await expect(barWords(page)).toHaveText(draftWords(words));
    };

    // 1. the second module's name, autosaved on its own route into the draft: the bar names „Moodul 02“, the row says „avaldamata“, live is as it was
    const second = card.locator(`[data-module="${live[1].id}"]`);
    const name = second.getByRole("textbox", { name: "Mooduli nimi" });
    const renamed = page.waitForResponse((r) => r.url().endsWith(`/api/admin/moodul/${live[1].id}`) && r.request().method() === "POST" && r.status() === 200);
    await name.fill(`${live[1].title} E2E`);
    await name.blur();
    await renamed;
    await labels("Moodul 02", 1);
    await expect(second.locator("[data-module-tag]")).toHaveText("avaldamata");
    await expect(card.locator("[data-module-tag]")).toHaveCount(1);
    expect((await storedModules()).map((m) => m.title)).toEqual(live.map((m) => m.title));
    expect(await sameSummary()).toBe("same");

    // 2. the last module one place up with its handle (a finger on a phone, the mouse on a desktop): the order waits in the draft too
    const last = live[live.length - 1];
    const before = live[live.length - 2];
    await card.locator(`[data-drag-row="${before.id}"]`).evaluate((el) => el.scrollIntoView({ block: "center" }));
    const from = (await card.locator(`[data-drag-row="${last.id}"] [data-drag-tool="handle"]`).boundingBox())!;
    const over = (await card.locator(`[data-drag-row="${before.id}"]`).boundingBox())!;
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const to = { x: start.x, y: over.y + 8 };
    if (isMobile) await dragWithFinger(page, start, to, 20);
    else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 20 });
      await page.mouse.up();
    }
    const moved = [...live.slice(0, -2).map((m) => m.id), last.id, before.id];
    await expect.poll(shownIds).toEqual(moved);
    // (the renamed module is the second still on a phone's four modules; on the desktop's three it is now the third)
    const renamedAt = String(moved.indexOf(live[1].id) + 1).padStart(2, "0");
    await labels(`Moodulite järjekord, Moodul ${renamedAt}`, 2);
    expect((await storedModules()).map((m) => m.id)).toEqual(live.map((m) => m.id));
    expect(await sameSummary()).toBe("same");

    // 3. a new module: a real row flagged unpublished (R-e), „avaldamata“ in its row, nowhere for students
    const add = card.locator("[data-add-module]");
    await add.getByLabel("Uue mooduli nimi").fill("E2E uus moodul");
    await add.getByRole("button", { name: "Lisa moodul" }).click();
    await expect.poll(async () => (await storedModules()).find((m) => m.title === "E2E uus moodul")?.unpublished).toBe(true);
    const added = (await storedModules()).find((m) => m.title === "E2E uus moodul")!;
    await expect(card.locator(`[data-module="${added.id}"] [data-module-tag]`)).toHaveText("avaldamata");
    expect(await sameSummary()).toBe("same");

    if (!isMobile) {
      // 4. „Loobu muudatustest“ (the desktop's bar; a phone has it on the preview page, spec C3): live's order and name back, the new module gone
      const discarded = page.waitForResponse((r) => r.url().endsWith(`/api/admin/koolitus/${id}/loobu`) && r.status() === 200);
      await page.locator("[data-publish-discard]").click();
      await page.locator("[data-publish-bar] [data-confirm-panel]").getByRole("button", { name: "Jah, loobu" }).click();
      await discarded;
      await expect(publishBar(page)).toHaveCount(0);
      await expect.poll(shownNames).toEqual(live.map((m) => m.title));
      await expect.poll(shownIds).toEqual(live.map((m) => m.id));
      await expect(card.locator("[data-module-tag]")).toHaveCount(0);
      expect((await storedModules()).map((m) => m.id)).toEqual(live.map((m) => m.id));
      expect(await onLocalDb((sql) => sql`select part from content_drafts where entity = 'course' and entity_id = ${id}`)).toHaveLength(0);
      // and once more a name, for the publish below
      const again = card.locator(`[data-module="${live[1].id}"]`).getByRole("textbox", { name: "Mooduli nimi" });
      const saved = page.waitForResponse((r) => r.url().endsWith(`/api/admin/moodul/${live[1].id}`) && r.request().method() === "POST" && r.status() === 200);
      await again.fill(`${live[1].title} E2E`);
      await again.blur();
      await saved;
      await labels("Moodul 02", 1);
    }

    // 5. „Avalda muudatused“: what waited is live, and no row says „avaldamata“ any more
    await publish(page);
    await expect(card.locator("[data-module-tag]")).toHaveCount(0);
    const now = await storedModules();
    expect(now.find((m) => m.id === live[1].id)?.title).toBe(`${live[1].title} E2E`);
    expect(now.every((m) => !m.unpublished)).toBe(true);
    if (isMobile) expect(now.map((m) => m.id)).toEqual([...moved, added.id]);
    else expect(now.map((m) => m.id)).toEqual(live.map((m) => m.id));
    await expect.poll(shownNames).toEqual(now.map((m) => m.title));
  });

  test("two tabs on one published course: the second tab's save of the same card is a conflict, never an overwrite; „Taasta minu tekst“ saves it over", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(isMobile, "two windows side by side: the desktop project");
    const c = mine(info);
    const id = await changing(c.slug);
    await signIn(page, context, visitorIp);
    const other = await context.newPage();
    for (const p of [page, other]) {
      await p.goto(`/admin/koolitused/${id}`);
      await adminReady(p);
    }
    const summaryOf = (p: Page) => p.getByRole("textbox", { name: "Lühikirjeldus (eesti keeles)" });
    // tab A types first: its draft
    const first = partSaved(page, "basics");
    await summaryOf(page).fill("E2E tab A");
    await summaryOf(page).blur();
    await first;
    // tab B, still on the version it opened with: 409, the chip says so, B's text stays in its field and nothing is written over A's
    const refused = partSaved(other, "basics", 409);
    await summaryOf(other).fill("E2E tab B");
    await summaryOf(other).blur();
    await refused;
    await expect(chip(other)).toHaveAttribute("data-save-kind", "conflict");
    await expect(spoken(other)).toHaveText("Muudeti teises aknas — vaata üle");
    await expect(summaryOf(other)).toHaveValue("E2E tab B");
    const draftOf = async () => (await onLocalDb((sql) => sql<{ value: { summary: { et: string } } }[]>`select value from content_drafts where entity = 'course' and entity_id = ${id} and part = 'basics'`))[0]?.value.summary.et;
    expect(await draftOf()).toBe("E2E tab A");
    // „Taasta minu tekst“ (B13): B's text over A's, explicitly
    const restored = partSaved(other, "basics");
    // (the type card offers the basics' restore too, for its radio: the one in „Põhiinfo“ here)
    await other.locator("#course-basics [data-part-restore]").click();
    await restored;
    await expect(chip(other)).toHaveAttribute("data-save-kind", "saved");
    expect(await draftOf()).toBe("E2E tab B");
    // and tab A's next save of that card is the conflict now
    const late = partSaved(page, "basics", 409);
    await summaryOf(page).fill("E2E tab A again");
    await summaryOf(page).blur();
    await late;
    await expect(chip(page)).toHaveAttribute("data-save-kind", "conflict");
    expect(await draftOf()).toBe("E2E tab B");
    await other.close();
  });

  test("on a 375×812 phone: „Jaotised ▾“ under the H1 in the map's place, „Avaldamine“ next, the PublishBar at the foot of the screen with „Avalda“", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(!isMobile, "a phone's size and touch: the phone project");
    const c = mine(info);
    const id = await changing(c.slug);
    await signIn(page, context, visitorIp);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);
    await expect(page.locator("nav[aria-label='Jaotised']")).toBeHidden();
    const select = page.locator("[data-section-select]");
    await expect(select).toBeVisible();
    await expect(select.locator("[data-section-face]")).toHaveText(/Jaotised · Põhiinfo/);
    // the order down the page: the H1, the select, „Avaldamine“, then the cards
    const top = async (selector: string) => (await page.locator(selector).first().boundingBox())!.y;
    const [h1, map, side, basics] = [await top("h1"), await top("[data-section-select]"), await top("[data-publish-card]"), await top("#course-basics")];
    expect(h1 < map && map < side && side < basics).toBe(true);
    expect(await noOverflow(page)).toBe(true);
    // a choice in the select goes to its card
    await select.locator("select").selectOption((await select.locator("option").filter({ hasText: /^Galerii/ }).getAttribute("value"))!);
    await expect.poll(async () => Math.round((await page.locator("#course-gallery").boundingBox())!.y)).toBeLessThan(140);

    // a change: the bar sticks to the bottom of the screen, „Avaldamata 1 · Eelvaade“ and „Avalda“ (44 px and more), above the page
    await page.locator("#course-basics").scrollIntoViewIfNeeded();
    const summary = page.getByRole("textbox", { name: "Lühikirjeldus (eesti keeles)" });
    const saved = partSaved(page, "basics");
    await summary.fill(`${await summary.inputValue()} E2E telefon`);
    await summary.blur();
    await saved;
    const bar = publishBar(page);
    await expect(page.locator("[data-publish-phone]")).toHaveText("Avaldamata 1 · Eelvaade");
    await expect(barWords(page)).toBeHidden();
    await expect(page.locator("[data-publish-discard]")).toBeHidden();
    const box = (await bar.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(812);
    expect(Math.round(box.width)).toBe(375);
    const go = (await page.locator("[data-publish-go]").boundingBox())!;
    expect(go.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator("[data-publish-go] [data-phone]")).toHaveText("Avalda");
    await expect(bar).toHaveAttribute("data-fab-avoid", "");
    expect(await noOverflow(page)).toBe(true);
    await publish(page);
  });

  test("one ET | RU switch in the heading sets every field, is kept on reload, counts the empty Russian fields and walks them; „Kopeeri eesti keelest“ fills one", async ({ page, context, visitorIp }, info) => {
    const c = mine(info);
    const id = await changing(c.slug); // (what is typed here autosaves into the course's draft: put back all the same)
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);

    // one control, at the right of the heading; no pills on the fields
    const bar = page.locator("[data-edit-lang-bar]:visible");
    await expect(bar).toContainText("Sisu keel");
    await expect(bar.locator("[data-edit-lang-switch] button")).toHaveText(["ET", "RU"]);
    await expect(page.locator("[data-lang-switch]")).toHaveCount(0);
    await expect(page.locator("[data-edit-lang='et']:visible")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-ru-missing]")).toHaveCount(0); // (the line is for RU mode)
    const fields = page.locator("[data-lang-field]:visible");
    expect(await fields.count()).toBeGreaterThan(3);
    await expect(fields.and(page.locator('[data-lang-field="ru"]'))).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
    // the track is 44 px tall, and so is the tap target of each segment (the pill you see inside it is 38)
    expect((await bar.locator("[data-edit-lang-switch]").boundingBox())!.height).toBe(44);
    for (const segment of await bar.locator("[data-edit-lang-switch] button").all()) expect((await segment.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await editLang(page, "ru");
    await expect(fields.and(page.locator('[data-lang-field="et"]'))).toHaveCount(0); // every field on the page is in Russian now
    // the choice is kept on this device: the page opens in Russian
    await page.reload();
    await adminReady(page);
    await expect(page.locator("[data-edit-lang='ru']:visible")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-lang-field="ru"]:visible').first()).toBeVisible();
    await expect(fields.and(page.locator('[data-lang-field="et"]'))).toHaveCount(0);

    // an empty Russian title: counted, with the way to it and the copy of the Estonian text
    const titleBox = page.locator("[data-i18n-box]:visible", { has: page.locator('[data-i18n="title"]') });
    const ru = page.getByRole("textbox", { name: "Koolituse nimi (vene keeles)" });
    await ru.fill("");
    const line = page.locator("[data-ru-missing]");
    await expect(line).toContainText(/^RU puudub \d+ väljal/);
    // the section map says it at the card too (desktop: the list; phone: the select's option)
    await expect(page.locator("nav[aria-label='Jaotised'] a, [data-section-select] option").filter({ hasText: /^Põhiinfo/ }).first()).toContainText("RU puudub");
    await page.locator("[data-ru-next]").click();
    await expect(ru).toBeFocused();
    const copy = titleBox.getByRole("button", { name: "Kopeeri eesti keelest" });
    await expect(copy).toBeVisible();
    expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await copy.click();
    await expect(ru).toHaveValue(c.title);
    await expect(copy).toHaveCount(0);
    await expect(ru).toBeFocused();
    expect(await noOverflow(page)).toBe(true);
    // (what was typed has autosaved into the course's draft by the time the test ends: the course is put back after it)
    await ru.blur();
    await expect(chip(page)).toHaveAttribute("data-save-kind", "saved");
  });

  test("badge 'Uus' in Orhidee (D badge editor): the live card preview, then the public card after „Avalda muudatused“; 'Puudub' takes it off", async ({ page, context, visitorIp }, info) => {
    test.slow(); // one long flow: under the whole suite's load on `next dev` it needs more than the default 30 s (about 15 s alone, 24 to 31 s in the full run)
    const c = mine(info);
    const id = await changing(c.slug);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);

    const editor = page.locator("[data-badge-editor]");
    await expect(editor.getByRole("heading", { name: "Koolituse märgis" })).toBeVisible();
    await expect(editor).toContainText("muudatus on koolituste lehel näha pärast avaldamist."); // (P-5)
    await expect(editor.getByRole("button", { name: "Puudub" })).toHaveAttribute("aria-pressed", "true");
    const preview = editor.locator("[data-badge-preview] [data-course-card]");
    await expect(preview).toContainText(c.title); // the real course card, with this course's data
    await expect(preview.getByText("Uus", { exact: true })).toHaveCount(0);

    const saved = partSaved(page, "badge");
    await editor.getByRole("button", { name: "Uus", exact: true }).click();
    await saved; // a pick saves at once
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
    await expect(barWords(page)).toHaveText(draftWords("Koolituse märgis"));
    await publish(page);
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
    await publish(page);
    expect((await storedCourse(c.slug)).badge).toEqual({ label: { et: "Sügise hitt", ru: "Хит осени" }, bg: "#6B4F5C", fg: "#ffffff" });
    await editor.getByRole("button", { name: "Puudub" }).click();
    await expect(own).toHaveValue("");
    await expect(ownRu).toBeDisabled();
    await expect(preview.getByText("Sügise hitt")).toHaveCount(0);
    await publish(page);
    expect((await storedCourse(c.slug)).badge).toBeNull();
    await page.goto("/koolitused");
    await expect(publicCard(page, c.slug).getByText("Uus", { exact: true })).toHaveCount(0);
  });

  test("the type switch shows only that type's cards and fields; a published course without a price: „Avalda muudatused“ is held, „Puudub: hind“, nothing live changes", async ({ page, context, visitorIp }, info) => {
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
    // (text fields by role)
    const field = (name: string | RegExp) => page.getByRole("textbox", { name, exact: typeof name === "string" });
    for (const name of ["Ligipääs (kuud)", "Videotunde", /^Soodustus järgmiselt koolituselt/]) await expect(field(name)).toHaveCount(1);
    for (const name of ["Grupikoolituse hind (€)", "Individuaalkoolituse hind (€)", /^Kestus/]) await expect(field(name)).toHaveCount(0);
    await expect(page.locator('[data-list-editor="includes"]')).toHaveCount(0);
    // "Protokolli punktid" are an e-course's practical points too, with their own hint; "Teadmiste test" is an e-course's only (e-course completion)
    await expect(page.locator("[data-protocol-stages] h3")).toHaveText("Protokolli punktid");
    await expect(page.locator("[data-protocol-stages]")).toContainText("E-kursusel on need praktilise töö punktid: õpilane lisab iga punkti juurde 1–3 fotot.");
    await expect(page.locator("[data-test-editor] h3")).toHaveText("Teadmiste test");
    await expect(page.getByText(/hübriid/i)).toHaveCount(0); // no third type anywhere
    await expect(page.locator("[data-type-hint]")).toHaveText("Koolitus on kas e-õpe või kontaktõpe. Õppevormi vahetamisel eemaldatakse teise õppevormi väljad."); // (P-5)

    // the type is instant: into the basics' draft at once, and the cards follow it (the section map too)
    const switched = partSaved(page, "basics");
    await typeSwitch.getByRole("radio", { name: "Kontaktõpe" }).check();
    await switched;
    for (const name of ["Grupikoolituse hind (€)", "Individuaalkoolituse hind (€)", /^Kestus/]) await expect(field(name)).toHaveCount(1);
    for (const name of ["Hind (€)", "Ligipääs (kuud)", "Videotunde", /^Soodustus/]) await expect(field(name)).toHaveCount(0);
    await expect(page.locator('[data-list-editor="includes"] h3')).toHaveText("Koolitus sisaldab");
    await expect(page.locator("[data-protocol-stages] h3")).toHaveText("Protokolli punktid");
    await expect(page.locator("[data-protocol-stages]")).toContainText("Koolituspäeva protokolli etapid");
    await expect(page.locator("[data-test-editor]")).toHaveCount(0);
    await expect(page.locator("[data-section-select] option").filter({ hasText: /^Programm/ })).toHaveCount(1);
    await expect(page.locator("[data-section-select] option").filter({ hasText: /^Teadmiste test/ })).toHaveCount(0);
    await expect(barWords(page)).toHaveText(draftWords("Õppevorm"));
    const back = partSaved(page, "basics");
    await typeSwitch.getByRole("radio", { name: "E-õpe" }).check();
    await back;
    await expect(page.getByLabel("Hind (€)")).toHaveValue(c.price); // switching back keeps what was there
    await expect(publishBar(page)).toHaveCount(0); // typed back to live: no change waits

    // the price emptied: a draft may wait without one, the publish may not (S3-P3-b), and the field says why
    const emptied = partSaved(page, "price");
    await page.getByLabel("Hind (€)").fill("");
    await page.getByLabel("Hind (€)").blur();
    await emptied;
    await expect(barWords(page)).toHaveText(draftWords("Hind"));
    const answer = page.waitForResponse((r) => r.url().endsWith(`/api/admin/koolitus/${id}/avalda`));
    await page.locator("[data-publish-go]").click();
    // (`stamp`: the database's clock after the commit, Task 9 review M-1)
    expect(await (await answer).json()).toEqual({ published: [], blocked: [{ part: "price", reason: "missing", fields: ["hind"] }], stamp: expect.any(Number) });
    await expect(page.locator("[data-publish-blocked]")).toHaveText("Puudub: hind");
    await expect(page.locator("[data-plain-field]", { has: page.getByLabel("Hind (€)") }).locator("[data-field-error]")).toHaveText("Avaldatud koolitusel peab olema hind.");
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
    for (const name of ['radio "Baaskoolitus"', 'radio "Täiendkoolitus"', 'radio "E-õpe"', 'radio "Kontaktõpe"', 'switch "Avalikul lehel"', 'switch "Näidissisu"', 'checkbox "Lash Lift BOTOX baaskoolitus"'])
      expect(tree, name).toContain(name);
    // „Avaldamine“ as drawn (Part 3 L111): two switches (this seed course is published and a sample), each row 44 px or more, the track 48 × 28
    const card = page.locator("[data-publish-card]");
    await expect(card.getByRole("switch", { name: "Avalikul lehel", exact: true })).toBeChecked();
    await expect(card.getByRole("switch", { name: "Näidissisu", exact: true })).toBeChecked({ checked: (await page.locator("[data-course-editor] [data-sample]").count()) > 0 });
    for (const row of await card.locator("[data-switch-row]").all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const track = (await card.getByRole("switch", { name: "Avalikul lehel", exact: true }).boundingBox())!;
    expect([Math.round(track.width), Math.round(track.height)]).toEqual([48, 28]);
    // the badge's presets and swatches are named buttons
    for (const name of ["Puudub", "Uus", "Tint", "Orhidee", "Tuhkroos", "Ploom", "Hele"])
      await expect(page.locator("[data-badge-editor]").getByRole("button", { name, exact: true })).toHaveCount(1);
  });

  test("lists (ET/RU rows, ↑ ↓, add, remove with „Võta tagasi“) autosave in their order and go live with „Avalda muudatused“", async ({ page, context, visitorIp }, info) => {
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
    // ↑ is aria-disabled on the first row, ↓ on the last; a move saves at once
    await expect(outcomes.getByRole("button", { name: "Liiguta rida 1 üles" })).toHaveAttribute("aria-disabled", "true");
    await expect(outcomes.getByRole("button", { name: `Liiguta rida ${count} alla` })).toHaveAttribute("aria-disabled", "true");
    const moved = partSaved(page, "outcomes");
    await outcomes.getByRole("button", { name: "Liiguta rida 1 alla" }).click();
    await moved;
    await expect(rows.nth(0).locator("[data-lang-field]")).toHaveValue(second);
    await expect(rows.nth(1).locator("[data-lang-field]")).toHaveValue(first);
    // the focus stays on the moved row's ↓: the row was put back into the page, and DragList finds it by its key (the server's and the browser's
    // the same, review I-1)
    await expect(outcomes.getByRole("button", { name: "Liiguta rida 2 alla" })).toBeFocused();
    await outcomes.getByRole("button", { name: "Lisa rida" }).click();
    await expect(rows).toHaveCount(count + 1);
    await expect(rows.nth(count).locator("[data-lang-field]")).toBeFocused();
    await page.keyboard.type("E2E õpiväljund");
    await editLang(page, "ru");
    await rows.nth(count).locator("[data-lang-field]").fill("E2E результат");
    await editLang(page, "et");
    // each row has its handle (DragList, S3-P3-m)
    await expect(rows.nth(2).locator('[data-drag-tool="handle"]')).toHaveAttribute("aria-label", "Lohista rida 3");
    // × takes the row out at once, with the UndoBar (S3-P3-d); „Võta tagasi“ puts it back at its place
    const third = await rows.nth(2).locator("[data-lang-field]").inputValue();
    await outcomes.getByRole("button", { name: "Eemalda rida 3" }).click();
    await expect(rows).toHaveCount(count);
    const undoBar = page.locator("[data-undo-bar]");
    await expect(undoBar).toContainText("Rida eemaldatud.");
    await notCovered(page, page.locator("[data-publish-go]"));
    await undoBar.getByRole("button", { name: "Võta tagasi" }).click();
    await expect(rows).toHaveCount(count + 1);
    await expect(rows.nth(2).locator("[data-lang-field]")).toHaveValue(third);
    await expect(undoBar).toHaveCount(0);
    await outcomes.getByRole("button", { name: "Eemalda rida 3" }).click();
    await expect(rows).toHaveCount(count);
    // (no Esc: a phone has none; the bar is up while „Avalda muudatused“ is pressed)
    await notCovered(page, page.locator("[data-publish-go]"));
    await expect(barWords(page)).toHaveText(draftWords("Õpiväljundid"));
    await publish(page);

    await page.goto(`/koolitused/${c.slug}`);
    const items = page.locator("[data-outcomes] li");
    await expect(items).toHaveCount(count);
    await expect(items.nth(0)).toContainText(second);
    await expect(items.nth(1)).toContainText(first);
    await expect(items.last()).toContainText("E2E õpiväljund");
    await page.goto(`/ru/koolitused/${c.slug}`);
    await expect(page.locator("[data-outcomes] li").last()).toContainText("E2E результат");
  });

  test("gallery: upload (resized, without camera data), reorder, describe — autosaved, then „Avalda muudatused“; the public page and /media show it", async ({ page, context, visitorIp, isMobile }, info) => {
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

    // the new JPEG becomes the main picture: its handle dragged with a mouse, ↑ on a phone (the pictures' own words, review M-1)
    const last = items.nth(before);
    if (isMobile) {
      for (let n = before + 1; n > 1; n--) await gallery.getByRole("button", { name: `Liiguta pilt ${n} ettepoole` }).click();
    } else {
      // both pictures on screen: a drag cannot scroll the page on its way
      const size = page.viewportSize()!;
      await page.setViewportSize({ width: size.width, height: 2400 });
      await items.nth(0).scrollIntoViewIfNeeded();
      await last.locator('[data-drag-tool="handle"]').dragTo(items.nth(0).locator('[data-drag-tool="handle"]'));
      await page.setViewportSize(size);
    }
    await expect(items.nth(0)).toHaveAttribute("data-gallery-item", jpgKey);
    await expect(items.nth(0)).toContainText("Põhipilt");
    await items.nth(0).getByRole("textbox", { name: "Pildi kirjeldus (eesti keeles)" }).fill("E2E õppematerjal");
    // the PNG goes again: at once, with the UndoBar „Pilt eemaldatud.“ (S3-P3-d); „Võta tagasi“ puts it back at its place, its stored file untouched
    // (a removal never deletes the file, so nothing an undo brings back is lost)
    const pngIndex = (await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-gallery-item")))).indexOf(pngKey);
    await gallery.getByRole("button", { name: `Eemalda pilt ${pngIndex + 1}` }).click();
    await expect(items).toHaveCount(before + 1);
    const undoBar = page.locator("[data-undo-bar]");
    await expect(undoBar).toContainText("Pilt eemaldatud.");
    await notCovered(page, page.locator("[data-publish-go]"));
    await undoBar.getByRole("button", { name: "Võta tagasi" }).click();
    await expect(items).toHaveCount(before + 2);
    await expect(items.nth(pngIndex)).toHaveAttribute("data-gallery-item", pngKey);
    expect((await page.request.get(`/media/${pngKey}`)).status()).toBe(200);
    await gallery.getByRole("button", { name: `Eemalda pilt ${pngIndex + 1}` }).click();
    await expect(items).toHaveCount(before + 1);
    // (no Esc: the bar is up while „Avalda muudatused“ is pressed)
    await notCovered(page, page.locator("[data-publish-go]"));
    await publish(page);
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

  test("'Lisa koolitus' (S3-P3-g): the header says what is missing, then to press it; leaving asks; the press creates an unpublished course whose cards autosave", async ({ page, context, visitorIp }, info) => {
    // the new course stands in the catalogue's order (a row of the list): it takes turns with the order tests, and it goes before the lock is let go
    // (a list that loses a row under the phone's finger drag scrolls; Task 8 review round 1)
    info.setTimeout(info.timeout + LOCK_WAIT_MS);
    await takeOrder();
    undo.push(async () => void (await removeEditRows(info.project.name)));
    await signIn(page, context, visitorIp);
    await page.goto("/admin/koolitused");
    await adminReady(page);
    await page.locator("[data-add-course]").click();
    await expect(page).toHaveURL(/\/admin\/koolitused\/uus$/);
    await adminReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Uus koolitus");
    await expect(page.locator("[data-course-state]")).toHaveText("Mustand");
    await expect(page.locator("[data-type-switch]").getByRole("radio", { name: "Kontaktõpe" })).toBeChecked();
    // nothing saves before the course exists: no chip, the header's line instead (P1:248), and the modules wait for the course
    const line = page.locator("[data-new-course-line]");
    await expect(line).toHaveText("Täida kohustuslikud väljad");
    await expect(chip(page)).toHaveCount(0);
    await expect(page.locator("[data-lessons-editor]")).toContainText("Vajuta „Lisa koolitus“, et lisada mooduleid.");
    const name = `E2E uus ${info.project.name} ${unique()}`;
    await page.getByRole("textbox", { name: "Koolituse nimi (eesti keeles)" }).fill(name);
    await expect(line).toHaveText("Vajuta „Lisa koolitus“.");
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

    // leaving with typed text and nothing created asks, with the reason (S3-P3-g); „Jää siia“ keeps everything
    await page.getByRole("link", { name: "← Koolitused", exact: true }).click();
    const notice = page.locator("[data-leave-notice]");
    await expect(notice.locator("[data-leave-title]")).toHaveText("Muudatust „Koolituse nimi“ ei saanud veel salvestada.");
    await expect(notice.locator("[data-leave-reason]")).toHaveText("Koolitust pole veel lisatud.");
    await notice.getByRole("button", { name: "Jää siia" }).click();
    await expect(page).toHaveURL(/\/admin\/koolitused\/uus$/);
    await expect(page.getByRole("textbox", { name: "Koolituse nimi (eesti keeles)" })).toHaveValue(name);

    await page.locator("[data-create-course]").click();
    await expect(page).toHaveURL(/\/admin\/koolitused\/\d+\?loodud=1$/);
    await adminReady(page);
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
    expect((await page.request.get(`/koolitused/${slug}`)).status()).toBe(404); // not published
    // from now on every card autosaves, straight to the record (an unpublished course has no draft and no bar)
    await expect(chip(page)).toHaveAttribute("data-save-kind", "saved");
    const saved = partSaved(page, "price");
    await page.getByLabel("Individuaalkoolituse hind (€)").fill("250");
    await page.getByLabel("Individuaalkoolituse hind (€)").blur();
    await saved;
    await expect(spoken(page)).toHaveText(/^Salvestatud \d\d:\d\d$/);
    await expect(publishBar(page)).toHaveCount(0);
    expect(await onLocalDb((sql) => sql`select price_individual from courses where slug = ${slug}`)).toEqual([{ price_individual: 25000 }]);
    // an unpublished course's type changed: the server empties the contact fields (new versions), so the cards wait (inert) until the page is read
    // again; then the e-course's price saves from its new version — no false „Muudeti teises aknas“ — and the focus is back on the radio
    const toOnline = partSaved(page, "basics");
    await page.locator("[data-type-switch]").getByRole("radio", { name: "E-õpe" }).check();
    await toOnline;
    await expect(page.locator("[data-cards-waiting]")).toHaveCount(0);
    await expect(page.locator("[data-type-switch]").getByRole("radio", { name: "E-õpe" })).toBeFocused();
    const priced = partSaved(page, "price");
    await page.getByLabel("Hind (€)").fill("120");
    await page.getByLabel("Hind (€)").blur();
    await priced;
    await expect(chip(page)).toHaveAttribute("data-save-kind", "saved");
    expect(await onLocalDb((sql) => sql`select type, price, price_group from courses where slug = ${slug}`)).toEqual([{ type: "e_learning", price: 12000, price_group: null }]);
    await page.goto("/admin/koolitused");
    await adminReady(page);
    await expect(page.locator(`[data-course-row="${slug}"] [data-course-state]`)).toHaveText("Mustand");
  });

  // The order is the whole catalogue's, so the tests that change it take turns (the desktop and the phone project run side by side), and the order is
  // put back afterwards (undone in reverse: the snapshot first, the lock let go last).
  const takeOrder = async () => {
    undo.push(await holdLocalLock("e2e-course-order"));
    undo.push(await snapshotOrder());
  };
  // the seed courses only: the other project may add a draft at the end meanwhile
  const seedOrder = async () => (await courseOrder()).filter((s) => !s.startsWith(NEW_COURSE_SLUG_PREFIX));
  const handleOf = (page: Page, title: string) => page.getByRole("button", { name: `Lohista: ${title}` });
  const courseRow = (page: Page, slug: string) => page.locator(`[data-course-row="${slug}"]`);
  const announced = (page: Page) => page.locator("[data-course-list] [role=status]");

  test("course order (B1): the handle, ↑ / ↓ and the keyboard are the public order; a filtered view cannot reorder", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(isMobile, "the phone has its own, below: the „↕“ menu and a finger on the handle");
    info.setTimeout(info.timeout + LOCK_WAIT_MS);
    const c = mine(info);
    await takeOrder();
    await signIn(page, context, visitorIp);
    const order = await seedOrder();
    const at = order.indexOf(c.slug);
    expect(at).toBeGreaterThan(0);
    await page.goto("/admin/koolitused");
    await adminReady(page);

    // the columns of the README: the heading row has "Järjekord", and "Muudetud" is gone; the title has "{tase} · /{slug}", the handle says "lohistatav"
    const head = page.locator("[data-course-head]");
    await expect(head).toContainText("Järjekord");
    await expect(head).not.toContainText("Muudetud");
    await expect(courseRow(page, c.slug).locator("[data-course-sub]")).toHaveText(new RegExp(`koolitus · /${c.slug}$`));
    await expect(handleOf(page, c.title)).toHaveAttribute("aria-roledescription", "lohistatav");
    expect(await noOverflow(page)).toBe(true);
    // the pills carry their counts, and the two forms add up to the whole
    const counts = await page.locator("[data-list-pills] a").evaluateAll((links) => links.map((a) => Number((a.textContent ?? "").replace(/\D+/g, ""))));
    expect(counts).toHaveLength(3);
    expect(counts[1] + counts[2]).toBe(counts[0]);
    expect(counts[0]).toBeGreaterThanOrEqual(6);

    // ↑ moves the course one place: stored, read out, the focus stays on the button, and the public catalogue has it
    await page.getByRole("button", { name: `Liiguta üles: ${c.title}` }).click();
    await expect.poll(seedOrder).toEqual([...order.slice(0, at - 1), c.slug, order[at - 1], ...order.slice(at + 1)]);
    await expect(page.getByRole("button", { name: `Liiguta üles: ${c.title}` })).toBeFocused();
    await expect(page.locator("[data-course-row]").nth(at - 1)).toHaveAttribute("data-course-row", c.slug);
    await expect(announced(page)).toHaveText(`„${c.title}“ on nüüd ${at}. kohal.`);
    await page.goto("/koolitused");
    await expect(page.locator("[data-course-card]").nth(at - 1)).toHaveAttribute("href", `/koolitused/${c.slug}`);

    // the first course cannot go up
    await page.goto("/admin/koolitused");
    await adminReady(page);
    await expect(page.locator("[data-course-row]").first().getByRole("button", { name: /Liiguta üles/ })).toHaveAttribute("aria-disabled", "true");

    // a drag with the mouse puts it back: the handle down over the next row (the row is lifted while it goes; one move is stored)
    const handle = handleOf(page, c.title);
    await handle.scrollIntoViewIfNeeded();
    const from = (await handle.boundingBox())!;
    const next = (await courseRow(page, order[at - 1]).boundingBox())!; // (the course that is now one place after it)
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, next.y + next.height / 2 + 4, { steps: 12 });
    await expect(courseRow(page, c.slug).locator("xpath=ancestor::li")).toHaveAttribute("data-dragging", "");
    await page.mouse.up();
    await expect.poll(seedOrder).toEqual(order);
    await expect(page.locator("[data-course-row]").nth(at)).toHaveAttribute("data-course-row", c.slug);
    await expect(handleOf(page, c.title)).toBeFocused();
    await expect(announced(page)).toHaveText(`„${c.title}“ on nüüd ${at + 1}. kohal.`);
    // a drag that ends where it began moves nothing
    const again = (await handle.boundingBox())!;
    await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
    await page.mouse.down();
    await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2 + 10, { steps: 4 });
    await page.mouse.up();
    expect(await seedOrder()).toEqual(order);

    // ↓ with the keyboard on the handle (it says „lohistatav“, so the arrow keys move it), and ↑ with the button
    await handle.focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(seedOrder).toEqual([...order.slice(0, at), order[at + 1], c.slug, ...order.slice(at + 2)]);
    await expect(handleOf(page, c.title)).toBeFocused();
    await page.getByRole("button", { name: `Liiguta üles: ${c.title}` }).click();
    await expect.poll(seedOrder).toEqual(order);

    // a filtered view cannot reorder: no handles, no arrows, no menus, and the hint says where it can
    await page.goto("/admin/koolitused?vorm=e");
    await adminReady(page);
    await expect(page.locator("[data-course-row]").first()).toBeVisible();
    await expect(page.locator("[data-drag-tool]")).toHaveCount(0);
    await expect(page.locator("[data-order-hint]")).toHaveText("Järjekorda saab muuta vaates „Kõik“.");
    await expect(page.locator("[data-list-pills] a[aria-current=true]")).toContainText("E-õpe");
    await page.goto("/admin/koolitused");
    await adminReady(page);
    await expect(page.locator("[data-order-hint]")).toHaveCount(0);
    await expect(page.locator("[data-drag-tool=handle]").first()).toBeVisible();
  });

  test("course order on a phone (B1): the „↕“ menu and a finger on the handle", async ({ page, context, visitorIp, isMobile }, info) => {
    test.skip(!isMobile, "the desktop project drags with a mouse, above");
    info.setTimeout(info.timeout + LOCK_WAIT_MS);
    const c = mine(info);
    await takeOrder();
    await signIn(page, context, visitorIp);
    const order = await seedOrder();
    const others = order.filter((s) => s !== c.slug);
    await page.goto("/admin/koolitused");
    await adminReady(page);

    // the phone card of the frame: the handle, the thumbnail, the title over „{Õppevorm} · {Staatus}“ and the round „↕“; no arrows, no price, no headings
    const row = courseRow(page, c.slug);
    await expect(row.locator("[data-course-line]")).toHaveText(/^E-õpe · .+ · Näidis$/);
    await expect(row.locator("[data-course-state]")).toBeHidden();
    await expect(row.locator("[data-drag-tool=up]")).toBeHidden();
    await expect(row.locator("[data-course-price]")).toBeHidden();
    await expect(page.locator("[data-course-head]")).toBeHidden();
    const menu = page.getByRole("button", { name: `Liiguta: ${c.title}` });
    const target = (await menu.boundingBox())!;
    expect(Math.min(target.width, target.height)).toBeGreaterThanOrEqual(44);
    const grip = (await handleOf(page, c.title).boundingBox())!;
    expect(Math.min(grip.width, grip.height)).toBeGreaterThanOrEqual(44);
    expect(await noOverflow(page)).toBe(true);

    // „Esimeseks“, then „Viimaseks“; the focus is back on the „↕“ each time and the move is read out
    await menu.tap();
    await expect(page.getByRole("menuitem")).toHaveText(["Üles", "Alla", "Esimeseks", "Viimaseks"]);
    await page.getByRole("menuitem", { name: "Esimeseks" }).tap();
    await expect.poll(seedOrder).toEqual([c.slug, ...others]);
    await expect(menu).toBeFocused();
    await expect(announced(page)).toHaveText(`„${c.title}“ on nüüd 1. kohal.`);
    await menu.tap();
    await expect(page.getByRole("menuitem", { name: "Üles" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("menuitem", { name: "Esimeseks" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: "Viimaseks" }).tap();
    await expect.poll(seedOrder).toEqual([...others, c.slug]);
    await expect(menu).toBeFocused();
    // the stored order is what a reload shows
    await page.reload();
    await adminReady(page);
    // (the seed courses' rows: the other project's new course may stand among them meanwhile, at the end of the list)
    const seedRows = async () =>
      (await page.locator("[data-course-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-course-row") ?? ""))).filter((s) => !s.startsWith(NEW_COURSE_SLUG_PREFIX));
    await expect.poll(async () => (await seedRows()).at(-1)).toBe(c.slug);

    // a finger on the handle drags it one place up: the page does not scroll with it, one move is stored, no row doubled or lost
    const handle = handleOf(page, c.title);
    // (to the middle of the screen: `next dev`'s own round badge sits at the bottom left, over the last row's handle, and a finger would land on it)
    await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const from = (await handle.boundingBox())!;
    const previous = (await courseRow(page, others[others.length - 1]).boundingBox())!;
    await dragWithFinger(page, { x: from.x + from.width / 2, y: from.y + from.height / 2 }, { x: from.x + from.width / 2, y: previous.y + previous.height / 2 - 4 });
    await expect.poll(seedOrder).toEqual([...others.slice(0, -1), c.slug, others[others.length - 1]]);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await expect(handleOf(page, c.title)).toBeFocused();
    await expect(announced(page)).toHaveText(`„${c.title}“ on nüüd ${order.length - 1}. kohal.`);
    await page.reload();
    await adminReady(page);
    const shown = await page.locator("[data-course-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-course-row") ?? ""));
    expect(shown.filter((s) => !s.startsWith(NEW_COURSE_SLUG_PREFIX))).toEqual(await seedOrder());
    expect(new Set(shown).size).toBe(shown.length);
  });

  test("'Teadmiste test' (e-course completion): a question without a right answer is held back, marked in its card, nothing saved; with one it autosaves and goes live with the course", async ({ page, context, visitorIp }, info) => {
    const c = mine(info);
    const id = await changing(c.slug);
    const before = await storedCourseTest(id);
    await signIn(page, context, visitorIp);
    await page.goto(`/admin/koolitused/${id}`);
    await adminReady(page);

    const editor = page.locator("[data-test-editor]");
    await expect(editor).toContainText("Muudatused kehtivad uutele katsetele; tehtud katsed jäävad nii, nagu need esitati.");
    await editor.locator("[data-question-add]").click();
    const question = editor.locator('[data-question="0"]');
    await expect(question.locator("[data-question-text]")).toBeFocused();
    await question.locator("[data-question-text]").fill("Mitu kihti värvi kanname?");
    await question.locator('[data-option="0"] [data-option-text]').fill("Ühe");
    const refused = partSaved(page, "test", 400);
    await question.locator('[data-option="1"] [data-option-text]').fill("Kaks");
    await question.locator('[data-option="1"] [data-option-text]').blur();
    await refused;
    // the check's words in the question's card; the chip says a field waits; nothing is stored, not even a draft
    await expect(chip(page)).toHaveAttribute("data-save-kind", "invalid");
    await expect(question).toHaveAttribute("data-invalid", "");
    await expect(question).toContainText("Märgi vähemalt üks vastus õigeks.");
    expect(await storedCourseTest(id)).toEqual(before);
    expect(await onLocalDb((sql) => sql`select part from content_drafts where entity = 'course' and entity_id = ${id} and part = 'test'`)).toHaveLength(0);
    // „Näita“ goes to it
    await chip(page).getByRole("button", { name: "Näita" }).click();
    await expect(question).toBeFocused();

    const saved = partSaved(page, "test");
    await question.locator('[data-option="1"] [data-option-correct]').check();
    await editor.locator("[data-test-pass]").fill("90");
    await editor.locator("[data-test-pass]").blur();
    await saved;
    await expect(question).not.toHaveAttribute("data-invalid", "");
    await expect(barWords(page)).toHaveText(draftWords("Teadmiste test"));
    await publish(page);
    expect(await storedCourseTest(id)).toMatchObject({
      passPercent: 90,
      tries: 3,
      questions: [{ kind: "choice", text: "Mitu kihti värvi kanname?", options: [{ text: "Ühe", correct: false }, { text: "Kaks", correct: true }] }],
    });
    expect(await noOverflow(page)).toBe(true);
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

    // the list (B3, piece 3b): no search field; the city select limits it to this session (the address says so) and the pills count what is then shown;
    // the course select too; the whole row, not only its name, opens the drawer on the same list
    await page.goto("/admin/kalender");
    await adminReady(page);
    const toolbar = page.locator("[data-list-toolbar]");
    await expect(toolbar.locator("input")).toHaveCount(0);
    await expect(toolbar.getByLabel("Koolitus", { exact: true })).toHaveValue("");
    await expect(toolbar.getByLabel("Linn", { exact: true })).toHaveValue("");
    await toolbar.getByLabel("Linn", { exact: true }).selectOption(city);
    await expect(page).toHaveURL((url) => url.pathname === "/admin/kalender" && url.searchParams.get("linn") === city);
    const timePills = page.getByRole("navigation", { name: "Aeg" });
    await expect(timePills.getByRole("link", { name: /^Tulevased/ })).toHaveText("Tulevased1");
    await expect(timePills.getByRole("link", { name: /^Möödunud/ })).toHaveText("Möödunud0");
    await expect(page.locator("[data-session-row]")).toHaveCount(1);
    await expect(page.locator("[data-calendar-count]")).toHaveText("Toimumisi: 1");
    expect(await noOverflow(page)).toBe(true);
    await toolbar.getByLabel("Koolitus", { exact: true }).selectOption({ label: "Lash Lift BOTOX baaskoolitus" }); // another course: nothing in this city
    await expect(page.locator("[data-list-empty]")).toContainText("Selle valikuga toimumisi pole.");
    await expect(timePills.getByRole("link", { name: /^Tulevased/ })).toHaveText("Tulevased0");
    await toolbar.getByLabel("Koolitus", { exact: true }).selectOption(String((await storedCourse(COURSE.slug)).id));
    await expect(page.locator("[data-session-row]")).toHaveCount(1);

    // edit: cancelled, 3 seats. A click on the row away from its name link opens the drawer, and the link is still the keyboard's way in
    const link = page.getByRole("link", { name: `Muuda toimumist: ${COURSE.title}, ${when.shown}, ${city}` });
    await expect(link).toBeVisible();
    await page.locator("[data-session-row]").locator("td").first().click();
    await expect(page).toHaveURL((url) => url.searchParams.get("id") === String(stored.id) && url.searchParams.get("linn") === city);
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
