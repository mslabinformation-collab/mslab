import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { clientEmail } from "./account";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { accountCourseSlug, onLocalDb, removeAdminRows, removeClientRows } from "./fixtures";
import { smallTargets } from "./targets";
import { submitsForms, test, expect } from "./test";
import { dragWithFinger } from "./touch";

// Phase 3a Task 5, admin UX pass piece 3a Task 9: the course editor's "Moodulid ja õppetunnid" — modules added, renamed in their row (autosaved,
// no "Salvesta"), moved (drag with the mouse or a finger, ↑ / ↓) and deleted (a ConfirmPanel); a lesson added (it opens in the drawer), moved and
// deleted; the video tags ("Valmis", "Töötlemisel {n}%", "Video puudub", "Tekst"); and the contact course's "Programm" with its „Kas kustutan punkti
// …?“. Task 10, the lesson drawer (README B2): „Moodul {nn} · Õppetund {n.n}“, the short text autosaved (✕ and Esc wait for its save, no question of
// the drawer's own), "Õppetunni liik" with its ConfirmPanel, a file added, removed with the UndoBar inside the open dialog (ledger T6-8: in a real
// browser the bar stands above the modal and can be pressed) and brought back, then purged once its mark is 10 s old; „Õpilastele nähtav“ with its
// UndoBar; a 375 × 812 phone. The admin signs in as Dim through the devLink (dev server only, admin-login.ts). The test's own unpublished e-course
// (slug e2e-konto-les-<project>) is removed after each test with everything under it (removeClientRows: modules, lessons and their files cascade),
// and the files it uploaded leave .media-local then too (also after a failed run). Its courses stay unpublished: a published one would show on the
// public catalogue the other specs read meanwhile (the draft layer's paths are the DOM and db tests').

const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
const made = new Set<string>();
/** Store keys this worker's tests uploaded (removed from .media-local after each test, whatever happened). */
const storedKeys = new Set<string>();

test.beforeEach(() => submitsForms());

/** A stored lesson file in the dev server's folder (server/media-local.ts: <key> and <key>.type). */
const localPath = (key: string) => join(process.cwd(), ".media-local", ...key.split("/"));

test.afterEach(async () => {
  for (const email of made) {
    // the files of the test's course: the rows say which (a file whose row is gone was recorded when it was uploaded)
    const rows = await db((sql) => sql<{ key: string }[]>`
      select f.r2_key as key from lesson_files f join lessons l on l.id = f.lesson_id join course_modules m on m.id = l.module_id join courses c on c.id = m.course_id
      where c.slug = ${accountCourseSlug(email)}`);
    for (const { key } of rows) storedKeys.add(key);
  }
  for (const key of storedKeys) for (const path of [localPath(key), `${localPath(key)}.type`]) rmSync(path, { force: true });
  storedKeys.clear();
  for (const email of made) await removeClientRows(email);
  made.clear();
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
});

const db = <T>(work: Parameters<typeof onLocalDb<T>>[0]) => onLocalDb(work, { marksPages: false });
const moduleTitles = (courseId: number) =>
  db(async (sql) => (await sql<{ t: string }[]>`select title->>'et' as t from course_modules where course_id = ${courseId} order by position, id`).map((r) => r.t));
const moduleId = async (courseId: number, title: string) =>
  (await db((sql) => sql<{ id: number }[]>`select id from course_modules where course_id = ${courseId} and title->>'et' = ${title}`))[0].id;
const lessonRow = async (id: number) =>
  (await db((sql) => sql<{ kind: string; body: { et: string } | null; hidden: boolean; videoId: string | null; videoStatus: string }[]>`
    select kind, body, hidden, video_id as "videoId", video_status as "videoStatus" from lessons where id = ${id}`))[0];
const lessonTitles = (moduleId: number) =>
  db(async (sql) => (await sql<{ t: string }[]>`select title->>'et' as t from lessons where module_id = ${moduleId} order by position, id`).map((r) => r.t));
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/** The module names on the page, in order (their Estonian fields). */
const shownModules = (page: Page) => page.locator("[data-lessons-editor] [data-module] [data-i18n^='module-']").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const shownLessons = (page: Page, moduleId: number) => page.locator(`[data-module="${moduleId}"] [data-lesson]`).evaluateAll((els) => els.map((e) => e.querySelector("[data-lesson-title]")?.textContent ?? ""));
const lessonOfAddress = (page: Page) => Number(new URL(page.url()).searchParams.get("oppetund"));

/** A radio's, a switch's or a file field's touch target is its label (the Choice pill, the switch's row, the drop zone), as in admin-site.spec.ts: those labels are measured instead. */
const LABELLED = /^<input[^>]*\stype="(radio|checkbox|file)"/;

