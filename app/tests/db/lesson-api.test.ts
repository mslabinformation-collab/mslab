import { eq, inArray } from "drizzle-orm";
import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, courseAccess, courseModules, courses, lessonFiles, lessonProgress, lessons, pages, termsAcceptances } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { bunnyConfig } from "@/server/bunny";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { PgKv } from "@/server/kv";
import { visibleLesson } from "@/server/lesson-data";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// Phase 3a (spec section 6): the lesson endpoints of the account API — the course with its lessons and their states, one lesson
// (a signed embed URL for an open lesson with a ready video, 403 locked or terms, 404 without access), progress (kept at its highest,
// done at 90 %, 12 a minute), "tehtud" for a text lesson, and the file download (the bytes, or a 302 to a signed address).

const NOW = new Date("2026-10-06T10:00:00Z");
const SITE = "https://mslab.example";
const BUNNY = bunnyConfig({ BUNNY_LIBRARY_ID: "12345", BUNNY_API_KEY: "test-api-key", BUNNY_TOKEN_KEY: "test-token-key" }, false)!;
const VIDEO_1 = "11111111-1111-4111-8111-111111111111";
const VIDEO_3 = "33333333-3333-4333-8333-333333333333";
const FILE_KEY = "lessons/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.pdf";
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

/**
 * An e-course of two modules: "Video" (lesson 1, a video lesson with a ready video of 100 s; a hidden lesson; lesson 2, a text lesson)
 * and "Lõpp" (lesson 3, a video lesson with a ready video of 200 s, with a PDF); a client signed in (one live session) with six
 * months of access; no terms text stored. Lessons are video lessons unless they say `kind: "text"` (the column default).
 */
async function world(access: Partial<typeof courseAccess.$inferInsert> = {}) {
  const [course] = await db.insert(courses).values({ slug: "veebikursus", type: "e_learning", level: "basic", title: { et: "Veebikursus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9500 }).returning();
  const [m1] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "Video" } }).returning();
  const [m2] = await db.insert(courseModules).values({ courseId: course.id, position: 2, title: { et: "Lõpp" } }).returning();
  const [l1] = await db.insert(lessons).values({ moduleId: m1.id, position: 1, title: { et: "Esimene" }, videoId: VIDEO_1, videoStatus: "ready", durationSec: 100 }).returning();
  const [hidden] = await db.insert(lessons).values({ moduleId: m1.id, position: 2, title: { et: "Peidus" }, hidden: true }).returning();
  const [l2] = await db.insert(lessons).values({ moduleId: m1.id, position: 3, title: { et: "Tekst" }, body: { et: "Loe see läbi." }, kind: "text" }).returning();
  const [l3] = await db.insert(lessons).values({ moduleId: m2.id, position: 1, title: { et: "Kolmas" }, videoId: VIDEO_3, videoStatus: "ready", durationSec: 200 }).returning();
  const [file] = await db.insert(lessonFiles).values({ lessonId: l3.id, position: 1, name: "Juhend.pdf", r2Key: FILE_KEY, size: 5, contentType: "application/pdf" }).returning();
  const [client] = await db.insert(clients).values({ email: "kati@example.test" }).returning();
  await db.insert(courseAccess).values({ clientId: client.id, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * 86_400_000), ...access });
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return { course, l1, l2, l3, hidden, file, client, cookie: `__Host-mslab_client=${raw}` };
}

function deps(over: Partial<AccountDeps> = {}): AccountDeps {
  return {
    db,
    env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
    now: NOW,
    siteUrl: SITE,
    later: () => {},
    dev: false,
    files: fakeMediaStore({ [FILE_KEY]: { bytes: PDF, contentType: "application/pdf" } }),
    bunny: BUNNY,
    ...over,
  };
}

/** GET (no body) or POST (a JSON body) to /api/konto<path> with the session cookie. */
const call = async (d: AccountDeps, cookie: string, path: string, body?: unknown) =>
  (await handleAccountApi(new Request(`${SITE}/api/konto${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), d))!;
const lessonPath = (id: number, rest = "") => `/kursus/veebikursus/${id}${rest}`;
/** Her progress clock on `lessonId` set `sec` seconds back, as if she had opened it then: reports up to 2 × sec + 30 s are kept. */
async function openedAgo(w: Awaited<ReturnType<typeof world>>, lessonId: number, sec = 3600) {
  const clockAt = new Date(NOW.getTime() - sec * 1000);
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId, clockAt }).onConflictDoUpdate({ target: [lessonProgress.clientId, lessonProgress.lessonId], set: { clockAt } });
}

test("the e-course lists its modules with the visible lessons and their states, the counts and where Jätka goes", async () => {
  const w = await world();
  const res = await call(deps(), w.cookie, "/kursus/veebikursus");
  expect(res.status).toBe(200);
  const view = await res.json();
  expect(view.progress).toEqual({ done: 0, total: 3, next: w.l1.id });
  expect(view.course.modules.map((m: { title: { et: string }; lessons: { title: { et: string }; state: string }[] }) => [m.title.et, m.lessons.map((l) => [l.title.et, l.state])])).toEqual([
    ["Video", [["Esimene", "current"], ["Tekst", "locked"]]],
    ["Lõpp", [["Kolmas", "locked"]]],
  ]);
});

test("an open lesson with a ready video: Bunny's URL signed for 4 hours, from the start, the e-mail as watermark; the next one is 403 locked", async () => {
  const w = await world();
  const res = await call(deps(), w.cookie, lessonPath(w.l1.id));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  const view = await res.json();
  const expires = Math.floor(NOW.getTime() / 1000) + 4 * 3600;
  expect(view.video).toEqual({
    state: "ready",
    embedUrl: expect.stringMatching(new RegExp(`^https://player\\.mediadelivery\\.net/embed/12345/${VIDEO_1}\\?token=[0-9a-f]{64}&expires=${expires}&autoplay=false$`)),
    expires,
    resumeAt: 0,
    durationSec: 100,
    shape: null, // no size known (an older video): the player assumes 16:9
  });
  expect(view).toMatchObject({
    course: { slug: "veebikursus", title: { et: "Veebikursus" } },
    module: { title: { et: "Video" } },
    lesson: { id: w.l1.id, title: { et: "Esimene" }, body: null, done: false, textOnly: false },
    files: [],
    next: w.l2.id,
    watermark: "kati@example.test",
  });
  const locked = await call(deps(), w.cookie, lessonPath(w.l2.id));
  expect(locked.status).toBe(403);
  expect(await locked.json()).toEqual({ ok: false, error: "locked", next: w.l1.id });
});

