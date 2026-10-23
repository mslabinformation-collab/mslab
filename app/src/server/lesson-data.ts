import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clients, courseModules, lessonFiles, lessonProgress, lessons } from "@/db/schema";
import { acceptProgress, completion, isWatched, nextLessonAfter, openedClock, playableVideo, resumeAt, validShape, type VideoShape } from "@/domain/lessons";
import type { I18n } from "@/i18n/field";
import { EMBED_TTL_SEC, signedEmbedUrl, type BunnyConfig } from "./bunny";
import { activeAccess, termsState } from "./client-data";
import { completeIfDone } from "./completion";
import { courseOutline, type CourseOutline } from "./lesson-outline";
import { logFailure } from "./log";

// The lesson endpoints' work (spec 3a sections 5 and 6), for account-api.ts: one lesson, progress, "Märgi tehtuks", a file. The
// client is always the session's. Each starts with openLesson, the one place of the checks' binding order: active access to the
// course (none: notFound) → a visible lesson of that course (else notFound) → (the lesson page only) the terms accepted → the lesson
// order (locked).
// How a lesson is completed follows its kind (domain/lessons.ts completion): a text lesson by "Märgi tehtuks", a video lesson only
// by watching 90 % of a playable video — a video lesson waiting for its video cannot be completed, so the next one stays locked.
// Opening a video lesson starts its progress clock, and a report can raise the watched seconds only as far as the clock allows
// (spec 2c section 3).
// A lesson done just now may be the course's last step (e-course completion, spec §4.4): completion.ts completeIfDone runs after the write. No
// transaction here: its UPDATE … where completed_at is null sets the date once, and of two lessons marked at once the later read sees both done.
// A check that fails never fails the lesson that was saved (completeAfterLesson); the student's next page load completes the course
// (client-data.ts loadEcourse).

export type LessonVideo =
  /** `shape`: the picture size in pixels of the video that plays (the player's frame takes its shape); null: unknown, the player assumes 16:9. */
  | { state: "ready"; embedUrl: string; expires: number; resumeAt: number; durationSec: number; shape: VideoShape | null }
  | { state: "soon" };
export type LessonView = {
  course: { slug: string; title: I18n };
  module: { title: I18n };
  /** `textOnly`: a text lesson (kind "text"), done with "Märgi tehtuks". */
  lesson: { id: number; title: I18n; body: I18n | null; done: boolean; textOnly: boolean };
  /** null: a text lesson; "soon": a video lesson whose video is not ready yet, or Bunny not set up ("Video lisandub peagi"). */
  video: LessonVideo | null;
  files: { id: number; name: string; size: number }[];
  /** The next visible lesson ("Järgmine õppetund", open once this one is done); null after the last. */
  next: number | null;
  /** The student's e-mail, for the watermark over the video. */
  watermark: string;
};
/** Why a lesson cannot be opened: not this client's (no access, no such visible lesson), terms to accept (asked for), not open yet. */
export type LessonRefusal = { kind: "notFound" } | { kind: "terms" } | { kind: "locked"; next: number | null };
export type LessonResult = { kind: "lesson"; view: LessonView } | LessonRefusal;
/**
 * `terms` never comes back here: only the lesson page asks openLesson for the terms check. `completed`: this write made the lesson done and
 * that finished the course (completion.ts completeIfDone set completed_at now; the handler queues the "completed" mail by `accessId`).
 */
export type ProgressResult = { kind: "saved"; done: boolean; next: number | null; completed: boolean; accessId: number } | { kind: "video" } | { kind: "range" } | LessonRefusal;
export type DoneResult = { kind: "saved"; next: number | null; completed: boolean; accessId: number } | { kind: "video" } | LessonRefusal;
export type LessonFileRef = { kind: "file"; key: string; name: string; contentType: string };

/**
 * A visible lesson of the course, with its module's title and this client's progress; null when it is not one (hidden, unpublished or in an
 * unpublished module — piece 3a, R-e —, unknown, or a lesson of another course). Exported for its own test only: the endpoints reach it
 * through openLesson.
 */
export async function visibleLesson(db: Db, courseId: number, clientId: number, lessonId: number) {
  const [row] = await db
    .select({
      id: lessons.id,
      title: lessons.title,
      body: lessons.body,
      kind: lessons.kind,
      moduleTitle: courseModules.title,
      videoId: lessons.videoId,
      videoStatus: lessons.videoStatus,
      replacedVideoId: lessons.replacedVideoId,
      durationSec: lessons.durationSec,
      videoWidth: lessons.videoWidth,
      videoHeight: lessons.videoHeight,
      watchedSec: sql<number>`coalesce(${lessonProgress.watchedSec}, 0)`.mapWith(Number),
      done: sql<boolean>`${lessonProgress.doneAt} is not null`,
      clockAt: lessonProgress.clockAt,
    })
    .from(lessons)
    .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
    .leftJoin(lessonProgress, and(eq(lessonProgress.lessonId, lessons.id), eq(lessonProgress.clientId, clientId)))
    .where(and(eq(lessons.id, lessonId), eq(courseModules.courseId, courseId), eq(lessons.hidden, false), eq(lessons.unpublished, false), eq(courseModules.unpublished, false)))
    .limit(1);
  return row ? { ...row, done: Boolean(row.done) } : null;
}

