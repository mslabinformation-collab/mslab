"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getDb } from "@/db/client";
import type { Db } from "@/db/client";
import { parseRowId, ROW_ID_MAX } from "@/lib/row-id";
import {
  addLessonForm, addModuleForm, courseOfLesson, deleteLessonFileForm, deleteLessonForm, deleteModuleForm, moveLessonForm, moveModuleToRequest, saveLessonForm,
  setLessonHiddenForm, setLessonKindForm, type LessonCleanup,
} from "../admin-lessons";
import { adminAction } from "../auth";
import { bunnyApi, bunnyConfig } from "../bunny";
import type { EditResult } from "../edit-check";
import { deleteBunnyVideos, removeLessonMedia } from "../lesson-media";
import { refreshLessonVideo, startLessonVideo, type VideoCheckResult, type VideoTicketResult } from "../lesson-videos";
import { logFailure } from "../log";
import { mediaStore } from "../media-store";
import { revalidatePublic } from "../public-cache";

// "Moodulid ja õppetunnid" server actions: every export is wrapped in adminAction (tests/unit/admin-guards.test.ts). The work is in
// ../admin-lessons.ts. Module titles show on the public course page, so their changes revalidate the course pages; lessons are
// only in the account (its JSON is never cached), so they refresh the open admin page only. On a published course (B18, R-e) a new
// module, a rename and a move wait for „Avalda muudatused“ (its route revalidates once then); the revalidation here is then needless but
// harmless, and a module's delete is live at once. The changes that may write the course's outline draft are handed the admin (the
// draft's updated_by). A module's name is no action: it autosaves on its own route (api/admin/moodul/<id>, R-b2; the card, Task 9).

async function run(what: string, publicChange: boolean, work: (db: Db) => Promise<EditResult>): Promise<EditResult> {
  try {
    const result = await work(getDb());
    if (result.ok) {
      if (publicChange) revalidatePublic({ kind: "courses" });
      refresh();
    }
    return result;
  } catch (e) {
    logFailure(`[admin] ${what} failed`, e);
    return { ok: false, error: "server" };
  }
}

/**
 * What comes after a stored change, outside the database (Bunny, the file store), runs once the answer has gone (`after`): Maria
 * does not wait for Bunny or R2, also not while one of them is slow or down. Still only after the commit, and never thrown:
 * deleteBunnyVideos and removeLessonMedia never throw, and whatever else might (reading the settings) is logged here too.
 */
function afterwards(what: string, work: () => Promise<void>): void {
  after(async () => {
    try {
      await work();
    } catch (e) {
      logFailure(`[admin] ${what} cleanup failed`, e);
    }
  });
}

const media = () => {
  const config = bunnyConfig();
  return { bunny: config ? bunnyApi(config) : null, files: mediaStore() };
};

export const addModule = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("module add", true, (db) => addModuleForm(db, formData)));
/** A module's drag, ↑ or ↓ (the card's DragList, README B2): `{ id, index }`, one move to that place. */
export const moveModuleTo = adminAction(async (admin, input: unknown) => run("module move", true, (db) => moveModuleToRequest(db, input, admin)));
export const deleteModule = adminAction(async (admin, _prev: EditResult | null, formData: FormData) => run("module delete", true, (db) => deleteModuleForm(db, formData, admin)));

/**
 * "Lisa õppetund": the new lesson opens in the drawer (fields moduleId, titleEt). The address is the lesson's own course (read
 * from its module), never a course id the form might name.
 */
export const addLesson = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  let course: number | null = null;
  const result = await run("lesson add", false, async (db) => {
    const done = await addLessonForm(db, formData);
    if (done.ok) course = await courseOfLesson(db, done.id);
    return done;
  });
  if (result.ok && result.created && course) redirect(`/admin/koolitused/${course}?oppetund=${result.id}`);
  return result;
});

export const saveLesson = adminAction(async (admin, _prev: EditResult | null, formData: FormData) => run("lesson save", false, (db) => saveLessonForm(db, formData, admin)));
export const moveLessonInList = adminAction(async (admin, _prev: EditResult | null, formData: FormData) => run("lesson move", false, (db) => moveLessonForm(db, formData, admin)));
export const setLessonHidden = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => run("lesson visibility", false, (db) => setLessonHiddenForm(db, formData)));

