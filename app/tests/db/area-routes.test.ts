import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courseAreas, courses } from "@/db/schema";
import { createSession } from "@/server/auth";
import { makeTestDb } from "./helpers";

// Seaded → „Valdkonnad“'s routes (course areas, spec 2026-11-11-course-areas-filter-design.md §4.1; server/course-areas.ts):
// - POST /api/admin/valdkond/<id>: a row's names, autosaved under server/autosave-route.ts' contract (200 the row's new version, 409 the names as
//   stored, 400 by field, 404 no such area);
// - POST /api/admin/valdkond/uus `{ et, ru }`: „Lisa valdkond“ (200 the list with the new id, 400 by field);
// - POST /api/admin/valdkond/<id>/liiguta `{ index }`: a move (200 the list, 404, 400 a body that is no place);
// - POST /api/admin/valdkond/<id>/kustuta: „Kustuta“ (200 the list, 409 inUse with how many, 404).
// Signed-in admins only (401), never from another site (403); every answer no-store. On PGlite, with the admin's session cookie faked (as
// tests/db/seaded-route.test.ts does). The migration's two areas are there: „Kulmukoolitused“ (1), „Ripsmekoolitused“ (2).

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
const pub = vi.hoisted(() => ({ revalidatePublic: vi.fn() }));
vi.mock("@/server/public-cache", () => pub);

import { POST as nameRoute } from "@/app/api/admin/valdkond/[id]/route";
import { POST as moveRoute } from "@/app/api/admin/valdkond/[id]/liiguta/route";
import { POST as deleteRoute } from "@/app/api/admin/valdkond/[id]/kustuta/route";
import { POST as addRoute } from "@/app/api/admin/valdkond/uus/route";

