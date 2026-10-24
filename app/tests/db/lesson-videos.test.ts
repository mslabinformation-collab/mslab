import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseModules, courses, lessons } from "@/db/schema";
import { BunnyError, bunnyConfig, tusSignature, UPLOAD_TTL_SEC, type BunnyApi } from "@/server/bunny";
import { refreshLessonVideo, startLessonVideo, SWEEP_BATCH, sweepStuckProcessing, sweepStuckUploads, sweepStuckVideos } from "@/server/lesson-videos";
import { makeTestDb } from "./helpers";

const NOW = new Date("2026-10-06T10:00:00Z");
const CONFIG = bunnyConfig({ BUNNY_LIBRARY_ID: "12345", BUNNY_API_KEY: "test-api-key", BUNNY_TOKEN_KEY: "test-token-key" }, false)!;
const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** What the fake Bunny holds of a video; no `width` and `height`: Bunny gives 0 for a video it has no size of (older, or still being processed). */
type Held = { status: number; length: number; width?: number; height?: number; encodeProgress?: number | null };

/** A Bunny that remembers videos: created at status 0, deleted ones gone. */
function fakeBunny(videos: Record<string, Held> = {}) {
  let n = 100;
  const titles: string[] = [];
  const deleted: string[] = [];
  const api: BunnyApi = {
    createVideo: vi.fn(async (title: string) => {
      titles.push(title);
      const id = guid(++n);
      videos[id] = { status: 0, length: 0 };
      return id;
    }),
    getVideo: vi.fn(async (id: string) => (videos[id] ? { width: 0, height: 0, encodeProgress: null, ...videos[id] } : null)),
    deleteVideo: vi.fn(async (id: string) => {
      deleted.push(id);
      delete videos[id];
    }),
  };
  return { api, videos, titles, deleted };
}

let db: Db;
let lessonId: number;
const row = async () => (await db.select().from(lessons).where(eq(lessons.id, lessonId)))[0];
/** The row version (Postgres xmin): it changes with every UPDATE of the row, also one that writes the same values. */
const version = async () => {
  const res = (await db.execute(sql`select xmin::text as v from lessons where id = ${lessonId}`)) as unknown as { rows: { v: string }[] };
  return res.rows[0].v;
};
beforeEach(async () => {
  db = await makeTestDb();
  const [c] = await db.insert(courses).values({ slug: "veeb", type: "e_learning", level: "basic", title: { et: "Veebikursus" }, summary: { et: "" }, body: { et: "" } }).returning();
  const [m] = await db.insert(courseModules).values({ courseId: c.id, position: 1, title: { et: "M" } }).returning();
  [{ id: lessonId }] = await db.insert(lessons).values({ moduleId: m.id, position: 1, title: { et: "Esimene" } }).returning();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createLessonVideo's work", () => {
  test("a first upload: a Bunny video titled course · lesson and a tus ticket signed for 6 hours; the lesson is uploading", async () => {
    const b = fakeBunny();
    const ticket = await startLessonVideo(db, b.api, CONFIG, lessonId, NOW);
    if (ticket === "notFound") throw new Error("lesson");
    const expires = Math.floor(NOW.getTime() / 1000) + UPLOAD_TTL_SEC;
    expect(ticket).toEqual({
      videoId: guid(101), libraryId: "12345", expires, endpoint: "https://video.bunnycdn.com/tusupload", title: "Veebikursus · Esimene",
      signature: await tusSignature("12345", "test-api-key", expires, guid(101)),
    });
    expect(b.titles).toEqual(["Veebikursus · Esimene"]);
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "uploading", replacedVideoId: null, videoStartedAt: NOW });
  });

  test("the ticket carries nothing secret: no API key, no token key", async () => {
    const ticket = await startLessonVideo(db, fakeBunny().api, CONFIG, lessonId, NOW);
    const text = JSON.stringify(ticket);
    expect(text).not.toContain("test-api-key");
    expect(text).not.toContain("test-token-key");
    expect(Object.keys(ticket as object).sort()).toEqual(["endpoint", "expires", "libraryId", "signature", "title", "videoId"]);
  });

  test("an unknown lesson, or a text lesson (it has no video): notFound, and no Bunny video is made", async () => {
    const b = fakeBunny();
    expect(await startLessonVideo(db, b.api, CONFIG, 999999, NOW)).toBe("notFound");
    await db.update(lessons).set({ kind: "text" }).where(eq(lessons.id, lessonId));
    expect(await startLessonVideo(db, b.api, CONFIG, lessonId, NOW)).toBe("notFound");
    expect(b.api.createVideo).not.toHaveBeenCalled();
  });

  test("“Asenda video”: the ready video keeps playing until the new one is ready, then it is deleted from Bunny", async () => {
    const b = fakeBunny({ [guid(1)]: { status: 4, length: 300 } });
    await db.update(lessons).set({ videoId: guid(1), videoStatus: "ready", durationSec: 300 }).where(eq(lessons.id, lessonId));
    await startLessonVideo(db, b.api, CONFIG, lessonId, NOW);
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "uploading", replacedVideoId: guid(1), durationSec: 300 });
    b.videos[guid(101)] = { status: 3, length: 0 };
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "processing", durationSec: 300, replacing: true, progress: null });
    expect(b.deleted).toEqual([]);
    b.videos[guid(101)] = { status: 4, length: 754 };
    expect(await refreshLessonVideo(db, b.api, { videoId: guid(101) })).toEqual({ status: "ready", durationSec: 754, replacing: false, progress: null });
    expect(b.deleted).toEqual([guid(1)]);
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "ready", replacedVideoId: null, durationSec: 754 });
  });

  test("“Asenda video” and the shape: the playing video's stays through the upload and the processing, the new video's replaces it once ready", async () => {
    const b = fakeBunny({ [guid(1)]: { status: 4, length: 300, width: 1920, height: 1080 } });
    await db.update(lessons).set({ videoId: guid(1), videoStatus: "ready", durationSec: 300, videoWidth: 1920, videoHeight: 1080 }).where(eq(lessons.id, lessonId));
    await startLessonVideo(db, b.api, CONFIG, lessonId, NOW);
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "uploading", videoWidth: 1920, videoHeight: 1080 });
    b.videos[guid(101)] = { status: 3, length: 0 }; // transcoding: Bunny has no size to give yet
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoStatus: "processing", replacedVideoId: guid(1), videoWidth: 1920, videoHeight: 1080 });
    b.videos[guid(101)] = { status: 4, length: 60, width: 1080, height: 1920 };
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "ready", replacedVideoId: null, durationSec: 60, videoWidth: 1080, videoHeight: 1920 });
  });

  test("a failed replacement keeps the shape of the video that plays", async () => {
    const b = fakeBunny({ [guid(1)]: { status: 4, length: 300, width: 1080, height: 1920 } });
    await db.update(lessons).set({ videoId: guid(1), videoStatus: "ready", durationSec: 300, videoWidth: 1080, videoHeight: 1920 }).where(eq(lessons.id, lessonId));
    await startLessonVideo(db, b.api, CONFIG, lessonId, NOW);
    b.videos[guid(101)] = { status: 5, length: 0 };
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoStatus: "failed", replacedVideoId: guid(1), videoWidth: 1080, videoHeight: 1920 });
  });

  test("“Lae uuesti üles” after a failure deletes the failed video and keeps a replaced one", async () => {
    const b = fakeBunny();
    await db.update(lessons).set({ videoId: guid(2), videoStatus: "failed", replacedVideoId: guid(1), durationSec: 300 }).where(eq(lessons.id, lessonId));
    await startLessonVideo(db, b.api, CONFIG, lessonId, NOW);
    expect(b.deleted).toEqual([guid(2)]);
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "uploading", replacedVideoId: guid(1) });
  });

  test("Bunny refusing the new video: the error goes up and the lesson is unchanged", async () => {
    const b = fakeBunny();
    b.api.createVideo = vi.fn(async () => {
      throw new BunnyError("create", 401);
    });
    await expect(startLessonVideo(db, b.api, CONFIG, lessonId, NOW)).rejects.toThrow(BunnyError);
    expect(await row()).toMatchObject({ videoId: null, videoStatus: "none", videoStartedAt: null });
  });

  test("the lesson deleted between Bunny's answer and the write: notFound, and the new video is deleted again", async () => {
    const b = fakeBunny();
    const create = b.api.createVideo;
    b.api.createVideo = vi.fn(async (title: string) => {
      const id = await create(title);
      await db.delete(lessons).where(eq(lessons.id, lessonId));
      return id;
    });
    expect(await startLessonVideo(db, b.api, CONFIG, lessonId, NOW)).toBe("notFound");
    expect(b.deleted).toEqual([guid(101)]);
  });
});

