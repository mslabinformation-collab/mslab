import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseModules, courses, lessonFiles, lessons } from "@/db/schema";
import { listCourseLessons } from "@/server/admin-lessons";
import { purgeRemovedLessonFiles } from "@/server/lesson-file-purge";
import { addLessonFile, removeLessonFile, restoreLessonFile } from "@/server/lesson-files";
import { MAX_IMAGE_BYTES, UploadError } from "@/server/media";
import { fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

let db: Db;
let courseId: number;
let lessonId: number;
beforeEach(async () => {
  db = await makeTestDb();
  const [c] = await db.insert(courses).values({ slug: "veeb", type: "e_learning", level: "basic", title: { et: "V" }, summary: { et: "" }, body: { et: "" } }).returning();
  courseId = c.id;
  const [m] = await db.insert(courseModules).values({ courseId: c.id, position: 1, title: { et: "M" } }).returning();
  [{ id: lessonId }] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "L" } }).returning();
});

const pdf = (size = 20, name = "Juhend.pdf") => {
  const bytes = new Uint8Array(size);
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  return new File([bytes], name, { type: "application/pdf" });
};
const reason = (e: unknown) => (e instanceof UploadError ? e.reason : e);

test("a PDF is stored under lessons/<uuid>.pdf with its type and download name, and listed last", async () => {
  const store = fakeMediaStore();
  const first = await addLessonFile(db, store, lessonId, pdf(20, "Juhend.pdf"));
  await addLessonFile(db, store, lessonId, pdf(30, "Lisa.pdf"));
  expect(first).toEqual({ id: expect.any(Number), name: "Juhend.pdf", size: 20, contentType: "application/pdf" });
  const rows = await db.select().from(lessonFiles).orderBy(lessonFiles.position);
  expect(rows.map((r) => [r.position, r.name, r.size])).toEqual([[1, "Juhend.pdf", 20], [2, "Lisa.pdf", 30]]);
  expect(rows[0].r2Key).toMatch(/^lessons\/[0-9a-f-]{36}\.pdf$/);
  const stored = store.objects.get(rows[0].r2Key)!;
  expect([stored.contentType, stored.disposition]).toEqual(["application/pdf", `attachment; filename="Juhend.pdf"; filename*=UTF-8''Juhend.pdf`]);
});

test("refused: another type, over 4 MB, empty, bytes that are not a PDF; an unknown lesson stores nothing", async () => {
  const store = fakeMediaStore();
  expect(reason(await addLessonFile(db, store, lessonId, new File(["<html>"], "x.html", { type: "text/html" })).catch((e) => e))).toBe("type");
  expect(reason(await addLessonFile(db, store, lessonId, pdf(MAX_IMAGE_BYTES + 1)).catch((e) => e))).toBe("size");
  expect(reason(await addLessonFile(db, store, lessonId, new File([], "x.pdf", { type: "application/pdf" })).catch((e) => e))).toBe("empty");
  expect(reason(await addLessonFile(db, store, lessonId, new File(["not a pdf"], "x.pdf", { type: "application/pdf" })).catch((e) => e))).toBe("content");
  expect(await addLessonFile(db, store, 999999, pdf())).toBe("notFound");
  expect(store.objects.size).toBe(0);
  expect(await db.select().from(lessonFiles)).toHaveLength(0);
});

test("the type is the file's own: a .docx sent without a type is stored as .docx, an image as its extension; the visitor's file name is only the download name", async () => {
  const store = fakeMediaStore();
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const docx = await addLessonFile(db, store, lessonId, new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])], "Ülesanne ../1.DOCX", { type: "" }));
  const jpeg = await addLessonFile(db, store, lessonId, new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "foto.jpeg", { type: "image/jpeg" }));
  expect(docx).toEqual({ id: expect.any(Number), name: "1.DOCX", size: 6, contentType: DOCX });
  expect(jpeg).toEqual({ id: expect.any(Number), name: "foto.jpeg", size: 4, contentType: "image/jpeg" });
  const rows = await db.select().from(lessonFiles).orderBy(lessonFiles.position);
  expect(rows.map((r) => r.r2Key)).toEqual([expect.stringMatching(/^lessons\/[0-9a-f-]{36}\.docx$/), expect.stringMatching(/^lessons\/[0-9a-f-]{36}\.jpg$/)]);
  expect(rows.map((r) => r.contentType)).toEqual([DOCX, "image/jpeg"]);
  expect([...store.objects.keys()].sort()).toEqual(rows.map((r) => r.r2Key).sort());
  expect(store.objects.get(rows[0].r2Key)!.disposition).toBe(`attachment; filename="1.DOCX"; filename*=UTF-8''1.DOCX`);
});