const ORIGIN = "https://mslab.example";
const HEX = /^[0-9a-f]{32}$/;
let db: Db;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  pub.revalidatePublic.mockReset();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  for (const method of ["info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
type Route = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function call(route: Route, path: string, id: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await route(
    new Request(`${ORIGIN}/api/admin/valdkond/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, cache: res.headers.get("cache-control"), body: (await res.json()) as Record<string, unknown> };
}
const name = (id: string, body: unknown, headers?: Record<string, string>) => call(nameRoute, id, id, body, headers);
const add = (body: unknown, headers?: Record<string, string>) => call(addRoute as unknown as Route, "uus", "", body, headers);
const move = (id: string, body: unknown) => call(moveRoute, `${id}/liiguta`, id, body);
const remove = (id: string) => call(deleteRoute, `${id}/kustuta`, id);
const stored = async () => (await db.select().from(courseAreas).orderBy(asc(courseAreas.sort), asc(courseAreas.id))).map((a) => a.name.et);
/** The row's version as the route holds it: a save from no version is a conflict, which tells it. */
async function versionOf(id: string) {
  const a = await name(id, { version: "?", patch: {} });
  expect(a.status).toBe(409);
  return a.body.version as string;
}

describe("signed in, same site", () => {
  test("without an admin's session every route is 401; from another site 403 — nothing stored", async () => {
    expect((await name("1", { version: "x", patch: { et: "Kulm" } })).status).toBe(401);
    expect((await add({ et: "Meik", ru: "Макияж" })).status).toBe(401);
    expect((await move("1", { index: 1 })).status).toBe(401);
    expect((await remove("2")).status).toBe(401);
    await signIn();
    expect((await name("1", { version: "x", patch: { et: "Kulm" } }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await add({ et: "Meik", ru: "Макияж" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await stored()).toEqual(["Kulmukoolitused", "Ripsmekoolitused"]);
  });
});

describe("POST /api/admin/valdkond/<id> (a row's names)", () => {
  beforeEach(signIn);

  test("saved from its version: 200 with the new one, no-store; the calendar and the catalogue revalidated", async () => {
    const answer = await name("1", { version: await versionOf("1"), patch: { et: "Kulmud" } });
    expect(answer).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, version: expect.stringMatching(HEX) } });
    expect(await stored()).toEqual(["Kulmud", "Ripsmekoolitused"]);
    expect(pub.revalidatePublic.mock.calls).toEqual([[{ kind: "areas" }]]);
  });

  test("409 with the names as stored; 400 by field (empty, too long, taken, a key that is no name); 404 for no such area", async () => {
    expect(await name("1", { version: "old", patch: { et: "Kulmud" } })).toMatchObject({ status: 409, body: { ok: false, error: "conflict", value: { et: "Kulmukoolitused", ru: "Курсы по бровям" } } });
    const version = await versionOf("1");
    expect(await name("1", { version, patch: { et: " ", ru: "x".repeat(61) } })).toMatchObject({ status: 400, body: { ok: false, error: "invalid", fields: { et: "required", ru: "tooLong" } } });
    expect(await name("1", { version, patch: { et: "Ripsmekoolitused" } })).toMatchObject({ status: 400, body: { fields: { et: "taken" } } });
    expect(await name("1", { version, patch: { sort: 9 } })).toMatchObject({ status: 400, body: { ok: false, error: "invalid" } });
    for (const id of ["99", "x", "0"]) expect((await name(id, { version, patch: { et: "Kulmud" } })).status, id).toBe(404);
    expect(await stored()).toEqual(["Kulmukoolitused", "Ripsmekoolitused"]);
  });
});

describe("POST /api/admin/valdkond/uus („Lisa valdkond“)", () => {
  beforeEach(signIn);

  test("200 with the list and the new area's id (last); 400 by field; a body that is no JSON is 400", async () => {
    const answer = await add({ et: "Meik", ru: "Макияж" });
    expect(answer).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, id: expect.any(Number) } });
    expect((answer.body.areas as { name: { et: string } }[]).map((a) => a.name.et)).toEqual(["Kulmukoolitused", "Ripsmekoolitused", "Meik"]);
    expect(await add({ et: "meik", ru: "Макияж" })).toMatchObject({ status: 400, body: { ok: false, error: "invalid", fields: { et: "taken" } } });
    expect(await add({ et: "Pedikuur", ru: "" })).toMatchObject({ status: 400, body: { fields: { ru: "required" } } });
    const res = await addRoute(new Request(`${ORIGIN}/api/admin/valdkond/uus`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }), undefined);
    expect(res.status).toBe(400);
    expect(await stored()).toEqual(["Kulmukoolitused", "Ripsmekoolitused", "Meik"]);
  });
});

describe("POST /api/admin/valdkond/<id>/liiguta and …/kustuta", () => {
  beforeEach(signIn);

  test("a move: 200 with the list in its new order; 404 for no such area; 400 for a body that is no place", async () => {
    const answer = await move("2", { index: 0 });
    expect(answer).toMatchObject({ status: 200, cache: "no-store", body: { ok: true } });
    expect((answer.body.areas as { id: number }[]).map((a) => a.id)).toEqual([2, 1]);
    expect((await move("99", { index: 0 })).status).toBe(404);
    expect((await move("x", { index: 0 })).status).toBe(404);
    for (const body of [{}, { index: -1 }, { index: 1.5 }, { index: "0" }]) expect((await move("1", body)).status, JSON.stringify(body)).toBe(400);
    expect(await stored()).toEqual(["Ripsmekoolitused", "Kulmukoolitused"]);
  });

  test("a delete: 200 with the list; one a course uses is 409 with how many; 404 for no such area", async () => {
    await db.insert(courses).values({ slug: "k", type: "contact", level: "basic", title: { et: "K" }, summary: { et: "" }, body: { et: "" }, areaId: 1, sort: 1 });
    expect(await remove("1")).toMatchObject({ status: 409, cache: "no-store", body: { ok: false, error: "inUse", used: 1 } });
    const answer = await remove("2");
    expect(answer).toMatchObject({ status: 200, body: { ok: true } });
    expect((answer.body.areas as { id: number }[]).map((a) => a.id)).toEqual([1]);
    expect((await remove("2")).status).toBe(404);
    expect(await stored()).toEqual(["Kulmukoolitused"]);
  });
});
