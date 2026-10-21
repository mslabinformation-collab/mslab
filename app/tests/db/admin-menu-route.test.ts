import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { setSetting } from "@/db/queries/admin";
import { payments, reviews } from "@/db/schema";
import { createSession } from "@/server/auth";
import { testPlan } from "@/server/testplan";
import { makeTestDb } from "./helpers";
import { contactCourse, pendingPayment, registrationOn } from "./payments-fixtures";

// GET /api/admin/margid (admin UX pass, B6): the menu's badges for the sidebar, from a real (PGlite) database. Admins only; the answer is
// menu.ts menuOf over adminCounts, the very function the shell paints its first badges with. The admin's session cookie (next/headers) is faked, as
// in tests/db/campaign-preview-route.test.ts.

const state = vi.hoisted(() => ({ db: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-mslab_admin" && state.cookie !== undefined ? { name, value: state.cookie } : undefined),
  }),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import { GET } from "@/app/api/admin/margid/route";
import { menuOf } from "@/components/admin/menu";
import { readMenuState } from "@/components/admin/menu-state";
import { adminCounts } from "@/db/queries/admin";

const ME = "maria@example.test";
/** 23:30 UTC on 30.11 is 1.12 in Tallinn. */
const NOW = new Date("2026-11-30T23:30:00Z");

let db: Db;

const get = () => GET(new Request("https://admin-request.example/api/admin/margid"), undefined);
const signIn = async () => {
  state.cookie = await createSession(db, ME);
};

beforeAll(async () => {
  db = await makeTestDb();
});
beforeEach(async () => {
  state.db = db;
  state.cookie = undefined;
  vi.stubEnv("ADMIN_EMAILS", ME);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/admin/margid", () => {
  test("without an admin's session: 401 { ok: false, error: 'unauthorized' }, never kept", async () => {
    const res = await get();
    expect([res.status, await res.json()]).toEqual([401, { ok: false, error: "unauthorized" }]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("an empty school: 200 with no badge, no sum and no card", async () => {
    await signIn();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, badges: {}, hrefs: {}, total: 0, today: null });
  });

  test("a seeded school: every badge counts what it should, a badged row carries its filtered address, and the card is today's first session (Tallinn's date)", async () => {
    // a session at 10:00 on 1.12 in Tallinn, and a registration waiting for its prepayment
    const fixture = await contactCourse(db, { capacity: 100, startsAt: new Date("2026-12-01T08:00:00Z") });
    const r = await registrationOn(db, fixture, { email: "kati@example.test", name: "Kati Tamm" });
    // payments: one paid without an invoice, one held
    const unbilled = await pendingPayment(db, r, {}, new Date("2026-10-20T09:00:00Z"));
    await db.update(payments).set({ status: "paid", paidAt: new Date("2026-10-20T09:00:00Z") }).where(eq(payments.id, unbilled.id));
    const held = await pendingPayment(db, await registrationOn(db, fixture, { email: "liis@example.test", name: "Liis Mets" }), {}, new Date("2026-10-20T09:00:00Z"));
    await db.update(payments).set({ status: "held" }).where(eq(payments.id, held.id));
    // a review waiting for „Avalda“
    await db.insert(reviews).values({ courseId: fixture.course.id, kind: "manual", text: "Super", name: "Kati", locale: "et", writtenAt: new Date("2026-10-01T09:00:00Z"), status: "pending" });
    // two „Viga“ answers of the signed-in admin and one of another
    const [one, two, three] = testPlan.items.map((i) => i.id);
    const bad = (by: string) => ({ status: "bad", note: "", at: "2026-10-21T08:00:00.000Z", by });
    await setSetting(db, "testplan_answers", { v: 1, answers: { [one]: bad(ME), [two]: bad(ME), [three]: bad("dim@example.test") } });

    await signIn();
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      badges: {
        registrations: { n: 2, label: "2 ootab ettemaksu" },
        protocols: { text: "Täna", label: "Täna on koolituspäev" },
        feedback: { n: 1, label: "1 arvustust ootab" },
        payments: { n: 2, label: "2 vajab kontrolli" },
        testing: { n: 2, label: "2 viga" },
      },
      // (B16: the one session on today, so „Protokollid“ goes straight to it)
      hrefs: {
        registrations: "/admin/registreerimised?staatus=ootab",
        protocols: expect.stringMatching(/^\/admin\/protokollid\?sessioon=\d+$/),
        feedback: "/admin/tagasiside?vaade=arvustused&olek=ootel",
      },
      total: 7,
      today: { href: expect.stringMatching(/^\/admin\/protokollid\?sessioon=\d+$/), time: "10:00", course: "Kulmumeistri baaskoolitus" },
    });

    // the shell's first paint is the same function over the same numbers
    expect(body).toEqual({ ok: true, ...JSON.parse(JSON.stringify(menuOf(await adminCounts(db, ME, NOW)))) });
    // and the sidebar can read what it is sent
    expect(readMenuState(body)).toEqual(menuOf(await adminCounts(db, ME, NOW)));
  });

  test("the answer is the signed-in admin's own: another admin does not see Maria's „Viga“ answers", async () => {
    vi.stubEnv("ADMIN_EMAILS", `${ME},dim@example.test`);
    const [one] = testPlan.items.map((i) => i.id);
    await setSetting(db, "testplan_answers", { v: 1, answers: { [one]: { status: "bad", note: "", at: "2026-10-21T08:00:00.000Z", by: ME } } });
    state.cookie = await createSession(db, "dim@example.test");
    expect(((await (await get()).json()) as { badges: Record<string, unknown> }).badges.testing).toBeUndefined();
    await signIn();
    expect(((await (await get()).json()) as { badges: Record<string, unknown> }).badges.testing).toEqual({ n: 1, label: "1 viga" });
  });

  test("a database that fails is 500 { ok: false, error: 'server' }, logged without data, never kept", async () => {
    await signIn();
    // the session is read as before; one of the counts cannot be
    await db.execute(sql`alter table reviews rename to reviews_away`);
    let res: Response;
    try {
      res = await get();
    } finally {
      await db.execute(sql`alter table reviews_away rename to reviews`);
    }
    expect([res.status, await res.json()]).toEqual([500, { ok: false, error: "server" }]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("[admin] the menu's badges could not be read");
  });
});
