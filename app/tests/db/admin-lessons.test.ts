import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import type { Db } from "@/db/client";
import { courseUsage, typeLocked } from "@/db/queries/admin";
import { clients, courseModules, courses, lessonFiles, lessonProgress, lessons } from "@/db/schema";
import {
  addLessonForm, addModuleForm, courseOfLesson, deleteLessonFileForm, deleteLessonForm, deleteModuleForm, listCourseLessons, moveLessonForm, moveModuleForm, renameModuleForm,
  saveLessonForm, setLessonHiddenForm, setLessonKindForm,
} from "@/server/admin-lessons";
import type { EditResult } from "@/server/edit-check";
import { makeTestDb } from "./helpers";

const form = (fields: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
};
const idOf = (r: EditResult) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.id;
};

let db: Db;
let courseId: number;
beforeEach(async () => {
  db = await makeTestDb();
  [{ id: courseId }] = await db.insert(courses).values({ slug: "veeb", type: "e_learning", level: "basic", title: { et: "Veeb" }, summary: { et: "" }, body: { et: "" } }).returning();
});
const titles = async () => (await listCourseLessons(db, courseId)).map((m) => [m.title.et, m.lessons.map((l) => l.title.et)]);

describe("modules", () => {
  test("add (last), rename ET/RU, ↑ ↓, delete only when it has no lessons", async () => {
    const a = idOf(await addModuleForm(db, form({ courseId, titleEt: " Sissejuhatus ", titleRu: "" })));
    const b = idOf(await addModuleForm(db, form({ courseId, titleEt: "Praktika", titleRu: "Практика" })));
    expect(await titles()).toEqual([["Sissejuhatus", []], ["Praktika", []]]);
    expect(await renameModuleForm(db, form({ id: a, titleEt: "Algus", titleRu: "Начало" }))).toEqual({ ok: true, id: a });
    expect(await moveModuleForm(db, form({ id: b, dir: "up" }))).toEqual({ ok: true, id: b });
    expect(await titles()).toEqual([["Praktika", []], ["Algus", []]]);
    expect((await listCourseLessons(db, courseId))[1].title).toEqual({ et: "Algus", ru: "Начало" });
    expect(await moveModuleForm(db, form({ id: b, dir: "up" }))).toEqual({ ok: true, id: b }); // already first: nothing moves
    idOf(await addLessonForm(db, form({ moduleId: b, titleEt: "Esimene" })));
    expect(await deleteModuleForm(db, form({ id: b }))).toEqual({ ok: false, error: "inUse" });
    expect(await deleteModuleForm(db, form({ id: a }))).toEqual({ ok: true, id: a, deleted: true });
    expect(await titles()).toEqual([["Praktika", ["Esimene"]]]);
  });

  test("a title is needed, at most 120 characters; an unknown course is notFound; a bad id is invalid", async () => {
    expect(await addModuleForm(db, form({ courseId, titleEt: "  " }))).toEqual({ ok: false, error: "invalid", fields: { title: "required" } });
    expect(await addModuleForm(db, form({ courseId, titleEt: "x".repeat(121) }))).toEqual({ ok: false, error: "invalid", fields: { title: "tooLong" } });
    expect(await addModuleForm(db, form({ courseId: 999999, titleEt: "X" }))).toEqual({ ok: false, error: "notFound" });
    expect(await addModuleForm(db, form({ courseId: "x", titleEt: "X" }))).toEqual({ ok: false, error: "invalid" });
    expect(await renameModuleForm(db, form({ id: 999999, titleEt: "X" }))).toEqual({ ok: false, error: "notFound" });
  });
});