test("a ready video carries its picture size as `shape` ({ width, height }); null when it is not known", async () => {
  const w = await world();
  const shapeOf = async () => (await (await call(deps(), w.cookie, lessonPath(w.l1.id))).json()).video.shape;
  expect(await shapeOf()).toBeNull();
  await db.update(lessons).set({ videoWidth: 1080, videoHeight: 1920 }).where(eq(lessons.id, w.l1.id));
  expect(await shapeOf()).toEqual({ width: 1080, height: 1920 });
  await db.update(lessons).set({ videoWidth: 1920, videoHeight: 1080 }).where(eq(lessons.id, w.l1.id));
  expect(await shapeOf()).toEqual({ width: 1920, height: 1080 });
});

test("a stored size that cannot be a shape (one side only, 0, over 10000) reaches the player as null, never as a number", async () => {
  const w = await world();
  const shapeOf = async () => (await (await call(deps(), w.cookie, lessonPath(w.l1.id))).json()).video.shape;
  for (const [videoWidth, videoHeight] of [[1080, null], [null, 1920], [0, 0], [1080, 0], [20_000, 1080], [-1080, 1920]] as const) {
    await db.update(lessons).set({ videoWidth, videoHeight }).where(eq(lessons.id, w.l1.id));
    expect(await shapeOf(), `${videoWidth} × ${videoHeight}`).toBeNull();
  }
});

test("during a replacement the lesson answers with the shape of the video that plays (the old one); a text lesson has no video and no shape", async () => {
  const w = await world();
  await db.update(lessons).set({ videoWidth: 1080, videoHeight: 1920, videoId: "44444444-4444-4444-8444-444444444444", videoStatus: "processing", replacedVideoId: VIDEO_1 }).where(eq(lessons.id, w.l1.id));
  const video = (await (await call(deps(), w.cookie, lessonPath(w.l1.id))).json()).video;
  expect(video.embedUrl).toContain(`/embed/12345/${VIDEO_1}?`);
  expect(video.shape).toEqual({ width: 1080, height: 1920 });
  await db.update(lessons).set({ kind: "text" }).where(eq(lessons.id, w.l1.id));
  expect((await (await call(deps(), w.cookie, lessonPath(w.l1.id))).json()).video).toBeNull();
});

test("progress is kept at its highest; at 90 % the lesson is done and the next one opens; a done lesson starts from the beginning", async () => {
  const w = await world();
  await openedAgo(w, w.l1.id);
  const d = deps();
  const post = (watchedSec: unknown) => call(d, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec });
  expect(await (await post(50)).json()).toEqual({ ok: true, done: false, next: w.l2.id });
  expect(await (await post(20)).json()).toEqual({ ok: true, done: false, next: w.l2.id });
  expect((await db.select().from(lessonProgress))[0].watchedSec).toBe(50);
  expect(await (await post(89.9)).json()).toMatchObject({ done: false });
  expect(await (await post(90)).json()).toEqual({ ok: true, done: true, next: w.l2.id });
  expect((await call(d, w.cookie, lessonPath(w.l2.id))).status).toBe(200);
  expect((await (await call(d, w.cookie, lessonPath(w.l1.id))).json()).video.resumeAt).toBe(0);
});

test("a lesson begun: the player starts at the saved second (t=…)", async () => {
  const w = await world();
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l1.id, watchedSec: 42 });
  const view = await (await call(deps(), w.cookie, lessonPath(w.l1.id))).json();
  expect(view.video.resumeAt).toBe(42);
  expect(new URL(view.video.embedUrl).searchParams.get("t")).toBe("42");
});

