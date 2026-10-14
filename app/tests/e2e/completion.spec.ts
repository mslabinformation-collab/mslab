import type { Locator, Page, TestInfo } from "@playwright/test";
import { PHOTO_LIMITS } from "../../src/domain/completion";
import { clientEmail, signInAsClient, takeTerms } from "./account";
import { adminReady, signInAsAdmin, type CreatedRows } from "./admin-login";
import {
  canvasJpeg, E2E_OPEN, E2E_POINTS, E2E_QUESTIONS, hasExif, insertAttempts, insertCompletionCourse, insertContactRegistration, insertPractical, jpegSize, localFile,
  storedAccessRow, storedAttempts, storedPhotos, storedProtocolOf, withExif, type CompletionCourse,
} from "./completion";
import { LOCK_WAIT_MS, removeAdminRows, removeClientRows } from "./fixtures";
import { general, note, runName, saved, storedProtocol, studentPage } from "./protocols";
import { smallTargets } from "./targets";
import { expect, submitsForms, test } from "./test";

// E-course completion (spec §9 "End to end"): the lessons done and the test (a fail, "Proovi uuesti", a pass); the practical work's photos from a
// phone (Review Focus 1: 6000×4000 with GPS, sideways, a lost upload, a HEIC) and "Saada hindamiseks"; Maria's "Hindamine", her verdicts and
// "Saada hinnang"; the "Paranda" point redone and approved, "Lõpetatud" on the page, the course page and the card; the open answers reviewed,
// rewritten and accepted; "Ava test uuesti"; "Lisa protokoll" from the student's drawer; and the pages at 390, 834, 1194 and 1440 px (hers,
// Hindamine with an item in each group, the review, the access screen and the overview's "Ootab hindamist"). Every
// student is a sample address (`e2e-client-compl-…@example.test`, never mailed) on an e-course of the test's own; all of it is removed after each
// test. Under `next dev` and the production build (E2E_PROD_BUILD=1); Maria signs in as Dim (admin-login.ts). The locks on real Postgres are
// completion-race.spec.ts.

const made = new Set<string>();
const created: CreatedRows = { tokens: new Set(), sessions: new Set() };
let restoreTerms: (() => Promise<void>) | null = null;

test.beforeEach(async ({}, info) => {
  submitsForms();
  // the first view of each page under `next dev` compiles it
  info.setTimeout(180_000);
});

/**
 * The shared course terms of version "1", held for this test: only the tests that open the e-course page or a lesson (which check the terms)
 * take them — the test and practical pages, their APIs and the admin pages do not — so the others never queue behind the shared lock. The
 * wait for it (another spec may hold it) is this test's too.
 */
async function holdTerms(info: TestInfo): Promise<void> {
  info.setTimeout(180_000 + LOCK_WAIT_MS);
  restoreTerms = await takeTerms();
}

test.afterEach(async () => {
  try {
    for (const email of made) await removeClientRows(email);
    made.clear();
    await removeAdminRows(created).catch(() => {});
    created.tokens.clear();
    created.sessions.clear();
  } finally {
    await restoreTerms?.();
    restoreTerms = null;
  }
});

type Student = CompletionCourse & { email: string };

/** A student of an e-course of her own (completion.ts insertCompletionCourse); her rows go after the test. */
async function student(label: string, info: TestInfo, opts: Parameters<typeof insertCompletionCourse>[1] = {}): Promise<Student> {
  const email = clientEmail(`compl-${label}`, runName(info));
  made.add(email);
  await removeClientRows(email);
  return { email, ...(await insertCompletionCourse(email, opts)) };
}

const coursePage = (s: Student) => `/konto/kursus/${s.slug}`;
const testPage = (s: Student) => `/konto/kursus/${s.slug}/test`;
const practicalPage = (s: Student) => `/konto/kursus/${s.slug}/praktiline`;
/** A step of the e-course page's "Lõpetamine" in `state` (the state on the step's own element, or on one inside it). */
const step = (page: Page, name: string, state: string) =>
  page.locator(`[data-completion] [data-step="${name}"][data-step-state="${state}"], [data-completion] [data-step="${name}"] [data-step-state="${state}"]`).first();
