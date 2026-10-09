import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { payments, registrations } from "@/db/schema";
import { contactCourse, orderToken, pendingPayment, registrationOn, stubMontonio, TEST_MONTONIO } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// app/api/payments/notify/route.ts, the Next.js side of Montonio's webhook: POST only, the dependencies built from the settings and the
// database, the mails and the notice after the response (`after`), a missing setting a 503 so that Montonio tries again. The logic itself is
// server/payments/routes.ts (payments-notify.test.ts); here the wiring runs with the database (PGlite) faked in.

const state = vi.hoisted(() => ({ db: null as unknown, later: [] as (() => unknown)[] }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => void state.later.push(task),
}));

import * as route from "@/app/api/payments/notify/route";

const URL_ = "https://mslab.example/api/payments/notify";
const post = (body: unknown) => new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let db: Db;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  state.later = [];
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  vi.stubEnv("MONTONIO_ACCESS_KEY", TEST_MONTONIO.accessKey);
  vi.stubEnv("MONTONIO_SECRET_KEY", TEST_MONTONIO.secretKey);
  vi.stubEnv("MONTONIO_ENV", "sandbox");
  vi.stubEnv("SITE_URL", "https://mslab.example");
  vi.stubEnv("MARIA_EMAIL", "maria@example.test");
  vi.stubEnv("MAIL_FROM", "MS LAB <info@send.example>");
  vi.stubEnv("RESEND_API_KEY", "re_test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("POST only: the module exports no other method, so Next.js answers 405 to the rest", () => {
  const methods = ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"].filter((name) => name in route);
  expect(methods).toEqual([]);
  expect(typeof route.POST).toBe("function");
  expect(route.dynamic).toBe("force-dynamic");
  expect(route.maxDuration).toBe(30); // a token in doubt asks Montonio (15 s at most)
});

test("a signed order token pays the payment; the payer's mail and Maria's notice follow after the response, with SITE_URL's links", async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  const p = await pendingPayment(db, r);
  const res = await route.POST(post({ orderToken: orderToken(p) }));
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0].status).toBe("paid");
  expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0]).toMatchObject({ status: "confirmed", paidCents: 17500 });
  expect(m.mails()).toEqual([]); // nothing before the response is out
  for (const task of state.later.splice(0)) await task();
  expect(m.mails().map((x) => [x.to, x.subject])).toEqual([
    ["kati@example.com", "Koht on kinnitatud — Kulmumeistri baaskoolitus"],
    ["maria@example.test", "Uus makse: Kati Tamm, Kulmumeistri baaskoolitus, 14.11.2026, 175 €"],
  ]);
  expect(m.mails()[0].text).toContain("https://mslab.example/konto/sisene#email=");
});

test("a token of another secret: 400; the unusable body is never paid", async () => {
  stubMontonio();
  const p = await pendingPayment(db, await registrationOn(db, await contactCourse(db)));
  const res = await route.POST(post({ orderToken: orderToken(p, {}, { secret: "another-secret-0123456789abcdef" }) }));
  expect([res.status, await res.json()]).toEqual([400, { ok: false }]);
  expect((await db.select().from(payments))[0].status).toBe("pending");
});

test("without Montonio's keys: 404 (the payment routes are off), and nothing is read from the database", async () => {
  vi.stubEnv("MONTONIO_ACCESS_KEY", "");
  vi.stubEnv("MONTONIO_SECRET_KEY", "");
  state.db = new Proxy({}, { get: () => { throw new Error("the database must not be touched"); } });
  const res = await route.POST(post({ orderToken: "x" }));
  expect([res.status, await res.json(), res.headers.get("cache-control")]).toEqual([404, { ok: false }, "no-store"]);
});

test("the database cannot be reached: 503 so that Montonio tries again, nothing logged but the class and code", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  state.db = { select: () => { throw Object.assign(new Error("connect ECONNREFUSED kati@example.com"), { code: "ECONNREFUSED" }); } };
  stubMontonio();
  const res = await route.POST(post({ orderToken: orderToken({ reference: "MSLAB-M1", amountCents: 100, providerUuid: "u" }) }));
  expect([res.status, await res.json(), res.headers.get("cache-control")]).toEqual([503, { ok: false }, "no-store"]);
  expect(log.mock.calls.flat().join("\n")).not.toContain("kati@example.com");
});

test("a setting that cannot be read (no DATABASE_URL in production) is a 503 too", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "");
  const res = await route.POST(post({ orderToken: "x" }));
  expect([res.status, res.headers.get("cache-control")]).toEqual([503, "no-store"]);
});