describe("refreshLessonVideo", () => {
  test("asks Bunny only about an upload in progress; Bunny not knowing the video is a failure; another video is ignored", async () => {
    const b = fakeBunny();
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "none", durationSec: null, replacing: false, progress: null });
    expect(b.api.getVideo).not.toHaveBeenCalled();
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "uploading" }).where(eq(lessons.id, lessonId));
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "failed", durationSec: null, replacing: false, progress: null });
    expect(await refreshLessonVideo(db, b.api, { videoId: guid(77) })).toBeNull();
    expect(await refreshLessonVideo(db, b.api, { lessonId: 999999 })).toBeNull();
  });

  test("Bunny 0 (created) keeps it uploading, 1–3 are processing, 5 is failed", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 0, length: 0 } });
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "uploading" }).where(eq(lessons.id, lessonId));
    expect((await refreshLessonVideo(db, b.api, { lessonId }))?.status).toBe("uploading");
    b.videos[guid(5)].status = 1;
    expect((await refreshLessonVideo(db, b.api, { lessonId }))?.status).toBe("processing");
    b.videos[guid(5)].status = 5;
    expect((await refreshLessonVideo(db, b.api, { lessonId }))?.status).toBe("failed");
  });

  test("the upload's start time stays while it is processing and is cleared once it is ready or failed", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 2, length: 0 }, [guid(6)]: { status: 6, length: 0 } });
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "uploading", videoStartedAt: NOW }).where(eq(lessons.id, lessonId));
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoStatus: "processing", videoStartedAt: NOW });
    b.videos[guid(5)] = { status: 4, length: 61 };
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoStatus: "ready", durationSec: 61, videoStartedAt: null });

    await db.update(lessons).set({ videoId: guid(6), videoStatus: "processing", videoStartedAt: NOW }).where(eq(lessons.id, lessonId));
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoStatus: "failed", videoStartedAt: null });
  });

  test("ready stores the picture size Bunny reports, in the same write as the length", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 4, length: 61, width: 1080, height: 1920 } });
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "processing", videoStartedAt: NOW }).where(eq(lessons.id, lessonId));
    expect(await refreshLessonVideo(db, b.api, { videoId: guid(5) })).toEqual({ status: "ready", durationSec: 61, replacing: false, progress: null });
    expect(await row()).toMatchObject({ videoStatus: "ready", durationSec: 61, videoWidth: 1080, videoHeight: 1920 });
  });

  test("ready without a size from Bunny (none in its answer, or one side 0): ready all the same, the shape null", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 4, length: 61 }, [guid(6)]: { status: 4, length: 62, width: 1920, height: 0 } });
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "processing" }).where(eq(lessons.id, lessonId));
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "ready", durationSec: 61, replacing: false, progress: null });
    expect(await row()).toMatchObject({ videoStatus: "ready", videoWidth: null, videoHeight: null });
    await db.update(lessons).set({ videoId: guid(6), videoStatus: "processing" }).where(eq(lessons.id, lessonId));
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoStatus: "ready", durationSec: 62, videoWidth: null, videoHeight: null }); // one side only is no shape
  });

  test("a size comes only with ready: processing and failed write none", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 2, length: 0, width: 1080, height: 1920 }, [guid(6)]: { status: 5, length: 0, width: 1080, height: 1920 } });
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "uploading" }).where(eq(lessons.id, lessonId));
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoStatus: "processing", videoWidth: null, videoHeight: null });
    await db.update(lessons).set({ videoId: guid(6) }).where(eq(lessons.id, lessonId));
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoStatus: "failed", videoWidth: null, videoHeight: null });
  });

  test("the same answer again (a repeated webhook, the next poll) writes nothing", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 2, length: 0 } });
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "processing", videoStartedAt: NOW }).where(eq(lessons.id, lessonId));
    const before = await version();
    expect(await refreshLessonVideo(db, b.api, { videoId: guid(5) })).toEqual({ status: "processing", durationSec: null, replacing: false, progress: null });
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "processing", durationSec: null, replacing: false, progress: null });
    expect(await version()).toBe(before);
  });

  test("a stale read never overwrites a newer write: the webhook stored ready while the poll was asking Bunny", async () => {
    const b = fakeBunny({ [guid(1)]: { status: 4, length: 300 } });
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "uploading", replacedVideoId: guid(1), durationSec: 300 }).where(eq(lessons.id, lessonId));
    // the poll read the row as uploading and Bunny says "transcoding"; meanwhile the webhook's read stored ready (and deleted the replaced video)
    b.api.getVideo = vi.fn(async () => {
      await db.update(lessons).set({ videoStatus: "ready", replacedVideoId: null, durationSec: 754, videoStartedAt: null }).where(eq(lessons.id, lessonId));
      return { status: 3, length: 0, width: 0, height: 0, encodeProgress: null };
    });
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "ready", durationSec: 754, replacing: false, progress: null });
    expect(await row()).toMatchObject({ videoId: guid(5), videoStatus: "ready", durationSec: 754, replacedVideoId: null });
    expect(b.deleted).toEqual([]); // only the write that won deletes the replaced video
  });

  test("a stale read cannot overwrite the shape either: the write that came first stored ready with its size, the late answer's size is dropped", async () => {
    const b = fakeBunny();
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "processing" }).where(eq(lessons.id, lessonId));
    b.api.getVideo = vi.fn(async () => {
      // another write came first: ready, 1920 × 1080; this read, begun before it, is told ready and 1080 × 1920
      await db.update(lessons).set({ videoStatus: "ready", durationSec: 754, videoWidth: 1920, videoHeight: 1080, videoStartedAt: null }).where(eq(lessons.id, lessonId));
      return { status: 4, length: 800, width: 1080, height: 1920, encodeProgress: null };
    });
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "ready", durationSec: 754, replacing: false, progress: null });
    expect(await row()).toMatchObject({ videoStatus: "ready", durationSec: 754, videoWidth: 1920, videoHeight: 1080 });
  });

  test("a read of an old upload cannot give the new upload its shape: a replacement began while Bunny was asked", async () => {
    const b = fakeBunny();
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "processing" }).where(eq(lessons.id, lessonId));
    b.api.getVideo = vi.fn(async () => {
      await db.update(lessons).set({ videoId: guid(6), videoStatus: "uploading", videoStartedAt: NOW }).where(eq(lessons.id, lessonId));
      return { status: 4, length: 754, width: 1080, height: 1920, encodeProgress: null };
    });
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoId: guid(6), videoStatus: "uploading", videoWidth: null, videoHeight: null });
  });

  test("two reads that both see ready: one write, one delete of the replaced video", async () => {
    const b = fakeBunny({ [guid(1)]: { status: 4, length: 300 }, [guid(5)]: { status: 4, length: 754 } });
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "processing", replacedVideoId: guid(1), durationSec: 300 }).where(eq(lessons.id, lessonId));
    const get = b.api.getVideo;
    let waiting: () => void = () => {};
    const both = new Promise<void>((resolve) => (waiting = resolve));
    let asked = 0;
    // both callers have Bunny's answer before either writes (the webhook and the poll at the same moment)
    b.api.getVideo = vi.fn(async (id: string) => {
      const answer = await get(id);
      if (++asked === 2) waiting();
      await both;
      return answer;
    });
    const [a, c] = await Promise.all([refreshLessonVideo(db, b.api, { lessonId }), refreshLessonVideo(db, b.api, { videoId: guid(5) })]);
    expect(a).toEqual({ status: "ready", durationSec: 754, replacing: false, progress: null });
    expect(c).toEqual({ status: "ready", durationSec: 754, replacing: false, progress: null });
    expect(b.deleted).toEqual([guid(1)]);
  });

  test("a new upload begun while Bunny was asked about the old one: the old answer is dropped", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 4, length: 754 } });
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "processing" }).where(eq(lessons.id, lessonId));
    b.api.getVideo = vi.fn(async () => {
      await db.update(lessons).set({ videoId: guid(6), videoStatus: "uploading", videoStartedAt: NOW }).where(eq(lessons.id, lessonId));
      return { status: 4, length: 754, width: 1920, height: 1080, encodeProgress: null };
    });
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "uploading", durationSec: null, replacing: false, progress: null });
    expect(await row()).toMatchObject({ videoId: guid(6), videoStatus: "uploading", durationSec: null });
  });

  test("Bunny failing or not answering goes up to the caller (a 500 for the webhook, `server` for the editor); the row stays", async () => {
    const b = fakeBunny();
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "processing" }).where(eq(lessons.id, lessonId));
    b.api.getVideo = vi.fn(async () => {
      throw new BunnyError("get", 500);
    });
    await expect(refreshLessonVideo(db, b.api, { lessonId })).rejects.toThrow(BunnyError);
    b.api.getVideo = vi.fn(async () => {
      throw new DOMException("Bunny did not answer in time", "TimeoutError");
    });
    await expect(refreshLessonVideo(db, b.api, { lessonId })).rejects.toThrow("Bunny did not answer in time");
    expect((await row()).videoStatus).toBe("processing");
  });
});

