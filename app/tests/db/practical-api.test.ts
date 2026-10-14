import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, courseAccess, courseModules, courses, lessonProgress, lessons, practicalPhotos } from "@/db/schema";
import { PHOTO_LIMITS } from "@/domain/completion";
import { handleAccountApi, sessionCookies, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// The practical work's endpoints of the account API (e-course completion, spec §4.3, §7, R5): the page's data; one photo as multipart (the
// Content-Length refused before the body is read, the form's fields, server/practical.ts's refusals passed on); the removal; "Saada
// hindamiseks"; and her photos as a 302 to a signed address (or the bytes from the local store). The paths are matched before the lesson
// paths. The rules themselves (the cap under the lock, the rounds, the verdicts) are server/practical.ts's (tests/db/practical.test.ts).

const NOW = new Date("2026-10-20T10:00:00Z");
const DAY = 86_400_000;
const SITE = "https://mslab.example";
const POINTS = ["Ettevalmistus", "Värvimine"];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];
const FULL = [...JPEG, 1, 2, 3];
const THUMB = [...JPEG, 9];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PRACTICAL = "/kursus/veebikursus/praktiline";

let db: Db;
let store: ReturnType<typeof fakeMediaStore>;
let kv: ReturnType<typeof fakeKv>;
beforeEach(async () => {
  db = await makeTestDb();
  store = fakeMediaStore();
  kv = fakeKv();
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The account API's dependencies; `later` drops its tasks (Maria's notice is server/practical.ts's to test), so nothing is mailed. */
const deps = (over: Partial<AccountDeps> = {}): AccountDeps => ({
  db,
  env: { KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
  now: NOW,
  siteUrl: SITE,
  later: () => {},
  dev: false,
  files: store,
  ...over,
});

/** A client with one live session. */
async function student(email: string) {
  const [client] = await db.insert(clients).values({ email }).returning();
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return { id: client.id, raw, cookie: `__Host-mslab_client=${raw}` };
}

/**
 * An e-course with the two points and no test (no course_tests row), one text lesson; Kati with six months of access and the lesson done:
 * her practical work is open. `grant` gives another student the same.
 */
async function world(access: Partial<typeof courseAccess.$inferInsert> = {}) {
  const [course] = await db
    .insert(courses)
    .values({ slug: "veebikursus", type: "e_learning", level: "basic", title: { et: "Veebikursus" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9500, protocolStages: POINTS })
    .returning();
  const [m] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "Teooria" } }).returning();
  const [lesson] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "Tekst" }, kind: "text" }).returning();
  const grant = async (clientId: number, over: Partial<typeof courseAccess.$inferInsert> = {}) => {
    await db.insert(courseAccess).values({ clientId, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY), ...over });
    await db.insert(lessonProgress).values({ clientId, lessonId: lesson.id, doneAt: NOW });
  };
  const kati = await student("kati@example.test");
  await grant(kati.id, access);
  return { course, lesson, kati, grant };
}

