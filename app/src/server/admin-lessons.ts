import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { lockCourse } from "@/db/queries/admin";
import { courseModules, courses, lessonFiles, lessonProgress, lessons, type Course, type LessonKind, type VideoStatus } from "@/db/schema";
import type { SaveAnswer } from "@/domain/autosave";
import { dropVideo, moveLesson, type ModuleLayout } from "@/domain/lessons";
import type { I18n } from "@/i18n/field";
import { parseRowId } from "@/lib/row-id";
import { contentVersion, stableJson } from "@/lib/version";
import { fieldCodes } from "./autosave-route";
import { LESSON_LIMITS, layoutFor, OUTLINE_TEXT_PATCHES, readLayout, storeLayout, storedBody, type Layout, type OutlineRows } from "./course-outline";
import { readDrafts } from "./drafts";
import { Check, field, invalid, type EditResult } from "./edit-check";

// "Moodulid ja õppetunnid" (spec 3a section 4): a course's modules (a contact course's programme too) and an e-course's lessons
// and lesson files, for the admin, without Next.js (tests/db/admin-lessons.test.ts). Callers have checked the admin session
// (server/actions/admin-lessons.ts wraps each in adminAction). Nothing the browser sends is trusted. Positions are 1…n within their
// list (modules per course, lessons per module), and every list is read by position, then id. Writes return the whole row
// (`returning()`): on the Db union, returning(fields) has no common overload.
//
// B18 (admin UX pass piece 3a, R-e; server/course-outline.ts): on a PUBLISHED course a new module or lesson is a row flagged `unpublished` (students
// and the public page see it at „Avalda muudatused“), and the name, the short text and the place of a row students see wait in the course's
// `outline` draft; a flagged row is renamed and moved on the row itself. The deletes, „Peida“, the lesson's kind, its video and files stay instant.
// On an unpublished course everything is written to the rows. Every change of the modules and lessons takes the course's lock first (the lock
// order of server/drafts.ts: a change, a publish and a discard of one course queue on its row) and works on the course's working order.

export { LESSON_LIMITS };

/** A progress row that is progress: watched, done, or opened by an admin ("Ava järgmine õppetund"). A row with only the progress clock (phase 2c: the lesson GET writes it) is none. */
const HAS_PROGRESS = sql`(${lessonProgress.watchedSec} > 0 or ${lessonProgress.doneAt} is not null or ${lessonProgress.unlockedBy} is not null)`;

/** A form field's row id (lib/row-id.ts parseRowId), or null when it is missing or not one. */
const idOf = (value: string | null): number | null => (value === null ? null : parseRowId(value));
/** A browser sends a form's line breaks as CR LF (multipart/form-data); they are stored as LF, as the JSON editors store them. */
const lf = (v: string | null) => (v ?? "").replace(/\r\n?/g, "\n");
const i18nOf = (fd: FormData, prefix: string): I18n => ({ et: lf(field(fd, `${prefix}Et`)), ru: lf(field(fd, `${prefix}Ru`)) });

/** Who made a change (a published course's outline draft names her: content_drafts.updated_by). */
type Who = { email: string };

export type AdminLessonFile = { id: number; name: string; size: number; contentType: string };
/** A lesson as the admin's card shows it: on a published course, in its draft's module and place, with its draft's name and text (B18). */
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
  /**
   * „Kustuta moodul“ can delete it: no lesson is in it, live or in the draft. A published course's live module whose lessons the draft moved
   * elsewhere shows no lesson, but still holds them until „Avalda muudatused“ (review M-1).
   */
  deletable: boolean;
  lessons: AdminLesson[];
};

/**
 * The course's modules, each with its lessons (hidden and unpublished ones too, with the flag) and their files (those removed with „Eemalda“ and
 * waiting for the UndoBar to run out are not listed), in order: five small queries. A published course's are in its working order, with the outline
 * draft's names and texts (B18: what „Avalda muudatused“ makes live; server/course-outline.ts); an unpublished course's are its rows.
 */