// Admin UX pass piece 3a, Task 11 (S6, R-g): lessons.video_progress is Bunny's encodeProgress, written by the status read (the editor's poll and the webhook
// are the same refreshLessonVideo) while the video is "processing", and gone (null) with a new upload, with ready, with failed and with the switch to Tekst.
describe("encode progress (S6, R-g)", () => {
  const hold = (videoId: string, over: Partial<typeof lessons.$inferInsert> = {}) =>
    db.update(lessons).set({ videoId, videoStatus: "uploading", videoStartedAt: NOW, ...over }).where(eq(lessons.id, lessonId));

  test("a refresh while Bunny encodes stores its figure and answers it; the next figure replaces it; the same figure again (webhook or poll) writes nothing", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 3, length: 0, encodeProgress: 40 } });
    await hold(guid(5));
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "processing", durationSec: null, replacing: false, progress: 40 });
    expect(await row()).toMatchObject({ videoStatus: "processing", videoProgress: 40 });
    const before = await version();
    expect(await refreshLessonVideo(db, b.api, { videoId: guid(5) })).toEqual({ status: "processing", durationSec: null, replacing: false, progress: 40 });
    expect(await version()).toBe(before);
    b.videos[guid(5)].encodeProgress = 80; // the webhook's read: the same function, by the video's id
    expect(await refreshLessonVideo(db, b.api, { videoId: guid(5) })).toEqual({ status: "processing", durationSec: null, replacing: false, progress: 80 });
    expect(await row()).toMatchObject({ videoStatus: "processing", videoProgress: 80 });
    expect(await version()).not.toBe(before);
  });

  test("processing without a figure from Bunny (the field absent) stores null; a figure of 0 is stored as 0", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 2, length: 0 } });
    await hold(guid(5));
    expect((await refreshLessonVideo(db, b.api, { lessonId }))?.progress).toBeNull();
    expect(await row()).toMatchObject({ videoStatus: "processing", videoProgress: null });
    b.videos[guid(5)].encodeProgress = 0;
    expect((await refreshLessonVideo(db, b.api, { lessonId }))?.progress).toBe(0);
    expect(await row()).toMatchObject({ videoProgress: 0 });
  });

  test("ready clears the figure (in the same write as the length and the start time); so does failed, and so does a video Bunny no longer knows", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 4, length: 61, encodeProgress: 100 }, [guid(6)]: { status: 5, length: 0, encodeProgress: 70 } });
    await hold(guid(5), { videoStatus: "processing", videoProgress: 90 });
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "ready", durationSec: 61, replacing: false, progress: null });
    expect(await row()).toMatchObject({ videoStatus: "ready", durationSec: 61, videoStartedAt: null, videoProgress: null });

    await hold(guid(6), { videoStatus: "processing", videoProgress: 55 });
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "failed", durationSec: 61, replacing: false, progress: null });
    expect(await row()).toMatchObject({ videoStatus: "failed", videoProgress: null });

    await hold(guid(7), { videoStatus: "processing", videoProgress: 55 }); // Bunny does not know it
    expect((await refreshLessonVideo(db, b.api, { lessonId }))?.progress).toBeNull();
    expect(await row()).toMatchObject({ videoStatus: "failed", videoProgress: null });
  });

  test("a figure belongs to processing only: a video Bunny still has as created stores none, whatever its figure", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 0, length: 0, encodeProgress: 7 } });
    await hold(guid(5));
    expect((await refreshLessonVideo(db, b.api, { lessonId }))?.progress).toBeNull();
    expect(await row()).toMatchObject({ videoStatus: "uploading", videoProgress: null });
  });

  test("a replacement shows no figure of the encode before it: starting an upload clears it (a processing row, a failed one, a ready one with a figure left over)", async () => {
    for (const status of ["processing", "failed", "ready"] as const) {
      const b = fakeBunny();
      await db.update(lessons).set({ videoId: guid(5), videoStatus: status, replacedVideoId: null, durationSec: status === "ready" ? 300 : null, videoProgress: 40 }).where(eq(lessons.id, lessonId));
      await startLessonVideo(db, b.api, CONFIG, lessonId, NOW);
      expect(await row(), status).toMatchObject({ videoId: guid(101), videoStatus: "uploading", videoProgress: null });
    }
  });

  test("a replacement end to end: the first encode's figure is gone at ready, the replacement starts without one and shows its own figure, not the old one", async () => {
    const b = fakeBunny({ [guid(5)]: { status: 3, length: 0, encodeProgress: 60 } });
    await hold(guid(5));
    expect((await refreshLessonVideo(db, b.api, { lessonId }))?.progress).toBe(60);
    b.videos[guid(5)] = { status: 4, length: 125, encodeProgress: 100 };
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoStatus: "ready", videoProgress: null });

    await startLessonVideo(db, b.api, CONFIG, lessonId, NOW);
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "uploading", replacedVideoId: guid(5), videoProgress: null });
    b.videos[guid(101)] = { status: 3, length: 0, encodeProgress: 12 };
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "processing", durationSec: 125, replacing: true, progress: 12 });
    b.videos[guid(101)] = { status: 4, length: 754, encodeProgress: 100 };
    expect(await refreshLessonVideo(db, b.api, { lessonId })).toEqual({ status: "ready", durationSec: 754, replacing: false, progress: null });
    expect(await row()).toMatchObject({ videoId: guid(101), videoStatus: "ready", videoProgress: null });
  });

  test("a read of an old upload cannot write its figure to the new upload that began while Bunny was asked", async () => {
    const b = fakeBunny();
    await hold(guid(5), { videoStatus: "processing" });
    b.api.getVideo = vi.fn(async () => {
      await db.update(lessons).set({ videoId: guid(6), videoStatus: "uploading", videoStartedAt: NOW, videoProgress: null }).where(eq(lessons.id, lessonId));
      return { status: 3, length: 0, width: 0, height: 0, encodeProgress: 70 };
    });
    await refreshLessonVideo(db, b.api, { lessonId });
    expect(await row()).toMatchObject({ videoId: guid(6), videoStatus: "uploading", videoProgress: null });
  });

  test("the daily sweep clears it too: a processing video given up after a day, an upload given up", async () => {
    const OLD = new Date(NOW.getTime() - 25 * 3600_000);
    const b = fakeBunny({ [guid(5)]: { status: 3, length: 0, encodeProgress: 60 } });
    await db.update(lessons).set({ videoId: guid(5), videoStatus: "processing", videoStartedAt: OLD, videoProgress: 60 }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 0, failed: 1 });
    expect(await row()).toMatchObject({ videoStatus: "failed", videoProgress: null });

    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", videoStartedAt: OLD, videoProgress: 30 }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(1);
    expect(await row()).toMatchObject({ videoId: null, videoStatus: "none", videoProgress: null });
  });
});