/** The touch targets and the width at 390 px (a phone; the desktop project too, for a moment). */
async function checkPhone(page: Page, isMobile: boolean | undefined) {
  if (!isMobile) await page.setViewportSize({ width: 390, height: 844 });
  const scope = page.locator("[data-lessons-editor], dialog[data-drawer]");
  expect((await smallTargets(scope)).filter((html) => !LABELLED.test(html))).toEqual([]);
  const labels = await scope
    .locator("input[type=radio], input[type=checkbox], input[type=file]")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).labels?.[0]?.getBoundingClientRect().height ?? 0));
  for (const height of labels) expect(height).toBeGreaterThanOrEqual(44);
  expect(await noOverflow(page)).toBe(true);
  const drawer = page.locator("dialog[data-drawer]");
  if (await drawer.count()) expect(await drawer.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
  if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
}

/**
 * The lesson drawer at 375 × 812 (both projects, for a moment; the plan's Review Focus 5): the whole screen, nothing wider than it, every control a 44 px
 * target, the phone's „Vali fail“ in place of the drag text, and the kind a segmented control (its two halves side by side).
 */
async function checkDrawer375(page: Page) {
  const before = page.viewportSize()!;
  await page.setViewportSize({ width: 375, height: 812 });
  const drawer = page.locator("dialog[data-drawer]");
  expect((await drawer.boundingBox())!.width).toBe(375);
  expect((await smallTargets(drawer)).filter((html) => !LABELLED.test(html))).toEqual([]);
  const labels = await drawer
    .locator("input[type=radio], input[type=checkbox], input[type=file]")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).labels?.[0]?.getBoundingClientRect().height ?? 0));
  for (const height of labels) expect(height).toBeGreaterThanOrEqual(44);
  expect(await drawer.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
  await expect(drawer.locator("[data-drop-phone]")).toBeVisible();
  await expect(drawer.locator("[data-drop-phone]")).toHaveText("Vali fail");
  await expect(drawer.locator("[data-drop-wide]")).toBeHidden();
  const [video, text] = await drawer.locator("[data-lesson-kind] label").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
  expect(Math.abs(video.top - text.top)).toBeLessThan(1);
  expect(Math.abs(video.width - text.width)).toBeLessThan(1);
  await page.setViewportSize(before);
}