test("progress refuses: no number (400), past the length + 5 s (400), a locked lesson (403), a hidden or unknown one (404), a text lesson (kind 'text', 409)", async () => {
  const w = await world();
  await openedAgo(w, w.l1.id);
  const d = deps();
  const post = (id: number, body: unknown) => call(d, w.cookie, lessonPath(id, "/progress"), body);
  expect(await (await post(w.l1.id, { watchedSec: "50" })).json()).toEqual({ ok: false, error: "watchedSec" });
  const tooFar = await post(w.l1.id, { watchedSec: 106 });
  expect(tooFar.status).toBe(400);
  expect(await tooFar.json()).toEqual({ ok: false, error: "watchedSec" });
  const locked = await post(w.l3.id, { watchedSec: 1 });
  expect([locked.status, await locked.json()]).toEqual([403, { ok: false, error: "locked", next: w.l1.id }]);
  expect((await post(w.hidden.id, { watchedSec: 1 })).status).toBe(404);
  expect((await post(999999, { watchedSec: 1 })).status).toBe(404);
  expect((await post(w.l1.id, { watchedSec: 105 })).status).toBe(200); // the length + 5 s is fine (and done)
  const text = await post(w.l2.id, { watchedSec: 1 });
  expect([text.status, await text.json()]).toEqual([409, { ok: false, error: "video" }]);
});

test("“Märgi tehtuks” is for a text lesson (kind 'text') only; it opens the next one", async () => {
  const w = await world();
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l1.id, watchedSec: 100, doneAt: NOW });
  const d = deps();
  expect((await call(d, w.cookie, lessonPath(w.l1.id, "/tehtud"), {})).status).toBe(409);
  expect((await (await call(d, w.cookie, lessonPath(w.l2.id))).json()).lesson).toMatchObject({ textOnly: true, done: false });
  expect((await (await call(d, w.cookie, lessonPath(w.l2.id))).json()).video).toBeNull();
  expect(await (await call(d, w.cookie, lessonPath(w.l2.id, "/tehtud"), {})).json()).toEqual({ ok: true, done: true, next: w.l3.id });
  expect((await (await call(d, w.cookie, "/kursus/veebikursus")).json()).progress).toEqual({ done: 2, total: 3, next: w.l3.id });
  expect((await call(d, w.cookie, lessonPath(w.l3.id, "/tehtud"), {})).status).toBe(409); // a video lesson is done by watching
});

test("a video lesson whose video is not uploaded or not ready: 'Video lisandub peagi'; progress and “tehtud” are 409; the next lesson stays locked", async () => {
  const w = await world();
  const d = deps();
  for (const videoStatus of ["none", "uploading", "processing", "failed"] as const) {
    await db.update(lessons).set({ videoStatus, videoId: videoStatus === "none" ? null : VIDEO_1, durationSec: null }).where(eq(lessons.id, w.l1.id));
    const view = await (await call(d, w.cookie, lessonPath(w.l1.id))).json();
    expect([view.video, view.lesson.textOnly], videoStatus).toEqual([{ state: "soon" }, false]);
    expect((await call(d, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 1 })).status, videoStatus).toBe(409);
    expect((await call(d, w.cookie, lessonPath(w.l1.id, "/tehtud"), {})).status, videoStatus).toBe(409);
    expect((await call(d, w.cookie, lessonPath(w.l2.id))).status, videoStatus).toBe(403);
    expect(await db.select().from(lessonProgress), `${videoStatus}: no video plays, so no progress clock`).toEqual([]);
  }
  expect(await db.select().from(lessonProgress)).toHaveLength(0);
  expect((await (await call(d, w.cookie, "/kursus/veebikursus")).json()).progress).toEqual({ done: 0, total: 3, next: w.l1.id });
});

test("a lesson an admin opened is open without the one before; a hidden lesson neither counts nor blocks, and is 404", async () => {
  const w = await world();
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l3.id, unlockedBy: "admin@example.test" });
  const view = await (await call(deps(), w.cookie, "/kursus/veebikursus")).json();
  expect(view.course.modules.flatMap((m: { lessons: { state: string }[] }) => m.lessons.map((l) => l.state))).toEqual(["current", "locked", "current"]);
  expect((await call(deps(), w.cookie, lessonPath(w.l3.id))).status).toBe(200);
  expect((await call(deps(), w.cookie, lessonPath(w.hidden.id))).status).toBe(404);
});

test.each([
  ["ended", { expiresAt: new Date(NOW.getTime() - 1000) }],
  ["revoked", { revokedAt: NOW }],
])("access %s: every lesson endpoint answers 404", async (_, access) => {
  const w = await world(access);
  const d = deps();
  expect((await call(d, w.cookie, lessonPath(w.l1.id))).status).toBe(404);
  expect((await call(d, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 1 })).status).toBe(404);
  expect((await call(d, w.cookie, lessonPath(w.l2.id, "/tehtud"), {})).status).toBe(404);
  expect((await call(d, w.cookie, lessonPath(w.l3.id, `/fail/${w.file.id}`))).status).toBe(404);
});

