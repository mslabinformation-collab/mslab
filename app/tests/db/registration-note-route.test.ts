import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { registrations } from "@/db/schema";
import { NOTE_MAX } from "@/domain/registration";
import { contentVersion } from "@/lib/version";
import { createSession } from "@/server/auth";
import { saveStatus } from "@/server/admin";
import { makeTestDb } from "./helpers";
import { contactCourse, registrationOn } from "./payments-fixtures";

// The registration drawer's „Märkus“ (admin UX pass, piece 2, Task 5; README A2 drawer 3, §1.3): its autosave route, POST
// /api/admin/registreering/<id>/markus with `{ version, patch: { note } }` (server/autosave-route.ts autosaveHandler, inside withAdmin). The note is a
// form part of its own: its version is the hash of the stored note (registrations has no updated_at: lib/version.ts contentVersion), so a status
// change does not make a note save stale. On PGlite, with the admin's session cookie faked (as tests/db/admin-invoice-routes.test.ts does).

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import { POST } from "@/app/api/admin/registreering/[id]/markus/route";

const ORIGIN = "https://mslab.example";
let db: Db;
let id: number;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.cookie = undefined;
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  id = (await registrationOn(db, await contactCourse(db), { note: "helistas" })).id;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const signIn = async () => {
  state.cookie = await createSession(db, "admin@example.test");
};
const save = (target: string | number, body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request(`${ORIGIN}/api/admin/registreering/${target}/markus`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: String(target) }),
  });
const answerOf = async (res: Response) => ({ status: res.status, cache: res.headers.get("cache-control"), body: await res.json() });
const stored = async () => (await db.select({ note: registrations.note, status: registrations.status }).from(registrations).where(eq(registrations.id, id)))[0];
const versionOf = (note: string) => contentVersion({ note });

describe("POST /api/admin/registreering/<id>/markus", () => {
  test("without an admin's session: 401, nothing stored; from another site: 403", async () => {
    expect(await answerOf(await save(id, { version: await versionOf("helistas"), patch: { note: "uus" } }))).toMatchObject({ status: 401, body: { ok: false, error: "unauthorized" } });
    await signIn();
    expect((await save(id, { version: await versionOf("helistas"), patch: { note: "uus" } }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await stored()).note).toBe("helistas");
  });

  test("ok: the note is stored and the answer carries its new version", async () => {
    await signIn();
    const before = await versionOf("helistas");
    const res = await answerOf(await save(id, { version: before, patch: { note: "Maksab kohapeal sularahas" } }));
    expect(res).toMatchObject({ status: 200, cache: "no-store", body: { ok: true, version: await versionOf("Maksab kohapeal sularahas"), savedAt: expect.any(String) } });
    expect(res.body.version).not.toBe(before);
    expect(Number.isNaN(Date.parse(res.body.savedAt))).toBe(false);
    expect((await stored()).note).toBe("Maksab kohapeal sularahas");
    // the next save goes on from the new version; the text is stored as typed (spaces too: the browser's copy must match what is stored)
    expect((await save(id, { version: res.body.version, patch: { note: "  kaks rida\n " } })).status).toBe(200);
    expect((await stored()).note).toBe("  kaks rida\n ");
    // an empty note is a note too
    expect((await save(id, { version: await versionOf("  kaks rida\n "), patch: { note: "" } })).status).toBe(200);
    expect((await stored()).note).toBe("");
  });

  test("a wrong version is a conflict: 409 with the stored note and its version, nothing stored", async () => {
    await signIn();
    expect(await answerOf(await save(id, { version: await versionOf("vana tekst"), patch: { note: "minu tekst" } }))).toEqual({
      status: 409,
      cache: "no-store",
      body: { ok: false, error: "conflict", version: await versionOf("helistas"), value: { note: "helistas" } },
    });
    expect((await stored()).note).toBe("helistas");
  });

  test("a status change meanwhile is not a conflict: the note is its own part", async () => {
    await signIn();
    const version = await versionOf("helistas");
    const fd = new FormData();
    for (const [k, v] of Object.entries({ id: String(id), status: "confirmed", expected: "awaiting_prepayment" })) fd.set(k, v);
    expect(await saveStatus(db, fd)).toEqual({ ok: true });
    expect((await save(id, { version, patch: { note: "pärast staatust" } })).status).toBe(200);
    expect(await stored()).toEqual({ note: "pärast staatust", status: "confirmed" });
  });

  test("2001 characters are invalid (the field's code), 2000 are fine; a field that is no note is refused", async () => {
    await signIn();
    const version = await versionOf("helistas");
    expect(await answerOf(await save(id, { version, patch: { note: "x".repeat(NOTE_MAX + 1) } }))).toEqual({
      status: 400,
      cache: "no-store",
      body: { ok: false, error: "invalid", fields: { note: "tooLong" } },
    });
    expect((await stored()).note).toBe("helistas");
    expect((await answerOf(await save(id, { version, patch: { status: "confirmed" } }))).body).toMatchObject({ ok: false, error: "invalid", fields: { status: expect.any(String) } });
    expect((await answerOf(await save(id, { version, patch: { note: 5 } }))).body).toMatchObject({ ok: false, error: "invalid", fields: { note: expect.any(String) } });
    // a NUL character, which a Postgres text column cannot hold: the field is refused, not a server error
    expect((await answerOf(await save(id, { version, patch: { note: "a\u0000b" } }))).body).toEqual({ ok: false, error: "invalid", fields: { note: "text" } });
    expect((await stored()).note).toBe("helistas");
    expect((await save(id, { version, patch: { note: "x".repeat(NOTE_MAX) } })).status).toBe(200);
    expect((await stored()).note).toHaveLength(NOTE_MAX);
  });

  test("an id that is no registration: 404 notFound; a body that is no save: 400", async () => {
    await signIn();
    const version = await versionOf("helistas");
    for (const target of ["999999", "abc", "0"]) expect(await answerOf(await save(target, { version, patch: { note: "x" } })), target).toMatchObject({ status: 404, body: { ok: false, error: "notFound" } });
    expect(await answerOf(await save(id, { patch: { note: "x" } }))).toMatchObject({ status: 400, body: { ok: false, error: "body" } });
    expect((await stored()).note).toBe("helistas");
  });
});
