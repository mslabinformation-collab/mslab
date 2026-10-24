import type { Page } from "@playwright/test";
import { clientEmail } from "./account";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import { E2E_BUNNY } from "./bunny-values";
import { accountCourseSlug, onLocalDb, removeAdminRows, removeClientRows } from "./fixtures";
import { smallTargets } from "./targets";
import { submitsForms, test, expect } from "./test";

// Phase 3a Task 6: a lesson's video in the admin drawer, against the fake Bunny Stream (fake-bunny.ts; Playwright starts it next
// to the dev server, which the local settings point at it). Picked, the file goes by tus straight to the fake; "Töötlemisel…" (then "Töötlemisel 40%", the fake's encodeProgress, S6)
// until the editor's poll reads it ready ("Valmis · 2:05", the fake's 125 s). "Asenda video" deletes the old one once the new one
// is ready; "Tekst" deletes the video (after its ConfirmPanel); the webhook is checked for its secret. Admin UX pass piece 3a, Task 10 (README B2): when
// the file input goes with the pick, the focus is on the progress line; ✕ during the upload asks through the leave guard („Üleslaadimine käib.“);
// while Bunny encodes, „Võid lehelt lahkuda — töötlemine jätkub.“ under a bar. The test's own unpublished e-course (slug
// e2e-konto-vid-<project>) is removed after the test with its module and lesson (removeClientRows). Admin e2e runs under `next dev`.

const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
const made = new Set<string>();

test.beforeEach(() => submitsForms());

test.afterEach(async () => {
  for (const email of made) await removeClientRows(email);
  made.clear();
  await removeAdminRows(created).catch(() => {});
  created.tokens.clear();
  created.sessions.clear();
});

const db = <T>(work: Parameters<typeof onLocalDb<T>>[0]) => onLocalDb(work, { marksPages: false });
type LessonRow = { kind: string; videoId: string | null; videoStatus: string; durationSec: number | null; replacedVideoId: string | null; videoWidth: number | null; videoHeight: number | null; videoProgress: number | null };
const lessonRow = async (id: number) =>
  (await db((sql) => sql<LessonRow[]>`
    select kind, video_id as "videoId", video_status as "videoStatus", duration_sec as "durationSec", replaced_video_id as "replacedVideoId",
      video_width as "videoWidth", video_height as "videoHeight", video_progress as "videoProgress" from lessons where id = ${id}`))[0];