export type LessonRow = NonNullable<Awaited<ReturnType<typeof visibleLesson>>>;
type Access = NonNullable<Awaited<ReturnType<typeof activeAccess>>>;
export type OpenedLesson = { kind: "open"; access: Access; row: LessonRow; outline: CourseOutline };

/**
 * The checks of every lesson endpoint, in the binding order (Global Constraints; spec 6), in this one place: active access to the course
 * → a visible lesson of that course → with `terms: true` (the lesson page only) the course's terms accepted → the lesson order. Answers
 * the course access, the lesson row and the client's outline of the course, or the refusal.
 */
export async function openLesson(db: Db, clientId: number, slug: string, lessonId: number, now: Date, opts: { terms?: boolean } = {}): Promise<OpenedLesson | LessonRefusal> {
  const access = await activeAccess(db, clientId, slug, now);
  if (!access) return { kind: "notFound" };
  const [row, outline, terms] = await Promise.all([
    visibleLesson(db, access.course.id, clientId, lessonId),
    courseOutline(db, access.course.id, clientId),
    opts.terms ? termsState(db, clientId, access.course.id) : null,
  ]);
  // A lesson that is not in this course's outline is not this course's, whatever visibleLesson found: never "open" for lack of a state.
  const state = outline.lessons.find((l) => l.id === lessonId)?.state;
  if (!row || !state) return { kind: "notFound" };
  if (terms && !terms.accepted) return { kind: "terms" };
  if (state === "locked") return { kind: "locked", next: outline.progress.next };
  return { kind: "open", access, row, outline };
}

/**
 * The video part of a lesson: null for a text lesson; ready with a URL signed for 4 hours (from the resume point) and the picture
 * size of the video that plays (`shape`, null when unknown); else soon. The shape is stored with the playing video (a replacement
 * in progress leaves it), and is checked again here, so a bad stored value reaches the player as null.
 */
async function videoOf(row: LessonRow, bunny: BunnyConfig | null, now: Date): Promise<LessonVideo | null> {
  if (row.kind === "text") return null;
  const videoId = playableVideo(row);
  if (!videoId || !bunny || !row.durationSec) return { state: "soon" };
  const expires = Math.floor(now.getTime() / 1000) + EMBED_TTL_SEC;
  const start = resumeAt(row.watchedSec, row.durationSec, row.done);
  return {
    state: "ready",
    embedUrl: await signedEmbedUrl(bunny, videoId, expires, start),
    expires,
    resumeAt: start,
    durationSec: row.durationSec,
    shape: validShape(row.videoWidth !== null && row.videoHeight !== null ? { width: row.videoWidth, height: row.videoHeight } : null),
  };
}

/**
 * Opening a video lesson whose video plays starts its progress clock (domain/lessons.ts openedClock); the row is made when there is
 * none, its seconds stay. The clock only ever moves forward in SQL (`greatest`, as the seconds do): a report kept since this page read
 * the row may have moved it on, and the older value written here must not take it back.
 */
async function startClock(db: Db, clientId: number, row: LessonRow, now: Date): Promise<void> {
  const clockAt = openedClock(row.clockAt, now);
  await db
    .insert(lessonProgress)
    .values({ clientId, lessonId: row.id, clockAt, updatedAt: now })
    .onConflictDoUpdate({
      target: [lessonProgress.clientId, lessonProgress.lessonId],
      set: { clockAt: sql`greatest(${lessonProgress.clockAt}, excluded.clock_at)`, updatedAt: now },
    });
}

/**
 * completeIfDone after a lesson write. The lesson is saved already: a check that throws is logged by the access's id (never the error's
 * message) and answered as "not completed", so the student's saved lesson is not turned into a 500; the page load completes the course later.
 */
async function completeAfterLesson(db: Db, accessId: number, now: Date): Promise<boolean> {
  try {
    return await completeIfDone(db, accessId, now);
  } catch (e) {
    logFailure(`[completion] access ${accessId}: the check failed`, e);
    return false;
  }
}

