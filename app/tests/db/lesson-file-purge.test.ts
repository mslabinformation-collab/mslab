import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseModules, courses, lessonFiles, lessons } from "@/db/schema";
import { PURGE_AFTER_MS } from "@/domain/undo";
import { deleteDueFiles, drainRemovedLessonFiles, PURGE_BATCH, PURGE_MAX_BATCHES, purgeRemovedLessonFiles } from "@/server/lesson-file-purge";
import { fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// The purge of removed lesson files (piece 3a, R-f): „Eemalda“ only sets lesson_files.removed_at, so that the UndoBar can bring the file back. The
// row and its R2 object go once the mark is at least 10 s old (10 s is a minimum, never less), called at the start of the next lesson-file
// action and by the daily sweep. The row goes first, the R2 object after it; it never throws (a failure is logged, the rest goes on).

const NOW = new Date("2026-10-23T10:00:00Z");
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000);

let db: Db;
let lessonId: number;
afterEach(() => {
  vi.useRealTimers();
});
beforeEach(async () => {
  db = await makeTestDb();
  const [c] = await db.insert(courses).values({ slug: "veeb", type: "e_learning", level: "basic", title: { et: "V" }, summary: { et: "" }, body: { et: "" } }).returning();
  const [m] = await db.insert(courseModules).values({ courseId: c.id, position: 1, title: { et: "M" } }).returning();
  [{ id: lessonId }] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "L" } }).returning();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** Files named by their R2 key (lessons/<name>.pdf), each removed `removed` seconds before NOW (null: kept). Their objects are in the store. */
async function files(removed: Record<string, number | null>) {
  const store = fakeMediaStore();
  let position = 0;
  for (const [name, sec] of Object.entries(removed)) {
    const key = `lessons/${name}.pdf`;
    await db.insert(lessonFiles).values({ lessonId, position: ++position, name: `${name}.pdf`, r2Key: key, size: 1, contentType: "application/pdf", removedAt: sec === null ? null : ago(sec) });
    await store.put(key, new Uint8Array([1]).buffer, "application/pdf");
  }
  return store;
}
const names = async () => (await db.select().from(lessonFiles).orderBy(lessonFiles.position)).map((r) => r.name);

test("rows removed 11 s ago go with their R2 objects; one removed 5 s ago stays (its UndoBar may still be open), and so does a file that was never removed", async () => {
  const store = await files({ old: 11, fresh: 5, kept: null });
  expect(await purgeRemovedLessonFiles(db, store, NOW)).toBe(1);
  expect(await names()).toEqual(["fresh.pdf", "kept.pdf"]);
  expect(store.deleted).toEqual(["lessons/old.pdf"]);
  expect([...store.objects.keys()].sort()).toEqual(["lessons/fresh.pdf", "lessons/kept.pdf"]);
  // nothing more to do the second time
  expect(await purgeRemovedLessonFiles(db, store, NOW)).toBe(0);
  // later, the fresh one is due
  expect(await purgeRemovedLessonFiles(db, store, new Date(NOW.getTime() + 5_000))).toBe(1);
  expect(await names()).toEqual(["kept.pdf"]);
  expect(store.deleted).toEqual(["lessons/old.pdf", "lessons/fresh.pdf"]);
});

test("10 s is the minimum: a file removed 9.9 s ago stays, one removed exactly 10 s ago goes", async () => {
  const store = fakeMediaStore();
  for (const [i, ms] of [9_900, 10_000].entries())
    await db.insert(lessonFiles).values({ lessonId, position: i + 1, name: `f${i}.pdf`, r2Key: `lessons/f${i}.pdf`, size: 1, contentType: "application/pdf", removedAt: new Date(NOW.getTime() - ms) });
  expect(await purgeRemovedLessonFiles(db, store, NOW)).toBe(1);
  expect(await names()).toEqual(["f0.pdf"]);
});