/** What the fake Bunny holds: its videos and the ids it was asked to delete. */
const fakeState = async () => (await (await fetch(`${E2E_BUNNY.url}/_fake/state`)).json()) as { videos: { guid: string; status: number; length: number }[]; deleted: string[] };
const video = (n: number) => ({ name: `tund-${n}.mp4`, mimeType: "video/mp4", buffer: Buffer.alloc(256 * 1024, n) });
const WAITING = "Õpilased näevad „Video lisandub peagi“ ja järgmine õppetund jääb lukku, kuni video on valmis.";
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("a lesson's video: chosen, sent to Bunny with tus, processed, replaced, dropped with Tekst; the webhook's secret", async ({ page, context, visitorIp, isMobile }, info) => {
  test.slow(); // two uploads, each waiting for the editor's 5 s poll
  const email = clientEmail("vid", info.project.name);
  made.add(email);
  await removeClientRows(email);
  const { courseId, lessonId } = await db(async (sql) => {
    const [c] = await sql<{ id: number }[]>`insert into courses (slug, type, level, title, summary, body, price, access_months, published)
      values (${accountCourseSlug(email)}, 'e_learning', 'basic', ${sql.json({ et: "E2E video" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 9500, 6, false) returning id`;
    const [m] = await sql<{ id: number }[]>`insert into course_modules (course_id, position, title) values (${c.id}, 1, ${sql.json({ et: "Moodul" })}) returning id`;
    const [l] = await sql<{ id: number }[]>`insert into lessons (module_id, position, title) values (${m.id}, 1, ${sql.json({ et: "Esimene tund" })}) returning id`;
    return { courseId: c.id, lessonId: l.id };
  });
  await signInAsAdmin(page, context, visitorIp, created);

  // 1. a video lesson without a video: "Vali video" and what students see meanwhile
  await page.goto(`/admin/koolitused/${courseId}?oppetund=${lessonId}`);
  await adminReady(page);
  const drawer = page.locator("dialog[data-drawer]");
  const field = drawer.locator("section[data-lesson-video]");
  await expect(field.getByRole("heading", { level: 3 })).toHaveText("Video");
  await expect(field.locator("[data-video-pick]")).toHaveText("Vali video");
  await expect(field).toContainText("Video laaditakse otse videoteenusesse. Hoia leht lahti, kuni üleslaadimine on lõppenud.");
  await expect(field.locator("[data-video-waiting]")).toHaveText(WAITING);
  const row = page.locator(`[data-lessons-editor] [data-lesson="${lessonId}"]`);
  await expect(row.locator("[data-lesson-video]")).toHaveText("Video puudub");

  // a phone: the button is a 44 px target and nothing is wider than the screen
  if (isMobile) {
    expect((await smallTargets(field)).filter((html) => !/^<input[^>]*\stype="file"/.test(html))).toEqual([]);
    expect((await field.locator("[data-video-pick]").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await noOverflow(page)).toBe(true);
    expect(await drawer.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
  }

  // 2. a file: straight to the fake Bunny with tus (held back here at first), then "Töötlemisel 40%" until the poll reads it ready. The input goes with
  // the pick: the focus is on the progress line, not lost to the page. ✕ meanwhile asks through the leave guard; „Jää siia“ keeps the upload going.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${E2E_BUNNY.url}/tusupload**`, async (route) => {
    await held;
    await route.continue();
  });
  const input = field.locator("input[type=file]");
  await input.focus();
  await input.setInputFiles(video(1));
  await expect(field.locator("[data-video-status]")).toHaveText(/^Laen üles… \d+ %$/);
  await expect(field.locator("input[type=file]")).toHaveCount(0);
  await expect(field.locator("[data-video-status]")).toBeFocused();
  await drawer.getByRole("button", { name: "Sulge" }).click();
  const notice = drawer.locator("[data-leave-notice='drawer']");
  await expect(notice.locator("[data-leave-title]")).toHaveText("Muudatust „Video“ ei saanud veel salvestada.");
  await expect(notice.locator("[data-leave-reason]")).toHaveText("Üleslaadimine käib.");
  await notice.getByRole("button", { name: "Jää siia" }).click();
  await expect(notice).toHaveCount(0);
  await expect(field.locator("[data-video-status]")).toBeFocused();
  expect(page.url()).toMatch(new RegExp(`\\?oppetund=${lessonId}$`));
  release();
  // the fake reads a finished upload as transcoding at 40 % once, then as ready: Bunny's encode progress reaches the line, the bar and the column (S6, R-g)
  await expect(field.locator("[data-video-status]")).toHaveText("Töötlemisel 40%");
  await expect(field.locator("progress")).toHaveAttribute("value", "40");
  expect((await lessonRow(lessonId)).videoProgress).toBe(40);
  // while Bunny encodes: the line from the phone frame (S3-P3-e)
  await expect(field.locator("[data-video-leave]")).toHaveText("Võid lehelt lahkuda — töötlemine jätkub.");
  await expect(field.locator("progress")).toHaveCount(1);
  await page.unroute(`${E2E_BUNNY.url}/tusupload**`);
  await expect(field.locator("[data-video-status]")).toHaveText("Valmis · 2:05", { timeout: 20_000 });
  await expect(field.locator("[data-video-waiting]")).toHaveCount(0);
  await expect(field.locator("[data-video-pick]")).toHaveText("Asenda video");
  await expect(row.locator("[data-lesson-video]")).toHaveText("Valmis"); // the list behind the drawer follows (README B2, P-4)
  const first = await lessonRow(lessonId);
  expect(first).toMatchObject({ kind: "video", videoStatus: "ready", durationSec: 125, replacedVideoId: null, videoWidth: 1920, videoHeight: 1080, videoProgress: null }); // the fake's usual 16:9, stored with the length
  expect((await fakeState()).videos.map((v) => v.guid)).toContain(first.videoId);

  // 3. "Asenda video": the old video plays until the new one is ready, then it is deleted from Bunny
  await field.locator("input[type=file]").setInputFiles(video(2));
  await expect(field.locator("[data-video-status]")).toHaveText("Töötlemisel 40%");
  await expect(field).toContainText("Vana video jääb õpilastele nähtavaks, kuni uus on valmis.");
  await expect(field.locator("[data-video-waiting]")).toHaveCount(0);
  // the new video is an upright one (the fake gives it 1080 × 1920 when it finishes): until then the playing video's shape stays
  const replacing = await lessonRow(lessonId);
  expect(replacing).toMatchObject({ replacedVideoId: first.videoId, videoWidth: 1920, videoHeight: 1080 });
  const planned = await fetch(`${E2E_BUNNY.url}/_fake/shape`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ videoId: replacing.videoId, width: 1080, height: 1920 }) });
  expect(planned.status).toBe(200);
  await expect(field.locator("[data-video-status]")).toHaveText("Valmis · 2:05", { timeout: 20_000 });
  const second = await lessonRow(lessonId);
  expect(second).toMatchObject({ videoStatus: "ready", durationSec: 125, replacedVideoId: null, videoWidth: 1080, videoHeight: 1920, videoProgress: null }); // the new video's shape took its place
  expect(second.videoId).not.toBe(first.videoId);
  await expect.poll(async () => (await fakeState()).deleted).toContain(first.videoId);
  expect((await fakeState()).videos.map((v) => v.guid)).toContain(second.videoId);

  // 4. "Tekst" asks first in a ConfirmPanel (README B2); „Katkesta“ changes nothing; „Jah, vaheta“ drops the video (deleted from Bunny) and the field goes
  const kind = drawer.locator("[data-lesson-kind]");
  await kind.getByRole("radio", { name: "Tekst" }).check();
  const confirm = kind.locator("[data-confirm-panel]");
  await expect(confirm.locator("p")).toHaveText("Kas vahetan liigi?");
  await expect(confirm.locator("li")).toHaveText(["Video kustutatakse."]);
  await confirm.getByRole("button", { name: "Katkesta" }).click();
  await expect(kind.getByRole("radio", { name: "Video" })).toBeChecked();
  expect(await lessonRow(lessonId)).toEqual(second);
  await kind.getByRole("radio", { name: "Tekst" }).check();
  await confirm.getByRole("button", { name: "Jah, vaheta" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(field).toHaveCount(0);
  expect(await lessonRow(lessonId)).toMatchObject({ kind: "text", videoStatus: "none", videoId: null, replacedVideoId: null, durationSec: null, videoWidth: null, videoHeight: null, videoProgress: null });
  await expect.poll(async () => (await fakeState()).deleted).toContain(second.videoId); // after the answer (after())
  await kind.getByRole("radio", { name: "Video" }).check();
  await expect(field.locator("[data-video-pick]")).toHaveText("Vali video");
  await expect(field.locator("[data-video-waiting]")).toHaveText(WAITING);

  // 5. the webhook: a wrong secret is refused; the right one is taken (the video is no lesson's any more: nothing to do)
  const hook = { VideoLibraryId: Number(E2E_BUNNY.libraryId), VideoGuid: second.videoId, Status: 3 };
  expect((await page.request.post("/api/bunny/webhook?secret=wrong", { data: hook })).status()).toBe(401);
  const ok = await page.request.post(`/api/bunny/webhook?secret=${E2E_BUNNY.webhookSecret}`, { data: hook });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
});

