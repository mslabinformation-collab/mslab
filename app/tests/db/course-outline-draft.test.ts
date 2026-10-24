import { PGlite } from "@electric-sql/pglite";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { listAllCourses } from "@/db/queries/admin";
import { listModuleTitles } from "@/db/queries/public";
import * as schema from "@/db/schema";
import { clients, contentDrafts, courseModules, courses, lessonFiles, lessonProgress, lessons } from "@/db/schema";
import { readDrafts } from "@/server/drafts";
import { makeTestDb } from "./helpers";

// B18 on the server (admin UX pass piece 3a, Task 5; ruling R-e; README B2 / B18; piece 3 texts P-3): a published course's modules and lessons join
// its draft. The order and the texts of the rows students see are the `outline` part (a draft in `content_drafts`, published with „Avalda
// muudatused“); a new module or lesson is a real row flagged `unpublished`, edited and moved directly (nobody sees it) and shown at the publish;
// deletes and the media stay instant. An unpublished course saves everything straight to its rows. On a real (PGlite) database; the public pages'
// revalidation is a spy.

const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import {
  addLessonForm, addModuleForm, deleteLessonForm, deleteModuleForm, listCourseLessons, moveLessonForm, moveModuleForm, readOutlineText, renameModuleForm, saveLessonForm,
  setLessonHiddenForm, writeOutlineText,
} from "@/server/admin-lessons";
import { courseChanges, discardCourse, publishCourse, readCoursePart, switchCoursePublished, writeCoursePart } from "@/server/course-parts";
import { saveDraftPart } from "@/server/drafts";
import { courseOutline } from "@/server/lesson-outline";

const MARIA = { email: "maria@example.test" };
const DIM = { email: "dim@example.test" };
const NOW = new Date("2026-10-24T09:00:00Z");

let db: Db;
/** A published e-course: „Moodul 1“ (Esimene, Teine) and „Moodul 2“ (Kolmas); a student of it. */
let course: number;
let m1: number;
let m2: number;
let a: number;
let b: number;
let c: number;
let student: number;

async function fixtures(d: Db, published = true) {
  [{ id: course }] = await d
    .insert(courses)
    .values({ slug: "e-kulm", type: "e_learning", level: "basic", title: { et: "E-kulm" }, summary: { et: "" }, body: { et: "" }, price: 9500, accessMonths: 6, published })
    .returning();
  [{ id: m1 }, { id: m2 }] = await d
    .insert(courseModules)
    .values([
      { courseId: course, position: 1, title: { et: "Moodul 1" } },
      { courseId: course, position: 2, title: { et: "Moodul 2" } },
    ])
    .returning();
  [{ id: a }, { id: b }, { id: c }] = await d
    .insert(lessons)
    .values([
      { moduleId: m1, position: 1, title: { et: "Esimene" }, body: { et: "Loe." } },
      { moduleId: m1, position: 2, title: { et: "Teine" } },
      { moduleId: m2, position: 1, title: { et: "Kolmas" } },
    ])
    .returning();
  [{ id: student }] = await d.insert(clients).values({ email: "kati@example.test" }).returning();
}

