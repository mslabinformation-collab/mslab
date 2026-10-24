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
  addLessonForm, addModuleForm, deleteLessonForm, deleteModuleForm, listCourseLessons, moveLessonForm, moveModuleForm, renameModuleForm, saveLessonForm, setLessonHiddenForm,
} from "@/server/admin-lessons";
import { courseChanges, discardCourse, publishCourse, readCoursePart, switchCoursePublished, writeCoursePart } from "@/server/course-parts";
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
const read = async () => (await readCoursePart(db, course, "outline" as never))!;
const write = (patch: Record<string, unknown>, version: string, admin = MARIA) => writeCoursePart(db, course, "outline" as never, patch, version, admin, NOW);
const revalidated = () => pub.revalidatePublic.mock.calls.map((x) => x[0]);

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
    // the flagged module holds it in the draft: it cannot be deleted from under it, and its own move stays direct
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

  test("a lesson with progress cannot be deleted on a published course either (the rule is unchanged)", async () => {
    await db.insert(lessonProgress).values({ clientId: student, lessonId: a, watchedSec: 5 });
    expect(await deleteLessonForm(db, form({ id: a }), MARIA)).toEqual({ result: { ok: false, error: "inUse" }, cleanup: { videoIds: [], fileKeys: [] } });
    expect(await lessonRow(a)).toBeDefined();
  });

  test("deleting a lesson without progress is instant; an outline draft waiting meanwhile stays publishable (made again on the new live)", async () => {
    await renameModuleForm(db, form({ id: m2, titleEt: "Praktika" }), MARIA);
    const before = (await read()).version;
    expect(await deleteLessonForm(db, form({ id: b }), MARIA)).toEqual({ result: { ok: true, id: b, deleted: true }, cleanup: { videoIds: [], fileKeys: [] } });
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene"]], ["Praktika", ["Kolmas"]]]);
    // the draft no longer holds the deleted lesson, and a tab still on the old version is told so (a conflict, never a write)
    const now = await read();
    expect(now.version).not.toBe(before);
    expect(await write({ modules: [] }, before)).toEqual({ ok: false, error: "conflict", version: now.version, value: now.value });
    expect(await publishCourse(db, course, NOW)).toEqual({ published: ["outline"], blocked: [] });
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene"]], ["Praktika", ["Kolmas"]]]);
    // an empty live module goes at once too, also from under a draft
    await renameModuleForm(db, form({ id: m2, titleEt: "Praktika 2" }), MARIA);
    await deleteLessonForm(db, form({ id: a }), MARIA);
    expect(await deleteModuleForm(db, form({ id: m1 }), MARIA)).toEqual({ ok: true, id: m1, deleted: true });
    expect((await listModuleTitles(db, course)).map((t) => t.et)).toEqual(["Praktika"]);
    expect((await publishCourse(db, course, NOW)).blocked).toEqual([]);
    expect((await listModuleTitles(db, course)).map((t) => t.et)).toEqual(["Praktika 2"]);
  });

  test("a live module whose lessons the draft moved away still holds them live: it cannot be deleted before the publish", async () => {
    await moveLessonForm(db, form({ id: c, dir: "up" }), MARIA);
    expect(await adminSees()).toEqual([["Moodul 1", ["Esimene", "Teine", "Kolmas"]], ["Moodul 2", []]]);
    expect(await deleteModuleForm(db, form({ id: m2 }), MARIA)).toEqual({ ok: false, error: "inUse" });
    await publishCourse(db, course, NOW);
    expect(await deleteModuleForm(db, form({ id: m2 }), MARIA)).toEqual({ ok: true, id: m2, deleted: true });
  });

  test("„Õpilastele nähtav“ stays instant on a published course (it is no part of the draft)", async () => {
    expect(await setLessonHiddenForm(db, form({ id: b, hidden: "1" }))).toEqual({ ok: true, id: b });
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await readDrafts(db, "course", course)).toEqual([]);
  });
});

