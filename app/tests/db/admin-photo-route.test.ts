import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, courseAccess, courses, practicalPhotos, protocols } from "@/db/schema";
import { createSession } from "@/server/auth";
import { fakeMediaStore } from "../fakes";
import { makeTestDb } from "./helpers";

// GET /api/admin/foto/<id> (e-course completion, spec §5.3, R5): a student's practical photo for Maria's assessment screen — signed-in admins
// only, a 302 to a 5-minute signed R2 address (or the local folder's bytes), `?v=pisi` the thumbnail. The route runs with the database
// (PGlite), the admin's session cookie (next/headers) and the store faked, as tests/db/preview-routes.test.ts runs the admin's preview route.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined, store: null as unknown }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/server/media-store", () => ({ mediaStore: () => state.store }));

import { GET, maxDuration } from "@/app/api/admin/foto/[id]/route";

const ORIGIN = "https://mslab.example";
const KEY = "practical/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f.jpg";
const THUMB = "practical/0f8b6c2e-3d4a-4b5c-8d9e-0a1b2c3d4e5f-t.jpg";
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 7, 7];

let db: Db;
let photoId: number;
beforeAll(async () => {
  db = await makeTestDb();
  const [course] = await db
    .insert(courses)
    .values({ slug: "veebikursus", type: "e_learning", level: "basic", title: { et: "Veebikursus" }, summary: { et: "" }, body: { et: "" }, price: 9500, protocolStages: ["Ettevalmistus"] })
    .returning();
  const [client] = await db.insert(clients).values({ email: "kati@example.test", name: "Kati Kask" }).returning();
  const [access] = await db.insert(courseAccess).values({ clientId: client.id, courseId: course.id, grantedBy: "admin@example.test", expiresAt: new Date("2027-04-13T10:00:00Z") }).returning();
  const [protocol] = await db.insert(protocols).values({ accessId: access.id, stages: [{ title: "Ettevalmistus", note: "" }], verdicts: [null], round: 1 }).returning();
  const [photo] = await db.insert(practicalPhotos).values({ protocolId: protocol.id, stage: 0, round: 1, key: KEY, thumbKey: THUMB, size: JPEG.length, width: 2048, height: 1536 }).returning();
  photoId = photo.id;
});
beforeEach(() => {
  state.db = db;
  state.cookie = undefined;
  state.store = fakeMediaStore({ [KEY]: { bytes: JPEG, contentType: "image/jpeg" }, [THUMB]: { bytes: JPEG.slice(0, 4), contentType: "image/jpeg" } });
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const get = (id: string, query = "") => GET(new Request(`${ORIGIN}/api/admin/foto/${id}${query}`), { params: Promise.resolve({ id }) });
const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};

describe("GET /api/admin/foto/<id>", () => {
  test("without an admin's session: 401 (an address no longer allowed too), and the store is not asked", async () => {
    const res = await get(String(photoId));
    expect([res.status, await res.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
    state.cookie = await createSession(db, "former.admin@example.com");
    expect((await get(String(photoId))).status).toBe(401);
    expect((state.store as ReturnType<typeof fakeMediaStore>).requested).toEqual([]);
  });

  test("R2: a 302 to the full photo's signed address, ?v=pisi to the thumbnail's; private, never cached, no referrer", async () => {
    await signIn();
    const signedGetUrl = vi.fn(async (key: string) => `https://r2.example/${key}?X-Amz-Expires=300`);
    state.store = { ...fakeMediaStore(), signedGetUrl };
    const full = await get(String(photoId));
    expect(full.status).toBe(302);
    expect(full.headers.get("location")).toBe(`https://r2.example/${KEY}?X-Amz-Expires=300`);
    expect(full.headers.get("cache-control")).toBe("private, no-store");
    expect(full.headers.get("referrer-policy")).toBe("no-referrer");
    const thumb = await get(String(photoId), "?v=pisi");
    expect(thumb.headers.get("location")).toBe(`https://r2.example/${THUMB}?X-Amz-Expires=300`);
    expect(signedGetUrl.mock.calls).toEqual([
      [KEY, { expiresSec: 300 }],
      [THUMB, { expiresSec: 300 }],
    ]);
  });

  test("the local folder: the bytes inline as image/jpeg, nosniff", async () => {
    await signIn();
    const res = await get(String(photoId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(JPEG);
    expect([...new Uint8Array(await (await get(String(photoId), "?v=pisi")).arrayBuffer())]).toEqual(JPEG.slice(0, 4));
  });

  test("404: an id that is no photo or no id, a file the folder does not have, and no store at all", async () => {
    await signIn();
    for (const id of ["999999", "abc", "0", "007", "2147483648"]) {
      const res = await get(id);
      expect([res.status, await res.json()], id).toEqual([404, { ok: false, error: "notFound" }]);
    }
    state.store = fakeMediaStore();
    expect((await get(String(photoId))).status).toBe(404);
    state.store = null;
    expect((await get(String(photoId))).status).toBe(404);
  });

  test("a hung call does not hold the function: maxDuration 30", () => {
    expect(maxDuration).toBe(30);
  });
});