test("the webhook needs its secret and never takes the payload's status", async ({ request }, info) => {
  const email = clientEmail("vid-hook", info.project.name);
  made.add(email);
  await removeClientRows(email);
  // a lesson whose upload Bunny (the fake) still has as created: the payload's "finished" changes nothing
  const res = await fetch(`${E2E_BUNNY.url}/library/${E2E_BUNNY.libraryId}/videos`, { method: "POST", headers: { AccessKey: E2E_BUNNY.apiKey, "content-type": "application/json" }, body: "{}" });
  const { guid } = (await res.json()) as { guid: string };
  const lessonId = await db(async (sql) => {
    const [c] = await sql<{ id: number }[]>`insert into courses (slug, type, level, title, summary, body, price, access_months, published)
      values (${accountCourseSlug(email)}, 'e_learning', 'basic', ${sql.json({ et: "E2E veebikonks" })}, ${sql.json({ et: "" })}, ${sql.json({ et: "" })}, 9500, 6, false) returning id`;
    const [m] = await sql<{ id: number }[]>`insert into course_modules (course_id, position, title) values (${c.id}, 1, ${sql.json({ et: "Moodul" })}) returning id`;
    const [l] = await sql<{ id: number }[]>`insert into lessons (module_id, position, title, video_id, video_status, video_started_at)
      values (${m.id}, 1, ${sql.json({ et: "Tund" })}, ${guid}, 'uploading', now()) returning id`;
    return l.id;
  });
  const hook = { VideoLibraryId: Number(E2E_BUNNY.libraryId), VideoGuid: guid, Status: 4 };
  expect((await request.post("/api/bunny/webhook", { data: hook })).status()).toBe(401);
  expect((await request.post("/api/bunny/webhook?secret=wrong", { data: hook })).status()).toBe(401);
  const ok = await request.post(`/api/bunny/webhook?secret=${E2E_BUNNY.webhookSecret}`, { data: hook });
  expect(ok.status()).toBe(200);
  expect(await lessonRow(lessonId)).toMatchObject({ videoId: guid, videoStatus: "uploading" }); // Bunny's API says 0: still uploading
  expect((await request.post(`/api/bunny/webhook?secret=${E2E_BUNNY.webhookSecret}`, { data: "not json", headers: { "content-type": "text/plain" } })).status()).toBe(400);
});