test("positions count per lesson", async () => {
  const [m] = await db.select().from(courseModules);
  const [other] = await db.insert(lessons).values({ moduleId: m.id, position: 2, title: { et: "L2" } }).returning();
  const store = fakeMediaStore();
  await addLessonFile(db, store, lessonId, pdf());
  await addLessonFile(db, store, other.id, pdf());
  await addLessonFile(db, store, lessonId, pdf());
  const rows = await db.select().from(lessonFiles).orderBy(lessonFiles.lessonId, lessonFiles.position);
  expect(rows.map((r) => [r.lessonId === lessonId, r.position])).toEqual([[true, 1], [true, 2], [false, 1]]);
});

test("a removed file (removed_at set, waiting for the UndoBar to run out) does not count for the next position (piece 3a, R-f)", async () => {
  const store = fakeMediaStore();
  await addLessonFile(db, store, lessonId, pdf(20, "Üks.pdf"));
  await addLessonFile(db, store, lessonId, pdf(20, "Kaks.pdf"));
  await db.update(lessonFiles).set({ removedAt: new Date() }).where(eq(lessonFiles.name, "Kaks.pdf"));
  await addLessonFile(db, store, lessonId, pdf(20, "Kolm.pdf"));
  const rows = await db.select().from(lessonFiles).orderBy(lessonFiles.position, lessonFiles.id);
  expect(rows.map((r) => [r.name, r.position, r.removedAt !== null])).toEqual([["Üks.pdf", 1, false], ["Kaks.pdf", 2, true], ["Kolm.pdf", 2, false]]);
});

