import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { courseModules, courses, lessonFiles, lessonProgress, lessons, type LessonKind, type VideoStatus } from "@/db/schema";
import { dropVideo, moveLesson, type ModuleLayout } from "@/domain/lessons";
import type { I18n } from "@/i18n/field";
import { parseRowId } from "@/lib/row-id";
import { Check, field, invalid, type EditResult } from "./edit-check";

// "Moodulid ja õppetunnid" (spec 3a section 4): a course's modules (a contact course's programme too) and an e-course's lessons
// and lesson files, for the admin, without Next.js (tests/db/admin-lessons.test.ts). Callers have checked the admin session
// (server/actions/admin-lessons.ts wraps each in adminAction). Nothing the browser sends is trusted. Positions are 1…n within their
// list (modules per course, lessons per module), and every list is read by position, then id. Writes return the whole row
// (`returning()`): on the Db union, returning(fields) has no common overload.

export const LESSON_LIMITS = { title: 120, body: 5000 } as const;

/** A progress row that is progress: watched, done, or opened by an admin ("Ava järgmine õppetund"). A row with only the progress clock (phase 2c: the lesson GET writes it) is none. */
const HAS_PROGRESS = sql`(${lessonProgress.watchedSec} > 0 or ${lessonProgress.doneAt} is not null or ${lessonProgress.unlockedBy} is not null)`;

/** A form field's row id (lib/row-id.ts parseRowId), or null when it is missing or not one. */
const idOf = (value: string | null): number | null => (value === null ? null : parseRowId(value));
/** A browser sends a form's line breaks as CR LF (multipart/form-data); they are stored as LF, as the JSON editors store them. */
const lf = (v: string | null) => (v ?? "").replace(/\r\n?/g, "\n");
const i18nOf = (fd: FormData, prefix: string): I18n => ({ et: lf(field(fd, `${prefix}Et`)), ru: lf(field(fd, `${prefix}Ru`)) });

export type AdminLessonFile = { id: number; name: string; size: number; contentType: string };
export type AdminLesson = {
  id: number;
  moduleId: number;
  title: I18n;
  body: I18n | null;
  /** "Õppetunni liik": a video lesson (the default) or a text lesson (no video field). */
  kind: LessonKind;
  hidden: boolean;
  /** Made on a published course and not published yet (piece 3a, R-e): students and the public page do not see it until „Avalda muudatused“. */
  unpublished: boolean;
  videoStatus: VideoStatus;
  /** Bunny's encode progress in percent while the video is processing (R-g); null when Bunny gave none. */
  videoProgress: number | null;
  durationSec: number | null;
  /** A new video is on its way while the old one still plays. */
  replacing: boolean;
  /** A student has progress on it (watched, done, or opened by an admin): it can be hidden, not deleted. */
  inUse: boolean;
  files: AdminLessonFile[];
};
export type AdminModule = {
  id: number;
  title: I18n;
  /** As AdminLesson.unpublished: a module made on a published course and not published yet. */
  unpublished: boolean;
  lessons: AdminLesson[];
};

/**
 * The course's modules, each with its lessons (hidden and unpublished ones too, with the flag) and their files (those removed with „Eemalda“ and
 * waiting for the UndoBar to run out are not listed), in order: three small queries.
 */
