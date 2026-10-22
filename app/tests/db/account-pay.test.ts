import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Db } from "@/db/client";
import { clients, clientSessions, courses, payments, registrations, settings } from "@/db/schema";
import { handleAccountApi, type AccountDeps } from "@/server/account-api";
import { CLIENT_SESSION_TTL_MS } from "@/server/client-auth";
import { settleToken } from "@/server/payments/settle";
import { newToken, sha256 } from "@/server/token";
import { fakeKv } from "../fakes";
import { contactCourse, orderToken, registrationOn, settleDeps, SITE, stubMontonio } from "./payments-fixtures";
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

test("a card's 'Maksa' on an allow-listed host that is not SITE_URL (the local dev server): the return comes back to that host, Montonio's webhook always goes to SITE_URL", async () => {
  const m = stubMontonio();
  const { client, cookie } = await signedIn();
  const r = await registrationOn(db, await contactCourse(db), { clientId: client.id });
  expect((await call({ ...deps(m.montonio), siteUrl: "http://localhost:3000" }, cookie, { registrationId: r.id })).status).toBe(200);
  expect(m.state.orders).toEqual([expect.objectContaining({ returnUrl: "http://localhost:3000/api/payments/return", notificationUrl: `${SITE}/api/payments/notify` })]);
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

test("the body's `method` (instalments, §4): hirePurchase starts the järelmaks when allowed, else 409 financing; none is the bank; another value 400", async () => {
  const m = stubMontonio();
  const { client, cookie } = await signedIn();
  const c = await contactCourse(db);
  const r = await registrationOn(db, c, { clientId: client.id, paymentChoice: "financing" });
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: r.id, method: "hirePurchase" }))).toEqual([409, { ok: false, error: "financingOff" }]);
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: r.id, method: "instalment" }))).toEqual([400, { ok: false, error: "method" }]);
  expect(await db.select().from(payments)).toEqual([]);
  await db.insert(settings).values({ key: "financing", value: { enabled: true } });
  expect((await call(deps(m.montonio), cookie, { registrationId: r.id, method: "hirePurchase" })).status).toBe(200);
  const other = await registrationOn(db, c, { email: "teine@example.com", clientId: client.id, paymentChoice: "financing" });
  expect((await call(deps(m.montonio), cookie, { registrationId: other.id })).status).toBe(200);
  expect((await db.select().from(payments).orderBy(payments.id)).map((p) => [p.registrationId, p.method])).toEqual([
    [r.id, "hirePurchase"],
    [other.id, "paymentInitiation"],
  ]);
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

test("the dashboard says `financing` when Maria switched Järelmaks (Inbank) on (Seaded), and says nothing when it is off or unset (Task 7: the card's two buttons)", async () => {
  const { cookie } = await signedIn();
  const dash = async () => (await (await handleAccountApi(new Request(`${SITE}/api/konto`, { headers: { cookie } }), deps(stubMontonio().montonio)))!.json()) as Record<string, unknown>;
  expect("financing" in (await dash())).toBe(false);
  await db.insert(settings).values({ key: "financing", value: { enabled: false } });
  expect("financing" in (await dash())).toBe(false);
  await db.update(settings).set({ value: { enabled: true } }).where(eq(settings.key, "financing"));
  expect((await dash()).financing).toBe(true);
  await db.update(settings).set({ value: { enabled: "true" } }).where(eq(settings.key, "financing"));
  expect("financing" in (await dash())).toBe(false);
});

test("the card of a järelmaks registration carries what the two buttons are decided on: its choice, the whole price, nothing paid", async () => {
  const { client, cookie } = await signedIn();
  const r = await registrationOn(db, await contactCourse(db), { clientId: client.id, paymentChoice: "financing" });
  const res = await handleAccountApi(new Request(`${SITE}/api/konto`, { headers: { cookie } }), deps(stubMontonio().montonio));
  const cards = ((await res!.json()) as { cards: Record<string, unknown>[] }).cards;
  expect(cards.find((c) => c.registrationId === r.id)).toMatchObject({ kind: "contact", paymentChoice: "financing", priceCents: 35000, paidCents: 0, status: "awaiting_prepayment" });
});

test("both buttons of the card: `method` hirePurchase starts the loan (60-minute hold), paymentInitiation the bank (30); the bank payment then confirms the place in full", async () => {
  const m = stubMontonio();
  await db.insert(settings).values({ key: "financing", value: { enabled: true } });
  const { client, cookie } = await signedIn();
  const c = await contactCourse(db);
  const loan = await registrationOn(db, c, { clientId: client.id, paymentChoice: "financing" });
  const bank = await registrationOn(db, c, { clientId: client.id, paymentChoice: "financing", email: "teine@example.com" });
  expect((await call(deps(m.montonio), cookie, { registrationId: loan.id, method: "hirePurchase" })).status).toBe(200);
  expect((await call(deps(m.montonio), cookie, { registrationId: bank.id, method: "paymentInitiation" })).status).toBe(200);
  const rows = await db.select().from(payments).orderBy(payments.id);
  expect(rows.map((p) => [p.registrationId, p.method, p.amountCents])).toEqual([[loan.id, "hirePurchase", 35000], [bank.id, "paymentInitiation", 35000]]);
  const hold = async (id: number) => (await db.select().from(registrations).where(eq(registrations.id, id)))[0].seatHoldUntil;
  expect([await hold(loan.id), await hold(bank.id)]).toEqual([new Date(NOW.getTime() + 60 * 60_000), new Date(NOW.getTime() + 30 * 60_000)]);
  // she pays by bank: the whole price, and the place is confirmed
  const { deps: settle, flush } = settleDeps(db, m.montonio, NOW);
  expect(await settleToken(settle, m.montonio.verifyOrderToken(orderToken(rows[1])))).toMatchObject({ kind: "done", payment: { status: "paid", amountCents: 35000 } });
  await flush();
  const [after] = await db.select().from(registrations).where(eq(registrations.id, bank.id));
  expect([after.status, after.paidCents]).toEqual(["confirmed", 35000]);
});

test("a loan the start refuses: the toggle went off since the page was loaded (the price within the range) is 409 financingOff, the price out of range is 409 financing — nothing started, and the bank's press still works", async () => {
  const m = stubMontonio();
  const { client, cookie } = await signedIn();
  const c = await contactCourse(db);
  const r = await registrationOn(db, c, { clientId: client.id, paymentChoice: "financing" });
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: r.id, method: "hirePurchase" }))).toEqual([409, { ok: false, error: "financingOff" }]);
  // out of 100–5000 € with the toggle off as well: the range (the price is the permanent fact)
  await db.update(courses).set({ priceGroup: 600_000 }).where(eq(courses.id, c.course.id));
  expect(await answer(await call(deps(m.montonio), cookie, { registrationId: r.id, method: "hirePurchase" }))).toEqual([409, { ok: false, error: "financing" }]);
  await db.update(courses).set({ priceGroup: 35_000 }).where(eq(courses.id, c.course.id));
  expect(await db.select().from(payments)).toEqual([]);
  expect((await call(deps(m.montonio), cookie, { registrationId: r.id, method: "paymentInitiation" })).status).toBe(200);
});