// „Eemalda“ and „Võta tagasi“ (admin UX pass piece 3a, Task 10; README B2 „Eemalda is instant with UndoBar“, §1.7, R-f): the removal only marks the
// row (removed_at), so the undo can clear the mark; the purge (server/lesson-file-purge.ts) takes the row and its R2 object once the mark is 10 s old,
// and after that the undo is refused (the bar then says the ADM:162 line). A file brought back is at its place again, its position unique.
describe("„Eemalda“ and „Võta tagasi“ (piece 3a, Task 10, R-f)", () => {
  const T0 = new Date("2026-10-24T10:00:00Z");
  const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
  /** The lesson's files as the admin's drawer lists them (listCourseLessons: removed ones are left out), by name in order. */
  const listed = async () => (await listCourseLessons(db, courseId)).flatMap((m) => m.lessons.flatMap((l) => l.files.map((f) => f.name)));
  const stored = async () => (await db.select().from(lessonFiles).orderBy(lessonFiles.position, lessonFiles.id)).map((r) => [r.name, r.position, r.removedAt !== null]);

  test("„Eemalda“ marks the file: nobody lists it, its object stays; „Võta tagasi“ clears the mark and it is listed again where it was", async () => {
    const store = fakeMediaStore();
    const a = await addLessonFile(db, store, lessonId, pdf(20, "Üks.pdf"));
    const b = await addLessonFile(db, store, lessonId, pdf(20, "Kaks.pdf"));
    if (a === "notFound" || b === "notFound") throw new Error("no lesson");
    expect(await removeLessonFile(db, a.id, at(0))).toEqual({ ok: true, id: a.id });
    expect(await listed()).toEqual(["Kaks.pdf"]);
    const [row] = await db.select().from(lessonFiles).where(eq(lessonFiles.id, a.id));
    expect(row.removedAt?.toISOString()).toBe(T0.toISOString());
    expect(store.deleted).toEqual([]); // the object waits for the purge
    // removed already: a second press finds nothing to remove
    expect(await removeLessonFile(db, a.id, at(1))).toEqual({ ok: false, error: "notFound" });
    expect(await restoreLessonFile(db, a.id)).toEqual({ ok: true, id: a.id });
    expect(await listed()).toEqual(["Üks.pdf", "Kaks.pdf"]);
    expect(await stored()).toEqual([["Üks.pdf", 1, false], ["Kaks.pdf", 2, false]]);
    // a file that is not removed has nothing to bring back; no such file is notFound both ways
    expect(await restoreLessonFile(db, a.id)).toEqual({ ok: false, error: "notFound" });
    expect(await removeLessonFile(db, 999999, at(2))).toEqual({ ok: false, error: "notFound" });
    expect(await restoreLessonFile(db, 999999)).toEqual({ ok: false, error: "notFound" });
  });

  test("removed, then purged 10 s later: the row and its R2 object are gone, and the undo is refused", async () => {
    const store = fakeMediaStore();
    const a = await addLessonFile(db, store, lessonId, pdf(20, "Üks.pdf"));
    if (a === "notFound") throw new Error("no lesson");
    const [{ r2Key: key }] = await db.select().from(lessonFiles).where(eq(lessonFiles.id, a.id));
    await removeLessonFile(db, a.id, at(0));
    expect(await purgeRemovedLessonFiles(db, store, at(9))).toBe(0); // the UndoBar (8 s) may still be up
    expect(await restoreLessonFile(db, a.id)).toEqual({ ok: true, id: a.id }); // so the undo still works
    await removeLessonFile(db, a.id, at(20));
    expect(await purgeRemovedLessonFiles(db, store, at(30))).toBe(1);
    expect(await db.select().from(lessonFiles)).toEqual([]);
    expect(store.deleted).toEqual([key]);
    expect(store.objects.has(key)).toBe(false);
    expect(await restoreLessonFile(db, a.id)).toEqual({ ok: false, error: "notFound" });
  });

  test("a file brought back after another took its place (Task 2 note): its place again, every position unique, the others after it", async () => {
    const store = fakeMediaStore();
    await addLessonFile(db, store, lessonId, pdf(20, "Üks.pdf"));
    const b = await addLessonFile(db, store, lessonId, pdf(20, "Kaks.pdf"));
    if (b === "notFound") throw new Error("no lesson");
    await removeLessonFile(db, b.id, at(0));
    await addLessonFile(db, store, lessonId, pdf(20, "Kolm.pdf")); // place 2: the removed one's place is free
    expect(await stored()).toEqual([["Üks.pdf", 1, false], ["Kaks.pdf", 2, true], ["Kolm.pdf", 2, false]]);
    expect(await restoreLessonFile(db, b.id)).toEqual({ ok: true, id: b.id });
    expect(await stored()).toEqual([["Üks.pdf", 1, false], ["Kaks.pdf", 2, false], ["Kolm.pdf", 3, false]]);
    expect(await listed()).toEqual(["Üks.pdf", "Kaks.pdf", "Kolm.pdf"]);
    // and the next file goes last after them
    await addLessonFile(db, store, lessonId, pdf(20, "Neli.pdf"));
    const live = (await db.select().from(lessonFiles)).map((r) => r.position);
    expect(new Set(live).size).toBe(live.length);
    expect(await listed()).toEqual(["Üks.pdf", "Kaks.pdf", "Kolm.pdf", "Neli.pdf"]);
  });

  test("another lesson's files are not moved by a file brought back", async () => {
    const store = fakeMediaStore();
    const [m] = await db.select().from(courseModules);
    const [other] = await db.insert(lessons).values({ moduleId: m.id, position: 2, title: { et: "L2" } }).returning();
    const a = await addLessonFile(db, store, lessonId, pdf(20, "Üks.pdf"));
    await addLessonFile(db, store, other.id, pdf(20, "Teine.pdf"));
    if (a === "notFound") throw new Error("no lesson");
    await removeLessonFile(db, a.id, at(0));
    await addLessonFile(db, store, lessonId, pdf(20, "Uus.pdf"));
    await restoreLessonFile(db, a.id);
    const rows = await db.select().from(lessonFiles).orderBy(lessonFiles.lessonId, lessonFiles.position);
    expect(rows.map((r) => [r.name, r.position])).toEqual([["Üks.pdf", 1], ["Uus.pdf", 2], ["Teine.pdf", 1]]);
  });
});

