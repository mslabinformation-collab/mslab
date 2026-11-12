import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { courses } from "@/db/schema";
import { createSession } from "@/server/auth";
import { listCertificateDesigns, readCertificateDesign } from "@/server/certificate-designs";
import { fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// The routes of Seaded → Tunnistus → „Kujundused“ (2026-11-11 certificate designs, spec §5.1): POST /api/admin/tunnistuse-kujundus („Lisa
// kujundus“), POST /api/admin/tunnistuse-kujundus/<id> (a row's autosave, server/autosave-route.ts' contract) and DELETE of the same („Kustuta“).
// The rules themselves are tests/db/certificate-designs.test.ts'; here the answers. PGlite, the session cookie faked (as admin-certificate-route).

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined, store: null as unknown }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/media-store", () => ({ mediaStore: () => state.store }));

import { POST as create, maxDuration as createMaxDuration } from "@/app/api/admin/tunnistuse-kujundus/route";
import { DELETE as remove, POST as save, maxDuration } from "@/app/api/admin/tunnistuse-kujundus/[id]/route";

const ORIGIN = "https://mslab.example";
const KEY = "img/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";

let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  state.store = fakeMediaStore({ [KEY]: { bytes: [...readFileSync("tests/fixtures/certificate-background.jpg")], contentType: "image/jpeg" } });
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, body: unknown) =>
  save(new Request(`${ORIGIN}/api/admin/tunnistuse-kujundus/${id}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), ctx(id));
const del = (id: string) => remove(new Request(`${ORIGIN}/api/admin/tunnistuse-kujundus/${id}`, { method: "DELETE" }), ctx(id));
const answer = async (res: Response) => [res.status, await res.json()];

describe("the designs' routes", () => {
  test("without an admin's session: 401, nothing changed; a cross-site write 403", async () => {
    expect(await answer(await create(new Request(`${ORIGIN}/api/admin/tunnistuse-kujundus`, { method: "POST" }), undefined))).toEqual([401, { ok: false, error: "unauthorized" }]);
    const [hele] = await listCertificateDesigns(db);
    expect((await post(String(hele.id), { version: "x", patch: { name: "Uus" } })).status).toBe(401);
    expect((await del(String(hele.id))).status).toBe(401);
    await signIn();
    const cross = await remove(new Request(`${ORIGIN}/api/admin/tunnistuse-kujundus/${hele.id}`, { method: "DELETE", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), ctx(String(hele.id)));
    expect(cross.status).toBe(403);
    expect((await listCertificateDesigns(db)).map((d) => d.name)).toEqual(["Hele", "Tume"]);
  });

  test("„Lisa kujundus“: 201 with the new design's id; its row saves, refuses by field and answers a stale version with the stored fields", async () => {
    await signIn();
    const res = await create(new Request(`${ORIGIN}/api/admin/tunnistuse-kujundus`, { method: "POST" }), undefined);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    expect((await readCertificateDesign(db, id))!.value).toEqual({ name: "Uus kujundus", tone: "light", backgroundKey: "" });
    const v1 = (await readCertificateDesign(db, id))!.version;
    const saved = await post(String(id), { version: v1, patch: { name: "Lilled", backgroundKey: KEY } });
    expect(saved.status).toBe(200);
    const { version: v2 } = (await saved.json()) as { version: string };
    expect((await readCertificateDesign(db, id))!).toEqual({ version: v2, value: { name: "Lilled", tone: "light", backgroundKey: KEY } });
    expect(await answer(await post(String(id), { version: v2, patch: { name: "Tume" } }))).toEqual([400, { ok: false, error: "invalid", fields: { name: "taken" } }]);
    expect(await answer(await post(String(id), { version: v1, patch: { tone: "dark" } }))).toEqual([409, { ok: false, error: "conflict", version: v2, value: { name: "Lilled", tone: "light", backgroundKey: KEY } }]);
    expect(await answer(await post(String(id), { version: v2, patch: { sort: 0 } }))).toEqual([400, { ok: false, error: "invalid", fields: { sort: "invalid" } }]);
    expect(await answer(await post("999999", { version: v2, patch: { name: "X" } }))).toEqual([404, { ok: false, error: "notFound" }]);
    expect(await answer(await post("abc", { version: v2, patch: { name: "X" } }))).toEqual([404, { ok: false, error: "notFound" }]);
  });

  test("„Lisa kujundus +“ with the add row's name: 201 and that name; refused by field (400), nothing added; a body that is no object is 400", async () => {
    await signIn();
    const make = (body: string) => create(new Request(`${ORIGIN}/api/admin/tunnistuse-kujundus`, { method: "POST", body, headers: { "content-type": "application/json" } }), undefined);
    const res = await make(JSON.stringify({ name: "Lilled" }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    expect((await readCertificateDesign(db, id))!.value.name).toBe("Lilled");
    expect(await answer(await make(JSON.stringify({ name: "hele" })))).toEqual([400, { ok: false, error: "invalid", fields: { name: "taken" } }]);
    expect(await answer(await make(JSON.stringify({ name: 5 })))).toEqual([400, { ok: false, error: "invalid", fields: { name: "invalid" } }]);
    expect(await answer(await make("[1]"))).toEqual([400, { ok: false, error: "invalid" }]);
    expect((await listCertificateDesigns(db)).map((d) => d.name)).toEqual(["Hele", "Tume", "Lilled"]);
  });

  test("„Kustuta“: 200 for a design no course uses; 409 with the count while one does; 409 `last`; 404 for none", async () => {
    await signIn();
    const [hele, tume] = await listCertificateDesigns(db);
    await db.insert(courses).values({ slug: "e", type: "e_learning", level: "basic", title: { et: "E" }, summary: { et: "" }, body: { et: "" }, certificateDesignId: tume.id });
    expect(await answer(await del(String(tume.id)))).toEqual([409, { ok: false, error: "inUse", courses: 1 }]);
    await db.delete(courses);
    expect(await answer(await del(String(tume.id)))).toEqual([200, { ok: true }]);
    expect(await answer(await del(String(tume.id)))).toEqual([404, { ok: false, error: "notFound" }]);
    expect(await answer(await del(String(hele.id)))).toEqual([409, { ok: false, error: "last" }]);
    expect(await answer(await del("x"))).toEqual([404, { ok: false, error: "notFound" }]);
  });

  test("a hung call does not hold the function: maxDuration 30", () => {
    expect([createMaxDuration, maxDuration]).toEqual([30, 30]);
  });
});