test("guard: the course editor and its lesson drawer need an admin session", async ({ request }) => {
  for (const path of ["/admin/koolitused/1", "/admin/koolitused/1?oppetund=1"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect([303, 307, 308], path).toContain(res.status());
    // B19: the login page keeps the page asked for as ?tagasi=
    const login = new URL(res.headers().location, "http://x");
    expect(login.pathname, path).toBe("/admin/login");
    expect(login.searchParams.get("tagasi"), path).toBe(path);
  }
});

test("Moodulid ja õppetunnid: modules, a lesson in the drawer (text, kind, file, hide, move, delete); a contact course's Programm", async ({ page, context, visitorIp, isMobile }, info) => {
  test.slow(); // one long flow: under the whole suite's load on `next dev` it needs more than the default 30 s
  const email = clientEmail("les", info.project.name);
  made.add(email);
  await removeClientRows(email);
  const [{ id: courseId }] = await db(
    (sql) => sql<{ id: number }[]>`insert into courses (slug, type, level, title, summary, body, price, access_months, published)
      values (${accountCourseSlug(email)}, 'e_learning', 'basic', ${sql.json({ et: "E2E õppetunnid" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 9500, 6, false) returning id`,
  );
  await signInAsAdmin(page, context, visitorIp, created);

  // 1. the part under the course editor, empty
  await page.goto(`/admin/koolitused/${courseId}`);
  await adminReady(page);
  const editor = page.locator("[data-lessons-editor]");
  await expect(editor.locator("h2")).toHaveText("Moodulid ja õppetunnid");
  await expect(editor).toContainText("Õpilane avab õppetunnid järjekorras: järgmine avaneb, kui eelmine on tehtud.");
  // (P-4: nothing yet stands in the summary's place)
  await expect(editor.locator("[data-modules-summary]")).toHaveText("Mooduleid veel pole.");

  // 2. two modules; a blank name is refused in words; ↓ on the first (the focus stays on the arrow), and the database agrees
  const addModule = editor.locator("[data-add-module]");
  const newModule = addModule.getByLabel("Uue mooduli nimi");
  await addModule.getByRole("button", { name: "Lisa moodul" }).click();
  await expect(addModule.getByRole("status")).toHaveText("Kirjuta nimi.");
  for (const [title, n] of [["Sissejuhatus", 1], ["Praktika", 2]] as const) {
    await newModule.fill(title);
    await addModule.getByRole("button", { name: "Lisa moodul" }).click();
    await expect(editor.locator("[data-module]")).toHaveCount(n);
    await expect(newModule).toHaveValue("");
  }
  await expect(addModule.getByRole("status")).toHaveText("");
  const down = editor.getByRole("button", { name: "Liiguta alla: Sissejuhatus" });
  await down.click();
  await expect.poll(() => shownModules(page)).toEqual(["Praktika", "Sissejuhatus"]);
  await expect(down).toBeFocused();
  await expect(down).toHaveAttribute("aria-disabled", "true"); // last now
  // (the list shows a move at once; the stored order follows with the action's answer)
  await expect.poll(() => moduleTitles(courseId)).toEqual(["Praktika", "Sissejuhatus"]);
  const intro = await moduleId(courseId, "Sissejuhatus");
  const practice = await moduleId(courseId, "Praktika");

  await expect(editor.locator("[data-modules-summary]")).toHaveText("2 moodulit · 0 õppetundi");

  // a module's name edits in its row and autosaves on its own route (README B2, R-b2): nothing to press
  const practiceRow = editor.locator(`[data-module="${practice}"]`);
  const practiceName = practiceRow.getByRole("textbox", { name: "Mooduli nimi" });
  await practiceName.fill("Praktika ja kordamine");
  await expect(practiceRow.getByRole("button", { name: "Salvesta" })).toHaveCount(0);
  const renamed = page.waitForResponse((r) => r.url().endsWith(`/api/admin/moodul/${practice}`) && r.request().method() === "POST" && r.status() === 200);
  await practiceName.blur();
  await renamed;
  await expect.poll(() => moduleTitles(courseId)).toEqual(["Praktika ja kordamine", "Sissejuhatus"]);
  await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-kind", "saved");

  // 3. a lesson in Sissejuhatus: it opens in the drawer
  const introRow = editor.locator(`[data-module="${intro}"]`);
  await expect(introRow).toContainText("Selles moodulis pole veel õppetunde.");
  await introRow.locator(`[data-add-lesson="${intro}"]`).getByLabel("Uue õppetunni nimi").fill("Tere tulemast");
  await introRow.getByRole("button", { name: "Lisa õppetund" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/koolitused/${courseId}\\?oppetund=\\d+$`));
  const first = lessonOfAddress(page);
  const drawer = page.locator("dialog[data-drawer]");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(`[data-lesson-drawer="${first}"]`)).toBeVisible();
  await expect(drawer.getByRole("heading", { level: 2 })).toHaveText("Tere tulemast");
  // (README B2: its place as the card numbers it — Sissejuhatus is the second module now)
  await expect(drawer.locator("[data-lesson-place]")).toHaveText("Moodul 02 · Õppetund 2.1");
  await expect(drawer.locator("[data-save-status]")).toBeVisible();
  await expect(drawer.getByRole("textbox", { name: "Õppetunni nimi" })).toHaveValue("Tere tulemast");
  const row = editor.locator(`[data-lesson="${first}"]`);
  await expect(editor.locator(`[data-module="${intro}"] [data-lesson]`)).toHaveCount(1); // the second module's first lesson
  await expect(row.locator("[data-lesson-title]")).toHaveText("Tere tulemast");
  await expect(editor.locator("[data-modules-summary]")).toHaveText("2 moodulit · 1 õppetund");
  // an e-course with a lesson keeps its type: the course editor's Kontaktõpe is locked and says why
  await expect(page.locator("[data-type-switch]").getByRole("radio", { name: "Kontaktõpe" })).toBeDisabled();
  await expect(page.locator("[data-type-hint]")).toHaveText("Sellel e-koolitusel on õppetunde või õpilasi, seega õppevormi muuta ei saa. Vajadusel loo uus koolitus.");

  // 4. the short text autosaves on its route (README B2, R-b2): no „Salvesta“; leaving the field saves it, the drawer's chip says so
  const body = drawer.getByRole("textbox", { name: "Lühike tekst" });
  await expect(drawer.getByRole("button", { name: "Salvesta" })).toHaveCount(0);
  const textSaved = page.waitForResponse((r) => r.url().endsWith(`/api/admin/oppetund/${first}`) && r.request().method() === "POST" && r.status() === 200);
  await body.fill("Vaata video lõpuni.\n\nSiis jätka.");
  await expect(drawer.locator("[data-save-status]")).toHaveAttribute("data-save-kind", "dirty");
  await body.blur();
  await textSaved;
  await expect(drawer.locator("[data-save-status]")).toHaveAttribute("data-save-kind", "saved");
  await expect.poll(async () => (await lessonRow(first)).body).toEqual({ et: "Vaata video lõpuni.\n\nSiis jätka." });
  await expect(drawer.locator("[data-leave-notice]")).toHaveCount(0);

  // 4a. "Õppetunni liik": Video by default ("Video puudub" in the list); Tekst at once (no video yet); Video again
  const kind = drawer.locator("[data-lesson-kind]");
  await expect(kind.getByRole("radio", { name: "Video" })).toBeChecked();
  await expect(row.locator("[data-lesson-video]")).toHaveText("Video puudub");
  await kind.getByRole("radio", { name: "Tekst" }).check();
  await expect(row.locator("[data-lesson-kind='text']")).toHaveText("Tekst");
  expect((await lessonRow(first)).kind).toBe("text");
  await kind.getByRole("radio", { name: "Video" }).check();
  await expect(row.locator("[data-lesson-video]")).toHaveText("Video puudub");
  expect((await lessonRow(first)).kind).toBe("video");

  // 4b. with a video, Tekst asks first in a ConfirmPanel (README B2): „Katkesta“ keeps it (the radio goes back, with the focus); „Jah, vaheta“ drops
  // the video, and the focus is on Tekst
  await db((sql) => sql`update lessons set video_id = ${`e2e-video-${info.project.name}`}, video_status = 'ready', duration_sec = 754 where id = ${first}`);
  await page.reload();
  await adminReady(page);
  await expect(row.locator("[data-lesson-video]")).toHaveText("Valmis"); // README B2, P-4 (the drawer keeps „Valmis · 12:34“)
  await kind.getByRole("radio", { name: "Tekst" }).check();
  const confirm = kind.locator("[data-confirm-panel]");
  await expect(confirm).toBeFocused();
  await expect(confirm.locator("p")).toHaveText("Kas vahetan liigi?");
  await expect(confirm.locator("li")).toHaveText(["Video kustutatakse."]);
  await confirm.getByRole("button", { name: "Katkesta" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(kind.getByRole("radio", { name: "Video" })).toBeChecked();
  await expect(kind.getByRole("radio", { name: "Video" })).toBeFocused();
  expect(await lessonRow(first)).toMatchObject({ kind: "video", videoId: `e2e-video-${info.project.name}`, videoStatus: "ready" });
  await kind.getByRole("radio", { name: "Tekst" }).check();
  await confirm.getByRole("button", { name: "Jah, vaheta" }).click();
  await expect(row.locator("[data-lesson-kind='text']")).toHaveText("Tekst");
  await expect(confirm).toHaveCount(0);
  await expect(kind.getByRole("radio", { name: "Tekst" })).toBeFocused();
  expect(await lessonRow(first)).toMatchObject({ kind: "text", videoId: null, videoStatus: "none" });
  await kind.getByRole("radio", { name: "Video" }).check();
  await expect(row.locator("[data-lesson-video]")).toHaveText("Video puudub");

  // 5. a file: added (a lessons/ key in the store) through the drop zone's picker
  const files = drawer.locator("[data-lesson-files]");
  await expect(files.locator("[data-lesson-file]")).toHaveCount(0);
  if (isMobile) await expect(files.locator("[data-drop-phone]")).toHaveText("Vali fail");
  else await expect(files.locator("[data-drop-wide]")).toHaveText("Lohista fail siia või vali fail · PDF, Word, pilt, kuni 4 MB");
  // while it uploads (held back here), the zone is aria-disabled, the line says so, a second pick is ignored, and ✕ asks through the leave guard
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let posts = 0;
  await page.route("**/api/admin/lesson-file", async (route) => {
    posts++;
    await held;
    await route.continue();
  });
  const picker = files.locator("input[type=file]");
  await picker.setInputFiles({ name: "Juhend.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%e2e\n") });
  await expect(files.locator("[data-file-status]")).toHaveText("Laen faili üles…");
  await expect(files.locator("[data-file-add]")).toHaveAttribute("aria-disabled", "true");
  await picker.setInputFiles({ name: "Teine.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%teine\n") });
  await drawer.getByRole("button", { name: "Sulge" }).click();
  const notice = drawer.locator("[data-leave-notice='drawer']");
  await expect(notice.locator("[data-leave-title]")).toHaveText("Muudatust „Failid“ ei saanud veel salvestada.");
  await expect(notice.locator("[data-leave-reason]")).toHaveText("Üleslaadimine käib.");
  await notice.getByRole("button", { name: "Jää siia" }).click();
  await expect(drawer).toBeVisible();
  release();
  await expect(files.locator("[data-file-status]")).toHaveText("Fail lisatud.");
  await page.unroute("**/api/admin/lesson-file");
  expect(posts).toBe(1);
  await expect(files.locator("[data-file-add]")).not.toHaveAttribute("aria-disabled");
  await expect(files.locator("[data-lesson-file]")).toHaveCount(1);
  await expect(files.locator("[data-lesson-file]")).toHaveText(/^Juhend\.pdf · \d+ kB/);
  const fileRows = () => db((sql) => sql<{ key: string; removed: boolean }[]>`select r2_key as key, removed_at is not null as removed from lesson_files where lesson_id = ${first}`);
  const stored = await fileRows();
  expect(stored).toHaveLength(1);
  storedKeys.add(stored[0].key);
  expect(stored[0].key).toMatch(/^lessons\/[0-9a-f-]{36}\.pdf$/);
  const path = localPath(stored[0].key);
  expect(existsSync(path)).toBe(true);

  // 5a. „Eemalda“ at once with the UndoBar „Fail eemaldatud.“ (S3-P3-c) — inside the open modal dialog, above it and pressable (ledger T6-8); the row is
  // only marked, the stored file stays; „Võta tagasi“ brings it back
  const undoBar = page.locator("[data-undo-bar]");
  await files.getByRole("button", { name: "Eemalda fail: Juhend.pdf" }).click();
  await expect(files.locator("[data-lesson-file]")).toHaveCount(0);
  await expect(undoBar).toBeVisible();
  await expect(undoBar.locator("p")).toHaveText("Fail eemaldatud.");
  expect(await undoBar.evaluate((el) => el.closest("dialog[data-drawer][open]") !== null)).toBe(true);
  const undoButton = undoBar.getByRole("button", { name: "Võta tagasi" });
  // nothing covers it: the hit test lands on the button itself (a trial click), and its box is on the screen
  await undoButton.click({ trial: true });
  const box = (await undoButton.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expect.poll(fileRows).toEqual([{ key: stored[0].key, removed: true }]);
  expect(existsSync(path)).toBe(true);
  await undoButton.click();
  await expect(undoBar).toHaveCount(0);
  await expect(files.locator("[data-lesson-file]")).toHaveCount(1);
  await expect(drawer).toBeVisible();
  expect(await fileRows()).toEqual([{ key: stored[0].key, removed: false }]);
  // removed again; Esc takes the bar away and leaves the drawer open; once the mark is 10 s old (set back here instead of waiting), the next read of
  // the page purges the row and the stored file (R-f)
  await files.getByRole("button", { name: "Eemalda fail: Juhend.pdf" }).click();
  await expect(undoBar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(undoBar).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect.poll(fileRows).toEqual([{ key: stored[0].key, removed: true }]);
  await db((sql) => sql`update lesson_files set removed_at = now() - interval '11 seconds' where lesson_id = ${first}`);
  await page.reload();
  await adminReady(page);
  await expect.poll(fileRows).toEqual([]);
  await expect.poll(() => existsSync(path)).toBe(false);

  // 6. „Õpilastele nähtav“ (the shared Switch): off → „Peidetud“ in the list behind the drawer and the UndoBar „Õppetund peidetud.“, whose „Võta tagasi“
  // shows it again; switched on by hand, no bar
  const visibility = drawer.locator("[data-lesson-visibility]");
  const visible = visibility.getByRole("switch", { name: "Õpilastele nähtav" });
  await expect(visible).toBeChecked();
  await visible.click();
  await expect(row.locator("[data-lesson-hidden]")).toHaveText("Peidetud");
  await expect(undoBar.locator("p")).toHaveText("Õppetund peidetud.");
  await expect(visible).not.toBeChecked();
  // "Peidetud" is a quiet tag; "Video puudub" (it locks the lessons after it) keeps the warning colours
  const tone = (tag: string) => row.locator(tag).evaluate((e) => `${getComputedStyle(e).backgroundColor} ${getComputedStyle(e).color}`);
  await expect(row.locator("[data-lesson-video]")).toHaveText("Video puudub");
  expect(await tone("[data-lesson-hidden]")).not.toBe(await tone("[data-lesson-video]"));
  await expect(visibility).toContainText("Peidetud: õpilased seda ei näe ja see ei loe edenemises.");
  expect((await lessonRow(first)).hidden).toBe(true);
  await undoBar.getByRole("button", { name: "Võta tagasi" }).click();
  await expect(row.locator("[data-lesson-hidden]")).toHaveCount(0);
  await expect(visible).toBeChecked();
  expect((await lessonRow(first)).hidden).toBe(false);
  await visible.click();
  await expect(undoBar).toBeVisible();
  await expect.poll(async () => (await lessonRow(first)).hidden).toBe(true);
  await visible.click();
  await expect(undoBar).toHaveCount(0);
  await expect(visible).toBeChecked();
  await expect.poll(async () => (await lessonRow(first)).hidden).toBe(false);

  // the drawer at 375 × 812
  await checkDrawer375(page);

  // 10 (with the drawer open). a phone: every control at least 44 px, nothing wider than the screen
  await checkPhone(page, isMobile);

  // the drawer closes back to the course, the focus on the lesson's "Muuda"
  await drawer.getByRole("button", { name: "Sulge" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/admin/koolitused/${courseId}$`));
  await expect(page.locator(`#edit-lesson-${first}`)).toBeFocused();

  // 7. a second lesson; ↑ puts it first; deleted from its drawer (after the question), the drawer closes
  await introRow.locator(`[data-add-lesson="${intro}"]`).getByLabel("Uue õppetunni nimi").fill("Teine");
  await introRow.getByRole("button", { name: "Lisa õppetund" }).click();
  await expect(page).toHaveURL(/\?oppetund=\d+$/);
  const second = lessonOfAddress(page);
  expect(second).not.toBe(first);
  await expect(drawer.getByRole("textbox", { name: "Õppetunni nimi" })).toHaveValue("Teine");
  await expect(drawer.locator("[data-lesson-place]")).toHaveText("Moodul 02 · Õppetund 2.2");
  await expect(drawer.locator("[data-save-status]")).toHaveAttribute("data-save-kind", "saved");
  await page.keyboard.press("Escape"); // nothing unsaved: it closes at once
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/admin/koolitused/${courseId}$`));
  const up = editor.getByRole("button", { name: "Liiguta üles: Teine" });
  await up.click();
  await expect.poll(() => shownLessons(page, intro)).toEqual(["Teine", "Tere tulemast"]);
  await expect(up).toBeFocused();
  expect(await lessonTitles(intro)).toEqual(["Teine", "Tere tulemast"]);
  // ↑ again: into the end of the module before (Praktika ja kordamine, empty)
  await up.click();
  await expect.poll(() => shownLessons(page, practice)).toEqual(["Teine"]);
  await expect(up).toBeFocused();
  await expect(up).toHaveAttribute("aria-disabled", "true"); // the course's very first lesson now
  expect(await lessonTitles(practice)).toEqual(["Teine"]);
  await editor.getByRole("button", { name: "Liiguta alla: Teine" }).click();
  await expect.poll(() => shownLessons(page, intro)).toEqual(["Teine", "Tere tulemast"]);

  // Esc with a text not saved yet (README §1.5): the leave guard saves it first and the drawer closes, the focus back on its ›; no question of its own
  await editor.getByRole("link", { name: "Muuda õppetundi: Teine" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?oppetund=${second}$`));
  await drawer.getByRole("textbox", { name: "Lühike tekst" }).fill("Salvestub sulgemisel");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/admin/koolitused/${courseId}$`));
  await expect(page.locator(`#edit-lesson-${second}`)).toBeFocused();
  await expect.poll(async () => (await lessonRow(second)).body).toEqual({ et: "Salvestub sulgemisel" });

  await editor.getByRole("link", { name: "Muuda õppetundi: Teine" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?oppetund=${second}$`));
  await expect(drawer.getByRole("textbox", { name: "Lühike tekst" })).toHaveValue("Salvestub sulgemisel");
  // „Kustuta õppetund“: a ConfirmPanel in its place (README B2), „Katkesta“ gives the button back with the focus
  const remove = drawer.locator("[data-delete-lesson]");
  await remove.getByRole("button", { name: "Kustuta õppetund" }).click();
  await expect(remove.locator("[data-confirm-panel] p")).toHaveText("Kas kustutan õppetunni „Teine“ koos video ja failidega?");
  await remove.getByRole("button", { name: "Katkesta" }).click();
  await expect(remove.getByRole("button", { name: "Kustuta õppetund" })).toBeFocused();
  await remove.getByRole("button", { name: "Kustuta õppetund" }).click();
  await remove.getByRole("button", { name: "Jah, kustuta" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/admin/koolitused/${courseId}$`));
  await expect(editor.locator("[data-lesson]")).toHaveCount(1);
  expect(await lessonTitles(intro)).toEqual(["Tere tulemast"]);
  await expect(page.locator(`#add-lesson-${intro}`)).toBeFocused(); // its row is gone: the module's "Uue õppetunni nimi"

  // a lesson with progress is only hidden: the switch's hint says so, and „Kustuta õppetund“ is not offered (README B2)
  const [{ id: student }] = await db((sql) => sql<{ id: number }[]>`insert into clients (email) values (${email}) returning id`);
  await db((sql) => sql`insert into lesson_progress (client_id, lesson_id, watched_sec) values (${student}, ${first}, 5)`);
  await page.goto(`/admin/koolitused/${courseId}?oppetund=${first}`);
  await adminReady(page);
  await expect(drawer.locator("[data-lesson-visibility]")).toContainText("Õppetunnil on õpilaste edenemist: seda saab ainult peita.");
  await expect(remove).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Kustuta õppetund" })).toHaveCount(0);
  // any other ?oppetund opens nothing
  for (const bad of ["abc", "0", "007", "999999999"]) {
    await page.goto(`/admin/koolitused/${courseId}?oppetund=${bad}`);
    await adminReady(page);
    await expect(editor).toBeVisible();
    await expect(drawer).toHaveCount(0);
  }

  // 8. "Kustuta moodul" only on the empty one; a ConfirmPanel in its place (README §1.6): „Katkesta“ gives the button back with the focus;
  // deleted after „Jah, kustuta“, the focus on the new module's field
  await expect(introRow.locator("[data-delete-module]")).toHaveCount(0);
  await expect(introRow.locator("[data-delete-blocked]")).toHaveText("Moodulit saab kustutada, kui selles pole õppetunde."); // Dim 24.10 D-7
  await practiceRow.locator("[data-delete-module]").click();
  const question = practiceRow.locator("[data-confirm-panel]");
  await expect(question).toBeFocused();
  await expect(question.locator("p")).toHaveText("Kas kustutan mooduli „Praktika ja kordamine“?");
  await question.getByRole("button", { name: "Katkesta" }).click();
  await expect(question).toHaveCount(0);
  await expect(practiceRow.locator("[data-delete-module]")).toBeFocused();
  await practiceRow.locator("[data-delete-module]").click();
  await question.getByRole("button", { name: "Jah, kustuta" }).click();
  await expect(editor.locator("[data-module]")).toHaveCount(1);
  await expect(newModule).toBeFocused();
  expect(await moduleTitles(courseId)).toEqual(["Sissejuhatus"]);

  // 9. a contact course: "Programm", module titles only
  await db((sql) => sql`update courses set type = 'contact' where id = ${courseId}`);
  await page.reload();
  await adminReady(page);
  await expect(editor.locator("h2")).toHaveText("Programm");
  await expect(editor).toContainText("Koolituse sisu järjekorras.");
  await expect(editor.locator("[data-lessons]")).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Lisa õppetund" })).toHaveCount(0);
  await expect(editor.locator("[data-add-module]").getByLabel("Uus programmi punkt")).toBeVisible();
  await expect(editor.locator("[data-add-module] button")).toHaveText("+ Lisa punkt");
  await expect(editor.locator("[data-modules-summary]")).toHaveText("1 punkt"); // a programme counts its points (Dim 24.10 D-6)
  // a programme point's delete asks „Kas kustutan punkti „{title}“?“ (README B2)
  await editor.locator("[data-add-module]").getByLabel("Uus programmi punkt").fill("Lõpuarutelu");
  await editor.locator("[data-add-module]").getByRole("button", { name: "Lisa punkt" }).click();
  await expect(editor.locator("[data-module]")).toHaveCount(2);
  await expect(editor.locator("[data-modules-summary]")).toHaveText("2 punkti");
  const point = editor.locator(`[data-module="${await moduleId(courseId, "Lõpuarutelu")}"]`);
  await expect(point.locator("[data-delete-module]")).toHaveText("Kustuta punkt"); // Dim 24.10 D-5
  await point.locator("[data-delete-module]").click();
  await expect(point.locator("[data-confirm-panel] p")).toHaveText("Kas kustutan punkti „Lõpuarutelu“?");
  await point.getByRole("button", { name: "Jah, kustuta" }).click();
  await expect(editor.locator("[data-module]")).toHaveCount(1);
  expect(await moduleTitles(courseId)).toEqual(["Sissejuhatus"]);

  // 10. a phone again, for the programme
  await checkPhone(page, isMobile);
});