export async function listCourseLessons(db: Db, courseId: number): Promise<AdminModule[]> {
  const [mods, rows, files] = await Promise.all([
    db.select({ id: courseModules.id, title: courseModules.title, unpublished: courseModules.unpublished }).from(courseModules).where(eq(courseModules.courseId, courseId)).orderBy(asc(courseModules.position), asc(courseModules.id)),
    db
      .select({
        id: lessons.id,
        moduleId: lessons.moduleId,
        title: lessons.title,
        body: lessons.body,
        kind: lessons.kind,
        hidden: lessons.hidden,
        unpublished: lessons.unpublished,
        videoStatus: lessons.videoStatus,
        videoProgress: lessons.videoProgress,
        durationSec: lessons.durationSec,
        replacedVideoId: lessons.replacedVideoId,
        inUse: sql<boolean>`exists (select 1 from ${lessonProgress} where ${lessonProgress.lessonId} = ${lessons.id} and ${HAS_PROGRESS})`,
      })
      .from(lessons)
      .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
      .where(eq(courseModules.courseId, courseId))
      .orderBy(asc(lessons.position), asc(lessons.id)),
    db
      .select({ id: lessonFiles.id, lessonId: lessonFiles.lessonId, name: lessonFiles.name, size: lessonFiles.size, contentType: lessonFiles.contentType })
      .from(lessonFiles)
      .innerJoin(lessons, eq(lessonFiles.lessonId, lessons.id))
      .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
      .where(and(eq(courseModules.courseId, courseId), isNull(lessonFiles.removedAt)))
      .orderBy(asc(lessonFiles.position), asc(lessonFiles.id)),
  ]);
  return mods.map((m) => ({
    id: m.id,
    title: m.title,
    unpublished: m.unpublished,
    lessons: rows
      .filter((r) => r.moduleId === m.id)
      .map(({ replacedVideoId, ...r }) => ({
        ...r,
        inUse: Boolean(r.inUse),
        replacing: replacedVideoId !== null,
        files: files.filter((f) => f.lessonId === r.id).map((f) => ({ id: f.id, name: f.name, size: f.size, contentType: f.contentType })),
      })),
  }));
}

/** "Lisa moodul" / "Lisa punkt": fields courseId, titleEt, titleRu. The new module goes last. */
export async function addModuleForm(db: Db, fd: FormData): Promise<EditResult> {
  const courseId = idOf(field(fd, "courseId"));
  if (courseId === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  if (!c.ok || !title) return invalid(c.errors);
  return db.transaction(async (tx): Promise<EditResult> => {
    const [course] = await tx.select({ id: courses.id }).from(courses).where(eq(courses.id, courseId)).for("update");
    if (!course) return { ok: false, error: "notFound" };
    const [{ last }] = await tx.select({ last: sql<number | null>`max(${courseModules.position})` }).from(courseModules).where(eq(courseModules.courseId, courseId));
    const [row] = await tx.insert(courseModules).values({ courseId, position: (last ?? 0) + 1, title }).returning();
    return { ok: true, id: row.id, created: true };
  });
}

/** A module's "Salvesta": fields id, titleEt, titleRu. */
export async function renameModuleForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  if (!c.ok || !title) return invalid(c.errors);
  const rows = await db.update(courseModules).set({ title }).where(eq(courseModules.id, id)).returning();
  return rows.length ? { ok: true, id } : { ok: false, error: "notFound" };
}

/** A module's ↑ / ↓: fields id, dir. The course's modules are numbered 1…n again. One that cannot move stays (ok). */
export async function moveModuleForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  const dir = field(fd, "dir");
  if (id === null || (dir !== "up" && dir !== "down")) return { ok: false, error: "invalid" };
  return db.transaction(async (tx): Promise<EditResult> => {
    const [own] = await tx.select({ courseId: courseModules.courseId }).from(courseModules).where(eq(courseModules.id, id));
    if (!own) return { ok: false, error: "notFound" };
    const list = await tx.select({ id: courseModules.id }).from(courseModules).where(eq(courseModules.courseId, own.courseId)).orderBy(asc(courseModules.position), asc(courseModules.id)).for("update");
    const i = list.findIndex((m) => m.id === id);
    const j = i + (dir === "up" ? -1 : 1);
    if (j < 0 || j >= list.length) return { ok: true, id };
    [list[i], list[j]] = [list[j], list[i]];
    for (const [n, m] of list.entries()) await tx.update(courseModules).set({ position: n + 1 }).where(eq(courseModules.id, m.id));
    return { ok: true, id };
  });
}

/** "Kustuta moodul": field id. Refused (inUse) while it has lessons. */
export async function deleteModuleForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { ok: false, error: "invalid" };
  return db.transaction(async (tx): Promise<EditResult> => {
    const [mod] = await tx.select({ id: courseModules.id }).from(courseModules).where(eq(courseModules.id, id)).for("update");
    if (!mod) return { ok: false, error: "notFound" };
    const [{ n }] = await tx.select({ n: count() }).from(lessons).where(eq(lessons.moduleId, id));
    if (Number(n) > 0) return { ok: false, error: "inUse" };
    await tx.delete(courseModules).where(eq(courseModules.id, id));
    return { ok: true, id, deleted: true };
  });
}