describe("sweepStuckUploads (the daily cron)", () => {
  test("an upload older than 24 h is deleted from Bunny: the replaced video comes back, or the lesson has none; a younger one stays", async () => {
    const b = fakeBunny();
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", replacedVideoId: guid(1), durationSec: 300, videoStartedAt: new Date(NOW.getTime() - 25 * 3600_000) }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(1);
    expect(b.deleted).toEqual([guid(9)]);
    expect(await row()).toMatchObject({ videoId: guid(1), videoStatus: "ready", replacedVideoId: null, durationSec: 300, videoStartedAt: null });

    await db.update(lessons).set({ videoId: guid(10), videoStatus: "uploading", replacedVideoId: null, durationSec: null, videoStartedAt: new Date(NOW.getTime() - 3600_000) }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(0);
    expect(await row()).toMatchObject({ videoId: guid(10), videoStatus: "uploading" });
  });

  test("the sweep gives the replaced video back with its shape; a first upload given up has none", async () => {
    const b = fakeBunny();
    const old = new Date(NOW.getTime() - 25 * 3600_000);
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", replacedVideoId: guid(1), durationSec: 300, videoWidth: 1080, videoHeight: 1920, videoStartedAt: old }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(1);
    expect(await row()).toMatchObject({ videoId: guid(1), videoStatus: "ready", replacedVideoId: null, videoWidth: 1080, videoHeight: 1920 });
    await db.update(lessons).set({ videoId: guid(10), videoStatus: "uploading", replacedVideoId: null, durationSec: null, videoWidth: null, videoHeight: null, videoStartedAt: old }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(1);
    expect(await row()).toMatchObject({ videoId: null, videoStatus: "none", videoWidth: null, videoHeight: null });
  });

  test("an upload that did finish is settled by the sweep with its size", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 4, length: 125, width: 1080, height: 1920 } });
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", videoStartedAt: new Date(NOW.getTime() - 25 * 3600_000) }).where(eq(lessons.id, lessonId));
    await sweepStuckUploads(db, b.api, NOW);
    expect(await row()).toMatchObject({ videoId: guid(9), videoStatus: "ready", durationSec: 125, videoWidth: 1080, videoHeight: 1920 });
  });

  test("the lesson is reset first and the video deleted from Bunny after that write (not before)", async () => {
    const b = fakeBunny();
    const seen: string[] = [];
    b.api.deleteVideo = vi.fn(async (id: string) => {
      seen.push(`${id} deleted while the lesson was ${(await row()).videoStatus}`); // the row as the delete finds it
    });
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", replacedVideoId: guid(1), durationSec: 300, videoStartedAt: new Date(NOW.getTime() - 25 * 3600_000) }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(1);
    expect(seen).toEqual([`${guid(9)} deleted while the lesson was ready`]); // already back on the replaced video
  });

  test("a write that lost (the webhook settled the upload while Bunny was asked) deletes nothing from Bunny: the ready video is never destroyed", async () => {
    const b = fakeBunny();
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", replacedVideoId: guid(1), durationSec: 300, videoStartedAt: new Date(NOW.getTime() - 25 * 3600_000) }).where(eq(lessons.id, lessonId));
    b.api.getVideo = vi.fn(async () => {
      // Bunny still says created, but meanwhile the webhook's read stored the finished upload and deleted the replaced video
      await db.update(lessons).set({ videoStatus: "ready", durationSec: 125, replacedVideoId: null, videoStartedAt: null }).where(eq(lessons.id, lessonId));
      return { status: 0, length: 0, width: 0, height: 0, encodeProgress: null };
    });
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(0);
    expect(b.api.deleteVideo).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ videoId: guid(9), videoStatus: "ready", durationSec: 125, replacedVideoId: null });
  });

  test("a delete that fails at Bunny after the write is logged without ids: the lesson stays reset, and the sweep goes on", async () => {
    const b = fakeBunny();
    b.api.deleteVideo = vi.fn(async () => {
      throw new Error("down");
    });
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", videoStartedAt: new Date(NOW.getTime() - 25 * 3600_000) }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(1);
    expect(await row()).toMatchObject({ videoId: null, videoStatus: "none", videoStartedAt: null });
    expect(String(vi.mocked(console.error).mock.calls)).toContain("[lesson] video not deleted");
    expect(String(vi.mocked(console.error).mock.calls)).not.toContain(guid(9));
  });

  test("an upload that did finish, but nobody asked Bunny about it since (editor closed at once, no webhook), is settled, not deleted", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 4, length: 125 } });
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", replacedVideoId: guid(1), durationSec: 300, videoStartedAt: new Date(NOW.getTime() - 25 * 3600_000) }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(0);
    expect(b.deleted).toEqual([guid(1)]); // the replaced video, as on any ready
    expect(await row()).toMatchObject({ videoId: guid(9), videoStatus: "ready", durationSec: 125, replacedVideoId: null, videoStartedAt: null });
  });

  test("an upload Bunny still has as created (nothing arrived) is given up", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 0, length: 0 } });
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", videoStartedAt: new Date(NOW.getTime() - 25 * 3600_000) }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(1);
    expect(b.deleted).toEqual([guid(9)]);
    expect(await row()).toMatchObject({ videoId: null, videoStatus: "none", durationSec: null, videoStartedAt: null });
  });

  test("Bunny not answering the status read: the row stays for the next day and the other rows go on", async () => {
    const b = fakeBunny();
    b.api.getVideo = vi.fn(async () => {
      throw new DOMException("Bunny did not answer in time", "TimeoutError");
    });
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "uploading", videoStartedAt: new Date(NOW.getTime() - 25 * 3600_000) }).where(eq(lessons.id, lessonId));
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(0);
    expect(b.deleted).toEqual([]);
    expect((await row()).videoStatus).toBe("uploading");
    expect(String(vi.mocked(console.error).mock.calls)).not.toContain(guid(9));
  });
});