describe("lessons", () => {
  async function twoModules() {
    const a = idOf(await addModuleForm(db, form({ courseId, titleEt: "A" })));
    const b = idOf(await addModuleForm(db, form({ courseId, titleEt: "B" })));
    const add = async (moduleId: number, titleEt: string) => idOf(await addLessonForm(db, form({ moduleId, titleEt })));
    return { a, b, l1: await add(a, "Üks"), l2: await add(a, "Kaks"), l3: await add(b, "Kolm") };
  }

  test("added last in its module; the title and the short text are saved (a blank text is none)", async () => {
    const w = await twoModules();
    expect(await titles()).toEqual([["A", ["Üks", "Kaks"]], ["B", ["Kolm"]]]);
    expect(await saveLessonForm(db, form({ id: w.l1, titleEt: "Esimene", titleRu: "Первый", bodyEt: "Loe.\n\nVaata.", bodyRu: "" }))).toEqual({ ok: true, id: w.l1 });
    const [l] = await db.select().from(lessons).where(eq(lessons.id, w.l1));
    expect([l.title, l.body]).toEqual([{ et: "Esimene", ru: "Первый" }, { et: "Loe.\n\nVaata." }]);
    // a browser's form sends line breaks as CR LF: stored as LF
    await saveLessonForm(db, form({ id: w.l1, titleEt: "Esimene", bodyEt: "Loe.\r\n\r\nVaata.\rNüüd.", bodyRu: "Читай.\r\n" }));
    expect((await db.select().from(lessons).where(eq(lessons.id, w.l1)))[0].body).toEqual({ et: "Loe.\n\nVaata.\nNüüd.", ru: "Читай." });
    await saveLessonForm(db, form({ id: w.l1, titleEt: "Esimene", bodyEt: "  " }));
    expect((await db.select().from(lessons).where(eq(lessons.id, w.l1)))[0].body).toBeNull();
    expect(await saveLessonForm(db, form({ id: w.l1, titleEt: "", bodyEt: "x".repeat(5001) }))).toEqual({ ok: false, error: "invalid", fields: { title: "required", body: "tooLong" } });
    expect(await addLessonForm(db, form({ moduleId: 999999, titleEt: "X" }))).toEqual({ ok: false, error: "notFound" });
  });

  test("only an e-course has lessons: a module of a contact course is notFound; a lesson's own course is read through its module", async () => {
    const w = await twoModules();
    expect(await courseOfLesson(db, w.l3)).toBe(courseId);
    expect(await courseOfLesson(db, 999999)).toBeNull();
    const [{ id: contact }] = await db.insert(courses).values({ slug: "kontakt", type: "contact", level: "basic", title: { et: "Kontakt" }, summary: { et: "" }, body: { et: "" } }).returning();
    const programme = idOf(await addModuleForm(db, form({ courseId: contact, titleEt: "Programmi punkt" }))); // a contact course's programme: fine
    expect(await addLessonForm(db, form({ moduleId: programme, titleEt: "X" }))).toEqual({ ok: false, error: "notFound" });
    expect(await db.select().from(lessons).where(eq(lessons.moduleId, programme))).toHaveLength(0);
  });

  test("↑ ↓ within a module and across modules; the very first stays", async () => {
    const w = await twoModules();
    await moveLessonForm(db, form({ id: w.l2, dir: "down" }));
    expect(await titles()).toEqual([["A", ["Üks"]], ["B", ["Kaks", "Kolm"]]]);
    await moveLessonForm(db, form({ id: w.l3, dir: "up" }));
    expect(await titles()).toEqual([["A", ["Üks"]], ["B", ["Kolm", "Kaks"]]]);
    await moveLessonForm(db, form({ id: w.l3, dir: "up" }));
    expect(await titles()).toEqual([["A", ["Üks", "Kolm"]], ["B", ["Kaks"]]]);
    expect(await moveLessonForm(db, form({ id: w.l1, dir: "up" }))).toEqual({ ok: true, id: w.l1 });
    expect(await titles()).toEqual([["A", ["Üks", "Kolm"]], ["B", ["Kaks"]]]);
  });

  test("hide and show; delete only without progress, and the cleanup names its videos and files", async () => {
    const w = await twoModules();
    expect(await setLessonHiddenForm(db, form({ id: w.l1, hidden: "1" }))).toEqual({ ok: true, id: w.l1 });
    expect((await listCourseLessons(db, courseId))[0].lessons[0]).toMatchObject({ kind: "video", hidden: true, inUse: false, videoStatus: "none", replacing: false, files: [] });
    await setLessonHiddenForm(db, form({ id: w.l1, hidden: "0" }));
    expect((await listCourseLessons(db, courseId))[0].lessons[0].hidden).toBe(false);

    await db.update(lessons).set({ videoId: "new", videoStatus: "uploading", replacedVideoId: "old" }).where(eq(lessons.id, w.l2));
    await db.insert(lessonFiles).values({ lessonId: w.l2, position: 1, name: "a.pdf", r2Key: "lessons/a.pdf", size: 1, contentType: "application/pdf" });
    expect((await listCourseLessons(db, courseId))[0].lessons[1]).toMatchObject({ replacing: true, files: [{ name: "a.pdf", size: 1, contentType: "application/pdf" }] });
    expect(await deleteLessonForm(db, form({ id: w.l2 }))).toEqual({ result: { ok: true, id: w.l2, deleted: true }, cleanup: { videoIds: ["new", "old"], fileKeys: ["lessons/a.pdf"] } });
    expect(await db.select().from(lessonFiles)).toHaveLength(0);

    const [c] = await db.insert(clients).values({ email: "kati@example.test" }).returning();
    await db.insert(lessonProgress).values({ clientId: c.id, lessonId: w.l3, watchedSec: 5 });
    expect((await listCourseLessons(db, courseId))[1].lessons[0].inUse).toBe(true);
    expect(await deleteLessonForm(db, form({ id: w.l3 }))).toEqual({ result: { ok: false, error: "inUse" }, cleanup: { videoIds: [], fileKeys: [] } });
    expect((await deleteLessonForm(db, form({ id: 999999 }))).result).toEqual({ ok: false, error: "notFound" });

    // a row with only the progress clock (phase 2c: she opened the lesson and watched nothing) is no progress: the lesson can still go
    await db.insert(lessonProgress).values({ clientId: c.id, lessonId: w.l1, clockAt: new Date() });
    expect((await listCourseLessons(db, courseId))[0].lessons[0].inUse).toBe(false);
    expect((await deleteLessonForm(db, form({ id: w.l1 }))).result).toEqual({ ok: true, id: w.l1, deleted: true });
    expect(await db.select().from(lessonProgress).where(eq(lessonProgress.lessonId, w.l1))).toEqual([]); // its row went with it
  });

  test("a row that is done, or that an admin opened (\"Ava järgmine õppetund\"), is progress even with 0 s watched: the lesson can only be hidden", async () => {
    const w = await twoModules();
    const [c] = await db.insert(clients).values({ email: "mari@example.test" }).returning();
    await db.insert(lessonProgress).values([
      { clientId: c.id, lessonId: w.l1, doneAt: new Date(), clockAt: new Date() },
      { clientId: c.id, lessonId: w.l2, unlockedBy: "admin@example.test", clockAt: new Date() },
    ]);
    const inUse = async () => (await listCourseLessons(db, courseId)).flatMap((m) => m.lessons.map((l) => [l.id, l.inUse]));
    expect(await inUse()).toEqual([[w.l1, true], [w.l2, true], [w.l3, false]]);
    for (const id of [w.l1, w.l2]) expect((await deleteLessonForm(db, form({ id }))).result, String(id)).toEqual({ ok: false, error: "inUse" });
  });

  test("a file row is removed and its key comes back for the store", async () => {
    const w = await twoModules();
    const [f] = await db.insert(lessonFiles).values({ lessonId: w.l1, position: 1, name: "a.pdf", r2Key: "lessons/a.pdf", size: 1, contentType: "application/pdf" }).returning();
    expect(await deleteLessonFileForm(db, form({ id: f.id }))).toEqual({ result: { ok: true, id: f.id, deleted: true }, key: "lessons/a.pdf" });
    expect(await deleteLessonFileForm(db, form({ id: f.id }))).toEqual({ result: { ok: false, error: "notFound" }, key: null });
  });

  test("piece 3a: the admin reads unpublished modules and lessons with the flag and the encode progress, leaves removed files out, and a removed file still goes with its lesson", async () => {
    const w = await twoModules();
    const [um] = await db.insert(courseModules).values({ courseId, position: 3, title: { et: "Uus moodul" }, unpublished: true }).returning();
    await db.insert(lessons).values({ moduleId: um.id, position: 1, title: { et: "Uus" }, unpublished: true, videoStatus: "processing", videoProgress: 42 });
    await db.update(lessons).set({ unpublished: true }).where(eq(lessons.id, w.l2));
    const file = (lessonId: number, position: number, name: string, removedAt: Date | null = null) =>
      db.insert(lessonFiles).values({ lessonId, position, name, r2Key: `lessons/${name}`, size: 1, contentType: "application/pdf", removedAt }).returning();
    await file(w.l1, 1, "a.pdf");
    await file(w.l1, 2, "gone.pdf", new Date("2026-10-23T09:00:00Z"));
    await file(w.l1, 3, "b.pdf");
    const mods = await listCourseLessons(db, courseId);
    expect(mods.map((m) => [m.title.et, m.unpublished, m.lessons.map((l) => [l.title.et, l.unpublished, l.videoProgress])])).toEqual([
      ["A", false, [["Üks", false, null], ["Kaks", true, null]]],
      ["B", false, [["Kolm", false, null]]],
      ["Uus moodul", true, [["Uus", true, 42]]],
    ]);
    expect(mods[0].lessons[0].files.map((f) => f.name)).toEqual(["a.pdf", "b.pdf"]); // „Eemalda“ was pressed on gone.pdf: not listed (the UndoBar has it)
    // the type lock counts every lesson, unpublished ones too
    expect((await courseUsage(db, courseId))?.lessons).toBe(4);
    expect(typeLocked(await courseUsage(db, courseId))).toBe(true);
    // an unpublished module has lessons all the same: it cannot be deleted from under them
    expect(await deleteModuleForm(db, form({ id: um.id }))).toEqual({ ok: false, error: "inUse" });
    // deleting the lesson takes its removed file with it, and that file's store key is in the cleanup: nothing is left behind in R2
    expect(await deleteLessonForm(db, form({ id: w.l1 }))).toEqual({
      result: { ok: true, id: w.l1, deleted: true },
      cleanup: { videoIds: [], fileKeys: ["lessons/a.pdf", "lessons/gone.pdf", "lessons/b.pdf"] },
    });
    expect(await db.select().from(lessonFiles)).toHaveLength(0);
  });

  test("“Õppetunni liik”: a new lesson is a video lesson; to Tekst drops its videos (obsolete for Bunny); back to Video has none", async () => {
    const w = await twoModules();
    expect((await db.select().from(lessons).where(eq(lessons.id, w.l1)))[0].kind).toBe("video");
    await db.update(lessons).set({ videoId: "new", videoStatus: "processing", replacedVideoId: "old", durationSec: 300, videoWidth: 1080, videoHeight: 1920, videoStartedAt: new Date() }).where(eq(lessons.id, w.l1));
    expect(await setLessonKindForm(db, form({ id: w.l1, kind: "text" }))).toEqual({ result: { ok: true, id: w.l1 }, obsolete: ["new", "old"] });
    expect((await db.select().from(lessons).where(eq(lessons.id, w.l1)))[0]).toMatchObject({ kind: "text", videoId: null, videoStatus: "none", replacedVideoId: null, durationSec: null, videoWidth: null, videoHeight: null, videoStartedAt: null });
    expect((await listCourseLessons(db, courseId))[0].lessons[0].kind).toBe("text");
    expect(await setLessonKindForm(db, form({ id: w.l1, kind: "video" }))).toEqual({ result: { ok: true, id: w.l1 }, obsolete: [] });
    expect((await db.select().from(lessons).where(eq(lessons.id, w.l1)))[0]).toMatchObject({ kind: "video", videoStatus: "none" });
    expect(await setLessonKindForm(db, form({ id: w.l1, kind: "audio" }))).toEqual({ result: { ok: false, error: "invalid" }, obsolete: [] });
    expect(await setLessonKindForm(db, form({ id: 999999, kind: "text" }))).toEqual({ result: { ok: false, error: "notFound" }, obsolete: [] });
  });
});
