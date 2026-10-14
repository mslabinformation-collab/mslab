import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, courseAccess, courses, courseTests, lessonProgress, lessons, practicalPhotos, protocols, testAttempts, type TestQuestion } from "@/db/schema";
import { PHOTO_LIMITS } from "@/domain/completion";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { deleteClient } from "@/server/client-data";
import { isMediaKey } from "@/server/media";
import { addPhoto, photoFor, practicalKeys, practicalView, removeKeys, removePhoto, submitPractical, type PhotoInput, type PracticalDeps } from "@/server/practical";
import { newToken, sha256 } from "@/server/token";
import { fakeKv, fakeMediaStore, stubFetch } from "../fakes";
import { addModules, makeTestDb } from "./helpers";

// The practical work's server (e-course completion, spec §3.4, §3.5, §4.3, §7, §8): the first photo makes the access's protocol with the
// course's points; 1–3 photos a point a round, checked under the access's lock; "Saada hindamiseks" once a round, Maria told once; after her
// assessment only the "Paranda" points take photos; an expired access reads, a revoked one is gone; the files of a refused photo, a removed
// one and a deleted account leave the store.

const NOW = new Date("2026-10-13T10:00:00Z");
const SITE = "https://mslab.example";
const SLUG = "veebikursus";
const DAY = 86_400_000;
const QUESTION: TestQuestion = {
  id: "q1choice",
  kind: "choice",
  text: "Mis värvi kasutad heledatel kulmudel?",
  options: [
    { id: "o1right0", text: "Helepruun", correct: true },
    { id: "o1wrong0", text: "Must", correct: false },
  ],
};

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A JPEG as the browser's shrink makes it (FF D8 FF first), `size` bytes. */
function jpeg(size: number): File {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0].slice(0, size));
  return new File([bytes], "foto.jpg", { type: "image/jpeg" });
}
const photo = (stage: number, over: Partial<PhotoInput> = {}): PhotoInput => ({ stage, full: jpeg(4096), thumb: jpeg(512), width: 2048, height: 1536, ...over });

type World = { points?: string[]; questions?: TestQuestion[]; passed?: boolean; lessonsDone?: boolean };

/**
 * The e-course "veebikursus" (one text lesson; the points "Ettevalmistus" and "Tulemus" unless given; `questions` in course_tests), Kati Kask
 * with six months of access and her lesson done (unless `lessonsDone: false`), her test passed when `passed`. `enrol` adds another student
 * the same way. The deps' store is an in-memory one; `later` collects what production runs after the answer (`flush` runs it); Resend and
 * Telegram are set, and stubbed by `outbox()`.
 */
async function world(o: World = {}) {
  const [course] = await db
    .insert(courses)
    .values({ slug: SLUG, type: "e_learning", level: "basic", title: { et: "Veebikursus", ru: "Онлайн-курс" }, summary: { et: "" }, body: { et: "" }, published: true, price: 9500, protocolStages: o.points ?? ["Ettevalmistus", "Tulemus"] })
    .returning();
  const [mod] = await addModules(db, course.id, [{ et: "Moodul" }]);
  const [lesson] = await db.insert(lessons).values({ moduleId: mod.id, position: 1, title: { et: "Tekst" }, kind: "text" }).returning();
  if (o.questions) await db.insert(courseTests).values({ courseId: course.id, questions: o.questions });
  const enrol = async (email: string, name: string) => {
    const [client] = await db.insert(clients).values({ email, name }).returning();
    const [access] = await db.insert(courseAccess).values({ clientId: client.id, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date(NOW.getTime() + 180 * DAY) }).returning();
    if (o.lessonsDone !== false) await db.insert(lessonProgress).values({ clientId: client.id, lessonId: lesson.id, doneAt: NOW });
    if (o.questions && o.passed)
      await db.insert(testAttempts).values({ clientId: client.id, courseId: course.id, number: 1, questions: o.questions, answers: { q1choice: ["o1right0"] }, correct: 1, total: 1, status: "passed", submittedAt: NOW });
    return { client, access };
  };
  const { client, access } = await enrol("kati@example.test", "Kati Kask");
  const store = fakeMediaStore();
  const tasks: (() => Promise<unknown>)[] = [];
  const deps: PracticalDeps = {
    db,
    env: { KV: fakeKv(), MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE, RESEND_API_KEY: "re_test", TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHAT_ID: "42" },
    siteUrl: SITE,
    now: NOW,
    later: (task) => void tasks.push(task),
    files: store,
  };
  return { course, lesson, client, access, store, deps, tasks, enrol, flush: () => Promise.all(tasks.splice(0).map((task) => task())) };
}
type W = Awaited<ReturnType<typeof world>>;