test("a file: 403 while its lesson is locked; open → the bytes as a download (local store) or a 302 to a 5-minute signed address (R2); another lesson's file → 404", async () => {
  const w = await world();
  const path = lessonPath(w.l3.id, `/fail/${w.file.id}`);
  expect((await call(deps(), w.cookie, path)).status).toBe(403);
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l3.id, unlockedBy: "admin@example.test" });
  const local = await call(deps(), w.cookie, path);
  expect(local.status).toBe(200);
  expect(local.headers.get("content-type")).toBe("application/pdf");
  expect(local.headers.get("content-disposition")).toBe(`attachment; filename="Juhend.pdf"; filename*=UTF-8''Juhend.pdf`);
  expect(local.headers.get("cache-control")).toBe("private, no-store");
  expect(local.headers.get("referrer-policy")).toBe("no-referrer");
  expect([...new Uint8Array(await local.arrayBuffer())]).toEqual(PDF);
  const signedGetUrl = vi.fn(async () => "https://r2.example/signed");
  const r2 = await call(deps({ files: { ...fakeMediaStore(), signedGetUrl } }), w.cookie, path);
  expect(r2.status).toBe(302);
  expect(r2.headers.get("location")).toBe("https://r2.example/signed");
  expect(r2.headers.get("cache-control")).toBe("private, no-store");
  expect(r2.headers.get("referrer-policy")).toBe("no-referrer");
  expect(signedGetUrl).toHaveBeenCalledWith(FILE_KEY, { expiresSec: 300 });
  expect((await call(deps(), w.cookie, lessonPath(w.l1.id, `/fail/${w.file.id}`))).status).toBe(404);
  expect((await call(deps({ files: null }), w.cookie, path)).status).toBe(404);
});

test("terms not accepted: the lesson answers 403 terms; once accepted it opens", async () => {
  const w = await world();
  await db.insert(pages).values({ key: "course_terms", title: { et: "Tingimused" }, body: { et: "Ligipääs on isiklik." } });
  const res = await call(deps(), w.cookie, lessonPath(w.l1.id));
  expect([res.status, await res.json()]).toEqual([403, { ok: false, error: "terms" }]);
  await db.insert(termsAcceptances).values({ clientId: w.client.id, courseId: w.course.id, termsVersion: "1" });
  expect((await call(deps(), w.cookie, lessonPath(w.l1.id))).status).toBe(200);
});

test("one order of checks (openLesson): a hidden lesson is 404 before anything; terms come before the lock, on the lesson page only", async () => {
  const w = await world();
  await db.insert(pages).values({ key: "course_terms", title: { et: "Tingimused" }, body: { et: "Ligipääs on isiklik." } });
  const d = deps();
  expect((await call(d, w.cookie, lessonPath(w.hidden.id))).status).toBe(404);
  expect(await (await call(d, w.cookie, lessonPath(w.l3.id))).json()).toEqual({ ok: false, error: "terms" }); // locked too, but terms first
  expect(await (await call(d, w.cookie, lessonPath(w.l3.id, "/progress"), { watchedSec: 1 })).json()).toEqual({ ok: false, error: "locked", next: w.l1.id });
  expect(await (await call(d, w.cookie, lessonPath(w.l2.id, "/tehtud"), {})).json()).toEqual({ ok: false, error: "locked", next: w.l1.id });
  expect(await (await call(d, w.cookie, lessonPath(w.l3.id, `/fail/${w.file.id}`))).json()).toEqual({ ok: false, error: "locked" });
});

test("progress: at most 12 reports a minute per student (429 after)", async () => {
  const w = await world();
  const d = deps();
  for (let i = 1; i <= 12; i++) expect((await call(d, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: i })).status).toBe(200);
  const res = await call(d, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 13 });
  expect([res.status, await res.json()]).toEqual([429, { ok: false, error: "rate" }]);
});

test("no video to play yet ('Video lisandub peagi'): an upload on its way, or Bunny not set up; during a replacement the old video plays", async () => {
  const w = await world();
  await db.update(lessons).set({ videoStatus: "processing" }).where(eq(lessons.id, w.l1.id));
  expect((await (await call(deps(), w.cookie, lessonPath(w.l1.id))).json()).video).toEqual({ state: "soon" });
  expect((await call(deps(), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 1 })).status).toBe(409);
  expect(await db.select().from(lessonProgress)).toEqual([]); // no video plays: no progress clock
  await db.update(lessons).set({ videoId: "44444444-4444-4444-8444-444444444444", videoStatus: "uploading", replacedVideoId: VIDEO_1 }).where(eq(lessons.id, w.l1.id));
  expect((await (await call(deps({ bunny: null }), w.cookie, lessonPath(w.l1.id))).json()).video).toEqual({ state: "soon" });
  expect(await db.select().from(lessonProgress)).toEqual([]); // Bunny not set up: none either
  expect((await (await call(deps(), w.cookie, lessonPath(w.l1.id))).json()).video.embedUrl).toContain(`/embed/12345/${VIDEO_1}?`);
  expect((await db.select().from(lessonProgress)).map((r) => [r.lessonId, r.watchedSec, r.clockAt])).toEqual([[w.l1.id, 0, NOW]]); // the old video plays: the clock starts
});

test("ids that cannot be ids are 404; a GET of …/progress or a POST of a lesson is 404", async () => {
  const w = await world();
  for (const path of ["/kursus/veebikursus/0", "/kursus/veebikursus/01", "/kursus/veebikursus/abc", `/kursus/veebikursus/${w.l1.id}/fail/x`, `/kursus/veebikursus/${w.l1.id}/progress`])
    expect((await call(deps(), w.cookie, path)).status, path).toBe(404);
  expect((await call(deps(), w.cookie, lessonPath(w.l1.id), {})).status).toBe(404);
});

