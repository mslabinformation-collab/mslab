import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, payments, registrations } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { newToken, sha256 } from "@/server/token";
import { fakeKv } from "../fakes";
import { contactCourse, registrationOn, SITE, stubMontonio } from "./payments-fixtures";
import { makeTestDb } from "./helpers";

// POST /api/konto/maksa (phase 2b, spec 6.3): the card's "Maksa {summa}" / "Maksa ülejäänud {summa}" for one of the client's own registrations,
// with the /maksa page's checks; and the dashboard says payOnline when payments are on.

const NOW = new Date("2026-10-09T10:00:00Z");
let db: Db;
beforeEach(async () => {
  db = await makeTestDb();
  for (const method of ["info", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const deps = (montonio: AccountDeps["montonio"], kv = fakeKv()): AccountDeps => ({
  db,
  env: { KV: kv, MAIL_FROM: "MS LAB <info@send.example>", MARIA_EMAIL: "maria@example.test", SITE_URL: SITE },
  now: NOW,
  siteUrl: SITE,
  later: () => {},
  dev: false,
  montonio,
});

async function signedIn(email = "kati@example.com") {
  const [client] = await db.insert(clients).values({ email }).returning();
  const raw = newToken();
  await db.insert(clientSessions).values({ idHash: await sha256(raw), clientId: client.id, createdAt: NOW, expiresAt: new Date(NOW.getTime() + CLIENT_SESSION_TTL_MS) });
  return { client, cookie: `__Host-mslab_client=${raw}` };
}

const call = async (d: AccountDeps, cookie: string, body: unknown, opts: { ip?: string; origin?: string } = {}) =>
  (await handleAccountApi(
    new Request(`${SITE}/api/konto/maksa`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-forwarded-for": opts.ip ?? "203.0.113.9", ...(opts.origin ? { origin: opts.origin } : {}) },
      body: JSON.stringify(body),
    }),
    d,
  ))!;
const answer = async (res: Response) => [res.status, await res.json()];

test("her own unpaid registration: 200 with Montonio's page; a pending prepayment and the hold", async () => {
  const m = stubMontonio();
  const { client, cookie } = await signedIn();
  const r = await registrationOn(db, await contactCourse(db), { clientId: client.id });
  const res = await call(deps(m.montonio), cookie, { registrationId: r.id });
  const [p] = await db.select().from(payments);
  expect(await answer(res)).toEqual([200, { ok: true, paymentUrl: `https://sandbox-stargate.montonio.com/${p.providerUuid}` }]);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect([p.kind, p.clientId, p.amountCents]).toEqual(["prepayment", client.id, 17500]);
  expect((await db.select().from(registrations).where(eq(registrations.id, r.id)))[0].seatHoldUntil).not.toBeNull();
});

test("the rest of a confirmed one; not hers 404; paid in full or full 409; no payments 503; no body 400; cross-site 403", async () => {
  const m = stubMontonio();
  const { client, cookie } = await signedIn();
  const c = await contactCourse(db, { capacity: 1 });
  const rest = await registrationOn(db, c, { clientId: client.id, status: "confirmed", paidCents: 17500 });
  expect((await call(deps(m.montonio), cookie, { registrationId: rest.id })).status).toBe(200);
  expect((await db.select().from(payments).where(eq(payments.registrationId, rest.id)))[0].kind).toBe("balance");
  const other = await signedIn("teine@example.com");
  const theirs = await registrationOn(db, c, { email: "teine@example.com", clientId: other.client.id });
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: theirs.id }))).toEqual([404, { ok: false, error: "registration" }]);
  const paid = await registrationOn(db, c, { clientId: client.id, status: "confirmed", paidCents: 35000 });
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: paid.id }))).toEqual([409, { ok: false, error: "nothing" }]);
  const waiting = await registrationOn(db, c, { clientId: client.id });
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: waiting.id }))).toEqual([409, { ok: false, error: "full" }]);
  expect(await answer(await call(deps(null), cookie, { registrationId: waiting.id }))).toEqual([503, { ok: false, error: "unavailable" }]);
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: "7" }))).toEqual([400, { ok: false, error: "registrationId" }]);
  expect((await call(deps(m.montonio), cookie, { registrationId: waiting.id }, { origin: "https://elsewhere.example" })).status).toBe(403);
});

test("5 starts per IP in 10 minutes (shared with the /maksa page): then 429 rate", async () => {
  const m = stubMontonio();
  const { client, cookie } = await signedIn();
  const c = await contactCourse(db, { capacity: 20 });
  const kv = fakeKv();
  for (let i = 0; i < 5; i++) {
    const r = await registrationOn(db, c, { clientId: client.id, email: `k${i}@example.com` });
    expect((await call(deps(m.montonio, kv), cookie, { registrationId: r.id })).status).toBe(200);
  }
  const sixth = await registrationOn(db, c, { clientId: client.id, email: "k5@example.com" });
  expect(await answer(await call(deps(m.montonio, kv), cookie, { registrationId: sixth.id }))).toEqual([429, { ok: false, error: "rate" }]);
  expect(kv.store.get("rl:pay:203.0.113.9")).toBe("5");
});

test("the dashboard says payOnline when payments are on, and nothing when they are off", async () => {
  const m = stubMontonio();
  const { cookie } = await signedIn();
  const dash = async (montonio: AccountDeps["montonio"]) =>
    (await (await handleAccountApi(new Request(`${SITE}/api/konto`, { headers: { cookie } }), deps(montonio)))!.json()) as Record<string, unknown>;
  expect((await dash(m.montonio)).payOnline).toBe(true);
  expect("payOnline" in (await dash(null))).toBe(false);
});