const testState = (page: Page) => page.locator("[data-test-state]").first();
const practicalStatus = (page: Page) => page.locator("[data-practical-status]").first();
const point = (page: Page, i: number) => page.locator(`[data-point="${i}"]`);
const fileInput = (page: Page, i: number) => point(page, i).locator('[data-photo-add] input[type="file"]').first();
/** A point's stored photos (not one on its way). */
const storedOn = (page: Page, i: number) => point(page, i).locator("[data-photo]:not([data-photo-pending])");
const assessPoint = (page: Page, i: number) => page.locator(`[data-assess-point="${i}"]`);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/** A radio's, a checkbox's or a file field's touch target is its label (the test's options, "Lisa foto"), as in admin-lessons.spec.ts. */
const LABELLED = /^<input[^>]*\stype="(radio|checkbox|file)"/;

/** A confirming step's "yes": the marked element itself when it is a button, else the step's first button (the "yes" comes first on every step). */
async function confirmStep(marked: Locator): Promise<void> {
  const target = marked.first();
  await expect(target).toBeVisible();
  const own = await target.evaluate((el) => el instanceof HTMLButtonElement);
  await (own ? target : target.locator("button").first()).click();
}

/** On the test page: the options picked (question id → option ids) and the open answers written (question id → text). */
async function answer(page: Page, picks: Record<string, string[]>, texts: Record<string, string> = {}): Promise<void> {
  for (const [question, options] of Object.entries(picks)) for (const option of options) await page.locator(`[data-question="${question}"] [data-answer-option="${option}"]`).check();
  for (const [question, text] of Object.entries(texts)) await page.locator(`[data-question="${question}"] [data-answer-open]`).fill(text);
}

/** "Esita test" / "Saada uuesti", and its inline confirmation's yes when the page asks for one (the first submit always does: spec §4.2). */
async function submitTest(page: Page): Promise<void> {
  await page.locator("[data-test-submit]").click();
  const yes = page.locator('[data-test-page] [data-confirm="yes"]').first();
  if (await yes.waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false)) await yes.click();
}

/** "Saada hindamiseks" / "Saada uuesti" and its confirmation (spec §4.3). */
async function sendPractical(page: Page): Promise<void> {
  await page.locator("[data-practical-submit]").click();
  await confirmStep(page.locator("[data-practical-confirm]"));
}

/** "Saada hinnang" and its one confirmation (spec §5.3): the screen says it was sent. */
async function sendAssessment(page: Page): Promise<void> {
  await page.locator("[data-assess-send]").click();
  await confirmStep(page.locator("[data-assess-confirm]"));
  await expect(page.locator("[data-assess-sent]").first()).toBeVisible({ timeout: 30_000 });
}

/** Maria on "Hindamine", from where the access's item in `group` opens. */
async function hindamine(page: Page, group: "practicals" | "tests" | "tries", accessId: number): Promise<Locator> {
  await page.goto("/admin/hindamine");
  await adminReady(page);
  return page.locator(`[data-queue="${group}"] [data-queue-item="${accessId}"]`);
}