test("done_at is the moment the lesson was done: a later report keeps it, and the watched seconds still grow", async () => {
  const w = await world();
  await openedAgo(w, w.l1.id);
  const at = (sec: number) => deps({ now: new Date(NOW.getTime() + sec * 1000) });
  expect((await (await call(at(0), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 95 })).json()).done).toBe(true);
  const [first] = await db.select().from(lessonProgress);
  expect(first.doneAt).toEqual(NOW);
  expect((await call(at(3600), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 100 })).status).toBe(200);
  const [later] = await db.select().from(lessonProgress);
  expect([later.doneAt, later.watchedSec]).toEqual([NOW, 100]);
});

// The limit counts in fixed clock minutes: rateLimit alone restarts a key's expiry with every accepted request, so a player reporting
// every 15 s never let its 60 s window end and was refused after 12 reports, whatever the video's length. These run on the real PgKv
// (kv_entries, expiry read from a clock the test moves), as production does.

/** Dependencies on the real PgKv, at `clock()`. */
function clocked(clock: () => Date): AccountDeps {
  return deps({ now: clock(), env: { KV: new PgKv(db, clock), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE } });
}

test("progress reports every 15 s for ten minutes are all accepted (the limit is per clock minute, not a window that never ends)", async () => {
  const w = await world();
  await db.update(lessons).set({ durationSec: 3600 }).where(eq(lessons.id, w.l1.id));
  let clock = NOW;
  const statuses: number[] = [];
  for (let i = 1; i <= 40; i++) {
    clock = new Date(NOW.getTime() + i * 15_000);
    statuses.push((await call(clocked(() => clock), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: i * 15 })).status);
  }
  expect(statuses).toEqual(Array(40).fill(200));
  expect((await db.select().from(lessonProgress))[0].watchedSec).toBe(600);
});

test("a burst of more than 12 reports in one clock minute gets 429; the next minute starts again", async () => {
  const w = await world();
  await db.update(lessons).set({ durationSec: 3600 }).where(eq(lessons.id, w.l1.id));
  let clock = NOW; // 10:00:00, the start of a minute
  const report = async (watchedSec: number) => (await call(clocked(() => clock), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec })).status;
  const burst: number[] = [];
  for (let i = 1; i <= 14; i++) {
    clock = new Date(NOW.getTime() + i * 2_000); // 14 reports in 28 s
    burst.push(await report(i));
  }
  expect(burst).toEqual([...Array(12).fill(200), 429, 429]);
  clock = new Date(NOW.getTime() + 59_000);
  expect(await report(20)).toBe(429); // still the same minute
  clock = new Date(NOW.getTime() + 60_000);
  expect(await report(21)).toBe(200); // 10:01:00
  expect((await db.select().from(lessonProgress))[0].watchedSec).toBe(21); // the refused reports wrote nothing
});

test("a 210 s video watched to the end with a report every 15 s (and one at the end) is done, and the next lesson opens", async () => {
  const w = await world();
  await db.update(lessons).set({ durationSec: 210 }).where(eq(lessons.id, w.l1.id));
  let clock = NOW;
  const answers: [number, number, boolean][] = [];
  for (let t = 15; t <= 210; t += 15) {
    clock = new Date(NOW.getTime() + t * 1000);
    const res = await call(clocked(() => clock), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: t });
    answers.push([t, res.status, (await res.json()).done]);
  }
  expect(answers.every(([, status]) => status === 200)).toBe(true);
  expect(answers.at(-1)).toEqual([210, 200, true]);
  const [row] = await db.select().from(lessonProgress);
  expect([row.watchedSec, row.doneAt !== null]).toEqual([210, true]);
  expect((await call(clocked(() => clock), w.cookie, lessonPath(w.l2.id))).status).toBe(200);
});

/** A second e-course with a video lesson (and a file) and a text lesson. */
async function otherCourse() {
  const [course] = await db.insert(courses).values({ slug: "teine-kursus", type: "e_learning", level: "basic", title: { et: "Teine" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9500 }).returning();
  const [module] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "Teine moodul" } }).returning();
  const [b1] = await db.insert(lessons).values({ moduleId: module.id, position: 1, title: { et: "B esimene" }, videoId: "55555555-5555-4555-8555-555555555555", videoStatus: "ready", durationSec: 100 }).returning();
  const [b2] = await db.insert(lessons).values({ moduleId: module.id, position: 2, title: { et: "B tekst" }, kind: "text" }).returning();
  const [file] = await db.insert(lessonFiles).values({ lessonId: b1.id, position: 1, name: "B.pdf", r2Key: "lessons/1a1a1a1a-3d4a-4b5c-8d9e-0a1b2c3d4e5f.pdf", size: 5, contentType: "application/pdf" }).returning();
  return { course, b1, b2, file };
}

