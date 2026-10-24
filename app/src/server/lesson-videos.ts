import { and, asc, eq, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { courseModules, courses, lessons, type VideoStatus } from "@/db/schema";
import { abandonUpload, settleVideo, startUpload, type VideoFields } from "@/domain/lessons";
import { pick } from "@/i18n/field";
import { lessonVideoStatus, tusSignature, UPLOAD_TTL_SEC, type BunnyApi, type BunnyConfig, type BunnyVideo } from "./bunny";
import { deleteBunnyVideos } from "./lesson-media";
import { logFailure } from "./log";

// A lesson's Bunny video (spec 3a sections 4 and 7): the start of an upload (createLessonVideo), the status read (the editor's poll:
// every 5 s, then every 30 s after 10 minutes, paused while the tab is hidden; and Bunny's webhook, which is only a trigger), and the
// daily sweep of uploads and processing left unfinished. What changes is decided
// by domain/lessons.ts startUpload / settleVideo / abandonUpload; here are the database rows and the Bunny calls.
//
// The poll and the webhook can ask about the same video at the same moment, and Bunny takes up to 10 s to answer. So a status is
// written only by compare-and-set: the UPDATE names the video columns as they were read before Bunny was asked, and changes nothing
// if another write came first (a newer status, a new upload, the switch to Tekst). Only the write that wins deletes a replaced
// video. An answer that changes nothing (a repeated webhook, the next poll) writes nothing.

export type UploadTicket = { videoId: string; libraryId: string; expires: number; signature: string; endpoint: string; title: string };
/**
 * A lesson's video as the admin's drawer shows it. `progress`: Bunny's encode progress in percent (0…100) while the video is "processing" (R-g, S6),
 * null when Bunny gave none and in every other state; the screens read null and 0 alike („Töötlemisel“ without a number, S3-P3-e).
 */
export type AdminVideo = { status: VideoStatus; durationSec: number | null; replacing: boolean; progress: number | null };
export type VideoTicketResult = { ok: true; ticket: UploadTicket } | { ok: false; error: "setup" | "notFound" | "server" };
export type VideoCheckResult = { ok: true; video: AdminVideo } | { ok: false; error: "setup" | "notFound" | "server" };

/** An upload (or processing) this old is given up by the daily sweep (spec 7). */
const STUCK_MS = 24 * 3600_000;
/**
 * The most rows of each kind one sweep takes: the cron is one invocation a day (Vercel Hobby) with a time limit, and every row
 * costs one or two Bunny calls of up to 10 s each. What is left waits for the next day.
 */
export const SWEEP_BATCH = 20;

const VIDEO_COLUMNS = {
  videoId: lessons.videoId,
  videoStatus: lessons.videoStatus,
  replacedVideoId: lessons.replacedVideoId,
  durationSec: lessons.durationSec,
  videoWidth: lessons.videoWidth,
  videoHeight: lessons.videoHeight,
  videoProgress: lessons.videoProgress,
};
/** The video columns as read, with the figure (lessons.video_progress: Bunny's encode progress, written only while it processes). */
type VideoState = VideoFields & { videoProgress: number | null };
const adminVideo = (v: VideoState): AdminVideo => ({
  status: v.videoStatus,
  durationSec: v.durationSec,
  replacing: v.replacedVideoId !== null,
  progress: v.videoStatus === "processing" ? v.videoProgress : null, // (a figure left in any other state is none)
});
const sameVideo = (a: VideoFields, b: VideoFields) =>
  a.videoId === b.videoId &&
  a.videoStatus === b.videoStatus &&
  a.replacedVideoId === b.replacedVideoId &&
  a.durationSec === b.durationSec &&
  a.videoWidth === b.videoWidth &&
  a.videoHeight === b.videoHeight;
const nullable = (column: typeof lessons.videoId | typeof lessons.replacedVideoId, value: string | null): SQL => (value === null ? isNull(column) : eq(column, value));
/** The row still has the video columns it was read with (the compare of compare-and-set). */
const unchangedSince = (id: number, v: VideoFields): SQL =>
  and(eq(lessons.id, id), nullable(lessons.videoId, v.videoId), eq(lessons.videoStatus, v.videoStatus), nullable(lessons.replacedVideoId, v.replacedVideoId))!;

/**
 * A new Bunny video for the lesson (titled "<course> · <lesson>") and the signed tus upload of it, valid for 6 hours; the API key
 * stays here. The lesson becomes "uploading"; a ready video keeps playing as the replaced one; an unfinished or failed earlier
 * upload is deleted from Bunny. "notFound" for an unknown lesson or a text lesson (no Bunny video is made).
 */
export async function startLessonVideo(db: Db, api: BunnyApi, config: BunnyConfig, lessonId: number, now: Date): Promise<UploadTicket | "notFound"> {
  const [lesson] = await db
    .select({ title: lessons.title, kind: lessons.kind, course: courses.title })
    .from(lessons)
    .innerJoin(courseModules, eq(lessons.moduleId, courseModules.id))
    .innerJoin(courses, eq(courseModules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .limit(1);
  if (!lesson || lesson.kind !== "video") return "notFound"; // a text lesson has no video field
  const title = `${pick(lesson.course, "et")} · ${pick(lesson.title, "et")}`.slice(0, 200);
  const videoId = await api.createVideo(title);
  let obsolete: string[] | null;
  try {
    // the row is locked from the read to the write: two starts at once (a second tab) each give up the other's upload, in turn
    obsolete = await db.transaction(async (tx) => {
      const [current] = await tx.select(VIDEO_COLUMNS).from(lessons).where(and(eq(lessons.id, lessonId), eq(lessons.kind, "video"))).for("update");
      if (!current) return null;
      const change = startUpload(current, videoId);
      // (the figure of an encode before this upload is none of the new one's: cleared, whatever `change.next` carried over from the row)
      const written = await tx.update(lessons).set({ ...change.next, videoStartedAt: now, videoProgress: null }).where(unchangedSince(lessonId, current)).returning();
      return written.length ? change.obsolete : null;
    });
  } catch (e) {
    await deleteBunnyVideos(api, [videoId]); // not stored: the new video would be nobody's
    throw e;
  }
  if (obsolete === null) {
    await deleteBunnyVideos(api, [videoId]); // the lesson was deleted (or became a text lesson) meanwhile
    return "notFound";
  }
  await deleteBunnyVideos(api, obsolete);
  const expires = Math.floor(now.getTime() / 1000) + UPLOAD_TTL_SEC;
  return { videoId, libraryId: config.libraryId, expires, signature: await tusSignature(config.libraryId, config.apiKey, expires, videoId), endpoint: config.tusEndpoint, title };
}

type VideoRow = VideoState & { id: number };

/**
 * Stores Bunny's answer about the row's current upload (null: Bunny does not know the video, which counts as failed), by
 * compare-and-set against `row` as it was read before Bunny was asked. Ready or failed ends the upload (its start time is cleared); ready
 * also stores the video's picture size (the two columns are in the same write, so a stale write cannot change them either).
 * The encode progress (R-g, S6) is Bunny's `encodeProgress` while the video is "processing" and null in every other state: ready and failed
 * clear it in the same write that ends the upload. A new figure for a video that is processing already is a write of its own (the poll and the
 * webhook both bring it); the same figure again writes nothing. The compare names the video columns only, not the figure: a status that ends
 * the upload must not lose to a write that merely moved the figure, and a stale figure that wins the race is put right by the next read.
 * The lesson's video as it is now: the new state, the row unchanged, or (another write came first) the row read again; `wrote` says
 * whether this call's write is the one that changed the row.
 */
async function applyAnswer(db: Db, api: BunnyApi, row: VideoRow, videoId: string, bunny: BunnyVideo | null): Promise<{ video: AdminVideo | null; wrote: boolean }> {
  const status = bunny ? lessonVideoStatus(bunny.status) : "failed";
  const settled = settleVideo(row, videoId, status, bunny?.length ?? 0, bunny && { width: bunny.width, height: bunny.height });
  if (!settled) return { video: adminVideo(row), wrote: false }; // nothing new (not the current upload, a stale or downgrading answer): no write
  const videoProgress = settled.next.videoStatus === "processing" ? (bunny?.encodeProgress ?? null) : null;
  if (sameVideo(settled.next, row) && videoProgress === row.videoProgress) return { video: adminVideo(row), wrote: false }; // a repeated answer: no write
  const done = settled.next.videoStatus === "ready" || settled.next.videoStatus === "failed";
  const written = await db
    .update(lessons)
    .set({ ...settled.next, videoProgress, ...(done ? { videoStartedAt: null } : {}) })
    .where(unchangedSince(row.id, row))
    .returning();
  if (!written.length) {
    // another write came first (the webhook and the poll at once, a new upload, Tekst): it stands, and it did the deleting
    const [now] = await db.select(VIDEO_COLUMNS).from(lessons).where(eq(lessons.id, row.id)).limit(1);
    return { video: now ? adminVideo(now) : null, wrote: false };
  }
  await deleteBunnyVideos(api, settled.obsolete);
  return { video: adminVideo({ ...settled.next, videoProgress }), wrote: true };
}

const storeAnswer = async (db: Db, api: BunnyApi, row: VideoRow, videoId: string, bunny: BunnyVideo | null) => (await applyAnswer(db, api, row, videoId, bunny)).video;

/**
 * Reads the status of a lesson's current upload from Bunny's API and stores it. The lesson is named by its id (the editor's poll)
 * or by the video's id (the webhook; any other video is ignored). Only an upload in progress (uploading, processing) is asked
 * about. Ready stores the length and deletes a replaced video; a video Bunny no longer knows counts as failed. null: no such lesson.
 * A Bunny failure (BunnyError, a TimeoutError) is thrown to the caller; the row stays as it was.
 */
export async function refreshLessonVideo(db: Db, api: BunnyApi, target: { lessonId: number } | { videoId: string }): Promise<AdminVideo | null> {
  const where = "lessonId" in target ? eq(lessons.id, target.lessonId) : eq(lessons.videoId, target.videoId);
  const [row] = await db.select({ id: lessons.id, ...VIDEO_COLUMNS }).from(lessons).where(where).limit(1);
  if (!row) return null;
  if (!row.videoId || (row.videoStatus !== "uploading" && row.videoStatus !== "processing")) return adminVideo(row);
  return storeAnswer(db, api, row, row.videoId, await api.getVideo(row.videoId));
}

/**
 * What bounds a sweep run: at most `limit` rows (oldest first), and no new row is started after `until` (epoch ms; the cron gives
 * itself 35 s, because a row begun then still takes up to about 20 s to finish and the cron's limit is 60). A row that was started is finished.
 */
export type SweepBudget = { limit?: number; until?: number };

/** What a pass over one kind of stuck rows leaves: rows that matched but were not looked at (over the bound, or out of time). */
type PassEnd = { left: number; stopped: boolean };

async function countWhere(db: Db, where: SQL): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(lessons).where(where);
  return row.n;
}

/** One pass over the uploads still "uploading" for a day; see sweepStuckUploads. */
async function uploadsPass(db: Db, api: BunnyApi, now: Date, { limit = SWEEP_BATCH, until = Infinity }: SweepBudget): Promise<PassEnd & { swept: number }> {
  const where = and(eq(lessons.videoStatus, "uploading"), lt(lessons.videoStartedAt, new Date(now.getTime() - STUCK_MS)))!;
  const stuck = await db.select({ id: lessons.id, ...VIDEO_COLUMNS }).from(lessons).where(where).orderBy(asc(lessons.id)).limit(limit);
  const matching = await countWhere(db, where);
  let swept = 0;
  let looked = 0;
  let stopped = false;
  for (const row of stuck) {
    if (Date.now() > until) {
      stopped = true;
      break;
    }
    looked += 1;
    try {
      const bunny = row.videoId ? await api.getVideo(row.videoId) : null;
      if (row.videoId && bunny && lessonVideoStatus(bunny.status) !== "uploading") {
        await storeAnswer(db, api, row, row.videoId, bunny);
        continue;
      }
      // the write first (compare-and-set: still this upload, still "uploading"), the Bunny delete after the winning write only: a
      // write that lost (the webhook settled the video meanwhile) must never have its video deleted
      const { next, obsolete } = abandonUpload(row);
      const reset = await db
        .update(lessons)
        .set({ ...next, videoStartedAt: null, videoProgress: null })
        .where(unchangedSince(row.id, row))
        .returning();
      if (!reset.length) continue;
      swept += 1;
      await deleteBunnyVideos(api, obsolete); // never throws: a delete that fails is logged, and the video stays at Bunny
    } catch (e) {
      logFailure("[video] stuck upload not swept", e);
    }
  }
  return { swept, left: Math.max(0, matching - looked), stopped };
}

/**
 * The daily cron's part (spec 7): uploads still "uploading" more than 24 h after they began. Bunny is asked first: an upload that
 * did arrive (nobody asked since: the editor was closed at once and no webhook came) is settled like any status read. One that never
 * arrived is given up: the lesson gets its replaced video back, or has none again (compare-and-set), and only after that write is
 * the video deleted from Bunny (a delete that fails is logged and leaves the video at Bunny). A Bunny failure on the status read
 * leaves the row for the next day. At most SWEEP_BATCH rows a run. Answers the number of lessons reset.
 */
export async function sweepStuckUploads(db: Db, api: BunnyApi, now: Date, limit: number = SWEEP_BATCH): Promise<number> {
  return (await uploadsPass(db, api, now, { limit })).swept;
}

/** What the sweep of stuck processing did: videos found ready, and videos failed (Bunny's own error state, or given up after a day). */
export type ProcessingSweep = { ready: number; failed: number };

/** One pass over the videos still "processing" for a day; see sweepStuckProcessing. */
async function processingPass(db: Db, api: BunnyApi, now: Date, { limit = SWEEP_BATCH, until = Infinity }: SweepBudget): Promise<PassEnd & ProcessingSweep> {
  const where = and(eq(lessons.videoStatus, "processing"), isNotNull(lessons.videoId), lt(lessons.videoStartedAt, new Date(now.getTime() - STUCK_MS)))!;
  const stuck = await db
    .select({ id: lessons.id, ...VIDEO_COLUMNS })
    .from(lessons)
    .where(where)
    .orderBy(asc(lessons.videoStartedAt), asc(lessons.id))
    .limit(limit);
  const matching = await countWhere(db, where);
  const swept = { ready: 0, failed: 0 };
  let looked = 0;
  let stopped = false;
  for (const row of stuck) {
    if (Date.now() > until) {
      stopped = true;
      break;
    }
    looked += 1;
    if (!row.videoId) continue; // (never: the query asks for a video id)
    try {
      let answer = await applyAnswer(db, api, row, row.videoId, await api.getVideo(row.videoId));
      // still processing a day on, or an answer that is no use: given up (the same write as for a video Bunny does not know)
      if (answer.video?.status === "processing") answer = await applyAnswer(db, api, row, row.videoId, null);
      if (answer.wrote && answer.video?.status === "ready") swept.ready += 1;
      else if (answer.wrote && answer.video?.status === "failed") swept.failed += 1;
    } catch (e) {
      logFailure("[video] stuck processing video not swept", e);
    }
  }
  return { ...swept, left: Math.max(0, matching - looked), stopped };
}

/**
 * The daily cron's second part: videos still "processing" more than 24 h after their upload began (spec 7). Nobody asked Bunny
 * since (the editor was closed, no webhook came), or Bunny's encoding hangs; either way the editor has no replace button while a
 * video is processing, so without this the lesson would wait for ever. Bunny is asked first and its answer is stored like any
 * status read (settleVideo, compare-and-set, the replaced video deleted only after a winning write that made the new one ready):
 * ready is kept, Bunny's own error or a video it does not know is failed. A video Bunny still has as processing after a day (or
 * one it calls ready but without a usable length) is given up as failed: the editor then offers "Lae uuesti üles", and the retry
 * deletes the stale video from Bunny. A failed upload never deletes a replaced video: it keeps playing. A ready video is never
 * touched (only "processing" rows are read, and a write only goes through while the row is as it was read). A Bunny failure leaves
 * the row for the next day. At most `limit` rows a run, the oldest first. The counts are of the rows THIS run changed.
 */
export async function sweepStuckProcessing(db: Db, api: BunnyApi, now: Date, limit: number = SWEEP_BATCH): Promise<ProcessingSweep> {
  const { ready, failed } = await processingPass(db, api, now, { limit });
  return { ready, failed };
}

/** The cron's answer about the videos: what was done, and what is left for the next run (counts only). */
export type VideoSweep = { uploads: number; processingReady: number; processingFailed: number; left: number; outOfTime: boolean };

/**
 * Both sweeps, one after the other (uploads, then processing), within one budget: each takes at most SWEEP_BATCH rows, and no new
 * row is started after `until` (epoch ms). `left`: stuck rows this run did not look at, over the bound or out of time (rows a
 * Bunny failure kept stuck are not counted: they were looked at); `outOfTime`: the deadline stopped a pass.
 */
export async function sweepStuckVideos(db: Db, api: BunnyApi, now: Date, until: number = Infinity): Promise<VideoSweep> {
  const uploads = await uploadsPass(db, api, now, { until });
  const processing = await processingPass(db, api, now, { until });
  return { uploads: uploads.swept, processingReady: processing.ready, processingFailed: processing.failed, left: uploads.left + processing.left, outOfTime: uploads.stopped || processing.stopped };
}