test("one run takes at most PURGE_BATCH (20) files, the oldest marks first; the next run takes the rest (Task 2 review: R2 deletes were unbounded)", async () => {
  expect(PURGE_BATCH).toBe(20);
  const store = fakeMediaStore();
  // 25 due files, each removed one second before the next (f00 the oldest), plus one still within its 10 s
  for (let i = 0; i < 25; i++) {
    const key = `lessons/f${String(i).padStart(2, "0")}.pdf`;
    await db.insert(lessonFiles).values({ lessonId, position: i + 1, name: `f${String(i).padStart(2, "0")}.pdf`, r2Key: key, size: 1, contentType: "application/pdf", removedAt: ago(100 - i) });
    await store.put(key, new Uint8Array([1]).buffer, "application/pdf");
  }
  await db.insert(lessonFiles).values({ lessonId, position: 26, name: "fresh.pdf", r2Key: "lessons/fresh.pdf", size: 1, contentType: "application/pdf", removedAt: ago(3) });
  expect(await purgeRemovedLessonFiles(db, store, NOW)).toBe(20);
  expect(store.deleted).toHaveLength(20);
  expect(store.deleted.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `lessons/f${String(i).padStart(2, "0")}.pdf`));
  expect(await names()).toEqual(["f20.pdf", "f21.pdf", "f22.pdf", "f23.pdf", "f24.pdf", "fresh.pdf"]);
  // the next run: the five left (never more than were due), the fresh one stays
  expect(await purgeRemovedLessonFiles(db, store, NOW)).toBe(5);
  expect(store.deleted).toHaveLength(25);
  expect(await names()).toEqual(["fresh.pdf"]);
  // a caller may ask for a smaller batch
  for (let i = 0; i < 3; i++) await db.insert(lessonFiles).values({ lessonId, position: 30 + i, name: `g${i}.pdf`, r2Key: `lessons/g${i}.pdf`, size: 1, contentType: "application/pdf", removedAt: ago(60) });
  expect(await purgeRemovedLessonFiles(db, store, NOW, 2)).toBe(2);
  expect(await purgeRemovedLessonFiles(db, store, NOW, 2)).toBe(1);
});

// Task 10 review M1 (data safety): the purge is one DELETE … WHERE id IN (select … limit n). Postgres (read committed) evaluates the subquery on the
// statement's snapshot; a row the DELETE then finds locked by another transaction's UPDATE (the UndoBar's „Võta tagasi“, which clears removed_at)
// is waited for and re-checked against the OUTER where only. So the outer where must say "marked and due" again, or the restored file goes.
// A real race needs two connections (PGlite has one), so it is staged as the sequence it comes to: the candidate ids are taken, the file is restored,
// and then the statement's outer delete runs with that stale list — the same SQL purgeRemovedLessonFiles runs, through the seam it exports.
test("a file restored after the candidate list was taken is not deleted: the outer DELETE repeats „marked and due“ (Task 10 review M1)", async () => {
  await files({ a: 60, restored: 60, c: 60 });
  const due = new Date(NOW.getTime() - PURGE_AFTER_MS).toISOString();
  const candidates = await db.select({ id: lessonFiles.id }).from(lessonFiles).where(sql`${lessonFiles.removedAt} is not null and ${lessonFiles.removedAt} <= ${due}::timestamptz`);
  expect(candidates).toHaveLength(3); // all three were due when the list was taken
  const [restored] = await db.select().from(lessonFiles).where(eq(lessonFiles.name, "restored.pdf"));
  await db.update(lessonFiles).set({ removedAt: null }).where(eq(lessonFiles.id, restored.id)); // „Võta tagasi“ came in between
  const ids = sql.join(candidates.map((c) => sql`${c.id}`), sql`, `);
  const gone = await deleteDueFiles(db, sql`select ${lessonFiles.id} from ${lessonFiles} where ${lessonFiles.id} in (${ids})`, due);
  expect(gone.map((r) => r.name).sort()).toEqual(["a.pdf", "c.pdf"]);
  expect(await names()).toEqual(["restored.pdf"]);
  expect((await db.select().from(lessonFiles))[0].removedAt).toBeNull();
});