test("a lesson or file of another course is 404 under this course's slug, with and without access to the other course", async () => {
  const w = await world();
  const b = await otherCourse();
  const d = deps({ files: fakeMediaStore({ [FILE_KEY]: { bytes: PDF }, [b.file.r2Key]: { bytes: PDF } }) });
  const underA = async () => [
    (await call(d, w.cookie, lessonPath(b.b1.id))).status,
    (await call(d, w.cookie, lessonPath(b.b1.id, "/progress"), { watchedSec: 1 })).status,
    (await call(d, w.cookie, lessonPath(b.b2.id, "/tehtud"), {})).status,
    (await call(d, w.cookie, lessonPath(b.b1.id, `/fail/${b.file.id}`))).status,
    (await call(d, w.cookie, lessonPath(w.l1.id, `/fail/${b.file.id}`))).status, // B's file under A's open lesson
  ];
  expect(await underA()).toEqual([404, 404, 404, 404, 404]); // access to A only
  await db.insert(courseAccess).values({ clientId: w.client.id, courseId: b.course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * 86_400_000) });
  expect(await underA()).toEqual([404, 404, 404, 404, 404]); // access to both: still not under A's slug
  expect((await call(d, w.cookie, `/kursus/teine-kursus/${b.b1.id}`)).status).toBe(200); // under its own slug it is there
  expect((await call(d, w.cookie, `/kursus/teine-kursus/${w.l1.id}`)).status).toBe(404); // and A's lesson is not B's
  // the refused calls wrote nothing; the lesson opened under its own slug started its clock (a row with 0 s)
  expect((await db.select().from(lessonProgress)).map((r) => [r.lessonId, r.watchedSec, r.doneAt])).toEqual([[b.b1.id, 0, null]]);
});

test("visibleLesson (the first read of openLesson) finds a lesson only in its own course, and not a hidden one", async () => {
  const w = await world();
  const b = await otherCourse();
  expect((await visibleLesson(db, w.course.id, w.client.id, w.l1.id))?.id).toBe(w.l1.id);
  expect(await visibleLesson(db, w.course.id, w.client.id, b.b1.id)).toBeNull(); // another course's lesson
  expect((await visibleLesson(db, b.course.id, w.client.id, b.b1.id))?.id).toBe(b.b1.id);
  expect(await visibleLesson(db, w.course.id, w.client.id, w.hidden.id)).toBeNull();
  expect(await visibleLesson(db, w.course.id, w.client.id, 999999)).toBeNull();
});

// ---- admin UX pass piece 3a (Task 2, R-e, R-f): what a student never reads ----

/** The world plus an unpublished module "Uus moodul" with two lessons (one flagged itself, one not: its module's flag is enough) and an unpublished lesson at the very front of the first module. */
async function withUnpublished() {
  const w = await world();
  const [first] = await db.select({ moduleId: lessons.moduleId }).from(lessons).where(eq(lessons.id, w.l1.id));
  const [um] = await db.insert(courseModules).values({ courseId: w.course.id, position: 3, title: { et: "Uus moodul" }, unpublished: true }).returning();
  const [flagged] = await db.insert(lessons).values({ moduleId: um.id, position: 1, title: { et: "Uus üks" }, kind: "text", unpublished: true }).returning();
  const [unflagged] = await db.insert(lessons).values({ moduleId: um.id, position: 2, title: { et: "Uus kaks" }, kind: "text" }).returning();
  const [front] = await db.insert(lessons).values({ moduleId: first.moduleId, position: 0, title: { et: "Uus ees" }, kind: "text", unpublished: true }).returning();
  return { ...w, um, flagged, unflagged, front, ids: [flagged.id, unflagged.id, front.id] };
}

test("unpublished modules and lessons are not in the student's e-course: not listed, not counted, and they do not hold the order back", async () => {
  const w = await withUnpublished();
  const view = await (await call(deps(), w.cookie, "/kursus/veebikursus")).json();
  expect(view.progress).toEqual({ done: 0, total: 3, next: w.l1.id }); // the unpublished lesson in front of lesson 1 does not make lesson 1 wait
  expect(view.course.modules.map((m: { title: { et: string }; lessons: { title: { et: string }; state: string }[] }) => [m.title.et, m.lessons.map((l) => [l.title.et, l.state])])).toEqual([
    ["Video", [["Esimene", "current"], ["Tekst", "locked"]]],
    ["Lõpp", [["Kolmas", "locked"]]],
  ]);
  // the same rows, published: they are all there (the flag is the only thing that kept them out)
  await db.update(courseModules).set({ unpublished: false }).where(eq(courseModules.id, w.um.id));
  await db.update(lessons).set({ unpublished: false }).where(inArray(lessons.id, w.ids));
  const published = await (await call(deps(), w.cookie, "/kursus/veebikursus")).json();
  expect(published.progress.total).toBe(6);
  expect(published.course.modules.map((m: { title: { et: string } }) => m.title.et)).toEqual(["Video", "Lõpp", "Uus moodul"]);
});

test("a student's GET, progress and “tehtud” of an unpublished lesson are 404 (its own flag, or its module's), and write nothing", async () => {
  const w = await withUnpublished();
  const d = deps();
  for (const id of w.ids) {
    expect((await call(d, w.cookie, lessonPath(id))).status, `GET ${id}`).toBe(404);
    expect((await call(d, w.cookie, lessonPath(id, "/progress"), { watchedSec: 1 })).status, `progress ${id}`).toBe(404);
    expect((await call(d, w.cookie, lessonPath(id, "/tehtud"), {})).status, `tehtud ${id}`).toBe(404);
  }
  expect(await db.select().from(lessonProgress)).toEqual([]);
  expect(await visibleLesson(db, w.course.id, w.client.id, w.flagged.id)).toBeNull();
  expect(await visibleLesson(db, w.course.id, w.client.id, w.unflagged.id)).toBeNull(); // (only its module is unpublished)
  expect(await visibleLesson(db, w.course.id, w.client.id, w.front.id)).toBeNull();
  expect((await visibleLesson(db, w.course.id, w.client.id, w.l1.id))?.id).toBe(w.l1.id);
  // the last published lesson: "Järgmine õppetund" never points into the unpublished module after it
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l3.id, unlockedBy: "admin@example.test" });
  expect((await (await call(d, w.cookie, lessonPath(w.l3.id))).json()).next).toBeNull();
});

