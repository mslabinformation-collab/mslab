import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { contentDrafts, courseModules, courses, lessons } from "@/db/schema";
import { createSession } from "@/server/auth";
import { makeTestDb } from "./helpers";

// A row's text autosave (admin UX pass piece 3a, Task 5 review I-1; R-b amended: "t:<hash of the row's working text>"): POST /api/admin/moodul/<id>
// (a module's name) and /api/admin/oppetund/<id> (a lesson's name and short text), server/autosave-route.ts' contract around
// server/admin-lessons.ts writeOutlineText. On PGlite, with the admin's session cookie faked (as tests/db/course-parts-routes.test.ts does).

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import { POST as saveModule } from "@/app/api/admin/moodul/[id]/route";
import { POST as saveLesson } from "@/app/api/admin/oppetund/[id]/route";

const ORIGIN = "https://mslab.example";
let db: Db;
let mod: number;
let lesson: number;

async function course(published: boolean) {
  const [{ id }] = await db
    .insert(courses)
    .values({ slug: published ? "avaldatud" : "mustand", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" }, price: 9500, published })
    .returning();
  [{ id: mod }] = await db.insert(courseModules).values({ courseId: id, position: 1, title: { et: "Moodul" } }).returning();
  [{ id: lesson }] = await db.insert(lessons).values({ moduleId: mod, position: 1, title: { et: "Tund" } }).returning();
}

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  pub.revalidatePublic.mockReset();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
const answerOf = async (res: Response) => ({ status: res.status, cache: res.headers.get("cache-control"), body: await res.json() });
const moduleSave = async (id: string | number, body: unknown, headers?: Record<string, string>) => answerOf(await saveModule(post(`/api/admin/moodul/${id}`, body, headers), ctx(id)));
const lessonSave = async (id: string | number, body: unknown) => answerOf(await saveLesson(post(`/api/admin/oppetund/${id}`, body), ctx(id)));
/** The row's version, from the conflict a save on no version gets. */
const versionOf = async (kind: "module" | "lesson", id: number) => (kind === "module" ? await moduleSave(id, { version: "?", patch: {} }) : await lessonSave(id, { version: "?", patch: {} })).body.version as string;

describe("POST /api/admin/moodul/<id> and /api/admin/oppetund/<id>", () => {
  test("without an admin's session: 401; from another site: 403; nothing stored", async () => {
    await course(true);
    expect((await moduleSave(mod, { version: "t:0", patch: { title: { et: "X" } } })).status).toBe(401);
    expect((await lessonSave(lesson, { version: "t:0", patch: { title: { et: "X" } } })).status).toBe(401);
    await signIn();
    expect((await moduleSave(mod, { version: "t:0", patch: { title: { et: "X" } } }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await db.select().from(contentDrafts)).toEqual([]);
  });

  test("the contract: 200 with the row's t: version, 409 with the stored text, 400 per field, 404 for no such row or a deleted one", async () => {
    await course(true);
    await signIn();
    const v = await versionOf("lesson", lesson);
    expect(v).toMatch(/^t:[0-9a-f]{32}$/);
    const saved = await lessonSave(lesson, { version: v, patch: { body: { et: "Loe." } } });
    expect(saved).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, version: expect.stringMatching(/^t:/) } });
    expect(await lessonSave(lesson, { version: v, patch: { title: { et: "Teine aken" } } })).toEqual({
      status: 409,
      cache: "no-store",
      body: { ok: false, error: "conflict", version: saved.body.version, value: { title: { et: "Tund" }, body: { et: "Loe." } } },
    });
    expect(await lessonSave(lesson, { version: saved.body.version, patch: { title: { et: "" } } })).toMatchObject({ status: 400, body: { error: "invalid", fields: { title: "required" } } });
    // a module has no short text: refused by its schema
    expect(await moduleSave(mod, { version: await versionOf("module", mod), patch: { body: { et: "x" } } })).toMatchObject({ status: 400, body: { error: "invalid", fields: { body: expect.any(String) } } });
    // the live row is unchanged (a published course: the draft has the text)
    expect((await db.select().from(lessons).where(eq(lessons.id, lesson)))[0].body).toBeNull();
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    // gone
    await db.delete(lessons).where(eq(lessons.id, lesson));
    expect(await lessonSave(lesson, { version: saved.body.version, patch: { title: { et: "X" } } })).toMatchObject({ status: 404, body: { ok: false, error: "notFound" } });
    for (const id of ["999999", "x"]) expect((await moduleSave(id, { version: "t:0", patch: {} })).status, id).toBe(404);
  });

  test("the public pages are revalidated only when a module's name goes live: an unpublished course's module (a draft and a lesson: never)", async () => {
    await course(true);
    await signIn();
    expect((await moduleSave(mod, { version: await versionOf("module", mod), patch: { title: { et: "Uus" } } })).status).toBe(200);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    await course(false);
    expect((await lessonSave(lesson, { version: await versionOf("lesson", lesson), patch: { title: { et: "Uus tund" } } })).status).toBe(200);
    expect(pub.revalidatePublic).not.toHaveBeenCalled();
    expect((await moduleSave(mod, { version: await versionOf("module", mod), patch: { title: { et: "Uus moodul" } } })).status).toBe(200);
    expect(pub.revalidatePublic.mock.calls).toEqual([[{ kind: "courses" }]]);
    expect((await db.select().from(courseModules).where(eq(courseModules.id, mod)))[0].title).toEqual({ et: "Uus moodul" });
  });
});
