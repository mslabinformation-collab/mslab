import { beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseModules, courses, lessonFiles, lessons } from "@/db/schema";
import { purgeRemovedLessonFiles } from "@/server/lesson-file-purge";
import { fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// The purge of removed lesson files (piece 3a, R-f): „Eemalda“ only sets lesson_files.removed_at, so that the UndoBar can bring the file back. The
// row and its R2 object go once the mark is at least 10 s old (10 s is a minimum, never less), called at the start of the next lesson-file
// action and by the daily sweep. The row goes first, the R2 object after it; it never throws (a failure is logged, the rest goes on).

const NOW = new Date("2026-10-23T10:00:00Z");
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000);

let db: Db;
let lessonId: number;
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