describe("the outline part (R-a, R-b): its value, its versions, two tabs", () => {
  test("its value is the live rows' order and texts (flagged rows left out); l: while no draft is there, d:<id>.<n> after a save", async () => {
    await addLessonForm(db, form({ moduleId: m1, titleEt: "Uus" }));
    const live = await read();
    expect(live.value).toEqual({
      modules: [
        { id: m1, title: { et: "Moodul 1" }, lessons: [{ id: a, title: { et: "Esimene" }, body: { et: "Loe." } }, { id: b, title: { et: "Teine" }, body: { et: "" } }] },
        { id: m2, title: { et: "Moodul 2" }, lessons: [{ id: c, title: { et: "Kolmas" }, body: { et: "" } }] },
      ],
    });
    expect(live.version).toMatch(/^l:[0-9a-f]{32}$/);
    const value = live.value as { modules: { id: number; title: { et: string }; lessons: unknown[] }[] };
    // a save of the whole outline: the modules swapped and one renamed
    const next = { modules: [{ ...value.modules[1], title: { et: "Praktika" } }, value.modules[0]] };
    const saved = await write(next, live.version);
    expect(saved).toMatchObject({ ok: true, version: expect.stringMatching(/^d:[1-9][0-9]*\.1$/) });
    expect(await read()).toEqual({ version: saved.ok && saved.version, value: next });
    expect(await adminSees()).toEqual([["Praktika", ["Kolmas"]], ["Moodul 1", ["Esimene", "Teine", "Uus*"]]]);
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    // back to the live value: no draft is left
    expect(await write(live.value as Record<string, unknown>, saved.ok ? saved.version : "")).toEqual({ ok: true, version: live.version, savedAt: NOW.toISOString() });
    expect(await outlineDraft()).toBeNull();
  });

  test("a save must hold every live row once and no other; a name is needed", async () => {
    const live = await read();
    const value = live.value as { modules: { id: number; title: { et: string }; lessons: { id: number; title: { et: string }; body: { et: string } }[] }[] };
    const n = idOf(await addLessonForm(db, form({ moduleId: m2, titleEt: "Uus" })));
    const bad = [
      { modules: [value.modules[0]] }, // a module left out
      { modules: [value.modules[0], { ...value.modules[1], lessons: [] }] }, // a lesson left out
      { modules: [value.modules[0], { ...value.modules[1], lessons: [...value.modules[1].lessons, value.modules[0].lessons[0]] }] }, // a lesson twice
      { modules: [...value.modules, { id: 999_999, title: { et: "X" }, lessons: [] }] }, // no such module
      { modules: [value.modules[0], { ...value.modules[1], lessons: [...value.modules[1].lessons, { id: n, title: { et: "Uus" }, body: { et: "" } }] }] }, // a flagged lesson
    ];
    for (const [i, v] of bad.entries()) expect(await write(v, live.version), String(i)).toEqual({ ok: false, error: "invalid", fields: { modules: "invalid" } });
    expect(await write({ modules: [{ ...value.modules[0], title: { et: " " } }, value.modules[1]] }, live.version)).toEqual({ ok: false, error: "invalid", fields: { modules: "required" } });
    expect(await outlineDraft()).toBeNull();
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

  test("two tabs changing the outline get a conflict, never a silent overwrite", async () => {
    const tabA = await read();
    const tabB = tabA.version;
    const value = tabA.value as { modules: { id: number; title: { et: string } }[] };
    const mine = { modules: [{ ...value.modules[0], title: { et: "Tab A" } }, value.modules[1]] };
    expect(await write(mine, tabA.version)).toMatchObject({ ok: true });
    const stored = await read();
    expect(await write({ modules: [value.modules[0], { ...value.modules[1], title: { et: "Tab B" } }] }, tabB, DIM)).toEqual({ ok: false, error: "conflict", version: stored.version, value: mine });
    // a move in one tab moves the draft on: the other tab's save on the version before it is a conflict too
    await moveModuleForm(db, form({ id: m2, dir: "up" }), DIM);
    const moved = await read();
    expect(moved.version).not.toBe(stored.version);
    expect(await write(mine, stored.version)).toEqual({ ok: false, error: "conflict", version: moved.version, value: moved.value });
    expect(await adminSees()).toEqual([["Moodul 2", ["Kolmas"]], ["Tab A", ["Esimene", "Teine"]]]);
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
    // the outline part writes the rows too (spec §10: its students see it)
    const live = await read();
    const value = live.value as { modules: { id: number; title: { et: string } }[] };
    expect(await write({ modules: [...value.modules].reverse() }, live.version)).toMatchObject({ ok: true, version: expect.stringMatching(/^l:/) });
    expect(await studentSees()).toEqual([["Moodul 3", []], ["Sissejuhatus", ["Teine", "Alustame", "Uus"]], ["Moodul 2", ["Kolmas"]]]);
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

  test("switching it on shows a row still flagged (left by an earlier way of unpublishing) with the course, where it was placed", async () => {
    await db.update(courses).set({ published: false }).where(eq(courses.id, course));
    const [{ id: n }] = await db.insert(lessons).values({ moduleId: m1, position: 1, title: { et: "Jäänud" }, unpublished: true }).returning();
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
    expect(await switchCoursePublished(db, course, true, NOW)).toEqual({ ok: true });
    expect((await lessonRow(n)).unpublished).toBe(false);
    expect(await studentSees()).toEqual([["Moodul 1", ["Jäänud", "Esimene", "Teine"]], ["Moodul 2", ["Kolmas"]]]);
  });
});

describe("the admin's preview (Task 6): the student's outline with the draft laid over it", () => {
  test("courseOutline with `preview` shows the draft's order, names and new rows; without it, live", async () => {
    const n = idOf(await addLessonForm(db, form({ moduleId: m1, titleEt: "Uus" })));
    await renameModuleForm(db, form({ id: m2, titleEt: "Praktika" }), MARIA);
    await moveLessonForm(db, form({ id: n, dir: "up" }), MARIA);
    await setLessonHiddenForm(db, form({ id: b, hidden: "1" }));
    await db.insert(lessonProgress).values({ clientId: student, lessonId: a, doneAt: NOW });
    const preview = await courseOutline(db, course, student, { preview: true });
    expect(preview.modules.map((m) => [m.title.et, m.lessons.map((l) => [l.title.et, l.state])])).toEqual([
      ["Moodul 1", [["Esimene", "done"], ["Uus", "current"]]],
      ["Praktika", [["Kolmas", "locked"]]],
    ]);
    expect(preview.progress).toEqual({ done: 1, total: 3, next: n });
    expect(await studentSees()).toEqual([["Moodul 1", ["Esimene"]], ["Moodul 2", ["Kolmas"]]]);
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
  });
});