beforeEach(async () => {
  db = await makeTestDb();
  await fixtures(db);
  pub.revalidatePublic.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const form = (fields: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
};
const idOf = (r: { ok: boolean; id?: number }) => {
  if (!r.ok || r.id === undefined) throw new Error(JSON.stringify(r));
  return r.id;
};
/** What the student has: the modules and visible lessons in order (server/lesson-outline.ts courseOutline). */
const studentSees = async () => (await courseOutline(db, course, student)).modules.map((m) => [m.title.et, m.lessons.map((l) => l.title.et)]);
/** What the admin's card shows: every module and lesson in the draft's order, with the draft's texts; a flagged row marked „*“. */
const adminSees = async (id = course) =>
  (await listCourseLessons(db, id)).map((m) => [`${m.title.et}${m.unpublished ? "*" : ""}`, m.lessons.map((l) => `${l.title.et}${l.unpublished ? "*" : ""}`)]);
const lessonRow = async (id: number) => (await db.select().from(lessons).where(eq(lessons.id, id)))[0];
const moduleRow = async (id: number) => (await db.select().from(courseModules).where(eq(courseModules.id, id)))[0];
const outlineDraft = async (id = course) => (await readDrafts(db, "course", id)).find((d) => d.part === "outline") ?? null;
const read = async () => (await readCoursePart(db, course, "outline"))!;
const revalidated = () => pub.revalidatePublic.mock.calls.map((x) => x[0]);
/** A row's text as its autosave reads it (review I-1, R-b's `t:` version): `{ title }` of a module, `{ title, body }` of a lesson. */
const text = async (kind: "module" | "lesson", id: number) => (await readOutlineText(db, kind, id))!;
const saveText = (kind: "module" | "lesson", id: number, patch: Record<string, unknown>, version: string, admin = MARIA, live?: () => void) =>
  writeOutlineText(db, kind, id, patch, version, admin, NOW, { live });
const TEXT_VERSION = /^t:[0-9a-f]{32}$/;
const deletable = async (id: number) => (await listCourseLessons(db, course)).find((m) => m.id === id)?.deletable;

describe("a published course: new rows are flagged and wait for „Avalda muudatused“", () => {
  test("a new lesson is flagged and absent from the student's outline; after the publish it is visible, in the order the draft put it (M-5: no draft at all)", async () => {
    const n = idOf(await addLessonForm(db, form({ moduleId: m1, titleEt: "Uus tund" })));
    expect((await lessonRow(n)).unpublished).toBe(true);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene", "Teine", "Uus tund*"]], ["Moodul 2", ["Kolmas"]]]);
    // a flagged lesson moves directly (nobody sees it): no draft is made, the student's order is the same
    expect(await moveLessonForm(db, form({ id: n, dir: "up" }), MARIA)).toEqual({ ok: true, id: n });
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene", "Uus tund*", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await readDrafts(db, "course", course)).toEqual([]);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    // the course has an unpublished change all the same: the PublishBar names the module (P-3), the list says „Avaldamata muudatused“
    expect(await courseChanges(db, course)).toEqual([{ part: "outline", labels: ["Moodul 01"] }]);
    expect((await listAllCourses(db)).find((x) => x.id === course)?.changes).toBe(true);
    expect(revalidated()).toEqual([]);

    expect(await publishCourse(db, course, NOW)).toEqual({ published: ["outline"], blocked: [] });
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Uus tund", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    expect((await lessonRow(n)).unpublished).toBe(false);
    expect(revalidated()).toEqual([{ kind: "courses" }]);
    expect(await courseChanges(db, course)).toEqual([]);
    expect((await listAllCourses(db)).find((x) => x.id === course)?.changes).toBe(false);
  });

  test("a new module is flagged too: not on the public page and not in the student's outline until the publish; its own lessons with it", async () => {
    const m3 = idOf(await addModuleForm(db, form({ courseId: course, titleEt: "Moodul 3" })));
    const n = idOf(await addLessonForm(db, form({ moduleId: m3, titleEt: "Uus" })));
    expect([(await moduleRow(m3)).unpublished, (await lessonRow(n)).unpublished]).toEqual([true, true]);
    // flagged rows are edited and moved directly
    expect(await renameModuleForm(db, form({ id: m3, titleEt: "Kordamine" }), MARIA)).toEqual({ ok: true, id: m3 });
    expect(await saveLessonForm(db, form({ id: n, titleEt: "Kordamise tund", bodyEt: "Vaata uuesti." }), MARIA)).toEqual({ ok: true, id: n });
    expect(await moveModuleForm(db, form({ id: m3, dir: "up" }), MARIA)).toEqual({ ok: true, id: m3 });
    expect([(await moduleRow(m3)).title, (await lessonRow(n)).title, (await lessonRow(n)).body]).toEqual([{ et: "Kordamine" }, { et: "Kordamise tund" }, { et: "Vaata uuesti." }]);
    expect(await readDrafts(db, "course", course)).toEqual([]);
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Kordamine*", ["Kordamise tund*"]], ["Moodul 2", ["Kolmas"]]]);
    expect((await listModuleTitles(db, course)).map((t) => t.et)).toEqual(["Moodul 1", "Moodul 2"]);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await courseChanges(db, course)).toEqual([{ part: "outline", labels: ["Moodul 02"] }]);

    expect((await publishCourse(db, course, NOW)).published).toEqual(["outline"]);
    expect((await listModuleTitles(db, course)).map((t) => t.et)).toEqual(["Moodul 1", "Kordamine", "Moodul 2"]);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Kordamine", ["Kordamise tund"]], ["Moodul 2", ["Kolmas"]]]);
    expect((await db.select({ id: courseModules.id, position: courseModules.position }).from(courseModules).orderBy(asc(courseModules.position))).map((m) => m.id)).toEqual([m1, m3, m2]);
  });

  test("a contact course's programme point waits too; its PublishBar label is „Programm“", async () => {
    const [{ id: contact }] = await db
      .insert(courses)
      .values({ slug: "lami", type: "contact", level: "basic", title: { et: "LAMI" }, summary: { et: "" }, body: { et: "" }, priceGroup: 22000, published: true })
      .returning();
    const p1 = idOf(await addModuleForm(db, form({ courseId: contact, titleEt: "Teooria" })));
    expect((await moduleRow(p1)).unpublished).toBe(true);
    expect(await listModuleTitles(db, contact)).toEqual([]);
    expect(await courseChanges(db, contact)).toEqual([{ part: "outline", labels: ["Programm"] }]);
    expect((await publishCourse(db, contact, NOW)).published).toEqual(["outline"]);
    expect(await listModuleTitles(db, contact)).toEqual([{ et: "Teooria" }]);
    // a rename of a live point is drafted, and named „Programm“ again
    await renameModuleForm(db, form({ id: p1, titleEt: "Teooria ja praktika" }), MARIA);
    expect(await listModuleTitles(db, contact)).toEqual([{ et: "Teooria" }]);
    expect(await courseChanges(db, contact)).toEqual([{ part: "outline", labels: ["Programm"] }]);
  });
});

describe("a published course: the order and the texts of live rows are the outline draft", () => {
  test("a renamed module stays live-old (student, public page) until the publish; the admin sees the draft's name", async () => {
    expect(await renameModuleForm(db, form({ id: m1, titleEt: "Sissejuhatus", titleRu: "Введение" }), MARIA)).toEqual({ ok: true, id: m1 });
    expect((await moduleRow(m1)).title).toEqual({ et: "Moodul 1" });
    expect((await listModuleTitles(db, course)).map((t) => t.et)).toEqual(["Moodul 1", "Moodul 2"]);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await adminSees()).toEqual([["Sissejuhatus", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    const draft = (await outlineDraft())!;
    expect(draft).toMatchObject({ version: 1 });
    expect((await db.select({ by: contentDrafts.updatedBy }).from(contentDrafts))[0].by).toBe(MARIA.email);
    expect(await courseChanges(db, course)).toEqual([{ part: "outline", labels: ["Moodul 01"] }]);
    expect(revalidated()).toEqual([]);

    expect(await publishCourse(db, course, NOW)).toEqual({ published: ["outline"], blocked: [] });
    expect((await moduleRow(m1)).title).toEqual({ et: "Sissejuhatus", ru: "Введение" });
    expect((await listModuleTitles(db, course)).map((t) => t.et)).toEqual(["Sissejuhatus", "Moodul 2"]);
    expect(await outlineDraft()).toBeNull();
    expect(revalidated()).toEqual([{ kind: "courses" }]);
  });

  test("a lesson's name and short text wait in the draft too", async () => {
    expect(await saveLessonForm(db, form({ id: a, titleEt: "Alustame", bodyEt: "Loe ja vaata.\r\n\r\nSiis tee." }), MARIA)).toEqual({ ok: true, id: a });
    expect([(await lessonRow(a)).title, (await lessonRow(a)).body]).toEqual([{ et: "Esimene" }, { et: "Loe." }]);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    expect((await listCourseLessons(db, course))[0].lessons[0]).toMatchObject({ title: { et: "Alustame" }, body: { et: "Loe ja vaata.\n\nSiis tee." } });
    // a blank short text is none, in the draft as live
    await saveLessonForm(db, form({ id: b, titleEt: "Teine", bodyEt: "  " }), MARIA);
    expect((await listCourseLessons(db, course))[0].lessons[1].body).toBeNull();
    await publishCourse(db, course, NOW);
    expect([(await lessonRow(a)).title, (await lessonRow(a)).body, (await lessonRow(b)).body]).toEqual([{ et: "Alustame" }, { et: "Loe ja vaata.\n\nSiis tee." }, null]);
  });

  test("a lesson moved between modules in the draft is moved at the publish; the PublishBar names both modules", async () => {
    expect(await moveLessonForm(db, form({ id: b, dir: "down" }), MARIA)).toEqual({ ok: true, id: b });
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene"]], ["Moodul 2", ["Teine", "Kolmas"]]]);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    expect((await lessonRow(b)).moduleId).toBe(m1);
    expect(await courseChanges(db, course)).toEqual([{ part: "outline", labels: ["Moodul 01", "Moodul 02"] }]);
    await publishCourse(db, course, NOW);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene"]], ["Moodul 2", ["Teine", "Kolmas"]]]);
    expect((await lessonRow(b)).moduleId).toBe(m2);
  });

  test("moving modules is drafted: „Moodulite järjekord“ (P-3), and a new lesson in a moved module is named by its place in the draft", async () => {
    expect(await moveModuleForm(db, form({ id: m2, dir: "up" }), MARIA)).toEqual({ ok: true, id: m2 });
    expect(await adminSees()).toEqual([["Moodul 2", ["Kolmas"]], ["Moodul 1", ["Esimene", "Teine"]]]);
    expect((await listModuleTitles(db, course)).map((t) => t.et)).toEqual(["Moodul 1", "Moodul 2"]);
    expect(await courseChanges(db, course)).toEqual([{ part: "outline", labels: ["Moodulite järjekord"] }]);
    await addLessonForm(db, form({ moduleId: m2, titleEt: "Uus" }));
    expect(await courseChanges(db, course)).toEqual([{ part: "outline", labels: ["Moodulite järjekord", "Moodul 01"] }]);
    // moved back: the order is live's again, only the new lesson is left to publish
    await moveModuleForm(db, form({ id: m2, dir: "down" }), MARIA);
    expect(await outlineDraft()).toBeNull();
    expect(await courseChanges(db, course)).toEqual([{ part: "outline", labels: ["Moodul 02"] }]);
  });

  test("Task 2 review: a live lesson moved into a flagged module is a draft move, applied at the publish (it never leaves the students before)", async () => {
    const m3 = idOf(await addModuleForm(db, form({ courseId: course, titleEt: "Moodul 3" })));
    // Kolmas is the last of Moodul 2: ↓ takes it to the start of the module after, the flagged one
    expect(await moveLessonForm(db, form({ id: c, dir: "down" }), MARIA)).toEqual({ ok: true, id: c });
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", []], ["Moodul 3*", ["Kolmas"]]]);
    expect(await lessonRow(c)).toMatchObject({ moduleId: m2, unpublished: false });
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    // the flagged module holds it in the draft: it cannot be deleted from under it (the card is told: review M-1), and its own move stays direct
    expect(await deletable(m3)).toBe(false);
    expect(await deleteModuleForm(db, form({ id: m3 }), MARIA)).toEqual({ ok: false, error: "inUse" });
    expect((await read()).value).toEqual({
      modules: [
        { id: m1, title: { et: "Moodul 1" }, lessons: [{ id: a, title: { et: "Esimene" }, body: { et: "Loe." } }, { id: b, title: { et: "Teine" }, body: { et: "" } }] },
        { id: m2, title: { et: "Moodul 2" }, lessons: [] },
        { id: m3, title: { et: "Moodul 3" }, lessons: [{ id: c, title: { et: "Kolmas" }, body: { et: "" } }] },
      ],
    });
    await publishCourse(db, course, NOW);
    expect(await lessonRow(c)).toMatchObject({ moduleId: m3, unpublished: false });
    expect((await moduleRow(m3)).unpublished).toBe(false);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", []], ["Moodul 3", ["Kolmas"]]]);
  });
});

describe("„Loobu muudatustest“ and the deletes (R-e)", () => {
  test("discard removes the flagged lesson and the drafts, returns its Bunny ids and R2 keys; live and the students' order stay", async () => {
    const n = idOf(await addLessonForm(db, form({ moduleId: m1, titleEt: "Uus" })));
    await db.update(lessons).set({ videoId: "v-new", replacedVideoId: "v-old", videoStatus: "uploading" }).where(eq(lessons.id, n));
    await db.insert(lessonFiles).values([
      { lessonId: n, position: 1, name: "a.pdf", r2Key: "lessons/a.pdf", size: 1, contentType: "application/pdf" },
      { lessonId: n, position: 2, name: "b.pdf", r2Key: "lessons/b.pdf", size: 1, contentType: "application/pdf", removedAt: NOW },
      { lessonId: a, position: 1, name: "kept.pdf", r2Key: "lessons/kept.pdf", size: 1, contentType: "application/pdf" },
    ]);
    await renameModuleForm(db, form({ id: m1, titleEt: "Sissejuhatus" }), MARIA);
    await moveLessonForm(db, form({ id: a, dir: "down" }), MARIA);
    expect(await discardCourse(db, course)).toEqual({ discarded: 2, cleanup: { videoIds: ["v-new", "v-old"], fileKeys: ["lessons/a.pdf", "lessons/b.pdf"] } });
    expect(await db.select().from(lessons).where(eq(lessons.id, n))).toEqual([]);
    expect(await readDrafts(db, "course", course)).toEqual([]);
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    expect((await db.select({ key: lessonFiles.r2Key }).from(lessonFiles)).map((f) => f.key)).toEqual(["lessons/kept.pdf"]);
    expect(await discardCourse(db, course)).toEqual({ discarded: 0, cleanup: { videoIds: [], fileKeys: [] } });
    expect(revalidated()).toEqual([]);
  });

  test("review M-5: discard with a live lesson drafted into a flagged module: the module goes, the lesson stays where students have it", async () => {
    const m3 = idOf(await addModuleForm(db, form({ courseId: course, titleEt: "Moodul 3" })));
    await moveLessonForm(db, form({ id: c, dir: "down" }), MARIA);
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", []], ["Moodul 3*", ["Kolmas"]]]);
    expect(await discardCourse(db, course)).toEqual({ discarded: 2, cleanup: { videoIds: [], fileKeys: [] } });
    expect(await db.select().from(courseModules).where(eq(courseModules.id, m3))).toEqual([]);
    expect(await lessonRow(c)).toMatchObject({ moduleId: m2, unpublished: false });
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
  });

  test("a lesson with progress cannot be deleted on a published course either (the rule is unchanged)", async () => {
    await db.insert(lessonProgress).values({ clientId: student, lessonId: a, watchedSec: 5 });
    expect(await deleteLessonForm(db, form({ id: a }), MARIA)).toEqual({ result: { ok: false, error: "inUse" }, cleanup: { videoIds: [], fileKeys: [] } });
    expect(await lessonRow(a)).toBeDefined();
  });

  test("deleting a lesson without progress is instant; an outline draft waiting meanwhile stays publishable (made again on the new live)", async () => {
    await renameModuleForm(db, form({ id: m2, titleEt: "Praktika" }), MARIA);
    const before = (await read()).version;
    const kolmas = (await text("lesson", c)).version;
    expect(await deleteLessonForm(db, form({ id: b }), MARIA)).toEqual({ result: { ok: true, id: b, deleted: true }, cleanup: { videoIds: [], fileKeys: [] } });
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene"]], ["Praktika", ["Kolmas"]]]);
    // the draft no longer holds the deleted lesson (made again: a new version), and another lesson's text version stays valid
    expect((await read()).version).not.toBe(before);
    expect(await saveText("lesson", c, { title: { et: "Kolmas osa" } }, kolmas)).toMatchObject({ ok: true });
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await publishCourse(db, course, NOW)).toEqual({ published: ["outline"], blocked: [] });
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene"]], ["Praktika", ["Kolmas osa"]]]);
    // an empty live module goes at once too, also from under a draft
    await renameModuleForm(db, form({ id: m2, titleEt: "Praktika 2" }), MARIA);
    await deleteLessonForm(db, form({ id: a }), MARIA);
    expect(await deleteModuleForm(db, form({ id: m1 }), MARIA)).toEqual({ ok: true, id: m1, deleted: true });
    expect((await listModuleTitles(db, course)).map((t) => t.et)).toEqual(["Praktika"]);
    expect((await publishCourse(db, course, NOW)).blocked).toEqual([]);
    expect((await listModuleTitles(db, course)).map((t) => t.et)).toEqual(["Praktika 2"]);
  });

  test("a live module whose lessons the draft moved away still holds them live: it cannot be deleted before the publish (and the card is told, M-1)", async () => {
    const empty = idOf(await addModuleForm(db, form({ courseId: course, titleEt: "Tühi" })));
    expect([await deletable(m1), await deletable(m2), await deletable(empty)]).toEqual([false, false, true]);
    await moveLessonForm(db, form({ id: c, dir: "up" }), MARIA);
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene", "Teine", "Kolmas"]], ["Moodul 2", []], ["Tühi*", []]]);
    expect(await deletable(m2)).toBe(false);
    expect(await deleteModuleForm(db, form({ id: m2 }), MARIA)).toEqual({ ok: false, error: "inUse" });
    await publishCourse(db, course, NOW);
    expect(await deletable(m2)).toBe(true);
    expect(await deleteModuleForm(db, form({ id: m2 }), MARIA)).toEqual({ ok: true, id: m2, deleted: true });
  });

  test("review M-3: an instant delete under a draft whose base was stale already (a live write outside the editor) never absorbs it: the outline stays blocked, its new rows stay flagged", async () => {
    await renameModuleForm(db, form({ id: m1, titleEt: "Sissejuhatus" }), MARIA);
    const n = idOf(await addLessonForm(db, form({ moduleId: m2, titleEt: "Uus" })));
    // a live name written by another way (db/ru-fill.ts writes module titles straight to the rows)
    await db.update(courseModules).set({ title: { et: "Moodul 2", ru: "Модуль 2" } }).where(eq(courseModules.id, m2));
    const base = (await outlineDraft())!.baseVersion;
    expect((await deleteLessonForm(db, form({ id: b }), MARIA)).result).toMatchObject({ ok: true });
    expect((await outlineDraft())!.baseVersion).toBe(base);
    expect(await publishCourse(db, course, NOW)).toEqual({ published: [], blocked: [{ part: "outline", reason: "changed", fields: ["Moodul 01", "Moodul 02"] }] });
    // review M-5: a blocked outline keeps its rows flagged (the draft's order places them), live stays as it is
    expect(await lessonRow(n)).toMatchObject({ unpublished: true });
    expect([(await moduleRow(m1)).title, (await moduleRow(m2)).title]).toEqual([{ et: "Moodul 1" }, { et: "Moodul 2", ru: "Модуль 2" }]);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene"]], ["Moodul 2", ["Kolmas"]]]);
    expect(revalidated()).toEqual([]);
  });

  test("„Õpilastele nähtav“ stays instant on a published course (it is no part of the draft)", async () => {
    expect(await setLessonHiddenForm(db, form({ id: b, hidden: "1" }))).toEqual({ ok: true, id: b });
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await readDrafts(db, "course", course)).toEqual([]);
  });
});

describe("the outline part (R-a, R-b): its value and versions; never written whole (review I-1)", () => {
  test("its value is the live rows' order and texts (flagged rows left out); l: while no draft is there, d:<id>.<n> once a change drafted it", async () => {
    await addLessonForm(db, form({ moduleId: m1, titleEt: "Uus" }));
    const live = await read();
    expect(live.value).toEqual({
      modules: [
        { id: m1, title: { et: "Moodul 1" }, lessons: [{ id: a, title: { et: "Esimene" }, body: { et: "Loe." } }, { id: b, title: { et: "Teine" }, body: { et: "" } }] },
        { id: m2, title: { et: "Moodul 2" }, lessons: [{ id: c, title: { et: "Kolmas" }, body: { et: "" } }] },
      ],
    });
    expect(live.version).toMatch(/^l:[0-9a-f]{32}$/);
    await moveModuleForm(db, form({ id: m2, dir: "up" }), MARIA);
    expect((await read()).version).toMatch(/^d:[1-9][0-9]*\.1$/);
    // back to the live order: no draft is left
    await moveModuleForm(db, form({ id: m2, dir: "down" }), MARIA);
    expect(await read()).toEqual(live);
    expect(await outlineDraft()).toBeNull();
  });

  test("a save of the whole outline through the part is refused (400 modules), on a published and an unpublished course: no editor holds its version", async () => {
    const live = await read();
    const value = live.value as { modules: { id: number; title: { et: string } }[] };
    const swapped = { modules: [value.modules[1], value.modules[0]] };
    for (const patch of [swapped, live.value as Record<string, unknown>, {}]) expect(await writeCoursePart(db, course, "outline", patch, live.version, MARIA, NOW)).toEqual({ ok: false, error: "invalid", fields: { modules: "invalid" } });
    await db.update(courses).set({ published: false }).where(eq(courses.id, course));
    expect(await writeCoursePart(db, course, "outline", swapped, (await read()).version, MARIA, NOW)).toEqual({ ok: false, error: "invalid", fields: { modules: "invalid" } });
    expect(await outlineDraft()).toBeNull();
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
  });

  test("the publish checks the outline again: a draft whose name is blank (no form makes one) is blocked, and the new rows stay flagged", async () => {
    const n = idOf(await addLessonForm(db, form({ moduleId: m1, titleEt: "Uus" })));
    const live = await read();
    const value = live.value as { modules: { id: number; title: { et: string } }[] };
    await saveDraftPart(db, { entity: "course", entityId: course, part: "outline", value: { modules: [{ ...value.modules[0], title: { et: " " } }, value.modules[1]] }, baseVersion: live.version.slice(2), version: null, by: MARIA.email });
    expect(await publishCourse(db, course, NOW)).toEqual({ published: [], blocked: [{ part: "outline", reason: "changed", fields: ["Moodul 01"] }] });
    expect(await lessonRow(n)).toMatchObject({ unpublished: true });
    expect((await moduleRow(m1)).title).toEqual({ et: "Moodul 1" });
  });

  test("a flagged row's own move or delete leaves the outline draft and its version as they are (an open editor is not put in conflict)", async () => {
    const n = idOf(await addLessonForm(db, form({ moduleId: m1, titleEt: "Uus" })));
    await renameModuleForm(db, form({ id: m2, titleEt: "Praktika" }), MARIA);
    const before = await read();
    await moveLessonForm(db, form({ id: n, dir: "up" }), MARIA);
    await moveLessonForm(db, form({ id: n, dir: "down" }), MARIA);
    await moveLessonForm(db, form({ id: n, dir: "down" }), MARIA); // the last of Moodul 1: to the start of Moodul 2
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Praktika", ["Uus*", "Kolmas"]]]);
    expect((await deleteLessonForm(db, form({ id: n }), MARIA)).result).toEqual({ ok: true, id: n, deleted: true });
    expect(await read()).toEqual(before);
  });

});

describe("a row's text autosave (review I-1; R-b amended: t:<hash of the row's working text>)", () => {
  test("a module's and a lesson's text with its t: version: the draft's on a published course, the row's for a flagged row", async () => {
    const n = idOf(await addLessonForm(db, form({ moduleId: m1, titleEt: "Uus" })));
    expect(await text("module", m1)).toEqual({ version: expect.stringMatching(TEXT_VERSION), value: { title: { et: "Moodul 1" } } });
    expect(await text("lesson", a)).toEqual({ version: expect.stringMatching(TEXT_VERSION), value: { title: { et: "Esimene" }, body: { et: "Loe." } } });
    expect((await text("lesson", n)).value).toEqual({ title: { et: "Uus" }, body: { et: "" } });
    await saveLessonForm(db, form({ id: a, titleEt: "Alustame", bodyEt: "Loe." }), MARIA);
    expect((await text("lesson", a)).value).toEqual({ title: { et: "Alustame" }, body: { et: "Loe." } });
    expect(await readOutlineText(db, "lesson", 999_999)).toBeNull();
    expect(await readOutlineText(db, "module", 999_999)).toBeNull();
  });

  test("a live row's save on a published course goes into the outline draft; the students keep the old text until the publish", async () => {
    const before = await text("lesson", a);
    const saved = await saveText("lesson", a, { body: { et: "Loe ja vaata." } }, before.version);
    expect(saved).toEqual({ ok: true, version: expect.stringMatching(TEXT_VERSION), savedAt: NOW.toISOString() });
    expect(await text("lesson", a)).toEqual({ version: saved.ok && saved.version, value: { title: { et: "Esimene" }, body: { et: "Loe ja vaata." } } });
    expect((await lessonRow(a)).body).toEqual({ et: "Loe." });
    expect((await outlineDraft())!.updatedAt).toBeDefined();
    expect((await db.select({ by: contentDrafts.updatedBy }).from(contentDrafts))[0].by).toBe(MARIA.email);
    expect(await courseChanges(db, course)).toEqual([{ part: "outline", labels: ["Moodul 01"] }]);
    // typed back to the live text: the draft goes (nothing is left to publish), the version is the live text's
    expect(await saveText("lesson", a, { body: { et: "Loe." } }, saved.ok ? saved.version : "")).toEqual({ ok: true, version: before.version, savedAt: NOW.toISOString() });
    expect(await outlineDraft()).toBeNull();
    // the module's name, published
    await saveText("module", m2, { title: { et: "Praktika" } }, (await text("module", m2)).version);
    expect((await listModuleTitles(db, course)).map((t) => t.et)).toEqual(["Moodul 1", "Moodul 2"]);
    await publishCourse(db, course, NOW);
    expect((await listModuleTitles(db, course)).map((t) => t.et)).toEqual(["Moodul 1", "Praktika"]);
    expect(revalidated()).toEqual([{ kind: "courses" }]);
  });

  test("a flagged row's save is written on the row (nobody sees it): no draft", async () => {
    const m3 = idOf(await addModuleForm(db, form({ courseId: course, titleEt: "Moodul 3" })));
    const n = idOf(await addLessonForm(db, form({ moduleId: m3, titleEt: "Uus" })));
    const live = vi.fn();
    expect(await saveText("module", m3, { title: { et: "  Kordamine " } }, (await text("module", m3)).version, MARIA, live)).toMatchObject({ ok: true });
    expect(await saveText("lesson", n, { title: { et: "Kordus" }, body: { et: "Vaata." } }, (await text("lesson", n)).version, MARIA, live)).toMatchObject({ ok: true });
    expect([(await moduleRow(m3)).title, (await lessonRow(n)).title, (await lessonRow(n)).body]).toEqual([{ et: "Kordamine" }, { et: "Kordus" }, { et: "Vaata." }]);
    expect(await readDrafts(db, "course", course)).toEqual([]);
    expect(live).not.toHaveBeenCalled();
  });

  test("two tabs on one lesson: the second save on the old version is a conflict with the stored text, never a write", async () => {
    const tabA = await text("lesson", b);
    const tabB = tabA.version;
    expect(await saveText("lesson", b, { title: { et: "Tab A" } }, tabA.version)).toMatchObject({ ok: true });
    const stored = await text("lesson", b);
    expect(await saveText("lesson", b, { title: { et: "Tab B" } }, tabB, DIM)).toEqual({ ok: false, error: "conflict", version: stored.version, value: { title: { et: "Tab A" }, body: { et: "" } } });
    expect((await text("lesson", b)).value).toEqual({ title: { et: "Tab A" }, body: { et: "" } });
    // anything that is not the row's version is a conflict too
    for (const junk of ["", "t:x", "l:abc", "d:1.1"]) expect((await saveText("lesson", b, { title: { et: "X" } }, junk)).ok, junk).toBe(false);
  });

  test("a module's name, a lesson's text and a move in one page: no conflict between them (a move changes no row's text)", async () => {
    let mod = (await text("module", m1)).version;
    let les = (await text("lesson", a)).version;
    const other = (await text("lesson", c)).version;
    for (const [i, name] of ["Algus", "Algus ja ülevaade"].entries()) {
      const savedModule = await saveText("module", m1, { title: { et: name } }, mod);
      expect(savedModule, `module ${i}`).toMatchObject({ ok: true });
      mod = savedModule.ok ? savedModule.version : "";
      const savedLesson = await saveText("lesson", a, { body: { et: `Tekst ${i}` } }, les);
      expect(savedLesson, `lesson ${i}`).toMatchObject({ ok: true });
      les = savedLesson.ok ? savedLesson.version : "";
      await moveLessonForm(db, form({ id: a, dir: i === 0 ? "down" : "up" }), MARIA);
      await moveModuleForm(db, form({ id: m2, dir: i === 0 ? "up" : "down" }), MARIA);
    }
    expect(await saveText("lesson", c, { title: { et: "Kolmas osa" } }, other)).toMatchObject({ ok: true });
    expect(await adminSees()).toEqual([["Algus ja ülevaade", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas osa"]]]);
    expect((await text("lesson", a)).value).toEqual({ title: { et: "Esimene" }, body: { et: "Tekst 1" } });
  });

  test("a deleted lesson: no text to read (the route's 404, gone), and a save from a tab still open is answered as gone", async () => {
    const open = (await text("lesson", b)).version;
    await deleteLessonForm(db, form({ id: b }), MARIA);
    expect(await readOutlineText(db, "lesson", b)).toBeNull();
    expect(await saveText("lesson", b, { title: { et: "X" } }, open)).toEqual({ ok: false, error: "conflict", version: "", value: null });
  });

  test("a refusal names the field: a name is needed, at most 120 characters; a short text at most 5000", async () => {
    const v = (await text("lesson", a)).version;
    expect(await saveText("lesson", a, { title: { et: " " } }, v)).toEqual({ ok: false, error: "invalid", fields: { title: "required" } });
    expect(await saveText("lesson", a, { title: { et: "x".repeat(121) }, body: { et: "y".repeat(5001) } }, v)).toEqual({ ok: false, error: "invalid", fields: { title: "tooLong", body: "tooLong" } });
    expect(await saveText("module", m1, { title: { et: "" } }, (await text("module", m1)).version)).toEqual({ ok: false, error: "invalid", fields: { title: "required" } });
    expect(await outlineDraft()).toBeNull();
    // a save that changes nothing answers the version it came from and writes nothing
    expect(await saveText("lesson", a, { title: { et: "Esimene" } }, v)).toEqual({ ok: true, version: v, savedAt: NOW.toISOString() });
  });

  test("a lesson's save at its limits stays under 20 KB (a page put away sends it as keepalive; the whole outline would not fit)", async () => {
    const et = "Õppetunni tekst. ".repeat(300).slice(0, 5000);
    const ru = "Текст урока. ".repeat(400).slice(0, 5000);
    const patch = { title: { et: "Õ".repeat(120), ru: "Ж".repeat(120) }, body: { et, ru } };
    const v = (await text("lesson", a)).version;
    expect(new TextEncoder().encode(JSON.stringify({ version: v, patch })).length).toBeLessThan(20_000);
    expect(await saveText("lesson", a, patch, v)).toMatchObject({ ok: true });
  });
});

describe("an unpublished course: everything is direct", () => {
  beforeEach(async () => {
    db = await makeTestDb();
    await fixtures(db, false);
  });

  test("new rows are not flagged; renames, texts and moves are written to the rows at once; no draft", async () => {
    const m3 = idOf(await addModuleForm(db, form({ courseId: course, titleEt: "Moodul 3" })));
    const n = idOf(await addLessonForm(db, form({ moduleId: m1, titleEt: "Uus" })));
    expect([(await moduleRow(m3)).unpublished, (await lessonRow(n)).unpublished]).toEqual([false, false]);
    await renameModuleForm(db, form({ id: m1, titleEt: "Sissejuhatus" }), MARIA);
    await saveLessonForm(db, form({ id: a, titleEt: "Alustame", bodyEt: "Tere." }), MARIA);
    await moveModuleForm(db, form({ id: m2, dir: "up" }), MARIA);
    await moveLessonForm(db, form({ id: b, dir: "up" }), MARIA);
    expect((await moduleRow(m1)).title).toEqual({ et: "Sissejuhatus" });
    expect((await lessonRow(a)).title).toEqual({ et: "Alustame" });
    expect(await studentSees()).toEqual([["Moodul 2", ["Kolmas"]], ["Sissejuhatus", ["Teine", "Alustame", "Uus"]], ["Moodul 3", []]]);
    expect(await db.select().from(contentDrafts)).toEqual([]);
    expect(await courseChanges(db, course)).toEqual([]);
    // a row's text autosave writes the rows too (spec §10: its students see it); a module's name is on the public page, so it is told to revalidate
    const live = vi.fn();
    expect(await saveText("module", m2, { title: { et: " Praktika " } }, (await text("module", m2)).version, MARIA, live)).toEqual({
      ok: true,
      version: (await text("module", m2)).version,
      savedAt: NOW.toISOString(),
    });
    expect(live).toHaveBeenCalledOnce();
    expect(await saveText("lesson", c, { body: { et: "Harjuta." } }, (await text("lesson", c)).version, MARIA, live)).toMatchObject({ ok: true });
    expect(live).toHaveBeenCalledOnce(); // a lesson is on no public page
    expect([(await moduleRow(m2)).title, (await lessonRow(c)).body]).toEqual([{ et: "Praktika" }, { et: "Harjuta." }]);
    expect(await studentSees()).toEqual([["Praktika", ["Kolmas"]], ["Sissejuhatus", ["Teine", "Alustame", "Uus"]], ["Moodul 3", []]]);
    expect(await db.select().from(contentDrafts)).toEqual([]);
  });
});

describe("R-d: switching „Avaldatud“ off publishes the outline and the flagged rows first", () => {
  test("the draft's order and names and the new rows are live, then the course is unpublished", async () => {
    const n = idOf(await addLessonForm(db, form({ moduleId: m2, titleEt: "Uus" })));
    await renameModuleForm(db, form({ id: m1, titleEt: "Sissejuhatus" }), MARIA);
    expect(await switchCoursePublished(db, course, false, NOW)).toEqual({ ok: true });
    expect((await db.select().from(courses).where(eq(courses.id, course)))[0].published).toBe(false);
    expect([(await moduleRow(m1)).title, (await lessonRow(n)).unpublished]).toEqual([{ et: "Sissejuhatus" }, false]);
    expect(await studentSees()).toEqual([["Sissejuhatus", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas", "Uus"]]]);
    expect(await readDrafts(db, "course", course)).toEqual([]);
  });

  test("review M-5: a live lesson drafted into a flagged module goes there, and the module is shown, before the course is unpublished", async () => {
    const m3 = idOf(await addModuleForm(db, form({ courseId: course, titleEt: "Moodul 3" })));
    await moveLessonForm(db, form({ id: c, dir: "down" }), MARIA);
    expect(await switchCoursePublished(db, course, false, NOW)).toEqual({ ok: true });
    expect(await lessonRow(c)).toMatchObject({ moduleId: m3, unpublished: false });
    expect((await moduleRow(m3)).unpublished).toBe(false);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", []], ["Moodul 3", ["Kolmas"]]]);
    expect(await readDrafts(db, "course", course)).toEqual([]);
  });

  test("switching it on shows a row still flagged (left by an earlier way of unpublishing) with the course, where it was placed", async () => {
    await db.update(courses).set({ published: false }).where(eq(courses.id, course));
    const [{ id: n }] = await db.insert(lessons).values({ moduleId: m1, position: 1, title: { et: "Jäänud" }, unpublished: true }).returning();
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await switchCoursePublished(db, course, true, NOW)).toEqual({ ok: true });
    expect((await lessonRow(n)).unpublished).toBe(false);
    expect(await studentSees()).toEqual([["Moodul 1", ["Jäänud", "Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
  });
});

describe("the lock order (ledger T11, 40P01): the course row first, then content_drafts", () => {
  test("the module and lesson changes of a published course lock the course before they touch content_drafts", async () => {
    const log: string[] = [];
    db = drizzle(new PGlite(), { schema, logger: { logQuery: (query: string) => void log.push(query) } });
    await migrate(db, { migrationsFolder: "./drizzle" });
    await fixtures(db);
    const courseLock = () => log.findIndex((q) => /^select [\s\S]* from "courses" where "courses"."id" = \$1 for update$/.test(q));
    const draftsTouched = () => log.findIndex((q) => /"content_drafts"/.test(q));
    const runs: [string, () => Promise<unknown>][] = [
      ["rename", () => renameModuleForm(db, form({ id: m1, titleEt: "Uus nimi" }), MARIA)],
      ["text", () => saveLessonForm(db, form({ id: a, titleEt: "Uus tund" }), MARIA)],
      ["move module", () => moveModuleForm(db, form({ id: m2, dir: "up" }), MARIA)],
      ["move lesson", () => moveLessonForm(db, form({ id: b, dir: "down" }), MARIA)],
      ["delete lesson", () => deleteLessonForm(db, form({ id: c }), MARIA)],
      ["add module", () => addModuleForm(db, form({ courseId: course, titleEt: "Uus" }))],
      ["publish", () => publishCourse(db, course, NOW)],
    ];
    for (const [name, run] of runs) {
      log.length = 0;
      await run();
      expect(courseLock(), name).toBeGreaterThanOrEqual(0);
      if (draftsTouched() >= 0) expect(draftsTouched(), name).toBeGreaterThan(courseLock());
    }
    expect(await db.select().from(contentDrafts).where(and(eq(contentDrafts.entity, "course"), eq(contentDrafts.entityId, course)))).toEqual([]);
    // a row's text autosave too (review I-1)
    const v = (await text("lesson", a)).version;
    log.length = 0;
    expect(await saveText("lesson", a, { body: { et: "Uus tekst" } }, v)).toMatchObject({ ok: true });
    expect(courseLock(), "text").toBeGreaterThanOrEqual(0);
    expect(draftsTouched(), "text").toBeGreaterThan(courseLock());
  });
});