/** "Õppetunni liik" (to Tekst after "Video kustutatakse. Jätkan?"): fields id, kind. The videos it drops are deleted from Bunny. */
export const setLessonKind = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  let obsolete: string[] = [];
  const result = await run("lesson kind", false, async (db) => {
    const done = await setLessonKindForm(db, formData);
    obsolete = done.obsolete;
    return done.result;
  });
  const videos = obsolete;
  if (result.ok && videos.length)
    afterwards("lesson kind", async () => {
      const config = bunnyConfig();
      if (config) await deleteBunnyVideos(bunnyApi(config), videos);
    });
  return result;
});

/**
 * "Kustuta õppetund" (after its confirmation): field id. The row, then (after the answer) its videos and files; back to the
 * lesson's own course (read before the row goes) with the drawer closed.
 */
export const deleteLesson = adminAction(async (admin, _prev: EditResult | null, formData: FormData) => {
  let cleanup: LessonCleanup = { videoIds: [], fileKeys: [] };
  let course: number | null = null;
  const result = await run("lesson delete", false, async (db) => {
    const id = parseRowId(String(formData.get("id") ?? ""));
    course = id === null ? null : await courseOfLesson(db, id);
    const done = await deleteLessonForm(db, formData, admin);
    cleanup = done.cleanup;
    return done.result;
  });
  const leftovers = cleanup;
  if (result.ok) afterwards("lesson delete", () => removeLessonMedia(leftovers, media()));
  if (result.ok && course) redirect(`/admin/koolitused/${course}`);
  return result;
});

/** A file's "Eemalda": the row, then (after the answer) the stored object. */
export const deleteLessonFile = adminAction(async (_admin, _prev: EditResult | null, formData: FormData) => {
  let key: string | null = null;
  const result = await run("lesson file delete", false, async (db) => {
    const done = await deleteLessonFileForm(db, formData);
    key = done.key;
    return done.result;
  });
  const stored = key;
  if (result.ok && stored) afterwards("lesson file delete", () => removeLessonMedia({ videoIds: [], fileKeys: [stored] }, { bunny: null, files: mediaStore() }));
  return result;
});

/** A lesson id as the video field sends it (a number; the browser may send anything): a row id, or the answer is notFound. */
const isLessonId = (id: unknown): id is number => Number.isInteger(id) && (id as number) > 0 && (id as number) <= ROW_ID_MAX;

/**
 * "Vali video" / "Asenda video" / "Proovi uuesti" / "Lae uuesti üles": a new Bunny video for the lesson and the signed tus upload
 * (the API key never reaches the browser). `setup` when Bunny is not configured ("Video seadistamata").
 */
export const createLessonVideo = adminAction(async (_admin, lessonId: number): Promise<VideoTicketResult> => {
  const config = bunnyConfig();
  if (!config) return { ok: false, error: "setup" };
  if (!isLessonId(lessonId)) return { ok: false, error: "notFound" };
  try {
    const ticket = await startLessonVideo(getDb(), bunnyApi(config), config, lessonId, new Date());
    return ticket === "notFound" ? { ok: false, error: "notFound" } : { ok: true, ticket };
  } catch (e) {
    logFailure("[admin] video create failed", e);
    return { ok: false, error: "server" };
  }
});

/** The editor's poll (every 5 s while a video is processing, every 30 s after 10 minutes, paused while the tab is hidden): the lesson's video state, read from Bunny for an upload in progress. */
export const checkLessonVideo = adminAction(async (_admin, lessonId: number): Promise<VideoCheckResult> => {
  const config = bunnyConfig();
  if (!config) return { ok: false, error: "setup" };
  if (!isLessonId(lessonId)) return { ok: false, error: "notFound" };
  try {
    const video = await refreshLessonVideo(getDb(), bunnyApi(config), { lessonId });
    return video ? { ok: true, video } : { ok: false, error: "notFound" };
  } catch (e) {
    logFailure("[admin] video check failed", e);
    return { ok: false, error: "server" };
  }
});