// The object is put first, the row follows. A row that cannot be made must not leave the private object behind in storage.
afterEach(() => vi.restoreAllMocks());

/** A store that runs `after` right after each put (to break the database between the put and the row), and records the keys put. */
const storeThat = (after: () => Promise<unknown>) => {
  const base = fakeMediaStore();
  const putKeys: string[] = [];
  const store = {
    ...base,
    async put(key: string, bytes: ArrayBuffer, contentType: string, disposition?: string) {
      await base.put(key, bytes, contentType, disposition);
      putKeys.push(key);
      await after();
    },
  };
  return { store, base, putKeys };
};

test("the insert fails (the lesson is gone by then): the call rejects with that error, the object is deleted, no row is left", async () => {
  const { store, base, putKeys } = storeThat(() => db.delete(lessons).where(eq(lessons.id, lessonId)));
  const err = await addLessonFile(db, store, lessonId, pdf()).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UploadError);
  expect(putKeys).toHaveLength(1);
  expect(base.deleted).toEqual(putKeys);
  expect(base.objects.size).toBe(0);
  expect(await db.select().from(lessonFiles)).toHaveLength(0);
});

test("the position select fails: the same, the object is deleted", async () => {
  const { store, base, putKeys } = storeThat(() => db.execute(sql`drop table lesson_files cascade`));
  const err = await addLessonFile(db, store, lessonId, pdf()).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(putKeys).toHaveLength(1);
  expect(base.deleted).toEqual(putKeys);
  expect(base.objects.size).toBe(0);
});

test("the cleanup itself fails: the original error still comes out (not the delete's), and the failure is logged without the key", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { store, putKeys } = storeThat(() => db.delete(lessons).where(eq(lessons.id, lessonId)));
  const failing = { ...store, delete: () => Promise.reject(new Error("R2 says: secret detail")) };
  const err = await addLessonFile(db, failing, lessonId, pdf()).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(String(err.message)).not.toContain("secret detail"); // the database's error, not the delete's
  expect(log).toHaveBeenCalledTimes(1);
  expect(String(log.mock.calls[0][0])).not.toContain(putKeys[0]);
  expect(log.mock.calls.map((c) => c.join(" "))).toEqual(["[lesson-files] a stored file could not be removed after its row failed: Error"]);
});

test("a delete that throws at once (not a rejected promise) does not hide the error either", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { store } = storeThat(() => db.delete(lessons).where(eq(lessons.id, lessonId)));
  const failing = {
    ...store,
    delete: (): Promise<void> => {
      throw new Error("sync");
    },
  };
  const err = await addLessonFile(db, failing, lessonId, pdf()).catch((e) => e);
  expect(String(err.message)).not.toBe("sync");
});

test("the put fails: the error is the store's own, no row, and nothing is deleted (nothing was stored)", async () => {
  const base = fakeMediaStore();
  const store = { ...base, put: () => Promise.reject(new Error("store down")) };
  await expect(addLessonFile(db, store, lessonId, pdf())).rejects.toThrow("store down");
  expect(base.deleted).toEqual([]);
  expect(await db.select().from(lessonFiles)).toHaveLength(0);
});

test("a file that is stored and listed is never deleted", async () => {
  const store = fakeMediaStore();
  await addLessonFile(db, store, lessonId, pdf());
  expect(store.deleted).toEqual([]);
  expect(store.objects.size).toBe(1);
});