const add = (w: W, stage: number, over: Partial<PhotoInput> = {}) => addPhoto(w.deps, w.client.id, SLUG, photo(stage, over));
const submit = (w: W) => submitPractical(w.deps, w.client.id, SLUG);
const view = (w: W) => practicalView(db, w.client.id, SLUG, NOW);
const protocolOf = async (accessId: number) => (await db.select().from(protocols).where(eq(protocols.accessId, accessId)))[0];
const photosOf = () => db.select().from(practicalPhotos).orderBy(practicalPhotos.id);
/** The photo an add answered with (the test fails if it was refused). */
const added = (r: Awaited<ReturnType<typeof addPhoto>>) => {
  if (r.kind !== "added") throw new Error(`not added: ${r.kind}`);
  return r.photo;
};

/** Maria's "Saada hinnang" of the round submitted (server/assessment.ts, Task 10, freezes the same): her verdicts and notes, as sent. */
async function assessed(accessId: number, verdicts: ("ok" | "fix")[], notes: string[] = [], generalNote = "") {
  const p = await protocolOf(accessId);
  const stages = p.stages.map((s, i) => ({ title: s.title, note: notes[i] ?? "" }));
  await db
    .update(protocols)
    .set({ stages, generalNote, verdicts, sent: { stages, generalNote, verdicts }, sentAt: NOW, sentVersion: p.version, sentRound: p.round })
    .where(eq(protocols.id, p.id));
}

/** Resend and Telegram, stubbed: the mails sent and the number of pings. */
function outbox() {
  const f = stubFetch((url) => (url.includes("resend") ? Response.json({ id: "email_1" }) : Response.json({ ok: true })));
  return {
    mails: () => f.calls.filter((c) => c.url.includes("resend")).map((c) => c.body as { to: string; subject: string; text: string; reply_to?: string }),
    pings: () => f.calls.filter((c) => c.url.includes("telegram")).length,
  };
}

describe("the access's protocol and her page", () => {
  test("the first photo makes the access's protocol, a copy of the course's points with no verdicts; a later change of the points does not reach it (spec §3.4)", async () => {
    const w = await world();
    expect(await add(w, 0)).toEqual({ kind: "added", photo: { id: expect.any(Number), round: 1, width: 2048, height: 1536 } });
    const p = await protocolOf(w.access.id);
    expect(p).toMatchObject({
      accessId: w.access.id,
      registrationId: null,
      stages: [{ title: "Ettevalmistus", note: "" }, { title: "Tulemus", note: "" }],
      verdicts: [null, null],
      round: 0,
      submittedAt: null,
      sent: null,
      sentRound: null,
    });
    const [row] = await photosOf();
    expect(row).toMatchObject({ protocolId: p.id, stage: 0, round: 1, size: 4096, width: 2048, height: 1536 });
    expect(row.key).toMatch(/^practical\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/);
    expect(row.thumbKey).toBe(row.key.replace(/\.jpg$/, "-t.jpg"));
    expect(isMediaKey(row.key)).toBe(false); // private: /media never serves it
    expect(w.store.objects.get(row.key)).toMatchObject({ contentType: "image/jpeg", disposition: null });
    expect(w.store.objects.get(row.thumbKey)!.bytes.byteLength).toBe(512);
    await db.update(courses).set({ protocolStages: ["Uus punkt"] }).where(eq(courses.id, w.course.id));
    expect((await view(w))!.points.map((pt) => pt.title)).toEqual(["Ettevalmistus", "Tulemus"]);
    expect(await db.select().from(protocols)).toHaveLength(1);
  });

  test("her page before the first photo: open, each point empty and open for a photo; reading it makes nothing", async () => {
    const w = await world();
    expect(await view(w)).toEqual({
      course: { slug: SLUG, title: { et: "Veebikursus", ru: "Онлайн-курс" } },
      status: "open",
      round: 0,
      points: [
        { index: 0, title: "Ettevalmistus", verdict: null, note: "", photos: [], earlier: [], canAdd: true },
        { index: 1, title: "Tulemus", verdict: null, note: "", photos: [], earlier: [], canAdd: true },
      ],
      generalNote: "",
      sentAt: null,
      locked: false,
      readOnly: false,
      notesOnly: false,
      completedAt: null,
    });
    expect(await db.select().from(protocols)).toEqual([]);
  });

  test("Maria's 'Lisa protokoll' came first: the photo goes to her protocol, her notes kept", async () => {
    const w = await world();
    await db.insert(protocols).values({ accessId: w.access.id, stages: [{ title: "Ettevalmistus", note: "Vaata hoolikalt." }, { title: "Tulemus", note: "" }], verdicts: [null, null], version: 2 });
    expect(await add(w, 1)).toMatchObject({ kind: "added" });
    const all = await db.select().from(protocols);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ version: 2, stages: [{ title: "Ettevalmistus", note: "Vaata hoolikalt." }, { title: "Tulemus", note: "" }] });
  });
});