/** "Lisa õppetund": fields moduleId, titleEt, titleRu. Last in its module; no video, no text, visible. Only an e-course has lessons: a module of a contact course is notFound. */
export async function addLessonForm(db: Db, fd: FormData): Promise<EditResult> {
  const moduleId = idOf(field(fd, "moduleId"));
  if (moduleId === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  if (!c.ok || !title) return invalid(c.errors);
  return db.transaction(async (tx): Promise<EditResult> => {
    const [mod] = await tx
      .select({ id: courseModules.id, type: courses.type })
      .from(courseModules)
      .innerJoin(courses, eq(courseModules.courseId, courses.id))
      .where(eq(courseModules.id, moduleId))
      .for("update", { of: courseModules });
    if (!mod || mod.type !== "e_learning") return { ok: false, error: "notFound" };
    const [{ last }] = await tx.select({ last: sql<number | null>`max(${lessons.position})` }).from(lessons).where(eq(lessons.moduleId, moduleId));
    const [row] = await tx.insert(lessons).values({ moduleId, position: (last ?? 0) + 1, title }).returning();
    return { ok: true, id: row.id, created: true };
  });
}

/** The course a lesson belongs to (through its module), or null when there is no such lesson: where the admin goes back to. */
export async function courseOfLesson(db: Db, lessonId: number): Promise<number | null> {
  const [row] = await db
    .select({ courseId: courseModules.courseId })
    .from(lessons)
    .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
    .where(eq(lessons.id, lessonId));
  return row?.courseId ?? null;
}

/** The lesson drawer's "Salvesta": fields id, titleEt, titleRu, bodyEt, bodyRu (the short text; blank is none). */
export async function saveLessonForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  const body = c.text("body", i18nOf(fd, "body"), LESSON_LIMITS.body);
  if (!c.ok || !title) return invalid(c.errors);
  const rows = await db.update(lessons).set({ title, body }).where(eq(lessons.id, id)).returning();
  return rows.length ? { ok: true, id } : { ok: false, error: "notFound" };
}

/** A lesson's ↑ / ↓ (domain/lessons.ts moveLesson: across modules at a module's edge): fields id, dir. Only moved rows are written. */
export async function moveLessonForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  const dir = field(fd, "dir");
  if (id === null || (dir !== "up" && dir !== "down")) return { ok: false, error: "invalid" };
  return db.transaction(async (tx): Promise<EditResult> => {
    const [own] = await tx.select({ courseId: courseModules.courseId }).from(lessons).innerJoin(courseModules, eq(lessons.moduleId, courseModules.id)).where(eq(lessons.id, id));
    if (!own) return { ok: false, error: "notFound" };
    const mods = await tx.select({ id: courseModules.id }).from(courseModules).where(eq(courseModules.courseId, own.courseId)).orderBy(asc(courseModules.position), asc(courseModules.id)).for("update");
    const rows = await tx
      .select({ id: lessons.id, moduleId: lessons.moduleId, position: lessons.position })
      .from(lessons)
      .where(inArray(lessons.moduleId, mods.map((m) => m.id)))
      .orderBy(asc(lessons.position), asc(lessons.id));
    const layout: ModuleLayout[] = mods.map((m) => ({ moduleId: m.id, lessonIds: rows.filter((r) => r.moduleId === m.id).map((r) => r.id) }));
    const moved = moveLesson(layout, id, dir === "up" ? -1 : 1);
    if (!moved) return { ok: true, id };
    const before = new Map(rows.map((r) => [r.id, r]));
    for (const m of moved)
      for (const [i, lessonId] of m.lessonIds.entries()) {
        const was = before.get(lessonId)!;
        if (was.moduleId !== m.moduleId || was.position !== i + 1) await tx.update(lessons).set({ moduleId: m.moduleId, position: i + 1 }).where(eq(lessons.id, lessonId));
      }
    return { ok: true, id };
  });
}

/** "Peida" / "Näita õpilastele": fields id, hidden ("1" | "0"). A hidden lesson is not shown, counted or in the order (spec 3). */
export async function setLessonHiddenForm(db: Db, fd: FormData): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  const hidden = field(fd, "hidden");
  if (id === null || (hidden !== "1" && hidden !== "0")) return { ok: false, error: "invalid" };
  const rows = await db.update(lessons).set({ hidden: hidden === "1" }).where(eq(lessons.id, id)).returning();
  return rows.length ? { ok: true, id } : { ok: false, error: "notFound" };
}

