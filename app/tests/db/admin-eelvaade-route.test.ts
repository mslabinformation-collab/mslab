import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { PREVIEW_COOKIE, PREVIEW_TTL_S, verifyPreview } from "@/lib/preview-cookie";
import { createSession } from "@/server/auth";
import { previewPath } from "@/server/preview";
import { makeTestDb } from "./helpers";

// GET /api/admin/eelvaade (admin UX pass, spec C3; README §1.8 „Eelvaade ↗“): the draft layer's preview. A signed-in admin gets Next's draft mode
// (the public pages then read the drafts) and the coming-soon gate's preview cookie, and is sent (303) to `tee`, a path of this site; anything else
// sends her to the home page, so the link can never take her to another site. `?lopeta=1` leaves draft mode. The admin's session cookie and draftMode
// (next/headers) are faked, the database is PGlite, as in tests/db/preview-routes.test.ts.

const state = vi.hoisted(() => ({
  db: null as unknown,
  cookie: undefined as string | undefined,
  draft: { enabled: false, enable: 0, disable: 0 },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
  draftMode: async () => ({
    get isEnabled() {
      return state.draft.enabled;
    },
    enable() {
      state.draft.enable++;
      state.draft.enabled = true;
    },
    disable() {
      state.draft.disable++;
      state.draft.enabled = false;
    },
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import { GET } from "@/app/api/admin/eelvaade/route";

const SECRET = "preview-secret-for-tests-0123456789abcdef";
const ORIGIN = "https://mslab.example";
const ME = "maria@example.test";

let db: Db;
beforeAll(async () => {
  db = await makeTestDb();
});
beforeEach(() => {
  state.db = db;
  state.cookie = undefined;
  state.draft = { enabled: false, enable: 0, disable: 0 };
  vi.stubEnv("ADMIN_EMAILS", ME);
  vi.stubEnv("PREVIEW_SECRET", SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const call = (query: string) => GET(new Request(`${ORIGIN}/api/admin/eelvaade${query}`), undefined);
const location = (res: Response) => res.headers.get("location");

describe("previewPath (the route's check of `tee`)", () => {
  test("a path of this site is kept, with its query and fragment", () => {
    for (const path of ["/", "/koolitused/kulmud", "/ru/koolitused/kulmud", "/uudised/uus-postitus?x=1", "/#kkk", "/praktika/", "/koolitused/kulmud-%C3%B5pe"])
      expect(previewPath(path, ORIGIN), path).toBe(path);
  });

  test("anything that is not one goes to the home page", () => {
    const refused = [
      null, "", "koolitused", "./koolitused", "//evil.example", "//evil.example/x", "/\\evil.example", "/\\/evil.example", "\\\\evil.example",
      "https://evil.example/", "https://mslab.example/koolitused", "javascript:alert(1)", "data:text/html,x", "/\t/evil.example", "/\n/evil.example",
      "/\r/evil.example", "/koolitused\u0000", "/a\u007fb", "/koolitused\\..\\x", " /koolitused", "/" + "a".repeat(2100),
    ];
    for (const tee of refused) expect(previewPath(tee, ORIGIN), JSON.stringify(tee)).toBe("/");
  });
});

describe("GET /api/admin/eelvaade", () => {
  test("without an admin's session: 401 JSON, never kept; no draft mode and no cookie", async () => {
    const res = await call("?tee=%2Fkoolitused%2Fkulmud");
    expect([res.status, await res.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(state.draft).toEqual({ enabled: false, enable: 0, disable: 0 });
    state.cookie = await createSession(db, "former.admin@example.test"); // not on the allow-list
    expect((await call("?tee=%2F")).status).toBe(401);
    expect(state.draft.enable).toBe(0);
  });

  test("a signed-in admin: draft mode on, the preview cookie, 303 to `tee` on this site, never kept", async () => {
    state.cookie = await createSession(db, ME);
    const res = await call("?tee=%2Fkoolitused%2Fkulmud%3Fx%3D1");
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${ORIGIN}/koolitused/kulmud?x=1`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.draft).toEqual({ enabled: true, enable: 1, disable: 0 });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${PREVIEW_COOKIE}=`))!;
    expect(cookie).toBeDefined();
    expect(cookie.toLowerCase()).toContain(`max-age=${PREVIEW_TTL_S}`);
    expect(await verifyPreview(decodeURIComponent(cookie.split(";")[0].split("=")[1]), SECRET)).toBe(true);
  });

  test("a `tee` that is not a path of this site, or none: 303 to the home page (draft mode still on)", async () => {
    state.cookie = await createSession(db, ME);
    for (const query of ["", "?tee=", "?tee=%2F%2Fevil.example", "?tee=%2F%5Cevil.example", "?tee=https%3A%2F%2Fevil.example%2F", "?tee=%2F%09%2Fevil.example", "?tee=koolitused"]) {
      const res = await call(query);
      expect([res.status, location(res)], query).toEqual([303, `${ORIGIN}/`]);
    }
    expect(state.draft.enabled).toBe(true);
  });

  test("?lopeta=1 leaves draft mode and goes to `tee` (or the home page); it gives no new preview cookie", async () => {
    state.cookie = await createSession(db, ME);
    state.draft.enabled = true;
    const res = await call("?lopeta=1&tee=%2Fkoolitused%2Fkulmud");
    expect([res.status, location(res)]).toEqual([303, `${ORIGIN}/koolitused/kulmud`]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.draft).toEqual({ enabled: false, enable: 0, disable: 1 });
    expect(res.headers.getSetCookie().filter((c) => c.startsWith(`${PREVIEW_COOKIE}=`))).toEqual([]);
    expect(location(await call("?lopeta=1&tee=%2F%2Fevil.example"))).toBe(`${ORIGIN}/`);
    expect(location(await call("?lopeta=1"))).toBe(`${ORIGIN}/`);
  });
});
