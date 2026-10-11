import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { payments, registrations } from "@/db/schema";
import { contactCourse, orderToken, pendingPayment, registrationOn, stubMontonio, TEST_MONTONIO } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// app/api/payments/return/route.ts, the Next.js side of Montonio's returnUrl: GET only, the dependencies built from the settings and the
// database, the mails and the notice after the response (`after`), and whatever fails here the payer lands on /makse ("pooleli"), never on an
// error page. The logic itself is server/payments/routes.ts (payments-return.test.ts); here the wiring runs with the database (PGlite) faked in.

const state = vi.hoisted(() => ({ db: null as unknown, later: [] as (() => unknown)[] }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => void state.later.push(task),
}));

import * as route from "@/app/api/payments/return/route";

const ORIGIN = "https://mslab.ee";
const get = (token: string, origin = ORIGIN) => new Request(`${origin}/api/payments/return?order-token=${encodeURIComponent(token)}`, { headers: { host: new URL(origin).host } });
const answer = (res: Response) => [res.status, res.headers.get("location"), res.headers.get("cache-control"), res.headers.get("referrer-policy")];
let db: Db;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.later = [];
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  vi.stubEnv("MONTONIO_ACCESS_KEY", TEST_MONTONIO.accessKey);
  vi.stubEnv("MONTONIO_SECRET_KEY", TEST_MONTONIO.secretKey);
  vi.stubEnv("MONTONIO_ENV", "sandbox");
  vi.stubEnv("SITE_URL", "https://mslab.ee");
  vi.stubEnv("MARIA_EMAIL", "maria@example.test");
  vi.stubEnv("MAIL_FROM", "MS LAB <info@send.example>");
  vi.stubEnv("RESEND_API_KEY", "re_test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("GET only: the module exports no other method, so Next.js answers 405 to the rest; dynamic, and 30 s for a token in doubt", () => {
  expect(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"].filter((name) => name in route)).toEqual([]);
  expect(typeof route.GET).toBe("function");
  expect(route.dynamic).toBe("force-dynamic");
  expect(route.maxDuration).toBe(30);
});

test("a signed order token pays the payment and sends the payer to /makse; the mails follow after the response, with the request's own origin in their links", async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  const p = await pendingPayment(db, r);
  const res = await route.GET(get(orderToken(p)));
  expect(answer(res)).toEqual([303, `/makse#tulemus=makstud&liik=registreering`, "no-store", "no-referrer"]);
  expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0].status).toBe("paid");
  expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0]).toMatchObject({ status: "confirmed", paidCents: 17500 });
  expect(m.mails()).toEqual([]); // nothing before the response is out
  for (const task of state.later.splice(0)) await task();
  expect(m.mails().map((x) => [x.to, x.subject])).toEqual([
    ["kati@example.com", "Koht on kinnitatud — Kulmumeistri baaskoolitus"],
    ["maria@example.test", "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"],
  ]);
  expect(m.mails()[0].text).toContain("https://mslab.ee/konto/sisene#email=");
});

test("a Host that is not one of ours never reaches a mail link: they use SITE_URL; the redirect is a path, so her browser stays on the origin it is already at", async () => {
  const m = stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const res = await route.GET(get(orderToken(p), "https://elsewhere.example"));
  expect(res.headers.get("location")).toBe("/makse#tulemus=makstud&liik=registreering"); // a path only: no host value in the redirect
  for (const task of state.later.splice(0)) await task();
  expect(m.mails()[0].text).toContain("https://mslab.ee/konto/sisene#email=");
  expect(m.mails().map((x) => x.text).join("\n")).not.toContain("elsewhere.example");
});

test("a token of another secret: 303 to /makse#tulemus=katkestatud, nothing paid", async () => {
  stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const res = await route.GET(get(orderToken(p, {}, { secret: "another-secret-0123456789abcdef" })));
  expect(answer(res)).toEqual([303, `/makse#tulemus=katkestatud`, "no-store", "no-referrer"]);
  expect((await db.select().from(payments))[0].status).toBe("pending");
});

test("without Montonio's keys: 404 (the payment routes are off), and nothing is read from the database", async () => {
  vi.stubEnv("MONTONIO_ACCESS_KEY", "");
  vi.stubEnv("MONTONIO_SECRET_KEY", "");
  state.db = new Proxy({}, { get: () => { throw new Error("the database must not be touched"); } });
  const res = await route.GET(get("x"));
  expect([res.status, await res.json(), res.headers.get("cache-control")]).toEqual([404, { ok: false }, "no-store"]);
});

test("the database cannot be reached: the payer still lands on /makse as pooleli, and nothing is logged but the class and code", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  state.db = { select: () => { throw Object.assign(new Error("connect ECONNREFUSED kati@example.com"), { code: "ECONNREFUSED" }); } };
  stubMontonio();
  const res = await route.GET(get(orderToken({ reference: "MSLAB-M1", amountCents: 100, providerUuid: "u" })));
  expect(answer(res)).toEqual([303, `/makse#tulemus=pooleli`, "no-store", "no-referrer"]);
  expect(log.mock.calls.flat().join("\n")).not.toContain("kati@example.com");
});

test("a setting that cannot be read (no DATABASE_URL in production) is the same landing, never a 500", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "");
  const res = await route.GET(get("x"));
  expect(answer(res)).toEqual([303, `/makse#tulemus=pooleli`, "no-store", "no-referrer"]);
});