describe("sweepStuckUploads: a bounded run", () => {
  test("at most SWEEP_BATCH uploads a run; the rest wait for the next one", async () => {
    const b = fakeBunny();
    const [{ moduleId }] = await db.select({ moduleId: lessons.moduleId }).from(lessons).where(eq(lessons.id, lessonId));
    const old = new Date(NOW.getTime() - 25 * 3600_000);
    for (let i = 0; i < SWEEP_BATCH + 1; i++) {
      await db.insert(lessons).values({ moduleId, position: 10 + i, title: { et: `L${i}` }, videoId: guid(500 + i), videoStatus: "uploading", videoStartedAt: old });
    }
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(SWEEP_BATCH);
    expect(b.deleted).toHaveLength(SWEEP_BATCH);
    expect(await sweepStuckUploads(db, b.api, NOW)).toBe(1);
  });
});

describe("sweepStuckProcessing (the daily cron, second part)", () => {
  const OLD = new Date(NOW.getTime() - 25 * 3600_000);
  const YOUNG = new Date(NOW.getTime() - 23 * 3600_000);
  const processing = (videoId: string, over: Partial<typeof lessons.$inferInsert> = {}) =>
    db.update(lessons).set({ videoId, videoStatus: "processing", videoStartedAt: OLD, ...over }).where(eq(lessons.id, lessonId));
  const moreLesson = async (position: number, values: Partial<typeof lessons.$inferInsert>) => {
    const [{ moduleId }] = await db.select({ moduleId: lessons.moduleId }).from(lessons).where(eq(lessons.id, lessonId));
    const [l] = await db.insert(lessons).values({ moduleId, position, title: { et: `L${position}` }, ...values }).returning();
    return l;
  };
  const rowOf = async (id: number) => (await db.select().from(lessons).where(eq(lessons.id, id)))[0];

  test("Bunny says it is ready: stored with its length and size, the start time cleared, the replaced video deleted", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 4, length: 125.4, width: 1080, height: 1920 } });
    await processing(guid(9), { replacedVideoId: guid(1), durationSec: 300 });
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 1, failed: 0 });
    expect(b.deleted).toEqual([guid(1)]);
    expect(await row()).toMatchObject({ videoId: guid(9), videoStatus: "ready", durationSec: 125, videoWidth: 1080, videoHeight: 1920, replacedVideoId: null, videoStartedAt: null });
  });

  test("Bunny still has it as processing after a day: failed, so the editor offers \"Lae uuesti üles\"; the playing replaced video stays, nothing is deleted", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 3, length: 0 }, [guid(1)]: { status: 4, length: 300 } });
    await processing(guid(9), { replacedVideoId: guid(1), durationSec: 300, videoWidth: 1920, videoHeight: 1080 });
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 0, failed: 1 });
    expect(b.deleted).toEqual([]);
    expect(await row()).toMatchObject({ videoId: guid(9), videoStatus: "failed", replacedVideoId: guid(1), durationSec: 300, videoWidth: 1920, videoHeight: 1080, videoStartedAt: null });
    // the retry (startLessonVideo) is what deletes the stale failed video, and the replaced one plays on meanwhile
    const ticket = await startLessonVideo(db, b.api, CONFIG, lessonId, NOW);
    expect(ticket).not.toBe("notFound");
    expect(b.deleted).toEqual([guid(9)]);
    expect(await row()).toMatchObject({ videoStatus: "uploading", replacedVideoId: guid(1) });
  });

  test("a first upload stuck in processing is failed too: the lesson has a video that failed, not none", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 2, length: 0 } });
    await processing(guid(9));
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 0, failed: 1 });
    expect(await row()).toMatchObject({ videoId: guid(9), videoStatus: "failed", durationSec: null, videoStartedAt: null });
    expect(b.deleted).toEqual([]);
  });

  test("Bunny's own error state, and a video Bunny no longer knows, are failed (no replaced video is deleted)", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 5, length: 0 } });
    await processing(guid(9), { replacedVideoId: guid(1), durationSec: 300 });
    const other = await moreLesson(2, { videoId: guid(8), videoStatus: "processing", videoStartedAt: OLD, replacedVideoId: guid(2), durationSec: 60 });
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 0, failed: 2 });
    expect(await row()).toMatchObject({ videoStatus: "failed", replacedVideoId: guid(1), durationSec: 300 });
    expect(await rowOf(other.id)).toMatchObject({ videoStatus: "failed", replacedVideoId: guid(2), durationSec: 60 });
    expect(b.deleted).toEqual([]);
  });

  test("a video Bunny calls ready without a usable length is no use: failed, not left for ever", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 4, length: 0 } });
    await processing(guid(9), { replacedVideoId: guid(1), durationSec: 300 });
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 0, failed: 1 });
    expect(await row()).toMatchObject({ videoStatus: "failed", replacedVideoId: guid(1) });
    expect(b.deleted).toEqual([]);
  });

  test("only processing videos older than 24 h are asked about: younger ones, ready ones, uploads and lessons without a video are left alone", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 4, length: 90 } });
    await processing(guid(9), { videoStartedAt: YOUNG });
    await moreLesson(2, { videoId: guid(2), videoStatus: "ready", durationSec: 60, videoStartedAt: OLD }); // (a ready row never keeps its start time; even so it is not read)
    await moreLesson(3, { videoId: guid(3), videoStatus: "uploading", videoStartedAt: OLD });
    await moreLesson(4, { videoStatus: "none" });
    await moreLesson(5, { videoId: guid(5), videoStatus: "failed", videoStartedAt: OLD });
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 0, failed: 0 });
    expect(b.api.getVideo).not.toHaveBeenCalled();
    expect(b.api.deleteVideo).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ videoId: guid(9), videoStatus: "processing" });
  });

  test("a second run finds nothing more", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 2, length: 0 } });
    await processing(guid(9));
    await sweepStuckProcessing(db, b.api, NOW);
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 0, failed: 0 });
  });

  test("a Bunny failure (BunnyError, TimeoutError) leaves that row for the next day, is logged without ids, and the other rows go on", async () => {
    const b = fakeBunny({ [guid(8)]: { status: 4, length: 60 } });
    await processing(guid(9), { videoStartedAt: new Date(OLD.getTime() - 3600_000) }); // the oldest: first
    await moreLesson(2, { videoId: guid(7), videoStatus: "processing", videoStartedAt: new Date(OLD.getTime() - 1800_000) });
    const third = await moreLesson(3, { videoId: guid(8), videoStatus: "processing", videoStartedAt: OLD });
    const get = b.api.getVideo;
    b.api.getVideo = vi.fn(async (id: string) => {
      if (id === guid(9)) throw new BunnyError("get", 500);
      if (id === guid(7)) throw new DOMException("Bunny did not answer in time", "TimeoutError");
      return get(id);
    });
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 1, failed: 0 });
    expect((await row()).videoStatus).toBe("processing");
    expect(await rowOf(third.id)).toMatchObject({ videoStatus: "ready", durationSec: 60 });
    const logged = String(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("[video] stuck processing video not swept: BunnyError (status 500)");
    expect(logged).toContain("TimeoutError");
    expect(logged).not.toContain(guid(9));
    expect(logged).not.toContain(guid(7));
  });

  test("at most `limit` rows a run, the oldest first", async () => {
    const b = fakeBunny({ [guid(1)]: { status: 4, length: 10 }, [guid(2)]: { status: 4, length: 10 }, [guid(3)]: { status: 4, length: 10 } });
    await processing(guid(2), { videoStartedAt: new Date(OLD.getTime() - 1000) });
    const first = await moreLesson(2, { videoId: guid(1), videoStatus: "processing", videoStartedAt: new Date(OLD.getTime() - 2000) });
    const last = await moreLesson(3, { videoId: guid(3), videoStatus: "processing", videoStartedAt: OLD });
    expect(await sweepStuckProcessing(db, b.api, NOW, 2)).toEqual({ ready: 2, failed: 0 });
    expect((await rowOf(first.id)).videoStatus).toBe("ready");
    expect((await row()).videoStatus).toBe("ready");
    expect((await rowOf(last.id)).videoStatus).toBe("processing");
    expect(await sweepStuckProcessing(db, b.api, NOW, 2)).toEqual({ ready: 1, failed: 0 });
  });

  test("the default bound is SWEEP_BATCH", async () => {
    const b = fakeBunny();
    for (let i = 0; i < SWEEP_BATCH + 1; i++) await moreLesson(10 + i, { videoId: guid(600 + i), videoStatus: "processing", videoStartedAt: OLD });
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 0, failed: SWEEP_BATCH });
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 0, failed: 1 });
  });

  test("a write that came first wins: the webhook settles the video while Bunny is asked, so the sweep changes and deletes nothing", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 4, length: 125 } });
    await processing(guid(9), { replacedVideoId: guid(1), durationSec: 300 });
    // between the sweep's read of the row and its write, the webhook stored ready and deleted the replaced video
    b.api.getVideo = vi.fn(async () => {
      await db.update(lessons).set({ videoStatus: "ready", durationSec: 125, replacedVideoId: null, videoStartedAt: null }).where(eq(lessons.id, lessonId));
      return { status: 2, length: 0, width: 0, height: 0, encodeProgress: null };
    });
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 0, failed: 0 });
    expect(await row()).toMatchObject({ videoId: guid(9), videoStatus: "ready", durationSec: 125, replacedVideoId: null });
    expect(b.deleted).toEqual([]);
  });

  test("a new upload that began while Bunny was asked is not touched by the old video's answer", async () => {
    const b = fakeBunny();
    await processing(guid(9), { replacedVideoId: guid(1), durationSec: 300 });
    b.api.getVideo = vi.fn(async () => {
      await db.update(lessons).set({ videoId: guid(10), videoStatus: "uploading", videoStartedAt: NOW }).where(eq(lessons.id, lessonId));
      return { status: 2, length: 0, width: 0, height: 0, encodeProgress: null };
    });
    expect(await sweepStuckProcessing(db, b.api, NOW)).toEqual({ ready: 0, failed: 0 });
    expect(await row()).toMatchObject({ videoId: guid(10), videoStatus: "uploading", replacedVideoId: guid(1) });
    expect(b.deleted).toEqual([]);
  });
});