export async function listCourseLessons(db: Db, courseId: number): Promise<AdminModule[]> {
  const [[course], mods, rows, files, drafts] = await Promise.all([
    db.select({ id: courses.id, published: courses.published }).from(courses).where(eq(courses.id, courseId)),
    db
      .select({ id: courseModules.id, position: courseModules.position, title: courseModules.title, unpublished: courseModules.unpublished })
      .from(courseModules)
      .where(eq(courseModules.courseId, courseId))
      .orderBy(asc(courseModules.position), asc(courseModules.id)),
    db
      .select({
        id: lessons.id,
        moduleId: lessons.moduleId,
        position: lessons.position,
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
    readDrafts(db, "course", courseId),
  ]);
  if (!course) return [];
  const layout = layoutFor(course, { modules: mods, lessons: rows }, drafts);
  const row = new Map(rows.map((r) => [r.id, r]));
  return layout.map((m) => ({
    id: m.id,
    title: m.title,
    unpublished: m.flagged,
    deletable: m.lessons.length === 0 && !rows.some((r) => r.moduleId === m.id),
    lessons: m.lessons.map((l) => {
      const r = row.get(l.id)!;
      return {
        id: r.id,
        moduleId: m.id,
        title: l.title,
        body: storedBody(l.body),
        kind: r.kind,
        hidden: r.hidden,
        unpublished: r.unpublished,
        videoStatus: r.videoStatus,
        videoProgress: r.videoProgress,
        durationSec: r.durationSec,
        replacing: r.replacedVideoId !== null,
        inUse: Boolean(r.inUse),
        files: files.filter((f) => f.lessonId === r.id).map((f) => ({ id: f.id, name: f.name, size: f.size, contentType: f.contentType })),
      };
    }),
  }));
}

const notFound = (): EditResult => ({ ok: false, error: "notFound" });

/** The course a module belongs to, or null when there is no such module. */
async function courseOfModule(db: Db, moduleId: number): Promise<number | null> {
  const [row] = await db.select({ courseId: courseModules.courseId }).from(courseModules).where(eq(courseModules.id, moduleId));
  return row?.courseId ?? null;
}

type Work = { tx: Tx; course: Course; rows: OutlineRows; layout: Layout };

/**
 * A change of a course's modules and lessons in one transaction: the course's lock first (db/queries/admin.ts lockCourse; the lock order of
 * server/drafts.ts), then its rows and working order as they are under it (server/course-outline.ts readLayout). `gone` when there is no such course
 * (`courseId` null: the module or lesson was not found).
 */
async function underCourse<T>(db: Db, courseId: number | null, gone: () => T, work: (w: Work) => Promise<T>): Promise<T> {
  if (courseId === null) return gone();
  return db.transaction(async (tx): Promise<T> => {
    const course = await lockCourse(tx, courseId);
    if (!course) return gone();
    const { rows, layout } = await readLayout(tx, course);
    return work({ tx, course, rows, layout });
  });
}

/** The highest place in a list of rows (0 for none). */
const lastPlace = (rows: { position: number }[]): number => rows.reduce((n, r) => Math.max(n, r.position), 0);

/**
 * "Lisa moodul" / "Lisa punkt": fields courseId, titleEt, titleRu. The new module goes last. On a published course it is flagged `unpublished` (R-e):
 * its place is the last of the working order, and it is shown at „Avalda muudatused“.
 */
export async function addModuleForm(db: Db, fd: FormData): Promise<EditResult> {
  const courseId = idOf(field(fd, "courseId"));
  if (courseId === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  if (!c.ok || !title) return invalid(c.errors);
  return underCourse(db, courseId, notFound, async ({ tx, course, rows, layout }): Promise<EditResult> => {
    const position = course.published ? layout.length + 1 : lastPlace(rows.modules) + 1;
    const [row] = await tx.insert(courseModules).values({ courseId, position, title, unpublished: course.published }).returning();
    return { ok: true, id: row.id, created: true };
  });
}

/**
 * A module's "Salvesta": fields id, titleEt, titleRu. A published course's live module is renamed in the outline draft (the students and the public
 * page keep the old name until „Avalda muudatused“); a flagged module, and every module of an unpublished course, on its row.
 */
export async function renameModuleForm(db: Db, fd: FormData, admin: Who): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  if (!c.ok || !title) return invalid(c.errors);
  return underCourse(db, await courseOfModule(db, id), notFound, async ({ tx, course, rows, layout }): Promise<EditResult> => {
    const m = layout.find((x) => x.id === id);
    if (!m) return notFound();
    if (!course.published || m.flagged) await tx.update(courseModules).set({ title }).where(eq(courseModules.id, id));
    else {
      m.title = title;
      await storeLayout(tx, course, rows, layout, admin.email);
    }
    return { ok: true, id };
  });
}

/**
 * A module's ↑ / ↓: fields id, dir. One that cannot move stays (ok). An unpublished course's modules are numbered 1…n again; a published course's
 * new order is the outline draft's (a flagged module's own place is on its row).
 */
export async function moveModuleForm(db: Db, fd: FormData, admin: Who): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  const dir = field(fd, "dir");
  if (id === null || (dir !== "up" && dir !== "down")) return { ok: false, error: "invalid" };
  return underCourse(db, await courseOfModule(db, id), notFound, async ({ tx, course, rows, layout }): Promise<EditResult> => {
    const i = layout.findIndex((m) => m.id === id);
    if (i < 0) return notFound();
    const j = i + (dir === "up" ? -1 : 1);
    if (j < 0 || j >= layout.length) return { ok: true, id };
    [layout[i], layout[j]] = [layout[j], layout[i]];
    await storeLayout(tx, course, rows, layout, admin.email);
    return { ok: true, id };
  });
}

/**
 * "Kustuta moodul": field id. Refused (inUse) while it has lessons: rows of its own, or (a published course) a lesson the draft moved into it. At
 * once on a published course too (R-e: nothing depends on an empty module); a waiting outline draft goes on from the new live.
 */
export async function deleteModuleForm(db: Db, fd: FormData, admin: Who): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { ok: false, error: "invalid" };
  return underCourse(db, await courseOfModule(db, id), notFound, async ({ tx, course, rows, layout }): Promise<EditResult> => {
    const at = layout.findIndex((m) => m.id === id);
    if (at < 0) return notFound();
    if (rows.lessons.some((l) => l.moduleId === id) || layout[at].lessons.length > 0) return { ok: false, error: "inUse" };
    await tx.delete(courseModules).where(eq(courseModules.id, id));
    layout.splice(at, 1);
    await storeLayout(tx, course, { modules: rows.modules.filter((m) => m.id !== id), lessons: rows.lessons }, layout, admin.email, { deletedFrom: rows });
    return { ok: true, id, deleted: true };
  });
}