test("a refused kind switch (the lesson is gone meanwhile) puts the choice back on the stored kind and says why", async ({ page, context, visitorIp }, info) => {
  const email = clientEmail("les-kind", info.project.name);
  made.add(email);
  await removeClientRows(email);
  const lessonId = await db(async (sql) => {
    const [{ id }] = await sql<{ id: number }[]>`insert into courses (slug, type, level, title, summary, body, price, access_months, published)
      values (${accountCourseSlug(email)}, 'e_learning', 'basic', ${sql.json({ et: "E2E liik" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 9500, 6, false) returning id`;
    const [m] = await sql<{ id: number }[]>`insert into course_modules (course_id, position, title) values (${id}, 1, ${sql.json({ et: "Moodul" })}) returning id`;
    const [l] = await sql<{ id: number }[]>`insert into lessons (module_id, position, title) values (${m.id}, 1, ${sql.json({ et: "Tund" })}) returning id`;
    return l.id;
  });
  const [{ courseId }] = await db((sql) => sql<{ courseId: number }[]>`select m.course_id as "courseId" from lessons l join course_modules m on m.id = l.module_id where l.id = ${lessonId}`);
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto(`/admin/koolitused/${courseId}?oppetund=${lessonId}`);
  await adminReady(page);
  const kind = page.locator("dialog[data-drawer] [data-lesson-kind]");
  await expect(kind.getByRole("radio", { name: "Video" })).toBeChecked();
  await db((sql) => sql`delete from lessons where id = ${lessonId}`);
  await kind.getByRole("radio", { name: "Tekst" }).check();
  await expect(kind.locator("[data-kind-error]")).toHaveText("Seda ei leitud. Laadi leht uuesti.");
  await expect(kind.getByRole("radio", { name: "Video" })).toBeChecked();
  await expect(kind.getByRole("radio", { name: "Tekst" })).not.toBeChecked();
});