describe("Review Focus 1: the server takes only a JPEG within the limits; a refused photo leaves nothing behind", () => {
  test("not a JPEG, too big, empty, an odd shape, a point that cannot be: refused before anything is stored", async () => {
    const w = await world();
    const notJpeg = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])], "foto.jpg", { type: "image/jpeg" });
    const cases: [Partial<PhotoInput>, string][] = [
      [{ full: new File([new Uint8Array([0xff, 0xd8, 0xff])], "foto.png", { type: "image/png" }) }, "type"],
      [{ thumb: new File([new Uint8Array([0xff, 0xd8, 0xff])], "foto.heic", { type: "image/heic" }) }, "type"],
      [{ full: jpeg(PHOTO_LIMITS.fullBytes + 1) }, "size"],
      [{ thumb: jpeg(PHOTO_LIMITS.thumbBytes + 1) }, "size"],
      [{ full: new File([], "foto.jpg", { type: "image/jpeg" }) }, "size"],
      [{ full: notJpeg }, "content"],
      [{ thumb: notJpeg }, "content"],
      [{ width: 0 }, "shape"],
      [{ height: 4097 }, "shape"],
      [{ width: 1.5 }, "shape"],
      [{ width: Number.NaN }, "shape"],
      [{ stage: -1 }, "stage"],
      [{ stage: 0.5 }, "stage"],
      [{ stage: 30 }, "stage"],
    ];
    for (const [over, error] of cases) expect(await add(w, 0, over), `${Object.keys(over).join()} → ${error}`).toEqual({ kind: "invalid", error });
    expect(w.store.objects.size).toBe(0);
    expect(w.store.deleted).toEqual([]);
    expect(await photosOf()).toEqual([]);
  });

  test("2 MB exactly is taken; a point the course does not have is refused under the lock, and the files it stored are removed", async () => {
    const w = await world();
    expect(await add(w, 0, { full: jpeg(PHOTO_LIMITS.fullBytes), thumb: jpeg(PHOTO_LIMITS.thumbBytes) })).toMatchObject({ kind: "added" });
    expect(w.store.objects.size).toBe(2);
    expect(await add(w, 2)).toEqual({ kind: "invalid", error: "stage" }); // two points: 0 and 1
    expect(w.store.objects.size).toBe(2);
    expect(w.store.deleted).toHaveLength(2);
    expect(w.store.deleted.every((key) => key.startsWith("practical/"))).toBe(true);
    expect(await photosOf()).toHaveLength(1);
  });

  test("a first photo for a point the course does not have makes no protocol: the drawer keeps 'Lisa protokoll' for a student who has sent nothing", async () => {
    const w = await world();
    expect(await add(w, 2)).toEqual({ kind: "invalid", error: "stage" }); // two points: 0 and 1
    expect(await protocolOf(w.access.id)).toBeUndefined();
    expect(w.store.objects.size).toBe(0); // its files, stored first, are removed again
    expect(await add(w, 1)).toMatchObject({ kind: "added" });
    expect((await protocolOf(w.access.id))!.stages.map((st) => st.title)).toEqual(["Ettevalmistus", "Tulemus"]);
  });

  test("no store: storage, nothing written; a store that refuses the thumbnail: storage, and the full photo it took is removed again", async () => {
    const w = await world();
    expect(await addPhoto({ ...w.deps, files: null }, w.client.id, SLUG, photo(0))).toEqual({ kind: "storage" });
    const base = fakeMediaStore();
    const failing = {
      ...base,
      put: async (key: string, bytes: ArrayBuffer, contentType: string) => {
        if (key.endsWith("-t.jpg")) throw new Error("R2 refused");
        await base.put(key, bytes, contentType);
      },
    };
    expect(await addPhoto({ ...w.deps, files: failing }, w.client.id, SLUG, photo(0))).toEqual({ kind: "storage" });
    expect(base.objects.size).toBe(0);
    expect(base.deleted).toHaveLength(2);
    expect(await photosOf()).toEqual([]);
    expect(await db.select().from(protocols)).toEqual([]);
  });
});