/**
 * "Õppetunni liik": fields id, kind ("video" | "text"). To "text": the lesson's videos are dropped (domain/lessons.ts dropVideo) and
 * come back as `obsolete`, for the action to delete from Bunny (the drawer asked "Video kustutatakse. Jätkan?" first). To "video":
 * nothing else changes (a text lesson has no video). Progress rows stay as they are.
 */
export async function setLessonKindForm(db: Db, fd: FormData): Promise<{ result: EditResult; obsolete: string[] }> {
  const id = idOf(field(fd, "id"));
  const kind = field(fd, "kind");
  if (id === null || (kind !== "video" && kind !== "text")) return { result: { ok: false, error: "invalid" }, obsolete: [] };
  return db.transaction(async (tx): Promise<{ result: EditResult; obsolete: string[] }> => {
    const [row] = await tx
      .select({
        videoId: lessons.videoId,
        videoStatus: lessons.videoStatus,
        replacedVideoId: lessons.replacedVideoId,
        durationSec: lessons.durationSec,
        videoWidth: lessons.videoWidth,
        videoHeight: lessons.videoHeight,
      })
      .from(lessons)
      .where(eq(lessons.id, id))
      .for("update");
    if (!row) return { result: { ok: false, error: "notFound" }, obsolete: [] };
    if (kind === "video") {
      await tx.update(lessons).set({ kind }).where(eq(lessons.id, id));
      return { result: { ok: true, id }, obsolete: [] };
    }
    const { next, obsolete } = dropVideo(row);
    await tx.update(lessons).set({ kind, ...next, videoStartedAt: null }).where(eq(lessons.id, id));
    return { result: { ok: true, id }, obsolete };
  });
}

/** What a deleted lesson leaves outside the database: its Bunny videos and its files' store keys (lesson-media.ts removes them). */
export type LessonCleanup = { videoIds: string[]; fileKeys: string[] };
const NOTHING: LessonCleanup = { videoIds: [], fileKeys: [] };

/**
 * "Kustuta õppetund": field id. Refused (inUse) once any student has progress on it (watched, done or opened by an admin; a row with
 * only the progress clock is none) — then it can only be hidden, so the counts stay honest (spec 7). The lesson and its file rows go
 * (cascade); `cleanup` names its videos and files for removeLessonMedia.
 */
export async function deleteLessonForm(db: Db, fd: FormData): Promise<{ result: EditResult; cleanup: LessonCleanup }> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { result: { ok: false, error: "invalid" }, cleanup: NOTHING };
  return db.transaction(async (tx): Promise<{ result: EditResult; cleanup: LessonCleanup }> => {
    const [row] = await tx.select({ videoId: lessons.videoId, replacedVideoId: lessons.replacedVideoId }).from(lessons).where(eq(lessons.id, id)).for("update");
    if (!row) return { result: { ok: false, error: "notFound" }, cleanup: NOTHING };
    const [{ n }] = await tx.select({ n: count() }).from(lessonProgress).where(and(eq(lessonProgress.lessonId, id), HAS_PROGRESS));
    if (Number(n) > 0) return { result: { ok: false, error: "inUse" }, cleanup: NOTHING };
    // (every file row, the removed ones too — piece 3a, R-f: they still hold an R2 object until they are purged, and the cascade takes the rows)
    const files = await tx.select({ key: lessonFiles.r2Key }).from(lessonFiles).where(eq(lessonFiles.lessonId, id)).orderBy(asc(lessonFiles.position), asc(lessonFiles.id));
    await tx.delete(lessons).where(eq(lessons.id, id));
    const videoIds = [row.videoId, row.replacedVideoId].filter((v): v is string => v !== null);
    return { result: { ok: true, id, deleted: true }, cleanup: { videoIds, fileKeys: files.map((f) => f.key) } };
  });
}

/** A file's "Eemalda": field id. The row goes; `key` is the store key to delete (null when there was no such file). */
export async function deleteLessonFileForm(db: Db, fd: FormData): Promise<{ result: EditResult; key: string | null }> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { result: { ok: false, error: "invalid" }, key: null };
  const [row] = await db.delete(lessonFiles).where(eq(lessonFiles.id, id)).returning();
  return row ? { result: { ok: true, id, deleted: true }, key: row.r2Key } : { result: { ok: false, error: "notFound" }, key: null };
}
