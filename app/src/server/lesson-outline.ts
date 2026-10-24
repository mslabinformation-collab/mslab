import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { courseModules, courses, lessonProgress, lessons } from "@/db/schema";
import type { EcourseProgress } from "@/domain/account-cards";
import { courseProgress, lessonStates, type CourseProgress, type LessonState, type OrderedLesson } from "@/domain/lessons";
import type { I18n } from "@/i18n/field";
import { readLayout } from "./course-outline";

// One student's view of a course's lessons: the modules in order (empty ones too), the visible lessons in course order with their
// state (domain/lessons.ts: done, current, locked), and the counts. Read by the e-course page (client-data.ts loadEcourse), the lesson
// endpoints (lesson-data.ts) and the admin's student drawer (admin-clients.ts). Two queries; no access check here (callers make it).
// "Visible" leaves out a hidden lesson and, on a published course being edited (admin UX pass piece 3a, R-e), every `unpublished` module and
// lesson — a lesson of an unpublished module too, whatever its own flag: they are neither listed, nor counted, nor in the order, so the completion
// counts, "view as student" and the lesson order all see the course as the students have it until „Avalda muudatused“.
// Only the admin's preview (`preview`: never a student's read) lays the course's draft over it: the outline draft's order and names and the
// flagged rows, as „Avalda muudatused“ would make them (server/course-outline.ts). Nothing calls it yet: the draft preview of the public pages (Task 6)
// needs only the module titles of the working order (server/course-parts.ts previewModuleTitles), as no public page lists lessons.

export type OutlineLesson = { id: number; moduleId: number; title: I18n; state: LessonState };
export type OutlineModule = { id: number; title: I18n; lessons: OutlineLesson[] };
export type CourseOutline = { modules: OutlineModule[]; lessons: OutlineLesson[]; progress: CourseProgress };

/** The admin's preview of `courseOutline`: the course's working order (its draft and its flagged rows), the hidden lessons left out, her progress. */
async function previewOutline(db: Db, courseId: number, clientId: number): Promise<CourseOutline> {
  const [course] = await db.select({ id: courses.id, published: courses.published }).from(courses).where(eq(courses.id, courseId));
  if (!course) return { modules: [], lessons: [], progress: courseProgress([]) };
  const { rows, layout } = await readLayout(db, course);
  const hidden = new Set(rows.lessons.filter((l) => l.hidden).map((l) => l.id));
  const shown = layout.flatMap((m) => m.lessons.filter((l) => !hidden.has(l.id)).map((l) => ({ id: l.id, moduleId: m.id, title: l.title })));
  const progress = shown.length
    ? await db
        .select({ lessonId: lessonProgress.lessonId, done: sql<boolean>`${lessonProgress.doneAt} is not null`, unlocked: sql<boolean>`${lessonProgress.unlockedBy} is not null` })
        .from(lessonProgress)
        .where(and(eq(lessonProgress.clientId, clientId), inArray(lessonProgress.lessonId, shown.map((l) => l.id))))
    : [];
  const mine = new Map(progress.map((p) => [p.lessonId, p]));
  const ordered: OrderedLesson[] = shown.map((l) => ({ id: l.id, done: Boolean(mine.get(l.id)?.done), unlockedByAdmin: Boolean(mine.get(l.id)?.unlocked) }));
  const states = lessonStates(ordered);
  const list: OutlineLesson[] = shown.map((l, i) => ({ ...l, state: states[i] }));
  return {
    modules: layout.map((m) => ({ id: m.id, title: m.title, lessons: list.filter((l) => l.moduleId === m.id) })),
    lessons: list,
    progress: courseProgress(ordered),
  };
}

export async function courseOutline(db: Db, courseId: number, clientId: number, opts: { preview?: boolean } = {}): Promise<CourseOutline> {
  if (opts.preview) return previewOutline(db, courseId, clientId);
  const [mods, rows] = await Promise.all([
    db
      .select({ id: courseModules.id, title: courseModules.title })
      .from(courseModules)
      .where(and(eq(courseModules.courseId, courseId), eq(courseModules.unpublished, false)))
      .orderBy(asc(courseModules.position), asc(courseModules.id)),
    db
      .select({
        id: lessons.id,
        moduleId: lessons.moduleId,
        title: lessons.title,
        done: sql<boolean>`${lessonProgress.doneAt} is not null`,
        unlocked: sql<boolean>`${lessonProgress.unlockedBy} is not null`,
      })
      .from(lessons)
      .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
      .leftJoin(lessonProgress, and(eq(lessonProgress.lessonId, lessons.id), eq(lessonProgress.clientId, clientId)))
      .where(and(eq(courseModules.courseId, courseId), eq(courseModules.unpublished, false), eq(lessons.hidden, false), eq(lessons.unpublished, false)))
      .orderBy(asc(courseModules.position), asc(courseModules.id), asc(lessons.position), asc(lessons.id)),
  ]);
  const ordered: OrderedLesson[] = rows.map((r) => ({ id: r.id, done: Boolean(r.done), unlockedByAdmin: Boolean(r.unlocked) }));
  const states = lessonStates(ordered);
  const list: OutlineLesson[] = rows.map((r, i) => ({ id: r.id, moduleId: r.moduleId, title: r.title, state: states[i] }));
  return {
    modules: mods.map((m) => ({ id: m.id, title: m.title, lessons: list.filter((l) => l.moduleId === m.id) })),
    lessons: list,
    progress: courseProgress(ordered),
  };
}

/** One e-course's lessons for the dashboard (phase 2c): done of total and the next lesson with its module's title; null without visible lessons. */
export function ecourseProgress(outline: CourseOutline): EcourseProgress | null {
  const { done, total, next } = outline.progress;
  if (total === 0) return null;
  const lesson = next === null ? undefined : outline.lessons.find((l) => l.id === next);
  const owner = lesson ? outline.modules.find((m) => m.id === lesson.moduleId) : undefined;
  return { done, total, next: lesson && owner ? { lessonId: lesson.id, title: lesson.title, moduleTitle: owner.title } : null };
}

/**
 * When she last did anything in each course's lessons (phase 2c, the "Pooleli" card): course id → the latest write of her progress
 * rows (a lesson opened, watched, marked done, or opened for her by an admin). One query.
 */
export async function progressActivity(db: Db, clientId: number): Promise<Map<number, Date>> {
  const rows = await db
    .select({ courseId: courseModules.courseId, at: max(lessonProgress.updatedAt) })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(courseModules, eq(courseModules.id, lessons.moduleId))
    .where(eq(lessonProgress.clientId, clientId))
    .groupBy(courseModules.courseId);
  return new Map(rows.flatMap((r) => (r.at ? [[r.courseId, r.at] as const] : [])));
}