test("a removed lesson file (removed_at set) is gone for the student: not in the lesson's files, its download is 404; undone, it is back", async () => {
  const w = await world();
  const KEY_2 = "lessons/1a2b3c4d-0000-4000-8000-000000000002.pdf";
  const d = deps({ files: fakeMediaStore({ [FILE_KEY]: { bytes: PDF, contentType: "application/pdf" }, [KEY_2]: { bytes: PDF, contentType: "application/pdf" } }) });
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l3.id, unlockedBy: "admin@example.test" });
  const [second] = await db.insert(lessonFiles).values({ lessonId: w.l3.id, position: 2, name: "Lisa.pdf", r2Key: KEY_2, size: 5, contentType: "application/pdf" }).returning();
  const filesOf = async () => (await (await call(d, w.cookie, lessonPath(w.l3.id))).json()).files.map((f: { name: string }) => f.name);
  expect(await filesOf()).toEqual(["Juhend.pdf", "Lisa.pdf"]);
  await db.update(lessonFiles).set({ removedAt: new Date(NOW.getTime() - 1000) }).where(eq(lessonFiles.id, w.file.id));
  expect(await filesOf()).toEqual(["Lisa.pdf"]);
  expect((await call(d, w.cookie, lessonPath(w.l3.id, `/fail/${w.file.id}`))).status).toBe(404);
  expect((await call(d, w.cookie, lessonPath(w.l3.id, `/fail/${second.id}`))).status).toBe(200); // the other one still downloads
  await db.update(lessonFiles).set({ removedAt: null }).where(eq(lessonFiles.id, w.file.id)); // „Võta tagasi“
  expect(await filesOf()).toEqual(["Juhend.pdf", "Lisa.pdf"]);
  expect((await call(d, w.cookie, lessonPath(w.l3.id, `/fail/${w.file.id}`))).status).toBe(200);
});

// ---- phase 2c: the progress clock (spec 3, domain/lessons.ts acceptProgress) ----

test("opening a lesson with a ready video starts its progress clock (a row with 0 s); reopened later it moves on, the seconds stay; a text lesson writes none", async () => {
  const w = await world();
  await call(deps(), w.cookie, lessonPath(w.l1.id));
  const [row] = await db.select().from(lessonProgress);
  expect([row.lessonId, row.watchedSec, row.clockAt, row.doneAt]).toEqual([w.l1.id, 0, NOW, null]);
  await db.update(lessonProgress).set({ watchedSec: 40 });
  const later = new Date(NOW.getTime() + 3600_000);
  await call(deps({ now: later }), w.cookie, lessonPath(w.l1.id));
  expect((await db.select().from(lessonProgress))[0]).toMatchObject({ watchedSec: 40, clockAt: later });
  await db.update(lessonProgress).set({ doneAt: NOW });
  await call(deps(), w.cookie, lessonPath(w.l2.id)); // the text lesson, open now
  expect(await db.select().from(lessonProgress).where(eq(lessonProgress.lessonId, w.l2.id))).toEqual([]);
});

test("a report that runs ahead is clamped to twice the time since the lesson was opened plus 30 s, not refused; the 90 % rule counts what was kept", async () => {
  const w = await world(); // lesson 1: 100 s
  await call(deps(), w.cookie, lessonPath(w.l1.id));
  const at = (sec: number) => deps({ now: new Date(NOW.getTime() + sec * 1000) });
  expect(await (await call(at(10), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 95 })).json()).toEqual({ ok: true, done: false, next: w.l2.id });
  expect((await db.select().from(lessonProgress))[0].watchedSec).toBe(50); // 10 × 2 + 30
  expect(await (await call(at(30), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 95 })).json()).toEqual({ ok: true, done: true, next: w.l2.id });
  expect((await db.select().from(lessonProgress))[0].watchedSec).toBe(90); // + (30 − 25) × 2 + 30
});

test("reports as often as the limit allows cannot beat the clock: a minute of them keeps at most 2 × 60 + 30 s", async () => {
  const w = await world();
  await db.update(lessons).set({ durationSec: 3600 }).where(eq(lessons.id, w.l1.id));
  await call(deps(), w.cookie, lessonPath(w.l1.id));
  for (let s = 5; s <= 60; s += 5) await call(deps({ now: new Date(NOW.getTime() + s * 1000) }), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 3600 });
  expect((await db.select().from(lessonProgress))[0].watchedSec).toBe(150);
});

test("a row from before phase 2c (no clock): the first report raises the seconds by at most 30 and starts the clock", async () => {
  const w = await world();
  await db.update(lessons).set({ durationSec: 600 }).where(eq(lessons.id, w.l1.id));
  await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.l1.id, watchedSec: 200 });
  await call(deps(), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 400 });
  expect((await db.select().from(lessonProgress))[0]).toMatchObject({ watchedSec: 230, clockAt: new Date(NOW.getTime() + 15_000) });
});

