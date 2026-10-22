import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { payments, registrations, settings } from "@/db/schema";
import { contactCourse, registrationOn, stubMontonio, TEST_MONTONIO } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// app/maksa/[token]/route.ts, the Next.js side of the "Maksa" page: GET and POST (the page's logic is server/pay-page.ts, pay-page.test.ts),
// HEAD that does nothing, the dependencies built from the settings, and a failure that names nothing (the token is in the address). The
// database (PGlite) is faked in.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import * as route from "@/app/maksa/[token]/route";

const ORIGIN = "https://mslab.example";
let db: Db;

beforeEach(async () => {
  db = await makeTestDb();
  state.db = db;
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  vi.stubEnv("MONTONIO_ACCESS_KEY", TEST_MONTONIO.accessKey);
  vi.stubEnv("MONTONIO_SECRET_KEY", TEST_MONTONIO.secretKey);
  vi.stubEnv("MONTONIO_ENV", "sandbox");
  vi.stubEnv("SITE_URL", ORIGIN);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const get = (token: string) => route.GET(new Request(`${ORIGIN}/maksa/${token}`), ctx(token));
const post = (token: string, headers: Record<string, string> = { origin: ORIGIN }) => route.POST(new Request(`${ORIGIN}/maksa/${token}`, { method: "POST", headers }), ctx(token));

test("GET and POST are the page's; HEAD is the route's own; no other method is exported (Next.js answers 405)", () => {
  expect(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].filter((name) => name in route)).toEqual(["GET", "HEAD", "POST"]);
  expect(route.dynamic).toBe("force-dynamic");
  expect(route.maxDuration).toBe(30); // the button's POST asks Montonio for an order (15 s at most)
});

test("HEAD (a mail scanner's first look) answers 204 and never reads the database", () => {
  state.db = new Proxy({}, { get: () => { throw new Error("the database must not be touched"); } });
  const res = route.HEAD();
  expect([res.status, res.headers.get("cache-control")]).toEqual([204, "no-store"]);
});

test("GET with the keys: the page with its button, never cached, and nothing written", async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  const res = await get(r.payToken);
  expect([res.status, res.headers.get("cache-control"), res.headers.get("content-type")]).toEqual([200, "no-store", "text/html; charset=utf-8"]);
  expect(await res.text()).toContain("Maksa 175 €");
  expect(await db.select().from(payments)).toEqual([]);
  expect(m.state.orders).toEqual([]);
});

test("GET without the keys: the page without a button; a POST then says 'Midagi läks valesti' and starts nothing", async () => {
  vi.stubEnv("MONTONIO_ACCESS_KEY", "");
  vi.stubEnv("MONTONIO_SECRET_KEY", "");
  const r = await registrationOn(db, await contactCourse(db));
  expect(await (await get(r.payToken)).text()).not.toContain("<form");
  const res = await post(r.payToken);
  expect(res.status).toBe(503);
  expect(await db.select().from(payments)).toEqual([]);
});

test("POST from this site: 303 to Montonio's page; Montonio's way back is SITE_URL's", async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  const res = await post(r.payToken);
  const [p] = await db.select().from(payments);
  expect([res.status, res.headers.get("location")]).toEqual([303, `https://sandbox-stargate.montonio.com/${p.providerUuid}`]);
  expect(m.state.orders[0]).toMatchObject({ returnUrl: `${ORIGIN}/api/payments/return`, notificationUrl: `${ORIGIN}/api/payments/notify` });
  expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].seatHoldUntil).not.toBeNull();
});

test("POST on an allow-listed host that is not SITE_URL (the local dev server, http://localhost:3000): the return comes back to that host, Montonio's webhook always goes to SITE_URL", async () => {
  const m = stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  const local = "http://localhost:3000";
  const res = await route.POST(new Request(`${local}/maksa/${r.payToken}`, { method: "POST", headers: { origin: local, host: "localhost:3000" } }), ctx(r.payToken));
  expect(res.status).toBe(303);
  expect(m.state.orders).toEqual([expect.objectContaining({ returnUrl: `${local}/api/payments/return`, notificationUrl: `${ORIGIN}/api/payments/notify` })]);
});

test("POST from another site: 403, nothing started", async () => {
  stubMontonio();
  const r = await registrationOn(db, await contactCourse(db));
  expect((await post(r.payToken, { origin: "https://elsewhere.example" })).status).toBe(403);
  expect(await db.select().from(payments)).toEqual([]);
});

test("the database cannot be reached: an empty 500, never cached, and the log names neither the token nor the address", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const token = "t".repeat(43);
  state.db = { select: () => { throw Object.assign(new Error(`connect ECONNREFUSED kati@example.com ${token}`), { code: "ECONNREFUSED" }); } };
  stubMontonio();
  const res = await get(token);
  expect([res.status, await res.text(), res.headers.get("cache-control")]).toEqual([503, expect.stringContaining("Midagi läks valesti"), "no-store"]);
  const logged = log.mock.calls.flat().join("\n");
  expect(logged).toContain("ECONNREFUSED");
  expect(logged).not.toContain("kati@example.com");
  expect(logged).not.toContain(token);
});

test("a setting that cannot be read (no DATABASE_URL in production) is an empty 500 that names nothing", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "");
  const token = "t".repeat(43);
  const res = await get(token);
  expect([res.status, await res.text(), res.headers.get("cache-control")]).toEqual([500, "", "no-store"]);
  expect(log.mock.calls.flat().join("\n")).not.toContain(token);
});

test("Järelmaks (Inbank) through the route: an allowed registration's page has the two buttons; the järelmaks form's POST (urlencoded, as a browser sends it) starts a hirePurchase order, the bank's a bank one", async () => {
  const m = stubMontonio();
  await db.insert(settings).values({ key: "financing", value: { enabled: true } });
  const c = await contactCourse(db);
  const a = await registrationOn(db, c, { paymentChoice: "financing" });
  const b = await registrationOn(db, c, { paymentChoice: "financing", email: "teine@example.com" });
  const html = await (await get(a.payToken)).text();
  expect(html).toContain("Maksa järelmaksuga (Inbank)");
  expect(html).toContain("Maksa pangalingiga");
  const form = (token: string, method: string) =>
    route.POST(new Request(`${ORIGIN}/maksa/${token}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ method }).toString() }), ctx(token));
  expect((await form(a.payToken, "hirePurchase")).status).toBe(303);
  expect((await form(b.payToken, "paymentInitiation")).status).toBe(303);
  expect(m.state.orders.map((o) => [(o.payment as { method: string }).method, o.grandTotal])).toEqual([["hirePurchase", 350], ["paymentInitiation", 350]]);
  expect((await db.select().from(payments).orderBy(payments.id)).map((p) => p.method)).toEqual(["hirePurchase", "paymentInitiation"]);
});

test("a järelmaks press with the toggle off: 409 with the range sentence and the bank's button, through the route", async () => {
  stubMontonio();
  const r = await registrationOn(db, await contactCourse(db), { paymentChoice: "financing" });
  const res = await route.POST(
    new Request(`${ORIGIN}/maksa/${r.payToken}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "method=hirePurchase" }),
    ctx(r.payToken),
  );
  const html = await res.text();
  expect(res.status).toBe(409);
  expect(html).toContain("Järelmaks on võimalik 100–5000 € hinnaga koolitusele.");
  expect(html).toContain("Maksa 350 €");
  expect(html).not.toContain("hirePurchase");
  expect(await db.select().from(payments)).toEqual([]);
});