test("§9 e2e 1: the lessons done, the test opens; a fail with its score and its wrong numbers, 'Proovi uuesti', a pass; the answer key never reaches her", async ({ page }, info) => {
  await holdTerms(info); // the e-course page and its lesson
  const s = await student("t1", info, { questions: E2E_QUESTIONS, points: [] });
  await signInAsClient(page, s.email);
  await page.goto(coursePage(s));
  await expect(step(page, "test", "locked")).toBeVisible();
  await expect(page.locator('[data-completion] [data-step="practical"]')).toHaveCount(0); // a course without points has no practical work
  // the only lesson, "Märgi tehtuks": the test opens
  await page.goto(`${coursePage(s)}/${s.lessonId}`);
  await page.locator("[data-mark-done]").click();
  await expect(page.locator("[data-lesson-done]")).toBeVisible();
  await page.goto(coursePage(s));
  await expect(step(page, "test", "open")).toBeVisible();
  await page.locator('[data-completion] [data-step="test"] [data-step-link]').first().click();
  await expect(page).toHaveURL(new RegExp(`/konto/kursus/${s.slug}/test$`));
  await expect(testState(page)).toHaveAttribute("data-test-state", "none");
  // the first try: the second answer wrong — 50 %, under 80 %; the step names the try
  await answer(page, { q1: ["a"], q2: ["b"] });
  await page.locator("[data-test-submit]").click();
  await expect(page.locator("[data-test-confirm]")).toContainText(/Katse 1\/3/); // the confirmation itself, not the form's own line
  await page.locator('[data-test-page] [data-confirm="yes"]').first().click();
  await expect(testState(page)).toHaveAttribute("data-test-state", "open");
  await expect(page.locator("[data-test-result]").first()).toContainText(/Said 50\s%, vaja 80\s%/);
  await expect(page.locator("[data-test-wrong]").first()).toContainText("2");
  await expect(page.locator("[data-test-retry]")).toContainText(/2 katset jäänud/);
  // what her page reads has no answer key, before or after a try (Global Constraints: the key never leaves the server for the student)
  const read = await page.request.get(`/api/konto/kursus/${s.slug}/test`);
  expect(read.status()).toBe(200);
  expect(await read.text()).not.toContain('"correct"');
  // "Proovi uuesti": both right — passed
  await page.locator("[data-test-retry]").click();
  await answer(page, { q1: ["a"], q2: ["a"] });
  await submitTest(page);
  await expect(testState(page)).toHaveAttribute("data-test-state", "passed");
  await expect(page.getByText("Test on sooritatud").first()).toBeVisible();
  expect((await storedAttempts(s.clientId)).map((a) => [a.number, a.status, a.correct, a.total])).toEqual([
    [1, "failed", 1, 2],
    [2, "passed", 2, 2],
  ]);
  // no points: the pass completed the course (spec §4.4)
  await page.goto(coursePage(s));
  await expect(step(page, "test", "done")).toBeVisible();
  await expect(step(page, "done", "done")).toBeVisible();
  expect((await storedAccessRow(s.accessId)).completedAt).not.toBeNull();
});

test("§9 e2e 2 — Review Focus 1: a 6000×4000 phone photo with GPS goes up under 2 MB and is stored without EXIF; a sideways one stands upright; a lost upload's 'Proovi uuesti'; a HEIC is refused; 'Saada hindamiseks'", async ({ page }, info) => {
  const s = await student("t2", info, { points: E2E_POINTS, lessonsDone: true });
  await signInAsClient(page, s.email);
  await page.goto(practicalPage(s));
  await expect(practicalStatus(page)).toHaveAttribute("data-practical-status", "open");
  // the fixtures, drawn in this browser, with a made-up EXIF block: GPS at sea; and one held sideways (orientation 6)
  const big = withExif((await canvasJpeg(page, 6000, 4000, { grain: true })).bytes);
  const sideways = withExif((await canvasJpeg(page, 600, 400)).bytes, { orientation: 6 });
  expect([hasExif(big), hasExif(sideways)]).toEqual([true, true]);
  test.info().annotations.push({ type: "fixture", description: `6000×4000 with GPS: ${big.length} bytes` });

  // 1. point 1: the big photo, its first upload lost on the way (a weak signal); only that photo offers "Proovi uuesti"
  let posts = 0;
  await page.route(`**/api/konto/kursus/${s.slug}/praktiline/foto`, (route) =>
    route.request().method() === "POST" && posts++ === 0 ? route.abort("connectionreset") : route.fallback(),
  );
  await fileInput(page, 0).setInputFiles({ name: "IMG_6000.jpg", mimeType: "image/jpeg", buffer: big });
  await expect(point(page, 0).locator("[data-photo-retry]")).toBeVisible({ timeout: 60_000 });
  await point(page, 0).locator("[data-photo-retry]").click();
  await expect(storedOn(page, 0)).toHaveCount(1, { timeout: 60_000 });
  // 2. point 2: a HEIC this browser cannot open is refused in words; then the sideways photo
  await fileInput(page, 1).setInputFiles({ name: "IMG_0002.HEIC", mimeType: "image/heic", buffer: Buffer.from("\0\0\0\u0018ftypheic\0\0\0\0", "latin1") });
  await expect(page.getByText("Seda pilti ei saa avada. Vali JPG või PNG pilt.").first()).toBeVisible();
  await expect(storedOn(page, 1)).toHaveCount(0);
  // the refused one stays as a row until its × (Task 8 pins this), and "Saada hindamiseks" waits while it is there
  await point(page, 1).locator('[data-photo-pending="decode"] [data-photo-remove]').click();
  await expect(point(page, 1).locator("[data-photo-pending]")).toHaveCount(0);
  await fileInput(page, 1).setInputFiles({ name: "IMG_0003.jpg", mimeType: "image/jpeg", buffer: sideways });
  await expect(storedOn(page, 1)).toHaveCount(1, { timeout: 60_000 });

  // 3. what the server keeps: JPEGs without EXIF (no GPS), the full one at most 2 MB and 2048 px, upright, and their thumbnails
  const protocol = (await storedProtocolOf(s.accessId))!;
  const photos = await storedPhotos(protocol.id);
  expect(photos.map((p) => [p.stage, p.round])).toEqual([
    [0, 1],
    [1, 1],
  ]);
  for (const p of photos) {
    const full = localFile(p.key);
    const thumb = localFile(p.thumbKey);
    expect([...full.subarray(0, 3)], p.key).toEqual([0xff, 0xd8, 0xff]);
    expect(hasExif(full), `${p.key} has no EXIF`).toBe(false);
    expect(hasExif(thumb), `${p.thumbKey} has no EXIF`).toBe(false);
    expect(full.length).toBeLessThanOrEqual(PHOTO_LIMITS.fullBytes);
    expect(thumb.length).toBeLessThanOrEqual(PHOTO_LIMITS.thumbBytes);
    expect(p.size).toBe(full.length);
    expect(await jpegSize(page, full)).toEqual({ width: p.width, height: p.height });
    const t = await jpegSize(page, thumb);
    expect(Math.max(t.width, t.height)).toBeLessThanOrEqual(PHOTO_LIMITS.thumbEdge);
  }
  const [taken, turned] = photos;
  // 2048 px on the long side (1600 when the encoder had to try again: R6), the 3:2 shape kept
  expect([PHOTO_LIMITS.maxEdge, 1600]).toContain(Math.max(taken.width, taken.height));
  expect(Math.abs(taken.height - Math.round((taken.width * 4000) / 6000))).toBeLessThanOrEqual(1);
  expect([turned.width, turned.height]).toEqual([400, 600]); // turned upright by its orientation tag before the metadata went

  // 4. "Saada hindamiseks": the page locks, waiting for Maria
  await sendPractical(page);
  await expect(practicalStatus(page)).toHaveAttribute("data-practical-status", "review");
  expect(await storedProtocolOf(s.accessId)).toMatchObject({ round: 1, sentRound: null });
});