test("a file marked again later than the cut-off (removed again after a restore) is not taken by a stale candidate list either", async () => {
  await files({ again: 60 });
  const due = new Date(NOW.getTime() - PURGE_AFTER_MS).toISOString();
  const [row] = await db.select().from(lessonFiles);
  await db.update(lessonFiles).set({ removedAt: ago(2) }).where(eq(lessonFiles.id, row.id)); // restored and removed once more, 2 s ago
  const gone = await deleteDueFiles(db, sql`select ${lessonFiles.id} from ${lessonFiles} where ${lessonFiles.id} = ${row.id}`, due);
  expect(gone).toEqual([]);
  expect(await names()).toEqual(["again.pdf"]);
});

test("without a store (R2 not set up) the rows still go and nothing is asked of a store", async () => {
  await files({ old: 60 });
  expect(await purgeRemovedLessonFiles(db, null, NOW)).toBe(1);
  expect(await names()).toEqual([]);
});

test("the row goes before the object: an object that cannot be deleted is logged without its key and the others go on; the answer counts rows", async () => {
  const store = await files({ a: 30, b: 30, c: 30 });
  const failing = {
    ...store,
    async delete(key: string) {
      if (key === "lessons/b.pdf") throw new Error("R2 says: secret detail lessons/b.pdf");
      return store.delete(key);
    },
  };
  expect(await purgeRemovedLessonFiles(db, failing, NOW)).toBe(3);
  expect(await names()).toEqual([]); // (the rows are gone whatever R2 did: a mark that reappears would only show a file that cannot be downloaded)
  expect(store.deleted.sort()).toEqual(["lessons/a.pdf", "lessons/c.pdf"]);
  const logged = vi.mocked(console.error).mock.calls.map((c) => c.join(" "));
  expect(logged).toEqual(["[lesson-files] a removed file's object was not deleted: Error"]);
  expect(logged.join()).not.toMatch(/lessons\/|secret/);
});