describe("sweepStuckVideos (both sweeps in one budget)", () => {
  const OLD = new Date(NOW.getTime() - 25 * 3600_000);
  const more = async (n: number, values: Partial<typeof lessons.$inferInsert>) => {
    const [{ moduleId }] = await db.select({ moduleId: lessons.moduleId }).from(lessons).where(eq(lessons.id, lessonId));
    for (let i = 0; i < n; i++) await db.insert(lessons).values({ moduleId, position: 100 + i + (values.videoStatus === "processing" ? 1000 : 0), title: { et: `L${i}` }, videoId: guid((values.videoStatus === "processing" ? 800 : 700) + i), videoStartedAt: OLD, ...values });
  };

  test("uploads and processing are swept, with the counts of both", async () => {
    const b = fakeBunny({ [guid(9)]: { status: 4, length: 60 } });
    await db.update(lessons).set({ videoId: guid(9), videoStatus: "processing", videoStartedAt: OLD }).where(eq(lessons.id, lessonId));
    await more(2, { videoStatus: "uploading" });
    expect(await sweepStuckVideos(db, b.api, NOW)).toEqual({ uploads: 2, processingReady: 1, processingFailed: 0, left: 0, outOfTime: false });
  });

  test("the rows over the bound are counted as left, for each kind", async () => {
    const b = fakeBunny();
    await more(SWEEP_BATCH + 2, { videoStatus: "uploading" });
    await more(SWEEP_BATCH + 3, { videoStatus: "processing" });
    expect(await sweepStuckVideos(db, b.api, NOW)).toEqual({ uploads: SWEEP_BATCH, processingReady: 0, processingFailed: SWEEP_BATCH, left: 2 + 3, outOfTime: false });
    expect(await sweepStuckVideos(db, b.api, NOW)).toMatchObject({ uploads: 2, processingFailed: 3, left: 0 });
  });

  test("past the deadline no new row is started: nothing is asked of Bunny, every row is left", async () => {
    const b = fakeBunny();
    await more(2, { videoStatus: "uploading" });
    await more(1, { videoStatus: "processing" });
    expect(await sweepStuckVideos(db, b.api, NOW, Date.now() - 1)).toEqual({ uploads: 0, processingReady: 0, processingFailed: 0, left: 3, outOfTime: true });
    expect(b.api.getVideo).not.toHaveBeenCalled();
    expect(b.api.deleteVideo).not.toHaveBeenCalled();
  });

  test("a row that has begun is finished, and the deadline stops the next one", async () => {
    const b = fakeBunny();
    await more(3, { videoStatus: "uploading" });
    const until = Date.now() + 60_000;
    let calls = 0;
    const get = b.api.getVideo;
    b.api.getVideo = vi.fn(async (id: string) => {
      if (++calls === 1) vi.setSystemTime(until + 1); // the first row's read takes the budget
      return get(id);
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now());
      const result = await sweepStuckVideos(db, b.api, NOW, until);
      expect(result).toMatchObject({ uploads: 1, left: 2, outOfTime: true });
    } finally {
      vi.useRealTimers();
    }
    expect(b.api.getVideo).toHaveBeenCalledTimes(1);
  });
});
