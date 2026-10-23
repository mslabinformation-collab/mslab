import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { contentDrafts, courseModules, courses, lessons } from "@/db/schema";
import { createSession } from "@/server/auth";
import { makeTestDb } from "./helpers";

// The course parts' routes (admin UX pass piece 3a, Task 4): POST /api/admin/koolitus/<id>/osa/<part> (a part's autosave, server/autosave-route.ts'
// contract), /avalda („Avalda muudatused“: `{ published, blocked }`) and /loobu („Loobu muudatustest“: `{ discarded }`, the flagged rows' media
// removed after the answer). On PGlite, with the admin's session cookie faked (as tests/db/registration-note-route.test.ts does).

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined, after: [] as (() => Promise<void>)[] }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => Promise<void>) => void state.after.push(fn) }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);
const media = vi.hoisted(() => ({ removeLessonMedia: vi.fn(async () => {}) }));
vi.mock("@/server/lesson-media", () => media);

import { POST as savePart } from "@/app/api/admin/koolitus/[id]/osa/[part]/route";
import { POST as publish } from "@/app/api/admin/koolitus/[id]/avalda/route";
import { POST as discard } from "@/app/api/admin/koolitus/[id]/loobu/route";

const ORIGIN = "https://mslab.example";
let db: Db;
let course: { id: number };

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  state.after = [];
  pub.revalidatePublic.mockReset();
  media.removeLessonMedia.mockClear();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  [course] = await db.insert(courses).values({ slug: "e-kulm", type: "e_learning", level: "basic", title: { et: "E-kulm" }, summary: { et: "" }, body: { et: "" }, price: 9500, published: true }).returning();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const save = (id: string | number, part: string, body: unknown, headers: Record<string, string> = {}) =>
  savePart(post(`/api/admin/koolitus/${id}/osa/${part}`, body, headers), { params: Promise.resolve({ id: String(id), part }) });
const answerOf = async (res: Response) => ({ status: res.status, cache: res.headers.get("cache-control"), body: await res.json() });
const versionOf = async (part: string) => (await answerOf(await save(course.id, part, { version: "?", patch: {} }))).body.version as string;

describe("POST /api/admin/koolitus/<id>/osa/<part>", () => {
  test("without an admin's session: 401; from another site: 403; nothing stored", async () => {
    expect((await save(course.id, "basics", { version: "l:x", patch: { title: { et: "Uus" } } })).status).toBe(401);
    await signIn();
    expect((await save(course.id, "basics", { version: "l:x", patch: { title: { et: "Uus" } } }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await db.select().from(contentDrafts)).toEqual([]);
  });

  test("the autosave contract: 200 with the draft's version, 409 with what is stored, 400 per field, 404 for no such course or part", async () => {
    await signIn();
    const live = await versionOf("basics"); // a conflict tells the version
    expect(live).toMatch(/^l:[0-9a-f]{32}$/);
    const first = await answerOf(await save(course.id, "basics", { version: live, patch: { title: { et: "Uus nimi" } } }));
    expect(first).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, version: expect.stringMatching(/^d:[1-9][0-9]*.1$/), savedAt: expect.any(String) } });
    const draft = first.body.version as string;
    expect(await answerOf(await save(course.id, "basics", { version: live, patch: { title: { et: "Teine" } } }))).toMatchObject({ status: 409, body: { ok: false, error: "conflict", version: draft, value: { title: { et: "Uus nimi" } } } });
    expect(await answerOf(await save(course.id, "basics", { version: draft, patch: { slug: "Vale aadress!" } }))).toMatchObject({ status: 400, body: { ok: false, error: "invalid", fields: { slug: "slugFormat" } } });
    // a field of another part, or no field at all: refused by the part's schema
    expect(await answerOf(await save(course.id, "basics", { version: draft, patch: { price: "10" } }))).toMatchObject({ status: 400, body: { ok: false, error: "invalid", fields: { price: expect.any(String) } } });
    expect((await save(course.id, "basics", { version: draft })).status).toBe(400);
    for (const [id, part] of [[999_999, "basics"], [course.id, "outline"], [course.id, "nimi"], ["abc", "basics"]] as const) expect((await save(id, part, { version: "d:1", patch: {} })).status, `${id} ${part}`).toBe(404);
    expect((await db.select().from(courses).where(eq(courses.id, course.id)))[0].title).toEqual({ et: "E-kulm" });
  });
});

describe("POST /api/admin/koolitus/<id>/avalda and /loobu", () => {
  test("publish answers { published, blocked } and revalidates once; discard answers { discarded }", async () => {
    await signIn();
    expect((await publish(post(`/api/admin/koolitus/${course.id}/avalda`), { params: Promise.resolve({ id: String(course.id) }) })).status).toBe(200);
    await save(course.id, "basics", { version: await versionOf("basics"), patch: { title: { et: "Uus nimi" } } });
    await save(course.id, "price", { version: await versionOf("price"), patch: { price: "" } });
    const published = await answerOf(await publish(post(`/api/admin/koolitus/${course.id}/avalda`), { params: Promise.resolve({ id: String(course.id) }) }));
    expect(published).toEqual({ status: 200, cache: "no-store", body: { published: ["basics"], blocked: [{ part: "price", reason: "missing", fields: ["hind"] }] } });
    expect(pub.revalidatePublic.mock.calls).toEqual([[{ kind: "courses" }]]);
    const discarded = await answerOf(await discard(post(`/api/admin/koolitus/${course.id}/loobu`), { params: Promise.resolve({ id: String(course.id) }) }));
    expect(discarded).toEqual({ status: 200, cache: "no-store", body: { discarded: 1 } });
    expect(await db.select().from(contentDrafts)).toEqual([]);
    expect(state.after).toEqual([]); // nothing flagged: no cleanup
  });

  test("discard removes a flagged lesson's video after the answer (after())", async () => {
    await signIn();
    const [mod] = await db.insert(courseModules).values({ courseId: course.id, position: 1, title: { et: "Moodul 01" }, unpublished: true }).returning();
    await db.insert(lessons).values({ moduleId: mod.id, position: 1, title: { et: "Uus" }, unpublished: true, videoId: "v-new" });
    expect(await answerOf(await discard(post(`/api/admin/koolitus/${course.id}/loobu`), { params: Promise.resolve({ id: String(course.id) }) }))).toMatchObject({ status: 200, body: { discarded: 2 } });
    expect(media.removeLessonMedia).not.toHaveBeenCalled();
    expect(state.after).toHaveLength(1);
    await state.after[0]();
    expect(media.removeLessonMedia).toHaveBeenCalledWith({ videoIds: ["v-new"], fileKeys: [] }, expect.anything());
  });

  test("no session: 401; another site: 403; no such course: 404", async () => {
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    expect((await publish(post(`/api/admin/koolitus/${course.id}/avalda`), ctx(String(course.id)))).status).toBe(401);
    expect((await discard(post(`/api/admin/koolitus/${course.id}/loobu`), ctx(String(course.id)))).status).toBe(401);
    await signIn();
    expect((await publish(post(`/api/admin/koolitus/${course.id}/avalda`, undefined, { origin: "https://evil.example" }), ctx(String(course.id)))).status).toBe(403);
    for (const id of ["999999", "x"]) {
      expect((await publish(post(`/api/admin/koolitus/${id}/avalda`), ctx(id))).status).toBe(404);
      expect((await discard(post(`/api/admin/koolitus/${id}/loobu`), ctx(id))).status).toBe(404);
    }
  });
});
