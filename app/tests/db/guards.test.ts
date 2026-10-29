import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { makeTestDb } from "./helpers";

// withAdmin, adminAction and requireAdmin(Email) with the cookie, the database and the environment faked.

// `path`: the request header x-mslab-path, which the middleware sets on every /admin request (B19).
const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined, path: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "__Host-mslab_admin" && state.cookie ? { name, value: state.cookie } : undefined) }),
  headers: async () => new Headers(state.path === undefined ? {} : { "x-mslab-path": state.path }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.stubEnv("ADMIN_EMAILS", "admin@example.test,second.admin@example.com"); // the sign-in allow-list: server/env.ts reads process.env

import { adminAction, createSession, isCrossSite, requireAdmin, requireAdminEmail, withAdmin } from "@/server/auth";

let db: Db;
beforeAll(async () => {
  db = await makeTestDb();
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  state.db = db;
  state.cookie = undefined;
  state.path = undefined;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const signIn = async (email = "admin@example.test") => void (state.cookie = await createSession(db, email));
const req = (method: string, headers: Record<string, string> = {}) => new Request("https://mslab.example/api/admin/x", { method, headers });
const body = async (r: Response) => ({ status: r.status, json: await r.json(), cache: r.headers.get("cache-control") });

describe("withAdmin", () => {
  test("no cookie: 401 JSON, no-store, the handler never runs", async () => {
    const handler = vi.fn(() => new Response("secret"));
    const res = await withAdmin(handler)(req("GET"), {});
    expect(await body(res)).toEqual({ status: 401, json: { ok: false, error: "unauthorized" }, cache: "no-store" });
    expect(handler).not.toHaveBeenCalled();
  });

  test("an unknown cookie and a session of an address that is not allowed (any more) are 401 too", async () => {
    const handler = vi.fn(() => new Response("secret"));
    state.cookie = "A".repeat(43);
    expect((await withAdmin(handler)(req("GET"), {})).status).toBe(401);
    await signIn("former.admin@example.com");
    expect((await withAdmin(handler)(req("GET"), {})).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  test("a live session: the handler gets the request, the context and the admin's e-mail; its response is returned as is", async () => {
    await signIn("second.admin@example.com");
    const handler = vi.fn(async (_r: Request, ctx: { params: Promise<{ id: string }> }, admin: { email: string }) => Response.json({ id: await ctx.params, email: admin.email }, { status: 201 }));
    const ctx = { params: Promise.resolve({ id: "7" }) };
    const request = req("POST");
    const res = await withAdmin(handler)(request, ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: { id: "7" }, email: "second.admin@example.com" });
    expect(handler).toHaveBeenCalledWith(request, ctx, { email: "second.admin@example.com" });
  });

  test("a mutating request from another site is 403, with or without a session; GET is not affected", async () => {
    const handler = vi.fn(() => new Response("ok"));
    const guarded = withAdmin(handler);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const origin of ["https://evil.example", "https://mslab.example.evil.example", "http://mslab.example", "https://mslab.example:8443", "null", "not a url"]) {
        await signIn();
        const res = await guarded(req(method, { origin }), {});
        expect(await body(res), `${method} ${origin}`).toEqual({ status: 403, json: { ok: false, error: "forbidden" }, cache: "no-store" });
        state.cookie = undefined;
        expect((await guarded(req(method, { origin }), {})).status, `${method} ${origin} (signed out)`).toBe(403);
      }
    }
    expect(handler).not.toHaveBeenCalled();
    await signIn();
    expect((await guarded(req("GET", { origin: "https://evil.example" }), {})).status).toBe(200);
    expect((await guarded(req("HEAD", { origin: "https://evil.example" }), {})).status).toBe(200);
  });

  test("the same origin, or no Origin header at all (curl, server to server), is let through", async () => {
    await signIn();
    const guarded = withAdmin(() => new Response("ok"));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await guarded(req(method, { origin: "https://mslab.example" }), {})).status, method).toBe(200);
      expect((await guarded(req(method), {})).status, method).toBe(200);
    }
    expect(isCrossSite(req("POST"))).toBe(false);
    expect(isCrossSite(req("POST", { origin: "https://mslab.example" }))).toBe(false);
    expect(isCrossSite(req("POST", { origin: "https://other.example" }))).toBe(true);
  });

  test("a failing database is an error (500), not a 401 that looks like a logout, and nothing leaks into the log", async () => {
    state.cookie = "A".repeat(43);
    state.db = {
      select: () => {
        throw new Error("select ... where id_hash = 'admin@example.test' failed");
      },
    };
    await expect(withAdmin(() => new Response("ok"))(req("GET"), {})).rejects.toThrow("admin session lookup failed");
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toMatch(/admin@|id_hash/);
  });
});

describe("adminAction", () => {
  test("without a session: redirect to /admin/login, the action never runs", async () => {
    const fn = vi.fn(async () => "done");
    const err = await adminAction(fn)().catch((e) => e);
    expect(String((err as { digest?: string }).digest)).toMatch(/^NEXT_REDIRECT;.*\/admin\/login/);
    expect(fn).not.toHaveBeenCalled();
  });

  test("with a session: the action gets the admin's e-mail first, then the caller's arguments", async () => {
    await signIn();
    const save = adminAction(async ({ email }, id: number, data: { name: string }) => `${email}:${id}:${data.name}`);
    expect(await save(5, { name: "Kulmud" })).toBe("admin@example.test:5:Kulmud");
  });
});

describe("requireAdmin / requireAdminEmail", () => {
  test("requireAdmin returns the e-mail or redirects; requireAdminEmail returns it or throws a 401 Response", async () => {
    await expect(requireAdmin()).rejects.toMatchObject({ digest: expect.stringContaining("/admin/login") });
    const thrown = await requireAdminEmail().catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
    await signIn("second.admin@example.com");
    expect(await requireAdmin()).toBe("second.admin@example.com");
    expect(await requireAdminEmail()).toBe("second.admin@example.com");
  });

  // B19 (admin UX pass piece 4c, ruling R-f): the page she opened signed out is kept as ?tagasi=, so the sign-in lands her back on it.
  const redirectOf = async (run: Promise<unknown>) => String(((await run.catch((e) => e)) as { digest?: string }).digest).split(";")[2];

  test("requireAdmin keeps the page asked for (the middleware's x-mslab-path) as ?tagasi=, encoded as one value", async () => {
    state.path = "/admin/kalender?id=3";
    expect(await redirectOf(requireAdmin())).toBe("/admin/login?tagasi=%2Fadmin%2Fkalender%3Fid%3D3");
    // an action posts to its page's address: the same way back
    state.path = "/admin/tagasiside?vaade=arvustused";
    expect(await redirectOf(adminAction(async () => "done")())).toBe("/admin/login?tagasi=%2Fadmin%2Ftagasiside%3Fvaade%3Darvustused");
  });

  test("the panel's front page, no header and a path that is not an admin page give the plain login page", async () => {
    for (const path of [undefined, "/admin", "//evil.example", "/admin/login?tagasi=%2Fadmin", "/\\evil", "/admin/%2F%2Fevil", "/adminx", "/admin/kalen\tder", `/admin/${"k".repeat(300)}`]) {
      state.path = path;
      expect(await redirectOf(requireAdmin()), String(path)).toBe("/admin/login");
    }
  });
});