test("§9 e2e 3: Maria finds the work in 'Hindamine', marks one point 'Paranda' with a note and sends; her page shows each verdict", async ({ page, context, visitorIp, browser }, info) => {
  const s = await student("t3", info, { points: E2E_POINTS, lessonsDone: true });
  await insertPractical(s.accessId, E2E_POINTS, await canvasJpeg(page, 640, 480), { round: 1, photos: [{ stage: 0, round: 1 }, { stage: 1, round: 1 }] });
  await signInAsAdmin(page, context, visitorIp, created);
  const item = await hindamine(page, "practicals", s.accessId);
  await expect(item).toContainText("Kati Kask");
  await expect(item).toContainText("1. kord");
  await item.getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?ligipaas=${s.accessId}$`));
  await adminReady(page);
  for (const i of [0, 1]) await expect(assessPoint(page, i).locator("[data-assess-photo]")).toHaveCount(1);
  await assessPoint(page, 0).locator('[data-verdict="ok"]').click();
  await assessPoint(page, 1).locator('[data-verdict="fix"]').click();
  await expect(assessPoint(page, 0).locator('[data-verdict="ok"]')).toHaveAttribute("aria-pressed", "true");
  await expect(assessPoint(page, 1).locator('[data-verdict="fix"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-verdict-unsaved]")).toHaveCount(0); // each tap stored
  await note(page, s.accessId, 1).fill("Värvi piir on ebaühtlane: tee uus foto päevavalges.");
  await saved(page, s.accessId);
  await sendAssessment(page);
  const stored = (await storedProtocolOf(s.accessId))!;
  expect(stored).toMatchObject({ round: 1, sentRound: 1, verdicts: ["ok", "fix"] });
  expect(stored.sent).toMatchObject({ verdicts: ["ok", "fix"], stages: [{ note: "" }, { note: "Värvi piir on ebaühtlane: tee uus foto päevavalges." }] });
  // assessed: the item has left Hindamine
  await expect(await hindamine(page, "practicals", s.accessId)).toHaveCount(0);
  // her page: ✓ on the first point, "Paranda" with the note on the second, which alone takes new photos
  const her = await studentPage(browser, s.email, visitorIp);
  await her.page.goto(practicalPage(s));
  await expect(practicalStatus(her.page)).toHaveAttribute("data-practical-status", "fix");
  await expect(point(her.page, 0).locator('[data-point-verdict="ok"]')).toBeVisible();
  await expect(point(her.page, 1).locator('[data-point-verdict="fix"]')).toBeVisible();
  await expect(point(her.page, 1).locator("[data-point-note]")).toContainText("Värvi piir on ebaühtlane");
  await expect(point(her.page, 0).locator('input[type="file"]')).toHaveCount(0);
  await expect(point(her.page, 1).locator('input[type="file"]')).not.toHaveCount(0);
  await her.close();
});

test("§9 e2e 4: she redoes only the 'Paranda' point and sends again; Maria approves; 'Lõpetatud' on her page, her course page and her card", async ({ page, context, visitorIp, browser }, info) => {
  await holdTerms(info); // her course page at the end
  const s = await student("t4", info, { points: E2E_POINTS, lessonsDone: true });
  const { protocolId } = await insertPractical(s.accessId, E2E_POINTS, await canvasJpeg(page, 640, 480), {
    round: 1,
    photos: [{ stage: 0, round: 1 }, { stage: 1, round: 1 }],
    sent: { verdicts: ["ok", "fix"], notes: ["", "Tee uus foto päevavalges."] },
  });
  const her = await studentPage(browser, s.email, visitorIp);
  const sp = her.page;
  await sp.goto(practicalPage(s));
  await expect(practicalStatus(sp)).toHaveAttribute("data-practical-status", "fix");
  await expect(point(sp, 1).locator("[data-point-note]")).toContainText("Tee uus foto päevavalges.");
  await expect(point(sp, 0).locator('input[type="file"]')).toHaveCount(0); // an approved point takes no photo
  await fileInput(sp, 1).setInputFiles({ name: "uus.jpg", mimeType: "image/jpeg", buffer: (await canvasJpeg(sp, 1200, 900)).bytes });
  await expect(storedOn(sp, 1)).toHaveCount(1, { timeout: 60_000 }); // stored as the page shows it: "Saada uuesti" goes by what the page holds
  expect((await storedPhotos(protocolId)).filter((p) => p.round === 2).map((p) => p.stage)).toEqual([1]);
  await expect(point(sp, 1).locator("[data-earlier]")).toBeVisible(); // "Varasemad fotod": the first round's
  await sendPractical(sp);
  await expect(practicalStatus(sp)).toHaveAttribute("data-practical-status", "review");
  // R3: the "Paranda" point's verdict cleared, the approved one kept; the notes untouched
  expect(await storedProtocolOf(s.accessId)).toMatchObject({ round: 2, sentRound: 1, verdicts: ["ok", null] });

  // Maria: the second round in Hindamine; the second point approved; sent — the course is complete
  await signInAsAdmin(page, context, visitorIp, created);
  const item = await hindamine(page, "practicals", s.accessId);
  await expect(item).toContainText("2. kord");
  await item.getByRole("link").first().click();
  await adminReady(page);
  await expect(assessPoint(page, 0).locator('[data-verdict="ok"]')).toHaveAttribute("aria-pressed", "true");
  await assessPoint(page, 1).locator('[data-verdict="ok"]').click();
  await expect(page.locator("[data-verdict-unsaved]")).toHaveCount(0);
  await sendAssessment(page);
  expect(await storedProtocolOf(s.accessId)).toMatchObject({ round: 2, sentRound: 2, verdicts: ["ok", "ok"] });
  expect((await storedAccessRow(s.accessId)).completedAt).not.toBeNull();

  // her page, her course page and her card
  await sp.reload();
  await expect(practicalStatus(sp)).toHaveAttribute("data-practical-status", "passed");
  await expect(sp.locator("[data-practical-completed]").first()).toContainText("Lõpetatud");
  await sp.goto(coursePage(s));
  await expect(step(sp, "practical", "done")).toBeVisible();
  await expect(step(sp, "done", "done")).toBeVisible();
  await sp.goto("/konto");
  await expect(sp.locator(`[data-card="course-${s.slug}"] [data-card-completed]`)).toContainText("Lõpetatud");
  await her.close();
});

test("§9 e2e 5: open answers — Maria asks for one fix, she rewrites only that one (no try used), Maria accepts", async ({ page, context, visitorIp, browser }, info) => {
  const questions = [E2E_QUESTIONS[0], ...E2E_OPEN];
  const s = await student("t5", info, { questions, points: [], lessonsDone: true });
  const her = await studentPage(browser, s.email, visitorIp);
  const sp = her.page;
  await sp.goto(testPage(s));
  await answer(sp, { q1: ["a"] }, { q3: "Puhastan, mõõdan, siis värvin.", q4: "Jätkan tööd." });
  await submitTest(sp);
  await expect(testState(sp)).toHaveAttribute("data-test-state", "review");
  await expect(sp.getByText("Ootab Maria hinnangut").first()).toBeVisible();
  const [first] = await storedAttempts(s.clientId);

  // Maria: "Testi vastused" → the review: the first answer accepted, the second "Paranda" with what to fix
  await signInAsAdmin(page, context, visitorIp, created);
  const item = await hindamine(page, "tests", s.accessId);
  await expect(item).toContainText("Katse 1/3");
  await item.getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/admin/hindamine/test\\?id=${first.id}$`));
  await adminReady(page);
  const reviewOf = (q: string) => page.locator(`[data-review-answer="${q}"]`);
  await expect(reviewOf("q3")).toContainText("Puhastan, mõõdan, siis värvin.");
  await reviewOf("q3").locator('[data-review-verdict="ok"]').click();
  await reviewOf("q4").locator('[data-review-verdict="fix"]').click();
  await reviewOf("q4").locator("[data-review-comment]").fill("Kirjuta, millal katkestad töö ja mida kliendile soovitad.");
  await page.locator("[data-review-send]").click();
  await expect(page.locator("[data-review-sent]")).toContainText("Saadetud");
  expect((await storedAttempts(s.clientId))[0]).toMatchObject({ number: 1, status: "fix" });

  // her page: Maria's comment at that answer, which alone opens again; "Saada uuesti" uses no try
  await sp.reload();
  await expect(testState(sp)).toHaveAttribute("data-test-state", "fix");
  await expect(sp.locator('[data-test-review-comment="q4"]')).toContainText("Kirjuta, millal katkestad töö");
  await expect(sp.locator('[data-question="q3"] [data-answer-open]')).not.toBeEditable();
  await sp.locator('[data-question="q4"] [data-answer-open]').fill("Katkestan töö, loputan silmad ja soovitan arsti.");
  await submitTest(sp);
  await expect(testState(sp)).toHaveAttribute("data-test-state", "review");
  expect((await storedAttempts(s.clientId)).map((a) => [a.number, a.status])).toEqual([[1, "review"]]); // the same attempt

  // Maria again: the accepted answer stays accepted; she accepts the rewritten one
  await page.reload();
  await adminReady(page);
  await expect(reviewOf("q3").locator('[data-review-verdict="ok"]')).toHaveAttribute("aria-pressed", "true");
  await expect(reviewOf("q4")).toContainText("Katkestan töö, loputan silmad ja soovitan arsti.");
  await reviewOf("q4").locator('[data-review-verdict="ok"]').click();
  await page.locator("[data-review-send]").click();
  await expect(page.locator("[data-review-sent]")).toContainText("Saadetud");

  // passed; the course had no points, so it is complete
  await sp.reload();
  await expect(testState(sp)).toHaveAttribute("data-test-state", "passed");
  expect((await storedAttempts(s.clientId))[0]).toMatchObject({ number: 1, status: "passed" });
  expect((await storedAccessRow(s.accessId)).completedAt).not.toBeNull();
  await her.close();
});