test("module order (README B2, S3-P3-m): a drag with the mouse or a finger and ↑ / ↓ are one stored move each; a field typed in another card stays; the video tags", async ({ page, context, visitorIp, isMobile }, info) => {
  const email = clientEmail("les-order", info.project.name);
  made.add(email);
  await removeClientRows(email);
  const { courseId, modules } = await db(async (sql) => {
    const [{ id }] = await sql<{ id: number }[]>`insert into courses (slug, type, level, title, summary, body, price, access_months, published)
      values (${accountCourseSlug(email)}, 'e_learning', 'basic', ${sql.json({ et: "E2E järjekord" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 9500, 6, false) returning id`;
    const rows = await sql<{ id: number }[]>`insert into course_modules (course_id, position, title) values
      (${id}, 1, ${sql.json({ et: "Alustame" })}), (${id}, 2, ${sql.json({ et: "Kujud" })}), (${id}, 3, ${sql.json({ et: "Lõpetame" })}) returning id`;
    // the video tags of the rows (P-4, S3-P3-e): processing with Bunny's figure, processing without one, ready, none, a text lesson
    await sql`insert into lessons (module_id, position, title, video_id, video_status, video_progress) values
      (${rows[0].id}, 1, ${sql.json({ et: "Töös 40" })}, ${`e2e-order-a-${info.project.name}`}, 'processing', 40),
      (${rows[0].id}, 2, ${sql.json({ et: "Töös" })}, ${`e2e-order-b-${info.project.name}`}, 'processing', null)`;
    await sql`insert into lessons (module_id, position, title, video_id, video_status, duration_sec) values (${rows[1].id}, 1, ${sql.json({ et: "Valmis tund" })}, ${`e2e-order-c-${info.project.name}`}, 'ready', 90)`;
    await sql`insert into lessons (module_id, position, title) values (${rows[1].id}, 2, ${sql.json({ et: "Videota" })})`;
    await sql`insert into lessons (module_id, position, title, kind) values (${rows[2].id}, 1, ${sql.json({ et: "Lugemine" })}, 'text')`;
    return { courseId: id, modules: rows.map((r) => r.id) };
  });
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto(`/admin/koolitused/${courseId}`);
  await adminReady(page);
  const editor = page.locator("[data-lessons-editor]");
  const tags = () => editor.locator("[data-lesson-video], [data-lesson-kind='text']").allTextContents();
  await expect.poll(tags).toEqual(["Töötlemisel 40%", "Töötlemisel", "Valmis", "Video puudub", "Tekst"]);
  await expect(editor.locator("[data-modules-summary]")).toHaveText("3 moodulit · 5 õppetundi");

  // the order controls of a module row: the handle („lohistatav“) and the arrows, each a 44 px target, nothing wider than the screen
  const handle = (name: string) => editor.getByRole("button", { name: `Lohista: ${name}` });
  await expect(handle("Lõpetame")).toHaveAttribute("aria-roledescription", "lohistatav");
  for (const control of [handle("Lõpetame"), editor.getByRole("button", { name: "Liiguta üles: Lõpetame" }), editor.getByRole("button", { name: "Liiguta alla: Alustame" })]) {
    const box = (await control.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  expect(await noOverflow(page)).toBe(true);

  // a text in another card („Lühikirjeldus“), the same field node before and after the moves: no card starts over (Task 7's restart is for a publish;
  // the DOM test has a text still unsaved). Saved first, so that the chip's words do not move the page while the finger is measured.
  const summary = page.locator("[data-course-editor] [data-i18n='summary']");
  await summary.fill("Kolm moodulit järjekorras.");
  await summary.blur();
  await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-kind", "saved");
  await summary.evaluate((el) => ((el as HTMLElement & { e2eMark?: string }).e2eMark = "same"));

  // „Lõpetame“ dragged one place up, over „Kujud“ (both on the screen), with a finger on a phone and the mouse on a desktop: one move stored, the page
  // does not scroll with a finger
  const announced = editor.locator("[data-drag-list] ~ [role=status]");
  const last = handle("Lõpetame");
  await editor.locator(`[data-drag-row="${modules[1]}"]`).evaluate((el) => el.scrollIntoView({ block: "start" }));
  const from = (await last.boundingBox())!;
  const previous = (await editor.locator(`[data-drag-row="${modules[1]}"]`).boundingBox())!;
  const to = { x: from.x + from.width / 2, y: previous.y + 8 };
  const scrollBefore = await page.evaluate(() => window.scrollY);
  if (isMobile) await dragWithFinger(page, { x: from.x + from.width / 2, y: from.y + from.height / 2 }, to, 20);
  else {
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 20 });
    await expect(editor.locator(`[data-drag-row="${modules[2]}"]`)).toHaveAttribute("data-dragging", "");
    await page.mouse.up();
  }
  await expect.poll(() => shownModules(page)).toEqual(["Alustame", "Lõpetame", "Kujud"]);
  await expect.poll(() => moduleTitles(courseId)).toEqual(["Alustame", "Lõpetame", "Kujud"]);
  if (isMobile) expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await expect(handle("Lõpetame")).toBeFocused();
  await expect(announced).toHaveText("„Lõpetame“ on nüüd 2. kohal.");
  // the lessons went with their module; its number is its new place
  await expect(editor.locator(`[data-module="${modules[2]}"] [data-lesson-title]`)).toHaveText(["Lugemine"]);
  await expect(editor.locator(`[data-module="${modules[2]}"]`)).toContainText("02");

  // ↑ with the arrow: one place up, to the top; the focus stays on it
  const up = editor.getByRole("button", { name: "Liiguta üles: Lõpetame" });
  await up.click();
  await expect.poll(() => moduleTitles(courseId)).toEqual(["Lõpetame", "Alustame", "Kujud"]);
  await expect(up).toBeFocused();
  await expect(up).toHaveAttribute("aria-disabled", "true");
  await expect(announced).toHaveText("„Lõpetame“ on nüüd 1. kohal.");

  // the other card's field is the same node with its text
  expect(await summary.evaluate((el) => (el as HTMLElement & { e2eMark?: string }).e2eMark)).toBe("same");
  await expect(summary).toHaveValue("Kolm moodulit järjekorras.");
  await expect
    .poll(async () => (await db((sql) => sql<{ s: string }[]>`select summary->>'et' as s from courses where id = ${courseId}`))[0].s)
    .toBe("Kolm moodulit järjekorras.");

  // the stored order is what a reload shows, no module doubled or lost
  await page.reload();
  await adminReady(page);
  await expect.poll(() => shownModules(page)).toEqual(["Lõpetame", "Alustame", "Kujud"]);
});

test("a new course says to create it first (piece3-texts P-5)", async ({ page, context, visitorIp }) => {
  await signInAsAdmin(page, context, visitorIp, created);
  await page.goto("/admin/koolitused/uus");
  await adminReady(page);
  const editor = page.locator("[data-lessons-editor]");
  await expect(editor).toContainText("Vajuta „Lisa koolitus“, et lisada mooduleid.");
  await expect(editor.locator("[data-add-module]")).toHaveCount(0);
});