describe("Review Focus 2: two devices or a double tap — the cap and the send are decided under the access's lock", () => {
  // These pin the outcome, not the lock: PGlite runs one transaction at a time, so they would pass without lockAccess too. Only
  // tests/e2e/completion-race.spec.ts, on real Postgres, proves the lock (Task 14).
  test("three photos a point a round: four sent at once make three and one 'full', whose files are removed; another point has its own three", async () => {
    const w = await world();
    const results = await Promise.all([0, 1, 2, 3].map(() => add(w, 0)));
    expect(results.map((r) => r.kind).sort()).toEqual(["added", "added", "added", "full"]);
    expect((await photosOf()).filter((p) => p.stage === 0)).toHaveLength(3);
    expect(w.store.objects.size).toBe(6);
    expect(await db.select().from(protocols)).toHaveLength(1); // made once
    expect(await add(w, 1)).toMatchObject({ kind: "added" });
    expect((await view(w))!.points.map((p) => [p.photos.length, p.canAdd])).toEqual([
      [3, false],
      [1, true],
    ]);
  });

  test("two 'Saada hindamiseks' at once: one round and one notice to Maria; the second, and any later one, answers 'already'", async () => {
    const w = await world();
    const out = outbox();
    await add(w, 0);
    await add(w, 1);
    const results = await Promise.all([submit(w), submit(w)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["already", "submitted"]);
    expect(await protocolOf(w.access.id)).toMatchObject({ round: 1, submittedAt: NOW });
    expect(w.tasks).toHaveLength(1);
    expect(await submit(w)).toEqual({ kind: "already" });
    await w.flush();
    expect(out.mails()).toHaveLength(1);
    const [mail] = out.mails();
    expect(mail).toMatchObject({ to: "maria@example.test", subject: "Praktiline töö hindamiseks: Kati Kask, Veebikursus", reply_to: "kati@example.test" });
    expect(mail.text).toContain(`/admin/protokollid?ligipaas=${w.access.id}`);
    expect(out.pings()).toBe(1);
    expect(console.info).toHaveBeenCalledWith(`[practical] access ${w.access.id}: submitted (round 1)`);
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^\\[practical\\] access ${w.access.id}: Maria notified by e-mail: true, Telegram: (true|false)$`)));
  });
});

describe("Saada hindamiseks", () => {
  test("every point needs a photo of the new round; sent, the work waits for Maria and takes no photos, none is removed", async () => {
    const w = await world();
    expect(await submit(w)).toEqual({ kind: "missing", points: [0, 1] });
    expect(await db.select().from(protocols)).toEqual([]); // asking made nothing
    await add(w, 1);
    expect(await submit(w)).toEqual({ kind: "missing", points: [0] });
    const first = added(await add(w, 0));
    const done = await submit(w);
    if (done.kind !== "submitted") throw new Error(done.kind);
    expect(done.view).toMatchObject({ status: "review", round: 1 });
    expect(done.view.points.map((p) => [p.photos.map((x) => x.round), p.canAdd])).toEqual([
      [[1], false],
      [[1], false],
    ]);
    expect(await add(w, 0)).toEqual({ kind: "closed" });
    expect(await removePhoto(w.deps, w.client.id, SLUG, first.id)).toEqual({ kind: "closed" });
    expect(w.store.objects.size).toBe(4); // the refused photo's files went again
    expect(await photosOf()).toHaveLength(2);
  });

  test("after Maria's assessment only the 'Paranda' points take photos; 'Saada uuesti' needs each of them, resets their verdicts and raises the round, not the notes' version (R3)", async () => {
    const w = await world();
    const out = outbox();
    await add(w, 0);
    await add(w, 1);
    await submit(w);
    await assessed(w.access.id, ["ok", "fix"], ["", "Kulmud on ebaühtlased."], "Hea algus.");
    const before = await protocolOf(w.access.id);
    const fix = (await view(w))!;
    expect(fix).toMatchObject({ status: "fix", round: 1, generalNote: "Hea algus.", sentAt: NOW.toISOString() });
    const shape = (v: NonNullable<Awaited<ReturnType<typeof view>>>) =>
      v.points.map((p) => ({ verdict: p.verdict, note: p.note, photos: p.photos.map((x) => x.round), earlier: p.earlier.map((x) => x.round), canAdd: p.canAdd }));
    expect(shape(fix)).toEqual([
      { verdict: "ok", note: "", photos: [1], earlier: [], canAdd: false },
      { verdict: "fix", note: "Kulmud on ebaühtlased.", photos: [], earlier: [1], canAdd: true },
    ]);
    expect(await add(w, 0)).toEqual({ kind: "closed" });
    expect(await submit(w)).toEqual({ kind: "missing", points: [1] });
    expect(await add(w, 1)).toMatchObject({ kind: "added", photo: { round: 2 } });
    expect((await submit(w)).kind).toBe("submitted");
    const after = await protocolOf(w.access.id);
    expect(after).toMatchObject({ round: 2, verdicts: ["ok", null], version: before.version, sentRound: 1, submittedAt: NOW });
    expect(after.sent).toEqual(before.sent); // only Maria's next send changes what the student is shown
    expect(shape((await view(w))!)).toEqual([
      { verdict: "ok", note: "", photos: [1], earlier: [], canAdd: false },
      { verdict: "fix", note: "Kulmud on ebaühtlased.", photos: [2], earlier: [1], canAdd: false },
    ]);
    await w.flush();
    expect(out.mails().map((m) => m.subject)).toEqual(["Praktiline töö hindamiseks: Kati Kask, Veebikursus", "Praktiline töö hindamiseks: Kati Kask, Veebikursus (2. kord)"]);
  });

  test("a photo of the round being prepared can be removed (its files after the answer); another student's, or none: notFound", async () => {
    const w = await world();
    const kept = added(await add(w, 0));
    const gone = added(await add(w, 0));
    expect(await removePhoto(w.deps, w.client.id, SLUG, gone.id)).toEqual({ kind: "removed" });
    expect((await photosOf()).map((p) => p.id)).toEqual([kept.id]);
    expect(w.store.objects.size).toBe(4); // removed after the answer
    await w.flush();
    expect(w.store.objects.size).toBe(2);
    expect(w.store.deleted).toHaveLength(2);
    const mari = await w.enrol("mari@example.test", "Mari Maasikas");
    expect(await removePhoto(w.deps, mari.client.id, SLUG, kept.id)).toEqual({ kind: "notFound" });
    expect(await removePhoto(w.deps, w.client.id, SLUG, 999_999)).toEqual({ kind: "notFound" });
    expect(await photosOf()).toHaveLength(1);
  });
});

describe("Review Focus 4: the access ends or is revoked mid-way", () => {
  test("expired: her results stay readable; nothing can be added, removed or sent", async () => {
    const w = await world();
    const first = added(await add(w, 0));
    await db.update(courseAccess).set({ expiresAt: new Date(NOW.getTime() - 1000) }).where(eq(courseAccess.id, w.access.id));
    const v = (await view(w))!;
    expect(v).toMatchObject({ readOnly: true, status: "open" });
    expect(v.points.map((p) => [p.photos.length, p.canAdd])).toEqual([
      [1, false],
      [0, false],
    ]);
    expect(await add(w, 1)).toEqual({ kind: "closed" });
    expect(await removePhoto(w.deps, w.client.id, SLUG, first.id)).toEqual({ kind: "closed" });
    expect(await submit(w)).toEqual({ kind: "closed" });
    expect(w.store.objects.size).toBe(2);
    expect(await photoFor(db, { clientId: w.client.id }, first.id)).not.toBeNull();
  });

  test("revoked: her page and every action are notFound and her photos hers no more; Maria still sees them", async () => {
    const w = await world();
    const first = added(await add(w, 0));
    await db.update(courseAccess).set({ revokedAt: NOW }).where(eq(courseAccess.id, w.access.id));
    expect(await view(w)).toBeNull();
    expect(await add(w, 1)).toEqual({ kind: "notFound" });
    expect(await removePhoto(w.deps, w.client.id, SLUG, first.id)).toEqual({ kind: "notFound" });
    expect(await submit(w)).toEqual({ kind: "notFound" });
    expect(await photoFor(db, { clientId: w.client.id }, first.id)).toBeNull();
    const [row] = await photosOf();
    expect(await photoFor(db, { admin: true }, first.id)).toEqual({ key: row.key, thumbKey: row.thumbKey });
    expect(w.store.objects.size).toBe(2);
  });
});

describe("when the practical work opens (D5)", () => {
  test("a course with questions: locked until the test is passed — no photo (its files removed again), no send, no protocol", async () => {
    const w = await world({ questions: [QUESTION] });
    const v = (await view(w))!;
    expect(v).toMatchObject({ locked: true, status: "open" });
    expect(v.points.every((p) => !p.canAdd)).toBe(true);
    expect(await add(w, 0)).toEqual({ kind: "closed" });
    expect(w.store.objects.size).toBe(0);
    expect(w.store.deleted).toHaveLength(2);
    expect(await submit(w)).toEqual({ kind: "closed" });
    expect(await db.select().from(protocols)).toEqual([]);
  });

  test("the test passed: open", async () => {
    const w = await world({ questions: [QUESTION], passed: true });
    expect(await view(w)).toMatchObject({ locked: false });
    expect(await add(w, 0)).toMatchObject({ kind: "added" });
  });

  test("a course without questions: locked until the lessons are done, open after", async () => {
    const w = await world({ lessonsDone: false });
    expect(await view(w)).toMatchObject({ locked: true });
    expect(await add(w, 0)).toEqual({ kind: "closed" });
    await db.insert(lessonProgress).values({ clientId: w.client.id, lessonId: w.lesson.id, doneAt: NOW });
    expect(await view(w)).toMatchObject({ locked: false });
    expect(await add(w, 0)).toMatchObject({ kind: "added" });
  });

  test("a course without points: no practical page, nothing to add or send — unless Maria sent a notes-only protocol (spec §4.3)", async () => {
    const w = await world({ points: [] });
    expect(await view(w)).toBeNull();
    expect(await add(w, 0)).toEqual({ kind: "closed" });
    expect(await submit(w)).toEqual({ kind: "closed" });
    await db.insert(protocols).values({ accessId: w.access.id, stages: [], verdicts: [], generalNote: "Tubli töö!", sent: { stages: [], generalNote: "Tubli töö!" }, sentAt: NOW, sentVersion: 1 });
    expect(await view(w)).toMatchObject({ notesOnly: true, points: [], generalNote: "Tubli töö!", sentAt: NOW.toISOString(), locked: false });
  });
});

describe("the photos' keys, and the account's deletion (spec §3.5)", () => {
  test("photoFor: her own photo, never another student's; any photo for an admin", async () => {
    const w = await world();
    const mine = added(await add(w, 0));
    const mari = await w.enrol("mari@example.test", "Mari Maasikas");
    const [row] = await photosOf();
    expect(await photoFor(db, { clientId: w.client.id }, mine.id)).toEqual({ key: row.key, thumbKey: row.thumbKey });
    expect(await photoFor(db, { clientId: mari.client.id }, mine.id)).toBeNull();
    expect(await photoFor(db, { admin: true }, mine.id)).toEqual({ key: row.key, thumbKey: row.thumbKey });
    expect(await photoFor(db, { admin: true }, 999_999)).toBeNull();
  });

  test("deleteClient lists her photo files of every round, deletes their rows with her access, and leaves another student's", async () => {
    const w = await world();
    await add(w, 0);
    await add(w, 1);
    await submit(w);
    await assessed(w.access.id, ["ok", "fix"], ["", "Uuesti."]);
    await add(w, 1);
    const mari = await w.enrol("mari@example.test", "Mari Maasikas");
    expect(await addPhoto(w.deps, mari.client.id, SLUG, photo(0))).toMatchObject({ kind: "added" });
    const hers = await protocolOf(w.access.id);
    const keys = (await photosOf()).filter((r) => r.protocolId === hers.id).flatMap((r) => [r.key, r.thumbKey]);
    expect(keys).toHaveLength(6);
    expect([...(await practicalKeys(db, w.client.id))].sort()).toEqual([...keys].sort());
    const gone = await deleteClient(db, w.client.id);
    expect(gone).toMatchObject({ email: "kati@example.test", locale: "et" });
    expect([...gone!.photoKeys].sort()).toEqual([...keys].sort());
    expect(await db.select().from(protocols).where(eq(protocols.id, hers.id))).toEqual([]);
    expect((await photosOf()).map((r) => r.protocolId)).toEqual([(await protocolOf(mari.access.id)).id]);
    expect(await practicalKeys(db, mari.client.id)).toHaveLength(2);
  });

  test("removeKeys: every file it can, a failure logged by its label and never the key; without a store it says so", async () => {
    const store = fakeMediaStore({ "practical/a.jpg": { bytes: [1] }, "practical/b.jpg": { bytes: [2] }, "practical/c.jpg": { bytes: [3] } });
    const flaky = {
      ...store,
      delete: async (key: string) => {
        if (key === "practical/b.jpg") throw new Error(`R2 refused ${key}`);
        await store.delete(key);
      },
    };
    const errors = vi.mocked(console.error);
    await removeKeys(flaky, ["practical/a.jpg", "practical/b.jpg", "practical/c.jpg"], "[practical] client 7");
    expect([...store.objects.keys()]).toEqual(["practical/b.jpg"]);
    expect(errors).toHaveBeenCalledWith("[practical] client 7: a photo file could not be removed: Error");
    expect(errors.mock.calls.flat().join(" ")).not.toContain("practical/");
    errors.mockClear();
    await removeKeys(null, ["practical/a.jpg"], "[practical] client 7");
    expect(errors).toHaveBeenCalledWith("[practical] client 7: no file store, 1 photo files not removed");
    await removeKeys(null, [], "[practical] client 7");
    expect(errors).toHaveBeenCalledTimes(1);
  });

  test("the account's deletion (POST /api/konto/kustuta) removes her photo files after the answer", async () => {
    const w = await world();
    await add(w, 0);
    await add(w, 1);
    const raw = newToken();
    await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: w.client.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
    const tasks: (() => Promise<unknown>)[] = [];
    const deps: AccountDeps = { db, env: w.deps.env, now: NOW, siteUrl: SITE, later: (task) => void tasks.push(task), dev: false, files: w.store };
    const res = await handleAccountApi(
      new Request(`${SITE}/api/konto/kustuta`, { method: "POST", headers: { cookie: `__Host-mslab_client=${raw}` }, body: JSON.stringify({ confirm: true }) }),
      deps,
    );
    expect(res!.status).toBe(200);
    expect(await photosOf()).toEqual([]);
    expect(w.store.objects.size).toBe(4); // the files go after the answer
    expect(tasks).toHaveLength(1); // a sample address gets no mail
    await Promise.all(tasks.splice(0).map((task) => task()));
    expect(w.store.objects.size).toBe(0);
    expect(w.store.deleted).toHaveLength(4);
  });
});