/**
 * "Lisa õppetund": fields moduleId, titleEt, titleRu. Last in its module; no video, no text, visible. Only an e-course has lessons: a module of a
 * contact course is notFound. On a published course it is flagged `unpublished` (R-e), last of its module in the working order.
 */
export async function addLessonForm(db: Db, fd: FormData): Promise<EditResult> {
  const moduleId = idOf(field(fd, "moduleId"));
  if (moduleId === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  if (!c.ok || !title) return invalid(c.errors);
  return underCourse(db, await courseOfModule(db, moduleId), notFound, async ({ tx, course, rows, layout }): Promise<EditResult> => {
    const m = layout.find((x) => x.id === moduleId);
    if (!m || course.type !== "e_learning") return notFound();
    const position = course.published ? m.lessons.length + 1 : lastPlace(rows.lessons.filter((l) => l.moduleId === moduleId)) + 1;
    const [row] = await tx.insert(lessons).values({ moduleId, position, title, unpublished: course.published }).returning();
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

/**
 * The lesson drawer's "Salvesta": fields id, titleEt, titleRu, bodyEt, bodyRu (the short text; blank is none). A published course's live lesson
 * keeps its name and text for the students until „Avalda muudatused“ (the outline draft has the new ones); a flagged lesson, and every lesson of
 * an unpublished course, is written on its row.
 */
export async function saveLessonForm(db: Db, fd: FormData, admin: Who): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { ok: false, error: "invalid" };
  const c = new Check();
  const title = c.text("title", i18nOf(fd, "title"), LESSON_LIMITS.title, { required: true });
  const body = c.text("body", i18nOf(fd, "body"), LESSON_LIMITS.body);
  if (!c.ok || !title) return invalid(c.errors);
  return underCourse(db, await courseOfLesson(db, id), notFound, async ({ tx, course, rows, layout }): Promise<EditResult> => {
    const l = layout.flatMap((m) => m.lessons).find((x) => x.id === id);
    if (!l) return notFound();
    if (!course.published || l.flagged) await tx.update(lessons).set({ title, body }).where(eq(lessons.id, id));
    else {
      l.title = title;
      l.body = body ?? { et: "" };
      await storeLayout(tx, course, rows, layout, admin.email);
    }
    return { ok: true, id };
  });
}

/**
 * A lesson's ↑ / ↓ (domain/lessons.ts moveLesson: across modules at a module's edge, an empty or a flagged one too): fields id, dir. An unpublished
 * course's moved rows are written; a published course's new order is the outline draft's (a live lesson moved into a flagged module stays in its
 * live module until „Avalda muudatused“, Task 2 review), and a flagged lesson's own place is on its row.
 */
export async function moveLessonForm(db: Db, fd: FormData, admin: Who): Promise<EditResult> {
  const id = idOf(field(fd, "id"));
  const dir = field(fd, "dir");
  if (id === null || (dir !== "up" && dir !== "down")) return { ok: false, error: "invalid" };
  return underCourse(db, await courseOfLesson(db, id), notFound, async ({ tx, course, rows, layout }): Promise<EditResult> => {
    const plan: ModuleLayout[] = layout.map((m) => ({ moduleId: m.id, lessonIds: m.lessons.map((l) => l.id) }));
    if (!plan.some((m) => m.lessonIds.includes(id))) return notFound();
    const moved = moveLesson(plan, id, dir === "up" ? -1 : 1);
    if (!moved) return { ok: true, id };
    const lesson = new Map(layout.flatMap((m) => m.lessons).map((l) => [l.id, l]));
    const next: Layout = layout.map((m, i) => ({ ...m, lessons: moved[i].lessonIds.map((x) => lesson.get(x)!) }));
    await storeLayout(tx, course, rows, next, admin.email);
    return { ok: true, id };
  });
}

// ---------- a row's text autosave (Task 5 review I-1; R-b amended: the "t:" version) ----------

/** The rows whose text the editor autosaves on its own: a module (its name) and a lesson (its name and short text). */
export type OutlineTextKind = "module" | "lesson";
/** A row's working text: a module's `{ title }`, a lesson's `{ title, body }` (a short text of none: `{ et: "" }`). */
type RowText = { title: I18n; body?: I18n };

const TEXT_FIELDS: Record<OutlineTextKind, readonly string[]> = { module: ["title"], lesson: ["title", "body"] };

/** A row in the working order: its text (the outline draft's on a published course, the row's otherwise) and whether it is flagged; null: none. */
function rowTextIn(layout: Layout, kind: OutlineTextKind, id: number): { text: RowText; flagged: boolean; set(t: RowText): void } | null {
  if (kind === "module") {
    const m = layout.find((x) => x.id === id);
    return m ? { text: { title: m.title }, flagged: m.flagged, set: (t) => void (m.title = t.title) } : null;
  }
  const l = layout.flatMap((m) => m.lessons).find((x) => x.id === id);
  return l ? { text: { title: l.title, body: l.body }, flagged: l.flagged, set: (t) => void Object.assign(l, { title: t.title, body: t.body ?? { et: "" } }) } : null;
}

/** A row's text version (R-b, amended after the Task 5 review): "t:" and lib/version.ts contentVersion of its working text. A move changes none. */
const textVersion = async (t: RowText): Promise<string> => `t:${await contentVersion(t)}`;

const courseOfRow = (db: Db, kind: OutlineTextKind, id: number) => (kind === "module" ? courseOfModule(db, id) : courseOfLesson(db, id));

/** Is there such a module or lesson (the text routes' 404)? */
export async function outlineTextExists(db: Db, kind: OutlineTextKind, id: number): Promise<boolean> {
  return (await courseOfRow(db, kind, id)) !== null;
}

/**
 * A row's text as its autosave reads it (the editor's version and value): a published course's live row with its outline draft's text, a flagged
 * row and an unpublished course's with the row's own. Null when there is no such module or lesson.
 */
export async function readOutlineText(db: Db, kind: OutlineTextKind, id: number): Promise<{ version: string; value: RowText } | null> {
  const courseId = await courseOfRow(db, kind, id);
  if (courseId === null) return null;
  const [course] = await db.select({ id: courses.id, published: courses.published }).from(courses).where(eq(courses.id, courseId));
  if (!course) return null;
  const found = rowTextIn((await readLayout(db, course)).layout, kind, id);
  return found ? { version: await textVersion(found.text), value: found.text } : null;
}

/**
 * A row's text save (the routes api/admin/moodul/<id> and api/admin/oppetund/<id>, server/autosave-route.ts' contract): `patch` (some of the row's
 * fields: `title`, a lesson's `body` too) over its working text at `version` ("t:<hash>"), under the course's lock. The answers:
 * - ok with the row's version after it (a save that changes nothing: the version it came from, nothing written);
 * - a conflict with the row's version and text when `version` is not the row's (another tab saved it first); the row deleted meanwhile: version
 *   "", value null;
 * - invalid with `title` / `body` and the forms' codes (a name needed, at most 120 characters; a short text at most 5000).
 * A published course's live row: into the outline draft, as typed (students keep the old text until „Avalda muudatused“; its labels and the
 * publish's check are the outline's). A flagged row, and every row of an unpublished course: on the row itself, trimmed as the forms store it.
 * `o.live` is called after the commit when a module's name went live on its row (an unpublished course's module: the public pages show module
 * names; a flagged row and a lesson are on none). Moves and deletes are no text: they stay the card's actions, and change no row's version.
 */
export async function writeOutlineText(
  db: Db,
  kind: OutlineTextKind,
  id: number,
  patch: Record<string, unknown>,
  version: string,
  admin: Who,
  now: Date,
  o: { live?: () => void } = {},
): Promise<SaveAnswer> {
  const savedAt = now.toISOString();
  const gone = (): { answer: SaveAnswer; live: boolean } => ({ answer: { ok: false, error: "conflict", version: "", value: null }, live: false });
  const parsed = OUTLINE_TEXT_PATCHES[kind].safeParse(Object.fromEntries(Object.entries(patch).filter(([k]) => TEXT_FIELDS[kind].includes(k))));
  if (!parsed.success) return { ok: false, error: "invalid", fields: fieldCodes(parsed.error.issues) ?? Object.fromEntries(TEXT_FIELDS[kind].map((f) => [f, "invalid"])) };
  const own: Partial<RowText> = parsed.data;
  const { answer, live } = await underCourse(db, await courseOfRow(db, kind, id), gone, async ({ tx, course, rows, layout }): Promise<{ answer: SaveAnswer; live: boolean }> => {
    const found = rowTextIn(layout, kind, id);
    if (!found) return gone();
    const current = await textVersion(found.text);
    if (version !== current) return { answer: { ok: false, error: "conflict", version: current, value: found.text }, live: false };
    const next: RowText = { ...found.text, ...own };
    if (stableJson(next) === stableJson(found.text)) return { answer: { ok: true, version: current, savedAt }, live: false };
    const c = new Check();
    const title = c.text("title", next.title, LESSON_LIMITS.title, { required: true });
    const body = next.body ? c.text("body", next.body, LESSON_LIMITS.body) : null;
    if (!c.ok || !title) return { answer: { ok: false, error: "invalid", fields: c.errors }, live: false };
    if (course.published && !found.flagged) {
      found.set(next);
      await storeLayout(tx, course, rows, layout, admin.email);
      return { answer: { ok: true, version: await textVersion(next), savedAt }, live: false };
    }
    if (kind === "module") await tx.update(courseModules).set({ title }).where(eq(courseModules.id, id));
    else await tx.update(lessons).set({ title, body }).where(eq(lessons.id, id));
    const stored: RowText = kind === "module" ? { title } : { title, body: body ?? { et: "" } };
    return { answer: { ok: true, version: await textVersion(stored), savedAt }, live: kind === "module" && !course.published && !found.flagged };
  });
  if (live) o.live?.();
  return answer;
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
 * (cascade); `cleanup` names its videos and files for removeLessonMedia. At once on a published course too (R-e: nothing depends on a lesson
 * without progress); a waiting outline draft goes on from the new live, without the lesson.
 */
export async function deleteLessonForm(db: Db, fd: FormData, admin: Who): Promise<{ result: EditResult; cleanup: LessonCleanup }> {
  const id = idOf(field(fd, "id"));
  if (id === null) return { result: { ok: false, error: "invalid" }, cleanup: NOTHING };
  const gone = () => ({ result: notFound(), cleanup: NOTHING });
  return underCourse(db, await courseOfLesson(db, id), gone, async ({ tx, course, rows, layout }): Promise<{ result: EditResult; cleanup: LessonCleanup }> => {
    // (the row's lock as well: a student's first progress row on it waits, so none is written between the check and the delete)
    const [row] = await tx.select({ videoId: lessons.videoId, replacedVideoId: lessons.replacedVideoId }).from(lessons).where(eq(lessons.id, id)).for("update");
    if (!row) return gone();
    const [{ n }] = await tx.select({ n: count() }).from(lessonProgress).where(and(eq(lessonProgress.lessonId, id), HAS_PROGRESS));
    if (Number(n) > 0) return { result: { ok: false, error: "inUse" }, cleanup: NOTHING };
    // (every file row, the removed ones too — piece 3a, R-f: they still hold an R2 object until they are purged, and the cascade takes the rows)
    const files = await tx.select({ key: lessonFiles.r2Key }).from(lessonFiles).where(eq(lessonFiles.lessonId, id)).orderBy(asc(lessonFiles.position), asc(lessonFiles.id));
    await tx.delete(lessons).where(eq(lessons.id, id));
    const next: Layout = layout.map((m) => ({ ...m, lessons: m.lessons.filter((l) => l.id !== id) }));
    await storeLayout(tx, course, { modules: rows.modules, lessons: rows.lessons.filter((l) => l.id !== id) }, next, admin.email, { deletedFrom: rows });
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