type Init = { body?: BodyInit; headers?: Record<string, string> };
const call = async (cookie: string | null, method: string, path: string, init: Init = {}, d: AccountDeps = deps()) =>
  (await handleAccountApi(new Request(`${SITE}/api/konto${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...init.headers }, body: init.body }), d))!;

const jpeg = (bytes: number[] | Uint8Array = FULL, name = "foto.jpg", type = "image/jpeg") => new File([new Uint8Array(bytes)], name, { type });
type FormOver = { stage?: string; width?: string; height?: string; full?: File | null; thumb?: File | null };
/** The page's upload form for point `stage`: the 2048 × 1365 photo and its thumbnail, or what `over` says (null: the field left out). */
function photoForm(stage: number, over: FormOver = {}): FormData {
  const form = new FormData();
  form.set("stage", over.stage ?? String(stage));
  form.set("width", over.width ?? "2048");
  form.set("height", over.height ?? "1365");
  if (over.full !== null) form.set("full", over.full ?? jpeg(FULL, "foto.jpg"));
  if (over.thumb !== null) form.set("thumb", over.thumb ?? jpeg(THUMB, "pisi.jpg"));
  return form;
}
const upload = (cookie: string, stage: number, over: FormOver = {}, d: AccountDeps = deps()) => call(cookie, "POST", `${PRACTICAL}/foto`, { body: photoForm(stage, over) }, d);
const photoIdOf = async (res: Response): Promise<number> => ((await res.json()) as { photo: { id: number } }).photo.id;
const storedPhotos = () => db.select().from(practicalPhotos);

describe("GET /kursus/:slug/praktiline", () => {
  test("her practical work: the points in order, open, nothing locked; private and never cached", async () => {
    const w = await world();
    const res = await call(w.kati.cookie, "GET", PRACTICAL);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toMatchObject({
      ok: true,
      course: { slug: "veebikursus", title: { et: "Veebikursus" } },
      status: "open",
      round: 0,
      locked: false,
      readOnly: false,
      notesOnly: false,
      points: [
        { index: 0, title: "Ettevalmistus", verdict: null, photos: [] },
        { index: 1, title: "Värvimine", verdict: null, photos: [] },
      ],
    });
  });

  test("matched before the lesson paths: 'praktiline' is never read as a lesson; an unknown part or method is 404; the lessons still answer", async () => {
    const w = await world();
    for (const [method, path] of [
      ["GET", `${PRACTICAL}/saada`],
      ["GET", `${PRACTICAL}/foto`],
      ["POST", PRACTICAL],
      ["DELETE", `${PRACTICAL}/foto`],
      ["POST", `${PRACTICAL}/saada/1`],
      ["GET", `${PRACTICAL}/muu`],
      ["POST", "/praktiline/foto/1"],
    ] as const) {
      const res = await call(w.kati.cookie, method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json(), `${method} ${path}`).toEqual({ ok: false });
    }
    expect((await call(w.kati.cookie, "GET", `/kursus/veebikursus/${w.lesson.id}`)).status).toBe(200);
  });

  test("Review Focus 4: without a session 401; a revoked access 404; an expired one is read-only and takes no photo", async () => {
    const w = await world();
    expect((await call(null, "GET", PRACTICAL)).status).toBe(401);
    await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.clientId, w.kati.id));
    expect((await call(w.kati.cookie, "GET", PRACTICAL)).status).toBe(404);
    expect((await upload(w.kati.cookie, 0)).status).toBe(404);
    await db.update(courseAccess).set({ revokedAt: null, expiresAt: new Date(NOW.getTime() - DAY) }).where(eq(courseAccess.clientId, w.kati.id));
    expect(await (await call(w.kati.cookie, "GET", PRACTICAL)).json()).toMatchObject({ ok: true, readOnly: true });
    const refused = await upload(w.kati.cookie, 0);
    expect([refused.status, await refused.json()]).toEqual([409, { ok: false, error: "closed" }]);
    expect(store.objects.size).toBe(0);
  });
});

describe("POST /kursus/:slug/praktiline/foto", () => {
  test("a photo and its thumbnail: both stored under practical/, the row written, the answer is the photo", async () => {
    const w = await world();
    const res = await upload(w.kati.cookie, 0);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, photo: { id: expect.any(Number), round: 1, width: 2048, height: 1365 } });
    const [row] = await storedPhotos();
    expect(row).toMatchObject({ stage: 0, round: 1, width: 2048, height: 1365 });
    expect([...store.objects.keys()].sort()).toEqual([row.key, row.thumbKey].sort());
    expect([...store.objects.get(row.key)!.bytes]).toEqual(FULL);
    expect([...store.objects.get(row.thumbKey)!.bytes]).toEqual(THUMB);
  });

  test("Review Focus 1: announced larger than 2 MB + 200 KB + the 64 KiB envelope: 413 'size' before the body is read", async () => {
    const w = await world();
    const request = new Request(`${SITE}/api/konto${PRACTICAL}/foto`, {
      method: "POST",
      headers: { cookie: w.kati.cookie, "content-length": String(PHOTO_LIMITS.fullBytes + PHOTO_LIMITS.thumbBytes + 64 * 1024 + 1) },
      body: photoForm(0),
    });
    const formData = vi.spyOn(request, "formData");
    const res = (await handleAccountApi(request, deps()))!;
    expect([res.status, await res.json()]).toEqual([413, { ok: false, error: "size" }]);
    expect(formData).not.toHaveBeenCalled();
    expect(store.objects.size).toBe(0);
    expect(await storedPhotos()).toEqual([]);
  });

  test("a body that is no form, or a form without a usable field: 400 naming it; nothing stored", async () => {
    const w = await world();
    const json = await call(w.kati.cookie, "POST", `${PRACTICAL}/foto`, { body: JSON.stringify({ stage: 0 }) });
    expect([json.status, await json.json()]).toEqual([400, { ok: false, error: "form" }]);
    for (const [over, field] of [
      [{ stage: "x" }, "stage"],
      [{ stage: "01" }, "stage"],
      [{ width: "-1" }, "width"],
      [{ height: "" }, "height"],
      [{ full: null }, "full"],
      [{ thumb: null }, "thumb"],
    ] as const) {
      const res = await upload(w.kati.cookie, 0, over);
      expect([res.status, await res.json()], field).toEqual([400, { ok: false, error: field }]);
    }
    expect(store.objects.size).toBe(0);
    expect(await storedPhotos()).toEqual([]);
  });

  test("Review Focus 1: the server refuses what is not a JPEG within the limits (a PNG, a full photo over 2 MB, a size over 4096 px, a point that is not there)", async () => {
    const w = await world();
    const png = await upload(w.kati.cookie, 0, { full: jpeg(PNG, "pilt.png", "image/png") });
    expect(png.status).toBe(400);
    expect(((await png.json()) as { error: string }).error).toBe("type"); // Task 7 checks the type first: image/png is "type"
    const big = new Uint8Array(PHOTO_LIMITS.fullBytes + 1);
    big.set(JPEG);
    const tooBig = await upload(w.kati.cookie, 0, { full: jpeg(big) });
    expect([tooBig.status, await tooBig.json()]).toEqual([400, { ok: false, error: "size" }]);
    const wide = await upload(w.kati.cookie, 0, { width: "5000" });
    expect([wide.status, await wide.json()]).toEqual([400, { ok: false, error: "shape" }]);
    const nowhere = await upload(w.kati.cookie, 7);
    expect([nowhere.status, await nowhere.json()]).toEqual([400, { ok: false, error: "stage" }]);
    expect(store.objects.size).toBe(0);
    expect(await storedPhotos()).toEqual([]);
  });

  test("a point takes 3 photos in a round: the fourth is 409 'full'; the other point still takes one", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) expect((await upload(w.kati.cookie, 0)).status).toBe(200);
    const fourth = await upload(w.kati.cookie, 0);
    expect([fourth.status, await fourth.json()]).toEqual([409, { ok: false, error: "full" }]);
    expect((await upload(w.kati.cookie, 1)).status).toBe(200);
    expect((await storedPhotos()).map((p) => p.stage).sort()).toEqual([0, 0, 0, 1]);
  });

  test("120 uploads an hour per student, then 429 'rate' (nothing read, nothing stored); no store: 503 'storage'; cross-site: 403", async () => {
    const w = await world();
    kv.store.set(`rl:client-photo:${w.kati.id}`, "120");
    const limited = await upload(w.kati.cookie, 0);
    expect([limited.status, await limited.json()]).toEqual([429, { ok: false, error: "rate" }]);
    expect(store.objects.size).toBe(0);
    kv.store.clear();
    const noStore = await upload(w.kati.cookie, 0, {}, deps({ files: null }));
    expect([noStore.status, await noStore.json()]).toEqual([503, { ok: false, error: "storage" }]);
    const cross = await call(w.kati.cookie, "POST", `${PRACTICAL}/foto`, { body: photoForm(0), headers: { origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
    expect(await storedPhotos()).toEqual([]);
  });

  test("without a session: 401, and nothing is stored", async () => {
    await world();
    const res = await call(null, "POST", `${PRACTICAL}/foto`, { body: photoForm(0) });
    expect(res.status).toBe(401);
    expect(store.objects.size).toBe(0);
  });
});

describe("DELETE /kursus/:slug/praktiline/foto/:id", () => {
  test("removes her photo of the round being prepared; again, an id that is no id, or another student's photo: 404", async () => {
    const w = await world();
    const mine = await photoIdOf(await upload(w.kati.cookie, 0));
    const kept = await photoIdOf(await upload(w.kati.cookie, 0));
    const mari = await student("mari@example.test");
    await w.grant(mari.id);
    const notHers = await call(mari.cookie, "DELETE", `${PRACTICAL}/foto/${mine}`);
    expect([notHers.status, await notHers.json()]).toEqual([404, { ok: false }]);
    const removed = await call(w.kati.cookie, "DELETE", `${PRACTICAL}/foto/${mine}`);
    expect([removed.status, await removed.json()]).toEqual([200, { ok: true }]);
    const view = (await (await call(w.kati.cookie, "GET", PRACTICAL)).json()) as { points: { photos: { id: number }[] }[] };
    expect(view.points[0].photos.map((p) => p.id)).toEqual([kept]);
    for (const id of [String(mine), "abc", "0"]) expect((await call(w.kati.cookie, "DELETE", `${PRACTICAL}/foto/${id}`)).status, id).toBe(404);
  });
});

describe("POST /kursus/:slug/praktiline/saada", () => {
  test("a point without a photo: 409 'missing' naming it; with both: 200, waiting (round 1); again: 409 'already'; a photo after: 409 'closed'", async () => {
    const w = await world();
    await upload(w.kati.cookie, 0);
    const missing = await call(w.kati.cookie, "POST", `${PRACTICAL}/saada`);
    expect([missing.status, await missing.json()]).toEqual([409, { ok: false, error: "missing", points: [1] }]);
    await upload(w.kati.cookie, 1);
    const sent = await call(w.kati.cookie, "POST", `${PRACTICAL}/saada`);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ ok: true, status: "review", round: 1 });
    const again = await call(w.kati.cookie, "POST", `${PRACTICAL}/saada`);
    expect([again.status, await again.json()]).toEqual([409, { ok: false, error: "already" }]);
    const late = await upload(w.kati.cookie, 0);
    expect([late.status, await late.json()]).toEqual([409, { ok: false, error: "closed" }]);
  });

  test("20 sends an hour per student, then 429 'rate'", async () => {
    const w = await world();
    kv.store.set(`rl:client-practical:${w.kati.id}`, "20");
    const res = await call(w.kati.cookie, "POST", `${PRACTICAL}/saada`);
    expect([res.status, await res.json()]).toEqual([429, { ok: false, error: "rate" }]);
  });
});

describe("GET /praktiline/foto/:id (R5)", () => {
  test("her photo and its thumbnail from the local store (next dev, the e2e run): the JPEG itself, private, no Referer", async () => {
    const w = await world();
    const id = await photoIdOf(await upload(w.kati.cookie, 0));
    for (const [path, bytes] of [[`/praktiline/foto/${id}`, FULL], [`/praktiline/foto/${id}/pisi`, THUMB]] as const) {
      const res = await call(w.kati.cookie, "GET", path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe("image/jpeg");
      expect(res.headers.get("cache-control"), path).toBe("private, no-store");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect([...new Uint8Array(await res.arrayBuffer())], path).toEqual(bytes);
    }
  });

  test("with R2: a 302 to a 5-minute signed address of the photo, or of its thumbnail", async () => {
    const w = await world();
    const id = await photoIdOf(await upload(w.kati.cookie, 0));
    const [row] = await db.select().from(practicalPhotos).where(eq(practicalPhotos.id, id));
    expect(row.key).toMatch(/^practical\/[0-9a-f-]{36}\.jpg$/);
    expect(row.thumbKey).toBe(row.key.replace(/\.jpg$/, "-t.jpg"));
    const signed = deps({ files: { ...store, signedGetUrl: async (key: string, opts: { expiresSec: number }) => `https://r2.example/${key}?ttl=${opts.expiresSec}` } });
    const full = await call(w.kati.cookie, "GET", `/praktiline/foto/${id}`, {}, signed);
    expect(full.status).toBe(302);
    expect(full.headers.get("location")).toBe(`https://r2.example/${row.key}?ttl=300`);
    expect(full.headers.get("referrer-policy")).toBe("no-referrer");
    expect(full.headers.get("cache-control")).toBe("private, no-store");
    const thumb = await call(w.kati.cookie, "GET", `/praktiline/foto/${id}/pisi`, {}, signed);
    expect(thumb.headers.get("location")).toBe(`https://r2.example/${row.thumbKey}?ttl=300`);
  });

  test("not hers, no such photo, an id that is no id: 404; without a session: 401; a renewed session's cookies come with the photo", async () => {
    const w = await world();
    const id = await photoIdOf(await upload(w.kati.cookie, 0));
    const mari = await student("mari@example.test");
    await w.grant(mari.id);
    for (const [cookie, path] of [
      [mari.cookie, `/praktiline/foto/${id}`],
      [mari.cookie, `/praktiline/foto/${id}/pisi`],
      [w.kati.cookie, "/praktiline/foto/999999"],
      [w.kati.cookie, "/praktiline/foto/abc"],
      [w.kati.cookie, `/praktiline/foto/${id}/muu`],
    ] as const)
      expect((await call(cookie, "GET", path)).status, path).toBe(404);
    expect((await call(null, "GET", `/praktiline/foto/${id}`)).status).toBe(401);
    const later = await call(w.kati.cookie, "GET", `/praktiline/foto/${id}`, {}, deps({ now: new Date(NOW.getTime() + 2 * DAY) }));
    expect(later.status).toBe(200);
    expect(later.headers.getSetCookie()).toEqual(sessionCookies(w.kati.raw));
  });
});