test("it never throws: a database that fails is logged (class only) and answers 0", async () => {
  const broken = { delete: () => ({ where: () => ({ returning: () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED db.example.com"), { code: "ECONNREFUSED" })) }) }) } as unknown as Db;
  expect(await purgeRemovedLessonFiles(broken, fakeMediaStore(), NOW)).toBe(0);
  expect(vi.mocked(console.error).mock.calls.map((c) => c.join(" "))).toEqual(["[lesson-files] removed files not purged: Error (code ECONNREFUSED)"]);
  // and a store whose delete throws at once, not as a rejected promise
  await files({ old: 60 });
  const throwing = { ...fakeMediaStore(), delete: (): Promise<void> => { throw new Error("sync"); } };
  expect(await purgeRemovedLessonFiles(db, throwing, NOW)).toBe(1);
});

// Task 10 review M3: one run takes PURGE_BATCH (20) files; the daily sweep used to call it once, so a session that removed more than 20 files left a
// backlog that only grew by 20 a day. drainRemovedLessonFiles runs the batches one after the other until nothing is due, within two bounds: at most
// PURGE_MAX_BATCHES batches, and no new batch after a deadline (the sweep gives it its 35 s). A batch begun is finished (its rows are gone, so are its objects).

/** `n` files f00… all removed a minute before NOW (the oldest marks first), their objects in the store, plus the fresh ones named. */
async function backlog(n: number, extra: Record<string, number | null> = {}) {
  const store = fakeMediaStore();
  const name = (i: number) => `f${String(i).padStart(3, "0")}`;
  const rows = Array.from({ length: n }, (_, i) => ({ lessonId, position: i + 1, name: `${name(i)}.pdf`, r2Key: `lessons/${name(i)}.pdf`, size: 1, contentType: "application/pdf", removedAt: ago(1000 - i) }));
  if (rows.length) await db.insert(lessonFiles).values(rows);
  for (const r of rows) await store.put(r.r2Key, new Uint8Array([1]).buffer, "application/pdf");
  for (const [key, sec] of Object.entries(extra)) {
    await db.insert(lessonFiles).values({ lessonId, position: n + 1, name: `${key}.pdf`, r2Key: `lessons/${key}.pdf`, size: 1, contentType: "application/pdf", removedAt: sec === null ? null : ago(sec) });
    await store.put(`lessons/${key}.pdf`, new Uint8Array([1]).buffer, "application/pdf");
  }
  return store;
}

test("draining takes batch after batch until nothing is due: 45 due files go in one call (3 batches), a fresh one and a kept one stay", async () => {
  expect(PURGE_MAX_BATCHES).toBe(25);
  const store = await backlog(45, { fresh: 3 });
  expect(await drainRemovedLessonFiles(db, store, NOW)).toEqual({ purged: 45, stopped: false });
  expect(store.deleted).toHaveLength(45);
  expect(await names()).toEqual(["fresh.pdf"]);
  // nothing due: no work, not stopped
  expect(await drainRemovedLessonFiles(db, store, NOW)).toEqual({ purged: 0, stopped: false });
  // exactly one full batch: the second batch finds nothing and ends it
  const again = await backlog(PURGE_BATCH);
  expect(await drainRemovedLessonFiles(db, again, NOW)).toEqual({ purged: PURGE_BATCH, stopped: false });
});

test("at most maxBatches batches a call: the rest is left and said so (stopped), and the next call takes it", async () => {
  const store = await backlog(45);
  expect(await drainRemovedLessonFiles(db, store, NOW, { maxBatches: 2 })).toEqual({ purged: 40, stopped: true });
  expect(await names()).toEqual(["f040.pdf", "f041.pdf", "f042.pdf", "f043.pdf", "f044.pdf"]); // the oldest marks went first
  expect(await drainRemovedLessonFiles(db, store, NOW, { maxBatches: 2 })).toEqual({ purged: 5, stopped: false });
  expect(await names()).toEqual([]);
});

test("the default bound is PURGE_MAX_BATCHES (25) batches of PURGE_BATCH files: 500 go, the rest waits for the next run", async () => {
  const store = await backlog(PURGE_MAX_BATCHES * PURGE_BATCH + 7);
  expect(await drainRemovedLessonFiles(db, store, NOW)).toEqual({ purged: PURGE_MAX_BATCHES * PURGE_BATCH, stopped: true });
  expect(await names()).toHaveLength(7);
  expect(await drainRemovedLessonFiles(db, store, NOW)).toEqual({ purged: 7, stopped: false });
});

test("no new batch after the deadline: a batch begun is finished (rows and objects), the next one is not started", async () => {
  const store = await backlog(45);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now());
  const until = Date.now() + 35_000;
  let first = true;
  const slow = {
    ...store,
    async delete(key: string) {
      if (first) {
        first = false;
        vi.setSystemTime(until + 1); // the first R2 delete takes the budget
      }
      return store.delete(key);
    },
  };
  expect(await drainRemovedLessonFiles(db, slow, NOW, { until })).toEqual({ purged: PURGE_BATCH, stopped: true });
  expect(store.deleted).toHaveLength(PURGE_BATCH); // the whole batch begun, every object
  expect(await names()).toHaveLength(25);
  // a deadline that is over before the first batch: nothing is started
  expect(await drainRemovedLessonFiles(db, store, NOW, { until: Date.now() - 1 })).toEqual({ purged: 0, stopped: true });
  expect(await names()).toHaveLength(25);
});

test("a failing database ends the drain at once (the purge logs it and answers 0): nothing purged, not stopped, one log line", async () => {
  const broken = { delete: () => ({ where: () => ({ returning: () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED db.example.com"), { code: "ECONNREFUSED" })) }) }) } as unknown as Db;
  expect(await drainRemovedLessonFiles(broken, fakeMediaStore(), NOW)).toEqual({ purged: 0, stopped: false });
  expect(vi.mocked(console.error).mock.calls.map((c) => c.join(" "))).toEqual(["[lesson-files] removed files not purged: Error (code ECONNREFUSED)"]);
});

test("a batch size of 0 purges nothing and does not loop", async () => {
  const store = await backlog(3);
  expect(await drainRemovedLessonFiles(db, store, NOW, { limit: 0 })).toEqual({ purged: 0, stopped: false });
  expect(await names()).toHaveLength(3);
});