test("opening the lesson again gives no new 30 s while her time is used up beyond now", async () => {
  const w = await world();
  await db.update(lessons).set({ durationSec: 600 }).where(eq(lessons.id, w.l1.id));
  await call(deps(), w.cookie, lessonPath(w.l1.id)); // the clock: NOW
  await call(deps(), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 30 }); // 30 kept; the clock: NOW + 15 s
  await call(deps(), w.cookie, lessonPath(w.l1.id)); // opened again at NOW: the clock stays at NOW + 15 s
  await call(deps(), w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 60 }); // allowed: (0 − 15) × 2 + 30 = 0
  expect((await db.select().from(lessonProgress))[0]).toMatchObject({ watchedSec: 30, clockAt: new Date(NOW.getTime() + 15_000) });
});

// The races of the progress clock. Postgres runs two requests of one student at once; each reads her row, then writes: what the later
// write brings from its older read must not undo the earlier one. Both writes keep the clock and the seconds with greatest().

/**
 * A Db whose writes to lesson_progress wait for each other: none goes out until `n` of them are waiting, then they go in the order they
 * came. So `n` requests started together have all read the row before any of them writes it: the race made certain, not left to timing.
 */
function raceOnProgress(real: Db, n: number): Db {
  const waiting: (() => void)[] = [];
  const gate = () =>
    new Promise<void>((go) => {
      waiting.push(go);
      if (waiting.length === n) for (const release of waiting) release();
    });
  type Call = (...args: unknown[]) => unknown;
  const held = <T extends object>(query: T): T =>
    new Proxy(query, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (prop === "then") return (ok?: unknown, fail?: unknown) => gate().then(() => (value as Call).call(target, ok, fail));
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const out = (value as Call).apply(target, args);
          return typeof out === "object" && out !== null ? held(out) : out;
        };
      },
    });
  return new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop !== "insert") return (value as Call).bind(target);
      return (table: unknown) => {
        const query = (value as Call).call(target, table) as object;
        return table === lessonProgress ? held(query) : query;
      };
    },
  });
}

test("two reports that read the same row at once: the one that lands last cannot take the clock back, so the allowance is not had twice", async () => {
  const w = await world();
  await db.update(lessons).set({ durationSec: 3600 }).where(eq(lessons.id, w.l1.id));
  await call(deps(), w.cookie, lessonPath(w.l1.id)); // the clock: NOW, 0 s
  const at = (sec: number, racing?: Db) => deps({ now: new Date(NOW.getTime() + sec * 1000), ...(racing ? { db: racing } : {}) });
  const post = (d: AccountDeps, watchedSec: number) => call(d, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec });
  // both read (0 s, the clock at NOW); the first raises to 40 s and the clock to NOW + 20 s; the second raises nothing and writes last
  const racing = at(20, raceOnProgress(db, 2));
  expect((await Promise.all([post(racing, 40), post(racing, 0)])).map((r) => r.status)).toEqual([200, 200]);
  expect((await db.select().from(lessonProgress))[0]).toMatchObject({ watchedSec: 40, clockAt: new Date(NOW.getTime() + 20_000) });
  // the 70 s of 20 s + 30 s are used: at the same moment she is allowed 30 s more, not the 70 s the stale clock would give
  await post(at(20), 3600);
  expect((await db.select().from(lessonProgress))[0]).toMatchObject({ watchedSec: 70, clockAt: new Date(NOW.getTime() + 35_000) });
});

test("two reports that both raise from the same row: the larger raise and its clock are kept, never a mix of the two", async () => {
  const w = await world();
  await db.update(lessons).set({ durationSec: 3600 }).where(eq(lessons.id, w.l1.id));
  await call(deps(), w.cookie, lessonPath(w.l1.id)); // the clock: NOW, 0 s
  const racing = deps({ now: new Date(NOW.getTime() + 20_000), db: raceOnProgress(db, 2) });
  const post = (watchedSec: number) => call(racing, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec });
  await Promise.all([post(60), post(30)]); // 60 s first (the clock NOW + 30 s), then 30 s (NOW + 15 s) over it
  expect((await db.select().from(lessonProgress))[0]).toMatchObject({ watchedSec: 60, clockAt: new Date(NOW.getTime() + 30_000) });
});

test("a lesson opened while a report is being kept: opening cannot take the clock back either", async () => {
  const w = await world();
  await db.update(lessons).set({ durationSec: 3600 }).where(eq(lessons.id, w.l1.id));
  await call(deps(), w.cookie, lessonPath(w.l1.id)); // the clock: NOW, 0 s
  const racing = deps({ now: new Date(NOW.getTime() + 5_000), db: raceOnProgress(db, 2) });
  // the report keeps 40 s (5 s × 2 + 30 s) and moves the clock to NOW + 20 s; the page, which read the clock at NOW, opens at NOW + 5 s
  const [report, page] = await Promise.all([call(racing, w.cookie, lessonPath(w.l1.id, "/progress"), { watchedSec: 40 }), call(racing, w.cookie, lessonPath(w.l1.id))]);
  expect([report.status, page.status]).toEqual([200, 200]);
  expect((await db.select().from(lessonProgress))[0]).toMatchObject({ watchedSec: 40, clockAt: new Date(NOW.getTime() + 20_000) });
});