/** GET a lesson (spec 6): the only endpoint with the terms check. */
export async function loadLesson(db: Db, bunny: BunnyConfig | null, clientId: number, slug: string, lessonId: number, now: Date): Promise<LessonResult> {
  const opened = await openLesson(db, clientId, slug, lessonId, now, { terms: true });
  if (opened.kind !== "open") return opened;
  const { access, row, outline } = opened;
  const [files, [client]] = await Promise.all([
    // (a file the admin removed — „Eemalda“, the UndoBar may still be open — is not listed: removed_at is null)
    db.select({ id: lessonFiles.id, name: lessonFiles.name, size: lessonFiles.size }).from(lessonFiles).where(and(eq(lessonFiles.lessonId, lessonId), isNull(lessonFiles.removedAt))).orderBy(asc(lessonFiles.position), asc(lessonFiles.id)),
    db.select({ email: clients.email }).from(clients).where(eq(clients.id, clientId)).limit(1),
  ]);
  if (!client) return { kind: "notFound" };
  const video = await videoOf(row, bunny, now);
  if (video?.state === "ready") await startClock(db, clientId, row, now);
  return {
    kind: "lesson",
    view: {
      course: { slug: access.course.slug, title: access.course.title },
      module: { title: row.moduleTitle },
      lesson: { id: row.id, title: row.title, body: row.body, done: row.done, textOnly: row.kind === "text" },
      video,
      files,
      next: nextLessonAfter(outline.lessons, lessonId),
      watermark: client.email,
    },
  };
}

/**
 * POST progress: the reported second clamped by the progress clock (domain/lessons.ts acceptProgress: at most twice the time since the
 * lesson was opened plus 30 s, a report past it is kept at that), kept at its highest (one upsert), done once what is kept reaches 90 %
 * of the length. A video lesson with a playable video only ("watch"): a text lesson, and a video lesson still waiting for its video,
 * are "video" (409). Two reports at the same moment read the same row: the clock, like the seconds, only ever moves forward in SQL
 * (`greatest`), so the one that writes last cannot take it back, and together they keep what the larger of the two raises allows.
 */
export async function saveProgress(db: Db, clientId: number, slug: string, lessonId: number, watchedSec: number, now: Date): Promise<ProgressResult> {
  const opened = await openLesson(db, clientId, slug, lessonId, now);
  if (opened.kind !== "open") return opened;
  const { access, row, outline } = opened;
  if (completion(row) !== "watch" || row.durationSec === null) return { kind: "video" };
  if (watchedSec > row.durationSec + 5) return { kind: "range" };
  const kept = acceptProgress({ watchedSec: row.watchedSec, clockAt: row.clockAt }, watchedSec, now);
  const [saved] = await db
    .insert(lessonProgress)
    .values({ clientId, lessonId, watchedSec: kept.watchedSec, clockAt: kept.clockAt, doneAt: isWatched(kept.watchedSec, row.durationSec) ? now : null, updatedAt: now })
    .onConflictDoUpdate({
      target: [lessonProgress.clientId, lessonProgress.lessonId],
      set: {
        watchedSec: sql`greatest(${lessonProgress.watchedSec}, excluded.watched_sec)`,
        clockAt: sql`greatest(${lessonProgress.clockAt}, excluded.clock_at)`,
        doneAt: sql`coalesce(${lessonProgress.doneAt}, excluded.done_at)`,
        updatedAt: now,
      },
    })
    .returning(); // (returning(fields) has no common overload on the Db union: the whole row)
  const done = saved.doneAt !== null;
  // done by this report (it was not when the lesson was read): maybe the course's last step
  const completed = done && !row.done ? await completeAfterLesson(db, access.id, now) : false;
  return { kind: "saved", done, next: nextLessonAfter(outline.lessons, lessonId), completed, accessId: access.id };
}

/**
 * POST tehtud ("Märgi tehtuks"): a text lesson (kind "text") only — any video lesson is "video" (409); done once (a second time changes nothing,
 * and completes nothing).
 */
export async function markTextLessonDone(db: Db, clientId: number, slug: string, lessonId: number, now: Date): Promise<DoneResult> {
  const opened = await openLesson(db, clientId, slug, lessonId, now);
  if (opened.kind !== "open") return opened;
  const { access, row, outline } = opened;
  if (completion(row) !== "mark") return { kind: "video" };
  await db
    .insert(lessonProgress)
    .values({ clientId, lessonId, doneAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [lessonProgress.clientId, lessonProgress.lessonId], set: { doneAt: sql`coalesce(${lessonProgress.doneAt}, excluded.done_at)`, updatedAt: now } });
  const completed = row.done ? false : await completeAfterLesson(db, access.id, now);
  return { kind: "saved", next: nextLessonAfter(outline.lessons, lessonId), completed, accessId: access.id };
}

/** GET a file: the store key, name and type of a file of an open lesson (a file of another lesson, or a removed one, is notFound); locked before the lesson opens. */
export async function lessonFileFor(db: Db, clientId: number, slug: string, lessonId: number, fileId: number, now: Date): Promise<LessonFileRef | LessonRefusal> {
  const opened = await openLesson(db, clientId, slug, lessonId, now);
  if (opened.kind !== "open") return opened;
  const [file] = await db
    .select({ key: lessonFiles.r2Key, name: lessonFiles.name, contentType: lessonFiles.contentType })
    .from(lessonFiles)
    .where(and(eq(lessonFiles.id, fileId), eq(lessonFiles.lessonId, lessonId), isNull(lessonFiles.removedAt)))
    .limit(1);
  return file ? { kind: "file", ...file } : { kind: "notFound" };
}