test("§9 e2e 6: out of tries — her page says so; Maria reopens the test from 'Katsed otsas'; her page opens again", async ({ page, context, visitorIp, browser }, info) => {
  const s = await student("t6", info, { questions: E2E_QUESTIONS, points: [], lessonsDone: true, tries: 2 });
  await insertAttempts(s.clientId, s.courseId, E2E_QUESTIONS, [
    { status: "failed", correct: 1, total: 2 },
    { status: "failed", correct: 0, total: 2 },
  ]);
  const her = await studentPage(browser, s.email, visitorIp);
  await her.page.goto(testPage(s));
  await expect(testState(her.page)).toHaveAttribute("data-test-state", "used");
  await expect(her.page.getByText(/Katsed on otsas/).first()).toBeVisible();
  await expect(her.page.locator("[data-test-submit]")).toHaveCount(0);

  await signInAsAdmin(page, context, visitorIp, created);
  const item = await hindamine(page, "tries", s.accessId);
  await expect(item).toContainText("parim tulemus 50 %");
  await item.locator("[data-reopen]").click();
  await confirmStep(item.locator("[data-reopen-confirm]"));
  // the page is not refreshed (Task 12): the row keeps its line saying what was done until the next visit, which no longer lists her
  await expect(item.locator("[data-reopen-done]")).toHaveText("Test on uuesti avatud: katseid jäänud 2.");
  await expect(item.locator("[data-reopen]")).toHaveCount(0);
  expect(await storedAccessRow(s.accessId)).toMatchObject({ extraTries: 2 });
  await expect(await hindamine(page, "tries", s.accessId)).toHaveCount(0);

  await her.page.reload();
  await expect(testState(her.page)).toHaveAttribute("data-test-state", "open");
  // her last attempt failed: the page shows its result and "Proovi uuesti" first (Task 6), the form after it
  await expect(her.page.locator("[data-test-retry]")).toContainText(/2 katset jäänud/);
  await her.page.locator("[data-test-retry]").click();
  await expect(her.page.locator("[data-test-submit]")).toBeVisible();
  await her.close();
});

