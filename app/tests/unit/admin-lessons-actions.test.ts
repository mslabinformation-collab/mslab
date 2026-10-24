import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { BunnyError } from "@/server/bunny";
import type { EditResult } from "@/server/edit-check";
import { fakeMediaStore } from "../fakes";

// server/actions/admin-lessons.ts around its form handlers (tests/db/admin-lessons.test.ts): which changes revalidate the public
// course pages (module titles show there; lessons do not), where the actions go next, and that the work outside the database
// (Bunny videos, stored files) runs after the answer (next/server after(): scheduled here, run by runScheduled()) and never turns
// a stored change into a failure: a Bunny error or time-out is logged without ids.

class Redirect extends Error {
  constructor(readonly url: string) {
    super("NEXT_REDIRECT");
  }
}

const mocks = vi.hoisted(() => ({
  names: [
    "addModuleForm", "moveModuleToRequest", "deleteModuleForm", "addLessonForm", "moveLessonForm", "setLessonHiddenForm", "setLessonKindForm",
    "deleteLessonForm", "courseOfLesson",
  ],
  /** The callbacks given to after(): they run once the answer has gone. */
  scheduled: [] as (() => unknown)[],
  forms: {} as Record<string, ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>>,
  config: null as unknown,
  config_throws: false,
  deleteVideo: vi.fn(),
  store: null as unknown,
  refresh: vi.fn(),
  revalidatePublic: vi.fn(),
  startLessonVideo: vi.fn(),
  refreshLessonVideo: vi.fn(),
  removeLessonFile: vi.fn(),
  restoreLessonFile: vi.fn(),
  purge: vi.fn(),
}));
vi.mock("@/server/admin-lessons", () => Object.fromEntries(mocks.names.map((name) => [name, (...args: unknown[]) => mocks.forms[name](...args)])));
vi.mock("@/server/auth", () => ({ adminAction: (fn: (admin: { email: string }, ...args: unknown[]) => unknown) => (...args: unknown[]) => fn({ email: "admin@example.test" }, ...args) }));
vi.mock("@/db/client", () => ({ getDb: () => "the-db" }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));
vi.mock("next/server", () => ({ after: (task: () => unknown) => void mocks.scheduled.push(task) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("@/server/public-cache", () => ({ revalidatePublic: mocks.revalidatePublic }));
vi.mock("@/server/media-store", () => ({ mediaStore: () => mocks.store }));
vi.mock("@/server/bunny", async (original) => ({
  ...(await original<typeof import("@/server/bunny")>()),
  bunnyConfig: () => {
    if (mocks.config_throws) throw new Error("Missing required environment variable: DATABASE_URL");
    return mocks.config;
  },
  bunnyApi: () => ({ createVideo: vi.fn(), getVideo: vi.fn(), deleteVideo: mocks.deleteVideo }),
}));

vi.mock("@/server/lesson-videos", () => ({ startLessonVideo: mocks.startLessonVideo, refreshLessonVideo: mocks.refreshLessonVideo }));
vi.mock("@/server/lesson-files", () => ({ removeLessonFile: mocks.removeLessonFile, restoreLessonFile: mocks.restoreLessonFile }));
vi.mock("@/server/lesson-file-purge", () => ({ purgeRemovedLessonFiles: mocks.purge }));

import * as actions from "@/server/actions/admin-lessons";

const form = (fields: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
};
const OK: EditResult = { ok: true, id: 7 };
/** Runs what the actions left for after the answer (as Next.js does once the response has gone). */
async function runScheduled(): Promise<void> {
  for (const task of mocks.scheduled.splice(0)) await task();
}
/** The redirect an action ends with (null: it answers instead). */
async function redirectOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
}

let log: MockInstance<typeof console.error>;
beforeEach(() => {
  for (const name of mocks.names) mocks.forms[name] = vi.fn(async () => OK);
  mocks.forms.courseOfLesson = vi.fn(async () => 5);
  mocks.scheduled.length = 0;
  mocks.config = { libraryId: "lib" };
  mocks.config_throws = false;
  mocks.deleteVideo.mockReset();
  mocks.store = fakeMediaStore();
  mocks.refresh.mockReset();
  mocks.revalidatePublic.mockReset();
  mocks.startLessonVideo.mockReset();
  mocks.refreshLessonVideo.mockReset();
  mocks.removeLessonFile.mockReset().mockResolvedValue(OK);
  mocks.restoreLessonFile.mockReset().mockResolvedValue(OK);
  mocks.purge.mockReset().mockResolvedValue(0);
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("what a change revalidates", () => {
  test("a module change (titles and order are on the public course page) revalidates the course pages and refreshes the admin page", async () => {
    for (const run of [(fd: FormData) => actions.addModule(null, fd), (fd: FormData) => actions.deleteModule(null, fd), () => actions.moveModuleTo({ id: 7, index: 0 })]) {
      mocks.revalidatePublic.mockReset();
      mocks.refresh.mockReset();
      expect(await run(form({ id: 7 }))).toEqual(OK);
      expect(mocks.revalidatePublic).toHaveBeenCalledExactlyOnceWith({ kind: "courses" });
      expect(mocks.refresh).toHaveBeenCalledOnce();
    }
  });

  test("a module's drag or ↑ / ↓ (Task 9; DragList): `{ id, index }` goes to moveModuleToRequest as it came, with the admin; a refusal refreshes nothing", async () => {
    const input = { id: 7, index: 2 };
    expect(await actions.moveModuleTo(input)).toEqual(OK);
    expect(mocks.forms.moveModuleToRequest).toHaveBeenCalledExactlyOnceWith("the-db", input, { email: "admin@example.test" });
    mocks.refresh.mockReset();
    mocks.revalidatePublic.mockReset();
    mocks.forms.moveModuleToRequest.mockResolvedValue({ ok: false, error: "invalid" });
    expect(await actions.moveModuleTo("nonsense")).toEqual({ ok: false, error: "invalid" });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.revalidatePublic).not.toHaveBeenCalled();
  });

  test("a lesson change (only in the account's JSON) refreshes the admin page and revalidates nothing", async () => {
    for (const run of [actions.moveLessonInList, actions.setLessonHidden]) {
      expect(await run(null, form({ id: 7 }))).toEqual(OK);
    }
    mocks.forms.setLessonKindForm.mockResolvedValue({ result: OK, obsolete: [] });
    expect(await actions.setLessonKind(null, form({ id: 7, kind: "video" }))).toEqual(OK);
    expect(await actions.removeLessonFile(7)).toEqual(OK);
    expect(await actions.undoRemoveLessonFile(7)).toEqual(OK);
    expect(mocks.revalidatePublic).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledTimes(5);
  });

  test("B18: the changes that may write a published course's outline draft are handed the admin (the draft's updated_by); an add is not", async () => {
    const admin = { email: "admin@example.test" };
    const fd = form({ id: 7 });
    for (const [run, name] of [
      [actions.deleteModule, "deleteModuleForm"],
      [actions.moveLessonInList, "moveLessonForm"],
    ] as const) {
      await run(null, fd);
      expect(mocks.forms[name], name).toHaveBeenCalledExactlyOnceWith("the-db", fd, admin);
    }
    mocks.forms.deleteLessonForm.mockResolvedValue({ result: { ok: false, error: "inUse" }, cleanup: { videoIds: [], fileKeys: [] } });
    await actions.deleteLesson(null, fd);
    expect(mocks.forms.deleteLessonForm).toHaveBeenCalledExactlyOnceWith("the-db", fd, admin);
    await actions.addModule(null, fd);
    expect(mocks.forms.addModuleForm).toHaveBeenCalledExactlyOnceWith("the-db", fd);
  });

  test("a refused change revalidates and refreshes nothing; a thrown one is `server`, logged without its message", async () => {
    mocks.forms.deleteModuleForm.mockResolvedValue({ ok: false, error: "notFound" });
    expect(await actions.deleteModule(null, form({ id: 7 }))).toEqual({ ok: false, error: "notFound" });
    mocks.forms.addModuleForm.mockRejectedValue(new Error("insert into course_modules … kati@example.test"));
    expect(await actions.addModule(null, form({ courseId: 5 }))).toEqual({ ok: false, error: "server" });
    expect(mocks.revalidatePublic).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[admin] module add failed: Error");
  });
});

describe("where an action goes next", () => {
  test("Lisa õppetund opens the new lesson in the drawer of its own course, whatever course the form names; a refused one stays", async () => {
    mocks.forms.addLessonForm.mockResolvedValue({ ok: true, id: 9, created: true });
    expect(await redirectOf(actions.addLesson(null, form({ moduleId: 3, courseId: 5, titleEt: "Tere" })))).toBe("/admin/koolitused/5?oppetund=9");
    expect(await redirectOf(actions.addLesson(null, form({ moduleId: 3, courseId: 8, titleEt: "Tere" })))).toBe("/admin/koolitused/5?oppetund=9");
    expect(await redirectOf(actions.addLesson(null, form({ moduleId: 3, titleEt: "Tere" })))).toBe("/admin/koolitused/5?oppetund=9");
    expect(mocks.forms.courseOfLesson.mock.calls).toEqual([["the-db", 9], ["the-db", 9], ["the-db", 9]]);
    mocks.forms.addLessonForm.mockResolvedValue({ ok: false, error: "invalid", fields: { title: "required" } });
    expect(await redirectOf(actions.addLesson(null, form({ moduleId: 3, courseId: 5 })))).toBeNull();
    expect(mocks.forms.courseOfLesson).toHaveBeenCalledTimes(3); // not asked for a lesson that was not added
  });

  test("Kustuta õppetund: back to the lesson's own course (read before the row goes); its videos and files go after the answer", async () => {
    const store = fakeMediaStore({ "lessons/a.pdf": { bytes: [1] } });
    mocks.store = store;
    mocks.forms.deleteLessonForm.mockResolvedValue({ result: { ok: true, id: 7, deleted: true }, cleanup: { videoIds: ["v1", "v2"], fileKeys: ["lessons/a.pdf"] } });
    expect(await redirectOf(actions.deleteLesson(null, form({ id: 7, courseId: 8 })))).toBe("/admin/koolitused/5");
    expect(mocks.forms.courseOfLesson).toHaveBeenCalledExactlyOnceWith("the-db", 7);
    expect(mocks.forms.courseOfLesson.mock.invocationCallOrder[0]).toBeLessThan(mocks.forms.deleteLessonForm.mock.invocationCallOrder[0]);
    // the answer has gone: nothing has been asked of Bunny or the store yet, one task is scheduled
    expect(mocks.deleteVideo).not.toHaveBeenCalled();
    expect(store.deleted).toEqual([]);
    expect(mocks.scheduled).toHaveLength(1);
    await runScheduled();
    expect(mocks.deleteVideo.mock.calls).toEqual([["v1"], ["v2"]]);
    expect(store.deleted).toEqual(["lessons/a.pdf"]);
  });

  test("the answer does not wait for Bunny: a delete that never answers still lets the action finish", async () => {
    mocks.deleteVideo.mockImplementation(() => new Promise(() => {}));
    mocks.forms.deleteLessonForm.mockResolvedValue({ result: { ok: true, id: 7, deleted: true }, cleanup: { videoIds: ["v1"], fileKeys: [] } });
    expect(await redirectOf(actions.deleteLesson(null, form({ id: 7 })))).toBe("/admin/koolitused/5");
    mocks.forms.setLessonKindForm.mockResolvedValue({ result: OK, obsolete: ["v2"] });
    expect(await actions.setLessonKind(null, form({ id: 7, kind: "text" }))).toEqual(OK);
    expect(mocks.scheduled).toHaveLength(2);
    expect(mocks.deleteVideo).not.toHaveBeenCalled();
  });

  test("a lesson with progress is not deleted: nothing leaves Bunny or the store, and the drawer stays with the answer", async () => {
    mocks.forms.deleteLessonForm.mockResolvedValue({ result: { ok: false, error: "inUse" }, cleanup: { videoIds: [], fileKeys: [] } });
    expect(await actions.deleteLesson(null, form({ id: 7, courseId: 5 }))).toEqual({ ok: false, error: "inUse" });
    expect(mocks.scheduled).toHaveLength(0);
    expect(mocks.deleteVideo).not.toHaveBeenCalled();
  });

  test("Eemalda (Task 10, R-f): the file is only marked, nothing leaves the store; the purge of files marked 10 s ago and more runs after the answer", async () => {
    const store = fakeMediaStore({ "lessons/b.pdf": { bytes: [1] } });
    mocks.store = store;
    expect(await actions.removeLessonFile(4)).toEqual(OK);
    expect(mocks.removeLessonFile).toHaveBeenCalledExactlyOnceWith("the-db", 4, expect.any(Date));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(store.deleted).toEqual([]);
    expect(mocks.purge).not.toHaveBeenCalled(); // the answer does not wait for R2
    await runScheduled();
    expect(mocks.purge).toHaveBeenCalledExactlyOnceWith("the-db", store, expect.any(Date));
    expect(store.deleted).toEqual([]); // (the purge is the one that deletes: a file marked now is not due)
  });

  test("„Võta tagasi“ of a file: the mark is cleared first, the purge comes after it (it can never take the file it brings back)", async () => {
    expect(await actions.undoRemoveLessonFile(4)).toEqual(OK);
    expect(mocks.restoreLessonFile).toHaveBeenCalledExactlyOnceWith("the-db", 4);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.purge).not.toHaveBeenCalled();
    await runScheduled();
    expect(mocks.purge).toHaveBeenCalledOnce();
    expect(mocks.restoreLessonFile.mock.invocationCallOrder[0]).toBeLessThan(mocks.purge.mock.invocationCallOrder[0]);
  });

  test("a file's removal or undo with no row id is invalid and asks nothing; a refusal (purged meanwhile) refreshes nothing", async () => {
    for (const bad of ["4", 0, -1, 1.5, 2 ** 31, null, { id: 4 }]) {
      expect(await actions.removeLessonFile(bad), String(bad)).toEqual({ ok: false, error: "invalid" });
      expect(await actions.undoRemoveLessonFile(bad), String(bad)).toEqual({ ok: false, error: "invalid" });
    }
    expect(mocks.removeLessonFile).not.toHaveBeenCalled();
    expect(mocks.restoreLessonFile).not.toHaveBeenCalled();
    mocks.restoreLessonFile.mockResolvedValue({ ok: false, error: "notFound" });
    expect(await actions.undoRemoveLessonFile(4)).toEqual({ ok: false, error: "notFound" });
    expect(mocks.refresh).not.toHaveBeenCalled();
    mocks.removeLessonFile.mockRejectedValue(new Error("update lesson_files … lessons/secret.pdf"));
    expect(await actions.removeLessonFile(4)).toEqual({ ok: false, error: "server" });
    expect(log).toHaveBeenCalledWith("[admin] lesson file remove failed: Error");
  });
});

describe("Bunny never fails a stored change", () => {
  test("to Tekst: every obsolete video is asked for; a time-out and a Bunny error are logged without ids, the answer is ok", async () => {
    mocks.forms.setLessonKindForm.mockResolvedValue({ result: OK, obsolete: ["slow-video", "bad-video", "good-video"] });
    mocks.deleteVideo.mockImplementation(async (id: string) => {
      if (id === "slow-video") throw new DOMException("Bunny did not answer in time", "TimeoutError");
      if (id === "bad-video") throw new BunnyError("delete", 500);
    });
    expect(await actions.setLessonKind(null, form({ id: 7, kind: "text" }))).toEqual(OK);
    expect(mocks.deleteVideo).not.toHaveBeenCalled(); // after the answer
    await runScheduled();
    expect(mocks.deleteVideo.mock.calls).toEqual([["slow-video"], ["bad-video"], ["good-video"]]);
    expect(log.mock.calls.map((c) => c[0])).toEqual([expect.stringMatching(/^\[lesson\] video not deleted: TimeoutError\b/), "[lesson] video not deleted: BunnyError (status 500)"]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/slow-video|bad-video|good-video/);
  });

  test("without Bunny set up nothing is asked; settings that cannot be read are logged, the change still answers ok", async () => {
    mocks.forms.setLessonKindForm.mockResolvedValue({ result: OK, obsolete: ["v1"] });
    mocks.config = null;
    expect(await actions.setLessonKind(null, form({ id: 7, kind: "text" }))).toEqual(OK);
    await runScheduled();
    expect(mocks.deleteVideo).not.toHaveBeenCalled();
    mocks.config_throws = true;
    expect(await actions.setLessonKind(null, form({ id: 7, kind: "text" }))).toEqual(OK);
    mocks.forms.deleteLessonForm.mockResolvedValue({ result: { ok: true, id: 7, deleted: true }, cleanup: { videoIds: ["v1"], fileKeys: [] } });
    expect(await redirectOf(actions.deleteLesson(null, form({ id: 7, courseId: 5 })))).toBe("/admin/koolitused/5");
    await expect(runScheduled()).resolves.toBeUndefined();
    expect(log.mock.calls.map((c) => c[0])).toEqual(["[admin] lesson kind cleanup failed: Error", "[admin] lesson delete cleanup failed: Error"]);
  });

  test("a failed Bunny delete while deleting a lesson: its files are still removed", async () => {
    const store = fakeMediaStore({ "lessons/c.pdf": { bytes: [1] } });
    mocks.store = store;
    mocks.deleteVideo.mockRejectedValue(new DOMException("Bunny did not answer in time", "TimeoutError"));
    mocks.forms.deleteLessonForm.mockResolvedValue({ result: { ok: true, id: 7, deleted: true }, cleanup: { videoIds: ["v1"], fileKeys: ["lessons/c.pdf"] } });
    expect(await redirectOf(actions.deleteLesson(null, form({ id: 7, courseId: 5 })))).toBe("/admin/koolitused/5");
    await runScheduled();
    expect(store.deleted).toEqual(["lessons/c.pdf"]);
  });
});

describe("the video field's two actions (createLessonVideo, checkLessonVideo)", () => {
  const TICKET = { videoId: "v-1", libraryId: "lib", expires: 99, signature: "sig", endpoint: "https://tus.example/tusupload", title: "K · L" };

  test("the ticket and the state pass through; nothing is revalidated or refreshed (the field refreshes on a status change)", async () => {
    mocks.startLessonVideo.mockResolvedValue(TICKET);
    mocks.refreshLessonVideo.mockResolvedValue({ status: "processing", durationSec: null, replacing: false });
    expect(await actions.createLessonVideo(7)).toEqual({ ok: true, ticket: TICKET });
    expect(mocks.startLessonVideo).toHaveBeenCalledWith("the-db", expect.anything(), mocks.config, 7, expect.any(Date));
    expect(await actions.checkLessonVideo(7)).toEqual({ ok: true, video: { status: "processing", durationSec: null, replacing: false } });
    expect(mocks.refreshLessonVideo).toHaveBeenCalledWith("the-db", expect.anything(), { lessonId: 7 });
    expect(mocks.revalidatePublic).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  test("without Bunny set up: `setup`, and nothing is asked", async () => {
    mocks.config = null;
    expect(await actions.createLessonVideo(7)).toEqual({ ok: false, error: "setup" });
    expect(await actions.checkLessonVideo(7)).toEqual({ ok: false, error: "setup" });
    expect(mocks.startLessonVideo).not.toHaveBeenCalled();
    expect(mocks.refreshLessonVideo).not.toHaveBeenCalled();
  });

  test("anything but a row id from the browser is notFound, and nothing is asked", async () => {
    for (const id of [0, -1, 1.5, 2_147_483_648, Number.NaN, "7", null, { id: 7 }] as unknown as number[]) {
      expect(await actions.createLessonVideo(id), String(id)).toEqual({ ok: false, error: "notFound" });
      expect(await actions.checkLessonVideo(id), String(id)).toEqual({ ok: false, error: "notFound" });
    }
    expect(mocks.startLessonVideo).not.toHaveBeenCalled();
    expect(mocks.refreshLessonVideo).not.toHaveBeenCalled();
  });

  test("an unknown or text lesson is notFound", async () => {
    mocks.startLessonVideo.mockResolvedValue("notFound");
    mocks.refreshLessonVideo.mockResolvedValue(null);
    expect(await actions.createLessonVideo(7)).toEqual({ ok: false, error: "notFound" });
    expect(await actions.checkLessonVideo(7)).toEqual({ ok: false, error: "notFound" });
  });

  test("Bunny failing or not answering is `server`, logged without ids or keys", async () => {
    mocks.startLessonVideo.mockRejectedValue(new BunnyError("create", 401));
    mocks.refreshLessonVideo.mockRejectedValue(new DOMException("Bunny did not answer in time", "TimeoutError"));
    expect(await actions.createLessonVideo(7)).toEqual({ ok: false, error: "server" });
    expect(await actions.checkLessonVideo(7)).toEqual({ ok: false, error: "server" });
    expect(log.mock.calls.map((c) => c[0])).toEqual(["[admin] video create failed: BunnyError (status 401)", expect.stringMatching(/^\[admin\] video check failed: TimeoutError\b/)]);
  });
});

describe("the course editor's read purges too (R-f; Task 2 carry)", () => {
  test("the page hands purgeRemovedLessonFiles to after(): files marked 10 s ago and more go with a read, and the page never waits for R2", () => {
    // (a server page the unit tests do not render: its source is pinned)
    const page = readFileSync(join(process.cwd(), "src", "app", "admin", "(panel)", "koolitused", "[id]", "page.tsx"), "utf8");
    expect(page).toMatch(/import \{ after \} from "next\/server";/);
    expect(page).toMatch(/after\(\(\) => purgeRemovedLessonFiles\(db, mediaStore\(\), new Date\(\)\)\)/);
  });
});