test("§9 e2e 7: 'Lisa protokoll' from the student's drawer, for her e-course access and for her contact registration", async ({ page, context, visitorIp }, info) => {
  const s = await student("t7", info, { points: E2E_POINTS });
  const courseEmail = clientEmail("compl-t7k", runName(info)); // names the contact course, so its removal takes it
  made.add(courseEmail);
  await removeClientRows(courseEmail);
  const registrationId = await insertContactRegistration(s.email, s.clientId, courseEmail);
  await signInAsAdmin(page, context, visitorIp, created);

  // her e-course: the step line, "Lisa protokoll" → the access's screen; Maria writes before the student has sent anything
  await page.goto(`/admin/opilased?id=${s.clientId}`);
  await adminReady(page);
  const accessRow = page.locator(`[data-access="${s.courseId}"]`);
  await expect(accessRow.locator("[data-access-steps]")).toContainText("Praktiline töö");
  await expect(accessRow.locator("[data-access-protocol]")).toHaveText("Lisa protokoll");
  await accessRow.locator("[data-access-protocol]").click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?ligipaas=${s.accessId}$`));
  await adminReady(page);
  await general(page, s.accessId).fill("Tere! Alusta ettevalmistusest; fotod lisad siis, kui test on tehtud.");
  await saved(page, s.accessId);
  expect(await storedProtocolOf(s.accessId)).toMatchObject({ round: 0, generalNote: "Tere! Alusta ettevalmistusest; fotod lisad siis, kui test on tehtud." });
  await page.goto(`/admin/opilased?id=${s.clientId}`);
  await adminReady(page);
  await expect(page.locator(`[data-access="${s.courseId}"] [data-access-protocol]`)).toHaveText("Ava protokoll");

  // her contact registration: "Lisa protokoll" → the registration's screen
  const regRow = page.locator(`[data-client-registration="${registrationId}"]`);
  await expect(regRow.locator("[data-registration-protocol]")).toHaveText("Lisa protokoll");
  await regRow.locator("[data-registration-protocol]").click();
  await expect(page).toHaveURL(new RegExp(`/admin/protokollid\\?registreering=${registrationId}$`));
  await adminReady(page);
  await note(page, registrationId, 0).fill("Ühtlane joon.");
  await saved(page, registrationId);
  expect(await storedProtocol(registrationId)).toMatchObject({ stages: [{ title: "Ettevalmistus", note: "Ühtlane joon." }, { title: "Värvimine", note: "" }] });
  await page.goto(`/admin/opilased?id=${s.clientId}`);
  await adminReady(page);
  await expect(page.locator(`[data-client-registration="${registrationId}"] [data-registration-protocol]`)).toHaveText("Ava protokoll");
});

test("§9 e2e 8: the pages at 390, 834, 1194 and 1440 px — no sideways scroll, every target 44 px", async ({ page, context, visitorIp, browser, isMobile }, info) => {
  test.skip(isMobile, "sets its own widths: the desktop project only");
  await holdTerms(info); // the e-course page's "Lõpetamine" is one of the screens
  const jpeg = await canvasJpeg(page, 640, 480);
  // A: a test to take; B: practical work being prepared (one photo); C: open answers waiting for Maria; D: practical work sent, waiting;
  // E: out of tries — so Hindamine has an item in each of its three groups, and the overview shows "Ootab hindamist"
  const a = await student("look-a", info, { questions: [...E2E_QUESTIONS, E2E_OPEN[0]], points: [], lessonsDone: true });
  const b = await student("look-b", info, { points: E2E_POINTS, lessonsDone: true });
  await insertPractical(b.accessId, E2E_POINTS, jpeg, { round: 0, photos: [{ stage: 0, round: 1 }] });
  const cQuestions = [E2E_QUESTIONS[0], ...E2E_OPEN];
  const c = await student("look-c", info, { questions: cQuestions, points: [], lessonsDone: true });
  const [attemptId] = await insertAttempts(c.clientId, c.courseId, cQuestions, [{ status: "review", correct: 1, total: 1 }]);
  const d = await student("look-d", info, { points: E2E_POINTS, lessonsDone: true });
  await insertPractical(d.accessId, E2E_POINTS, jpeg, { round: 1, photos: [{ stage: 0, round: 1 }, { stage: 0, round: 1 }, { stage: 1, round: 1 }] });
  const e = await student("look-e", info, { questions: E2E_QUESTIONS, points: [], lessonsDone: true, tries: 1 });
  await insertAttempts(e.clientId, e.courseId, E2E_QUESTIONS, [{ status: "failed", correct: 1, total: 2 }]);
  await signInAsAdmin(page, context, visitorIp, created);
  const herA = await studentPage(browser, a.email, visitorIp);
  const herB = await studentPage(browser, b.email, visitorIp);
  /** Hindamine's items: one in each group, the out-of-tries one with its "Ava test uuesti". */
  const queued = [`[data-queue="practicals"] [data-queue-item="${d.accessId}"]`, `[data-queue="tests"] [data-queue-item="${c.accessId}"]`, `[data-queue="tries"] [data-queue-item="${e.accessId}"] [data-reopen]`];
  // `shows`: what the screen must show before it is measured (its items, the review's buttons, the photos and verdicts)
  const screens: { page: Page; url: string; scope: string; admin: boolean; shows?: string[] }[] = [
    { page: herA.page, url: testPage(a), scope: "[data-test-page]", admin: false },
    { page: herA.page, url: coursePage(a), scope: "[data-completion]", admin: false },
    { page: herB.page, url: practicalPage(b), scope: "[data-practical-page]", admin: false, shows: ["[data-photo]", "[data-photo-add]"] },
    { page, url: "/admin", scope: "[data-overview-assessment]", admin: true, shows: ['[data-overview-assessment-group="practicals"]', '[data-overview-assessment-group="tests"]', '[data-overview-assessment-group="tries"]'] },
    { page, url: "/admin/hindamine", scope: "[data-assessment-page]", admin: true, shows: queued },
    { page, url: `/admin/hindamine/test?id=${attemptId}`, scope: "[data-test-review-page]", admin: true, shows: ["[data-review-verdict]", "[data-review-send]"] },
    { page, url: `/admin/protokollid?ligipaas=${d.accessId}`, scope: "[data-protocol-screen]", admin: true, shows: ["[data-assess-photo]", "[data-verdict]", "[data-assess-send]"] },
  ];
  for (const width of [390, 834, 1194, 1440]) {
    for (const v of screens) {
      await v.page.setViewportSize({ width, height: 900 });
      await v.page.goto(v.url);
      if (v.admin) await adminReady(v.page);
      const scope = v.page.locator(v.scope).first();
      await expect(scope).toBeVisible();
      for (const part of v.shows ?? []) await expect(scope.locator(part).first()).toBeVisible();
      const where = `${v.url} at ${width} px`;
      expect(await noOverflow(v.page), where).toBe(true);
      // a radio, a checkbox or the file input is small by design: its label is the 44 px target (as admin-lessons.spec.ts filters them)
      expect((await smallTargets(scope)).filter((h) => !LABELLED.test(h)), where).toEqual([]);
    }
  }
  await herA.close();
  await herB.close();
});
